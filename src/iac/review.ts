import {createHash} from 'crypto';
import {ulid} from 'ulid';
import {decide} from '../policy/decide';
import {assemble} from './assemble';
import {IacService} from './service';
import {parseTemplate, policyFromEnv, validateDesired, validateTemplate} from './validator';

// These types match the dedicated execution role, which cannot create IAM roles,
// execute code, or alter the graph service. Expanding this set also requires IAM.
export const APPLY_TYPES = ['AWS::S3::Bucket', 'AWS::S3::BucketPolicy', 'AWS::DynamoDB::Table',
    'AWS::SQS::Queue', 'AWS::SQS::QueuePolicy', 'AWS::SNS::Topic', 'AWS::SNS::TopicPolicy', 'AWS::Logs::LogGroup'];
const terminal = new Set(['succeeded', 'failed', 'rolled-back', 'rollback-failed', 'cancelled', 'expired', 'stale', 'no-changes']);
const hash = (value: any): string => createHash('sha256').update(canonical(value)).digest('hex');
function canonical(value: any): string {
    if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
    if (value && typeof value === 'object') return '{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
    return JSON.stringify(value);
}
function problem(message: string, code = 'IAC_REFUSED', status = 400): never {
    throw Object.assign(new Error(message), {code, status});
}

/** The exact, current graph content to be reviewed. No node code runs here. */
export function prepareReview(projection: any, nodeId: string, policy = policyFromEnv()) {
    const node = projection?.nodes?.find((n: any)=>n.id===nodeId);
    const carried = node?.properties?.iac;
    if (!carried?.stack) problem('This node does not describe a CloudFormation stack.', 'NOT_FOUND', 404);
    const assembled = assemble(projection, nodeId, policy);
    const fromGraph = assembled.fragments.length > 0 || typeof carried.template?.text !== 'string';
    const text = fromGraph ? assembled.text : carried.template.text;
    const format = fromGraph ? 'json' : carried.template.format === 'json' ? 'json' : 'yaml';
    const validation = validateTemplate(text || '', format, policy);
    const desired = IacService.desiredFor(projection.id, nodeId, 'live', carried, validation.templateSha256, '00000000000000000000000000');
    const problems = [...(fromGraph ? assembled.problems : []), ...validation.problems, ...validateDesired(desired, policy).problems];
    if (Buffer.byteLength(text || '') > 51200) problems.push({code:'SCHEMA_INVALID',message:'The template exceeds the 51,200-byte CloudFormation template limit.'});
    const input = {graphId:projection.id, nodeId, stack:carried.stack, text, format,
        parameters:carried.parameters || {}, capabilities:carried.capabilities || []};
    return {...input, source:fromGraph ? 'graph' : 'inline', inputDigest:hash(input),
        policyDigest:hash(policy), validation:{...validation, ok:problems.length===0, problems}};
}

export interface ReviewCloud {
    stack(name: string): Promise<any>;
    create(record: any): Promise<{changeSetId: string; stackId: string}>;
    describe(record: any): Promise<any>;
    execute(record: any): Promise<void>;
    remove(record: any): Promise<void>;
}
export interface ReviewDeps {
    projection?: (graphId: string) => Promise<any>;
    policy?: () => any;
    now?: () => number;
    enabled?: boolean;
    start?: (operationId: string) => Promise<void>;
    cloud?: ReviewCloud;
}

/** Durable reviewed operations; only step() runs in the privileged worker. */
export class IacReviewService {
    constructor(private store: any, private deps: ReviewDeps) {}
    get enabled() { return !!this.deps.enabled; }
    route(event: any, _context: any, callback: any) {
        const {id:graphId,nodeId}=event.pathParameters || {};
        const action=String(event.resource || event.path || '').split('/').pop();
        Promise.resolve().then(async()=>{
            let body:any={};
            if (event.httpMethod==='POST') {
                try {body=JSON.parse(event.body || '{}');} catch {problem('Invalid JSON request.','SCHEMA_INVALID');}
                if (!body || typeof body!=='object' || Array.isArray(body)) problem('Invalid request.','SCHEMA_INVALID');
            }
            if (event.httpMethod==='GET' && action==='template') return this.template(graphId,nodeId,event.principal);
            if (event.httpMethod==='GET' && action==='review') return {status:await this.current(graphId,nodeId,event.principal)};
            if (event.httpMethod==='POST' && action==='plan') return {status:await this.begin(graphId,nodeId,event.principal,body.replace===true)};
            if (event.httpMethod==='POST' && action==='apply') return {status:await this.approve(graphId,nodeId,event.principal,body)};
            if (event.httpMethod==='POST' && action==='discard') return {status:await this.cancel(graphId,nodeId,event.principal,body)};
            problem('Unknown infrastructure action.','NOT_FOUND',404);
        }).then(body=>callback(null,{statusCode:200,headers:{'Access-Control-Allow-Origin':'*','Content-Type':'application/json'},body:JSON.stringify(body)}))
          .catch(e=>callback(null,{statusCode:e.status || 500,headers:{'Access-Control-Allow-Origin':'*','Content-Type':'application/json'},body:JSON.stringify({error:e.status ? e.message : 'Infrastructure request failed.',code:e.code || 'INTERNAL',problems:e.problems})}));
    }
    private now() { return this.deps.now ? this.deps.now() : Date.now(); }
    private policy() { return this.deps.policy ? this.deps.policy() : policyFromEnv(); }
    static key(id: string) { return 'iac/reviews/'+id+'.json'; }
    static index(graphId: string, nodeId: string) { return 'iac/review-index/'+encodeURIComponent(graphId)+'/'+encodeURIComponent(nodeId)+'.json'; }
    private lockKey(stack: any) { return 'iac/stacks/'+stack.account+'/'+stack.region+'/'+stack.name+'/review-lock.json'; }
    private async read(key: string): Promise<any> {
        return new Promise((resolve, reject)=>this.store.getVersioned(key,(err: any, row: any)=>{
            if (err && !/NoSuchKey|NotFound|not found/i.test(String(err.code || err.message))) return reject(err);
            resolve(err ? null : row);
        }));
    }
    private async cas(key: string, value: any, etag: string | null): Promise<boolean> {
        return new Promise((resolve, reject)=>this.store.compareAndSet(key,value,etag,(err: any)=>{
            if (err && (err.statusCode===412 || /PreconditionFailed/.test(String(err.code || err.message)))) return resolve(false);
            err ? reject(err) : resolve(true);
        }));
    }
    private authorize(principal: any, approval = false) {
        const decision = decide(principal, [approval ? 'iac:approve' : 'iac:read-status']);
        if (!decision.allow || (approval && principal?.kind!=='human')) problem('An authenticated human with infrastructure approval authority is required.', 'ADMISSION_DENIED', 403);
    }
    async template(graphId: string, nodeId: string, principal: any) {
        this.authorize(principal);
        const graph = await this.deps.projection!(graphId);
        if (!graph) problem('Graph not found.', 'NOT_FOUND', 404);
        return prepareReview(graph, nodeId, this.policy());
    }
    private publicRecord(record: any) {
        if (!record) return null;
        const {input, policyDigest, ...visible} = record;
        return {...visible, template:{text:input.text, format:input.format, source:input.source}, stack:input.stack};
    }
    async current(graphId: string, nodeId: string, principal: any) {
        this.authorize(principal);
        const index = await this.read(IacReviewService.index(graphId,nodeId));
        if (!index) return null;
        const record = (await this.read(IacReviewService.key(index.value.operationId)))?.value;
        return this.publicRecord(record);
    }
    private async operation(graphId: string, nodeId: string, id: string) {
        if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id || '')) problem('Invalid review ID.','SCHEMA_INVALID');
        const row = await this.read(IacReviewService.key(id));
        if (!row || row.value.graphId!==graphId || row.value.nodeId!==nodeId) problem('Review not found.','NOT_FOUND',404);
        return row;
    }
    async begin(graphId: string, nodeId: string, principal: any, replace = false) {
        this.authorize(principal);
        if (!decide(principal,['iac:propose']).allow) problem('Infrastructure planning is not permitted.','ADMISSION_DENIED',403);
        if (!this.deps.enabled) problem('Reviewed deployment is not enabled on this server.','UNSUPPORTED',409);
        const input = await this.template(graphId,nodeId,principal);
        if (!input.validation.ok) throw Object.assign(new Error(input.validation.problems.map((p: any)=>p.message).join('\n')), {code:'IAC_REFUSED',status:400,problems:input.validation.problems});
        const unsupported = input.validation.resourceTypes.filter((t: string)=>!APPLY_TYPES.includes(t));
        if (unsupported.length) problem('The deployment role does not support: '+[...new Set(unsupported)].join(', '));
        this.checkPrivateBuckets(input);
        const lockKey = this.lockKey(input.stack);
        const lock = await this.read(lockKey);
        if (lock?.value.operationId) {
            const old = await this.read(IacReviewService.key(lock.value.operationId));
            if (old && (!terminal.has(old.value.state) || old.value.manualRecoveryRequired)) {
                if (old.value.graphId!==graphId || old.value.nodeId!==nodeId || old.value.manualRecoveryRequired) problem('Another operation holds this stack. Finish its review or recovery before starting another.','CONFLICT',409);
                if (!replace || !['awaiting-review'].includes(old.value.state)) return this.publicRecord(old.value);
                if (!await this.cas(IacReviewService.key(old.value.operationId), {...old.value,state:'cancelled',reason:'Replaced by a new review.'},old.etag)) problem('The review changed. Refresh and try again.','CONFLICT',409);
            }
        }
        const id=ulid(), now=this.now();
        const record:any={operationId:id,graphId,nodeId,input,policyDigest:input.policyDigest,inputDigest:input.inputDigest,
            state:'planning',createdAt:now,updatedAt:now,expiresAt:now+3600000,by:{sub:principal.sub,kind:principal.kind},
            changeSetName:'review-'+id,history:[{state:'planning',at:now}]};
        await this.cas(IacReviewService.key(id),record,null);
        if (!await this.cas(lockKey,{operationId:id},lock?.etag || null)) problem('Another review started for this stack. Refresh and try again.','CONFLICT',409);
        const indexKey=IacReviewService.index(graphId,nodeId), index=await this.read(indexKey);
        if (!await this.cas(indexKey,{operationId:id},index?.etag || null)) {
            await this.fail(id,'Another review started concurrently.');
            problem('Another review started concurrently. Refresh and try again.','CONFLICT',409);
        }
        try { await this.deps.start!(id); }
        catch { await this.fail(id,'The deployment workflow could not start.'); problem('The deployment workflow could not start.','UNAVAILABLE',503); }
        return this.publicRecord(record);
    }
    async approve(graphId: string, nodeId: string, principal: any, body: any) {
        this.authorize(principal,true);
        const row=await this.operation(graphId,nodeId,body.operationId), op=row.value;
        if (!body.reviewDigest || body.reviewDigest!==op.reviewDigest) problem('Approve the exact review displayed in the editor. Refresh the review.','STALE_REVIEW',409);
        if (op.approval && ['apply-requested','applying','succeeded','rolled-back','rollback-failed'].includes(op.state)) return this.publicRecord(op);
        if (op.state!=='awaiting-review' || this.now()>op.expiresAt) problem('This review is no longer available. Create a new review.','STALE_REVIEW',409);
        const current=await this.template(graphId,nodeId,principal);
        if (current.inputDigest!==op.inputDigest || current.policyDigest!==op.policyDigest || !current.validation.ok) problem('The template, stack settings, or deployment policy changed after this review. Create a new review.','STALE_REVIEW',409);
        if (op.plan.destructive && body.confirmDestructive!==true) problem('Confirm resource removal or replacement before applying this review.','APPROVAL_REQUIRED',409);
        const next={...op,state:'apply-requested',updatedAt:this.now(),approval:{sub:principal.sub,at:this.now(),reviewDigest:op.reviewDigest},
            history:[...op.history,{state:'apply-requested',at:this.now(),by:principal.sub}]};
        if (!await this.cas(IacReviewService.key(op.operationId),next,row.etag)) problem('The review changed. Refresh before approving.','CONFLICT',409);
        return this.publicRecord(next);
    }
    async cancel(graphId: string,nodeId: string,principal: any,body: any) {
        this.authorize(principal,true);
        const row=await this.operation(graphId,nodeId,body.operationId),op=row.value;
        if (!['planning','awaiting-review'].includes(op.state)) problem('Only a pending review can be discarded. An apply already submitted to AWS must finish.','CONFLICT',409);
        const next={...op,state:'cancelled',reason:'Review discarded.',updatedAt:this.now(),history:[...op.history,{state:'cancelled',at:this.now(),by:principal.sub}]};
        if (!await this.cas(IacReviewService.key(op.operationId),next,row.etag)) problem('The review changed. Refresh and try again.','CONFLICT',409);
        return this.publicRecord(next);
    }
    private async release(op: any) {
        if (op.manualRecoveryRequired) return;
        const key=this.lockKey(op.input.stack), lock=await this.read(key);
        if (lock?.value.operationId===op.operationId) await this.cas(key,{operationId:null},lock.etag);
    }
    private checkPrivateBuckets(input: any) {
        const doc=parseTemplate(input.text,input.format).doc;
        for (const [id,resource] of Object.entries<any>(doc?.Resources || {})) {
            if (resource.Type!=='AWS::S3::Bucket') continue;
            const block=resource.Properties?.PublicAccessBlockConfiguration;
            if (!block || !['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets'].every(k=>block[k]===true)) {
                problem(id+': reviewed deployments require all four S3 public-access blocks to be enabled.');
            }
            if (resource.Properties?.AccessControl && resource.Properties.AccessControl!=='Private') problem(id+': reviewed deployments require private bucket access.');
        }
    }
    async fail(id: string, reason: string) {
        const row=await this.read(IacReviewService.key(id)); if (!row) return;
        const op=row.value;
        if (terminal.has(op.state)) return;
        const manual=!!op.approval;
        const next={...op,state:'failed',reason,manualRecoveryRequired:manual,updatedAt:this.now(),history:[...op.history,{state:'failed',at:this.now()}]};
        if (await this.cas(IacReviewService.key(id),next,row.etag)) await this.release(next);
    }
    /** A short step, retried/polled by Step Functions rather than an HTTP request. */
    async step(id: string): Promise<any> {
        const row=await this.read(IacReviewService.key(id));
        if (!row) return {operationId:id,done:true};
        const op=row.value, cloud=this.deps.cloud!;
        const result=(done=false)=>({operationId:id,done,waitSeconds:op.state==='awaiting-review' ? 30 : 5});
        const save=async (patch: any)=>{
            const next={...op,...patch,updatedAt:this.now()};
            if (patch.state && patch.state!==op.state) next.history=[...op.history,{state:patch.state,at:this.now()}];
            if (!await this.cas(IacReviewService.key(id),next,row.etag)) return false;
            Object.assign(op,next);return true;
        };
        if (terminal.has(op.state)) {
            if (!op.approval) await cloud.remove(op);
            await this.release(op);return result(true);
        }
        if (op.state==='awaiting-review') {
            if (this.now()>op.expiresAt) await save({state:'expired',reason:'Review expired. Create a new review.'});
            return result();
        }
        if (this.now()-op.createdAt>5*3600000) {await this.fail(id,'The deployment exceeded its monitoring window. Check CloudFormation before retrying.');return result(true);}
        if (op.state==='planning') {
            // The privileged worker independently validates the stored input.
            const checked=prepareReview({id:op.graphId,nodes:[{id:op.nodeId,properties:{iac:{stack:op.input.stack,
                template:{text:op.input.text,format:op.input.format},parameters:op.input.parameters,capabilities:op.input.capabilities}}}]},op.nodeId,this.policy());
            if (!checked.validation.ok || checked.inputDigest!==op.inputDigest || checked.policyDigest!==op.policyDigest
                || checked.validation.resourceTypes.some(t=>!APPLY_TYPES.includes(t))) {
                await this.fail(id,'The stored template no longer passes deployment validation.');return result();
            }
            this.checkPrivateBuckets(checked);
            if (!op.changeSetId) {
                const stack=await cloud.stack(op.input.stack.name);
                if (stack.exists && /IN_PROGRESS$/.test(stack.status) && stack.status!=='REVIEW_IN_PROGRESS') {
                    await this.fail(id,'CloudFormation is already changing this stack. Wait for it to finish.');return result();
                }
                const exists=stack.exists && stack.status!=='REVIEW_IN_PROGRESS' && stack.status!=='DELETE_COMPLETE';
                const created=await cloud.create({...op,stackExists:exists});
                // Cancellation can win while AWS creates a change set; remove the
                // newly-created set if the saved operation no longer owns this step.
                if (!await save({...created,stackExists:exists})) await cloud.remove({...op,...created});
                return result();
            }
            const described=await cloud.describe(op);
            if (['CREATE_IN_PROGRESS','CREATE_PENDING'].includes(described.status)) return result();
            const noChanges=described.status==='FAILED' && /didn.t contain changes|no updates|no changes/i.test(described.reason || '');
            if (noChanges) {await cloud.remove(op);await save({state:'no-changes',reason:'The deployed stack already matches this template.'});await this.release(op);return result(true);}
            if (described.status!=='CREATE_COMPLETE') {await this.fail(id,described.reason || 'CloudFormation could not prepare the review.');return result();}
            const plan={changeSetId:op.changeSetId,changes:described.changes,destructive:described.changes.some((c:any)=>c.action==='Remove'||c.action==='Replace'||(c.action==='Modify' && c.replacement && c.replacement!=='False')),changeSetRetained:true,stackExists:op.stackExists};
            await save({state:'awaiting-review',plan,reviewDigest:hash({inputDigest:op.inputDigest,policyDigest:op.policyDigest,plan}),expiresAt:this.now()+3600000});
            return result();
        }
        if (op.state==='apply-requested') {
            if (!op.approval || op.approval.reviewDigest!==op.reviewDigest || hash(this.policy())!==op.policyDigest) {await this.fail(id,'The approval or deployment policy is no longer valid.');return result(true);}
            const described=await cloud.describe(op);
            if (described.executionStatus==='AVAILABLE') await cloud.execute(op);
            else if (!['EXECUTE_IN_PROGRESS','EXECUTE_COMPLETE'].includes(described.executionStatus)) {await this.fail(id,'This CloudFormation change set is no longer executable. Create a new review.');return result(true);}
            await save({state:'applying',startedAt:this.now()});return result();
        }
        if (op.state==='applying') {
            const stack=await cloud.stack(op.stackId || op.input.stack.name);
            if (!stack.exists || stack.status==='REVIEW_IN_PROGRESS' || /IN_PROGRESS$/.test(stack.status)) return result();
            const state=['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack.status) ? 'succeeded'
                : /ROLLBACK_FAILED$/.test(stack.status) ? 'rollback-failed'
                : /ROLLBACK_COMPLETE$/.test(stack.status) ? 'rolled-back' : 'failed';
            await save({state,stackStatus:stack.status,reason:stack.reason,outputs:stack.outputs || [],
                effectiveInputDigest:state==='succeeded' ? op.inputDigest : undefined,manualRecoveryRequired:state==='rollback-failed'});
            await this.release(op);return result(true);
        }
        await this.fail(id,'Unknown infrastructure operation state.');return result(true);
    }
}
