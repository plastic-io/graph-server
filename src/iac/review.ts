import {deploymentCapabilities, isolationEnabled, LEGACY_APPLY_TYPES} from './capabilities';
import {scopedPolicy,stackScope, ISOLATED_TYPES} from './isolation';
import {DeploymentProgress,phaseFor} from './progress';
import {diagnosticError,diagnosticText,recoveryFor} from './diagnosticSafety';
import {DelegationStore} from '../policy/delegation';
import {createHash} from 'crypto';
import {ulid} from 'ulid';
import {decide} from '../policy/decide';
import {assemble} from './assemble';
import {IacService} from './service';
import {parseTemplate, policyFromEnv, validateDesired, validateTemplate} from './validator';

// These types match the dedicated execution role, which cannot create IAM roles,
// execute code, or alter the graph service. Expanding this set also requires IAM.
export const APPLY_TYPES = LEGACY_APPLY_TYPES;
const terminal = new Set(['succeeded', 'failed', 'rolled-back', 'rollback-failed', 'cancelled', 'expired', 'stale', 'no-changes','destroyed']);
const hash = (value: any): string => createHash('sha256').update(canonical(value)).digest('hex');
const accessChange = (type:string,before:any,after:any) => /^AWS::IAM::/.test(type)||/::(?:BucketPolicy|QueuePolicy|TopicPolicy|Permission|Authorizer)$/.test(type)
    ? {before:before?.Properties||null,after:after?.Properties||null} : undefined;
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
    const scope=stackScope(projection.id,nodeId,policy);
    const basePolicy=policy;
    if(isolationEnabled())policy=scopedPolicy(scope,policy);
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
    const preflight=deploymentCapabilities(projection.id,nodeId,{...carried,template:{text,format}},basePolicy);
    if(isolationEnabled())problems.push(...preflight.problems.filter(p=>!['DEPLOYMENT_UNAVAILABLE'].includes(p.code)));
    const input = {graphId:projection.id, nodeId, stack:carried.stack, text, format,
        parameters:carried.parameters || {}, capabilities:carried.capabilities || [], ...(isolationEnabled()?{isolation:scope}:{})};
    return {...input, preflight, source:fromGraph ? 'graph' : 'inline', inputDigest:hash(input),
        policyDigest:hash(policy), validation:{...validation, ok:problems.length===0, problems}};
}

export interface ReviewCloud {
    prepare?(record:any):Promise<boolean>;
    resources?(record:any):Promise<any[]>;
    destroy?(record:any):Promise<void>;
    stack(name: string, record?:any): Promise<any>;
    create(record: any): Promise<{changeSetId: string; stackId: string}>;
    describe(record: any): Promise<any>;
    execute(record: any): Promise<void>;
    remove(record: any): Promise<void>;
}
export interface ReviewDeps {
    notify?: (graphId:string,event:any)=>Promise<void>;
    refreshDiagnostics?: (operationId:string)=>Promise<void>;
    revision?: (graphId:string)=>Promise<string>;
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
            if (event.httpMethod==='GET' && action==='review') return {status:await this.current(graphId,nodeId,event.principal,event.queryStringParameters?.operationId)};
            if (event.httpMethod==='GET' && action==='events') return this.events(graphId,nodeId,event.principal,event.queryStringParameters||{});
            if (event.httpMethod==='GET' && action==='operations') return this.operations(graphId,nodeId,event.principal,event.queryStringParameters||{});
            if (event.httpMethod==='POST' && action==='plan') return {status:await this.begin(graphId,nodeId,event.principal,body.replace===true,body.action||'apply')};
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
    private async authorize(graphId:string,principal: any, approval = false) {
        if(!/^[A-Za-z0-9_.-]{1,64}$/.test(graphId||''))problem('Invalid graph ID.','SCHEMA_INVALID');
        principal=await new DelegationStore(this.store).resolve(principal,graphId);
        const decision = decide(principal, ['graph:read',approval ? 'iac:approve' : 'iac:read-status']);
        if (!decision.allow || (approval && principal?.kind!=='human')) problem(approval?'An authenticated human with infrastructure approval authority is required.':'Graph read and infrastructure status authority are required for this graph.', 'ADMISSION_DENIED', 403);
        return principal;
    }
    async template(graphId: string, nodeId: string, principal: any) {
        await this.authorize(graphId,principal);
        const graph = await this.deps.projection!(graphId);
        if (!graph) problem('Graph not found.', 'NOT_FOUND', 404);
        return prepareReview(graph, nodeId, this.policy());
    }
    private async reviewInput(graphId:string,nodeId:string,principal:any,action:string):Promise<any> {
        if(action!=='destroy') return this.template(graphId,nodeId,principal);
        await this.authorize(graphId,principal);
        const binding=await this.read(`iac/deployed/${graphId}/${nodeId}.json`);
        const deployed=binding?.value.operationId && await this.read(IacReviewService.key(binding.value.operationId));
        const scope=stackScope(graphId,nodeId,this.policy());
        if(!deployed || deployed.value.state!=='succeeded' || !deployed.value.approval || deployed.value.graphId!==graphId || deployed.value.nodeId!==nodeId || deployed.value.input.isolation?.namespace!==scope.namespace) problem('No approved isolated deployment is bound to this node.','DEPLOYMENT_REQUIRED',409);
        const input=deployed.value.input;
        // Deletion uses the deployed template, including retention policies. Unapplied graph edits cannot change it.
        const checked=prepareReview({id:graphId,nodes:[{id:nodeId,properties:{iac:{stack:input.stack,template:{text:input.text,format:input.format},parameters:input.parameters,capabilities:input.capabilities}}}]},nodeId,this.policy());
        return {...checked,deploymentOperationId:deployed.value.operationId};
    }
    private removalPlan(op:any,resources:any[]) {
        const definitions=parseTemplate(op.input.text,op.input.format).doc?.Resources || {};
        return resources.map(r=>({action:'Remove',logicalId:r.logicalId,physicalId:r.physicalId,resourceType:r.resourceType,
            access:accessChange(r.resourceType,definitions[r.logicalId],null),
            deletionPolicy:definitions[r.logicalId]?.DeletionPolicy || 'Delete',
            outcome:['Retain','RetainExceptOnCreate'].includes(definitions[r.logicalId]?.DeletionPolicy)?'Retain':'Delete'})).sort((a,b)=>a.logicalId.localeCompare(b.logicalId));
    }
    private publicRecord(record: any) {
        if (!record) return null;
        const {input, policyDigest, ...visible} = record;
        return {...visible,...(record.reason?{reason:diagnosticText(record.reason,record)}:{}),...(record.originalError?{originalError:diagnosticError(record.originalError,record)}:{}),template:{text:input.text, format:input.format, source:input.source}, stack:input.stack,preflight:input.preflight};
    }
    private progress(){return new DeploymentProgress(this.store,this.deps.notify);}
    async current(graphId: string, nodeId: string, principal: any, operationId?:string, refresh=true) {
        await this.authorize(graphId,principal);
        const index = await this.read(IacReviewService.index(graphId,nodeId));
        if (!index&&!operationId) return null;
        const record=(await this.operation(graphId,nodeId,operationId||index.value.operationId)).value;
        try{if(refresh)await this.deps.refreshDiagnostics?.(record.operationId);}catch(e){
            try{await this.progress().append(record,[{id:'collector-unavailable',source:'diagnostics',kind:'diagnostic-warning',phase:phaseFor(record.state),status:'UNAVAILABLE',reason:'Diagnostic refresh failed. Stored progress and the original error remain available.',error:diagnosticError(e,record)}]);}catch{/* The stored deployment failure remains the primary response. */}
        }
        await this.progress().flush(record);
        let progress:any;
        try{progress=await this.progress().view(record);}catch(e){progress={version:1,collectionWarning:{reason:'Stored diagnostics are temporarily unavailable. The original deployment outcome is preserved.',error:diagnosticError(e,record)}};}
        const workflowFailed=progress.orchestrationFailure&&!terminal.has(record.state);
        const failure=['failed','rolled-back','rollback-failed'].includes(record.state)||workflowFailed||progress.cleanup?.status==='DELETE_FAILED';
        return {...this.publicRecord(record),...(workflowFailed?{state:'failed',workflowState:record.state}:{}),progress,
            ...(failure?{error:progress.failure?.error||(progress.failure?.reason?diagnosticError({code:progress.failure.status||'DEPLOYMENT_ERROR',message:progress.failure.reason},record):record.originalError),reason:progress.failure?.reason||record.reason,
                recovery:progress.recovery||recoveryFor(record,{status:record.state,reason:record.reason}),
                manualRecoveryRequired:record.manualRecoveryRequired||!!workflowFailed||progress.recovery?.category==='platform-intervention'}:{})};
    }
    async events(graphId:string,nodeId:string,principal:any,options:any={}){
        await this.authorize(graphId,principal);
        const index=options.operationId?null:await this.read(IacReviewService.index(graphId,nodeId));
        const op=(await this.operation(graphId,nodeId,options.operationId||index?.value.operationId)).value;
        return this.progress().page(op,{cursor:options.cursor,limit:Number(options.limit)||50});
    }
    async operations(graphId:string,nodeId:string,principal:any,options:any={}){
        await this.authorize(graphId,principal);
        const index=await this.read(IacReviewService.index(graphId,nodeId));let id=options.cursor||index?.value.operationId;
        const operations:any[]=[];
        for(let n=0;id&&n<Math.min(Math.max(Number(options.limit)||20,1),50);n++){
            const op=(await this.operation(graphId,nodeId,id)).value;
            operations.push({operationId:id,state:op.state,action:op.action,createdAt:op.createdAt,updatedAt:op.updatedAt,revisionId:op.revisionId||'live',inputDigest:op.inputDigest,reviewDigest:op.reviewDigest,reason:diagnosticText(op.reason,op)});
            id=op.previousOperationId;
        }
        return {operations,nextCursor:id||null};
    }
    private async operation(graphId: string, nodeId: string, id: string) {
        if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id || '')) problem('Invalid review ID.','SCHEMA_INVALID');
        const row = await this.read(IacReviewService.key(id));
        if (!row || row.value.graphId!==graphId || row.value.nodeId!==nodeId) problem('Review not found.','NOT_FOUND',404);
        return row;
    }
    async begin(graphId: string, nodeId: string, principal: any, replace = false, action='apply') {
        principal=await this.authorize(graphId,principal);
        if(!['apply','destroy'].includes(action))problem('Unknown deployment action.');
        if(action==='destroy'&&!isolationEnabled())problem('Reviewed destroy requires stack isolation.');
        if (!decide(principal,['iac:propose']).allow) problem('Infrastructure planning is not permitted.','ADMISSION_DENIED',403);
        if (!this.deps.enabled) problem('Reviewed deployment is not enabled on this server.','UNSUPPORTED',409);
        const input = await this.reviewInput(graphId,nodeId,principal,action);
        if (!input.validation.ok) throw Object.assign(new Error(input.validation.problems.map((p: any)=>p.message).join('\n')), {code:'IAC_REFUSED',status:400,problems:input.validation.problems});
        const unsupported = input.validation.resourceTypes.filter((t: string)=>!(isolationEnabled()?ISOLATED_TYPES:APPLY_TYPES).includes(t));
        if (unsupported.length) problem('The deployment role does not support: '+[...new Set(unsupported)].join(', '));
        this.checkPrivateBuckets(input);
        const lockKey = this.lockKey(input.stack);
        const lock = await this.read(lockKey);
        const existingIndex=await this.read(IacReviewService.index(graphId,nodeId));
        if(existingIndex?.value.operationId){const priorProgress=await this.progress().head(existingIndex.value.operationId),prior=await this.read(IacReviewService.key(existingIndex.value.operationId));
            if(prior&&terminal.has(prior.value.state)&&!['succeeded','destroyed'].includes(prior.value.state)&&priorProgress?.snapshot?.recovery?.category==='platform-intervention')problem('The previous operation requires platform intervention. Read its resource failures and recovery guidance in this graph before retrying.','RECOVERY_REQUIRED',409);}
        if (lock?.value.operationId) {
            const old = await this.read(IacReviewService.key(lock.value.operationId));
            if(old?.value.input.isolation && ['succeeded','destroyed'].includes(old.value.state) && !old.value.finalizedAt) return this.publicRecord(old.value);
            if (old && (!terminal.has(old.value.state) || old.value.manualRecoveryRequired)) {
                if (old.value.graphId!==graphId || old.value.nodeId!==nodeId || old.value.manualRecoveryRequired) problem('Another operation holds this stack. Finish its review or recovery before starting another.','CONFLICT',409);
                if (!replace || !['awaiting-review'].includes(old.value.state)) return this.publicRecord(old.value);
                if (!await this.cas(IacReviewService.key(old.value.operationId), {...old.value,state:'cancelled',reason:'Replaced by a new review.'},old.etag)) problem('The review changed. Refresh and try again.','CONFLICT',409);
            }
        }
        const id=ulid(), now=this.now();
        const record:any={operationId:id,graphId,nodeId,input,policyDigest:input.policyDigest,inputDigest:input.inputDigest,
            revisionId:await this.deps.revision?.(graphId)||'live',previousOperationId:existingIndex?.value.operationId||null,
            state:'planning',createdAt:now,updatedAt:now,expiresAt:now+3600000,by:{sub:principal.sub,kind:principal.kind},
            action,changeSetName:'review-'+id,history:[{state:'planning',at:now}]};
        await this.cas(IacReviewService.key(id),record,null);
        if (!await this.cas(lockKey,{operationId:id},lock?.etag || null)) problem('Another review started for this stack. Refresh and try again.','CONFLICT',409);
        const indexKey=IacReviewService.index(graphId,nodeId), index=await this.read(indexKey);
        if (!await this.cas(indexKey,{operationId:id},index?.etag || null)) {
            await this.fail(id,'Another review started concurrently.');
            problem('Another review started concurrently. Refresh and try again.','CONFLICT',409);
        }
        await this.observe(record);
        try { await this.deps.start!(id); }
        catch(e) { await this.fail(id,e);return this.current(graphId,nodeId,principal); }
        return this.publicRecord(record);
    }
    async approve(graphId: string, nodeId: string, principal: any, body: any) {
        await this.authorize(graphId,principal,true);
        const row=await this.operation(graphId,nodeId,body.operationId), op=row.value;
        if((await this.progress().head(op.operationId))?.snapshot?.orchestrationFailure)problem('The deployment workflow stopped. Create a new review after resolving its reported failure.','STALE_REVIEW',409);
        if (!body.reviewDigest || body.reviewDigest!==op.reviewDigest) problem('Approve the exact review displayed in the editor. Refresh the review.','STALE_REVIEW',409);
        if (op.approval && ['apply-requested','applying','succeeded','destroyed','rolled-back','rollback-failed'].includes(op.state)) return this.publicRecord(op);
        if (op.state!=='awaiting-review' || this.now()>op.expiresAt) problem('This review is no longer available. Create a new review.','STALE_REVIEW',409);
        const current=await this.reviewInput(graphId,nodeId,principal,op.action);
        if (current.inputDigest!==op.inputDigest || current.policyDigest!==op.policyDigest || current.deploymentOperationId!==op.input.deploymentOperationId || !current.validation.ok) problem('The template, deployed stack, or deployment policy changed after this review. Create a new review.','STALE_REVIEW',409);
        if (op.plan.destructive && body.confirmDestructive!==true) problem('Confirm resource removal or replacement before applying this review.','APPROVAL_REQUIRED',409);
        const next={...op,state:'apply-requested',updatedAt:this.now(),approval:{sub:principal.sub,at:this.now(),reviewDigest:op.reviewDigest},
            history:[...op.history,{state:'apply-requested',at:this.now(),by:principal.sub}]};
        if (!await this.cas(IacReviewService.key(op.operationId),next,row.etag)) problem('The review changed. Refresh before approving.','CONFLICT',409);
        await this.observe(next);
        return this.publicRecord(next);
    }
    async cancel(graphId: string,nodeId: string,principal: any,body: any) {
        await this.authorize(graphId,principal,true);
        const row=await this.operation(graphId,nodeId,body.operationId),op=row.value;
        if (!['planning','awaiting-review'].includes(op.state)) problem('Only a pending review can be discarded. An apply already submitted to AWS must finish.','CONFLICT',409);
        const next={...op,state:'cancelled',reason:'Review discarded.',updatedAt:this.now(),history:[...op.history,{state:'cancelled',at:this.now(),by:principal.sub}]};
        if (!await this.cas(IacReviewService.key(op.operationId),next,row.etag)) problem('The review changed. Refresh and try again.','CONFLICT',409);
        await this.observe(next);
        return this.publicRecord(next);
    }
    private async release(op: any) {
        if (op.manualRecoveryRequired) return;
        const key=this.lockKey(op.input.stack), lock=await this.read(key);
        if (lock?.value.operationId===op.operationId) await this.cas(key,{operationId:null},lock.etag);
    }
    private async finish(op:any) {
        if(['succeeded','destroyed'].includes(op.state) && !op.finalizedAt) {
            const lock=await this.read(this.lockKey(op.input.stack));
            if(lock?.value.operationId!==op.operationId) return;
            const key=`iac/deployed/${op.graphId}/${op.nodeId}.json`,bound=await this.read(key);
            const operationId=op.state==='succeeded'?op.operationId:null;
            if(bound?.value.operationId!==operationId && !await this.cas(key,{operationId},bound?.etag||null)) throw new Error('Deployment binding changed concurrently; retry finalization');
            const row=await this.read(IacReviewService.key(op.operationId));
            if(!await this.cas(IacReviewService.key(op.operationId),{...row.value,finalizedAt:this.now()},row.etag)) throw new Error('Deployment finalization changed concurrently');
        }
        await this.release(op);
    }
    private async observe(op:any) {
        const row=await this.read(IacReviewService.key(op.operationId));
        if(!row) return;
        const value=row.value;
        await this.progress().append(value,[{id:'state:'+value.state,source:'worker',state:value.state,phase:phaseFor(value.state),reason:value.reason,stackName:value.input.stack.name,at:value.updatedAt}]);
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
    async recordException(id:string,error:any,requestId?:string){
        const row=await this.read(IacReviewService.key(id));if(!row)return;
        const op=row.value,safe=diagnosticError(error,op),head=await this.progress().head(id);
        if(!op.originalError)await this.cas(IacReviewService.key(id),{...op,originalError:safe},row.etag);
        const entry={source:'worker',kind:'exception',phase:head?.snapshot?.latest?.phase||phaseFor(op.state),status:'ERROR',error:safe,reason:safe.message,requestId};
        await this.progress().append(op,[entry]);
        console.error(JSON.stringify({type:'deployment.diagnostic',operationId:id,requestId,phase:entry.phase,status:'ERROR',error:safe}));
    }
    async fail(id: string, reason: any) {
        const row=await this.read(IacReviewService.key(id)); if (!row) return;
        const op=row.value;
        if (terminal.has(op.state)) return;
        const error=op.originalError||diagnosticError(reason,op);
        const manual=!!op.approval||/guardrail.*fail|ROLLBACK_FAILED/i.test(error.message);
        const next={...op,state:'failed',reason:error.message,originalError:error,manualRecoveryRequired:manual,updatedAt:this.now(),history:[...op.history,{state:'failed',at:this.now()}]};
        if (await this.cas(IacReviewService.key(id),next,row.etag)) {await this.progress().append(next,[{id:'original-failure',source:'worker',kind:'exception',phase:'terminal',state:'failed',error,reason:error.message}]);await this.observe(next);await this.release(next);}
    }
    /** A short step, retried/polled by Step Functions rather than an HTTP request. */
    async step(id: string): Promise<any> {
        let row=await this.read(IacReviewService.key(id));
        if (!row) return {operationId:id,done:true};
        await this.observe(row.value);
        row=await this.read(IacReviewService.key(id));
        const op=row.value, cloud=this.deps.cloud!;
        const result=(done=false)=>({operationId:id,done,waitSeconds:op.state==='awaiting-review' ? 30 : 5});
        const save=async (patch: any)=>{
            if(patch.reason)patch.reason=diagnosticText(patch.reason,op);
            const next={...op,...patch,updatedAt:this.now()};
            if (patch.state && patch.state!==op.state) next.history=[...op.history,{state:patch.state,at:this.now()}];
            if (!await this.cas(IacReviewService.key(id),next,row.etag)) return false;
            Object.assign(op,next);
            if(patch.state)await this.observe(op);
            return true;
        };
        if (terminal.has(op.state)) {
            // No change set means there is nothing to clean up. Never assume an uncreated role just to record failure.
            if (!op.approval&&op.action!=='destroy'&&op.changeSetId) {
                try{await cloud.remove(op);await this.progress().append(op,[{id:'cleanup-complete',source:'worker',kind:'cleanup',phase:'cleanup',status:'COMPLETE',reason:'Unexecuted change set removed.'}]);}
                catch(e){await save({manualRecoveryRequired:true});await this.progress().append(op,[{id:'cleanup-failed',source:'worker',kind:'cleanup',phase:'cleanup',status:'DELETE_FAILED',reason:diagnosticError(e,op).message,error:e}]);}
            }
            await this.finish(op);return result(true);
        }
        if (op.state==='awaiting-review') {
            if (this.now()>op.expiresAt) await save({state:'expired',reason:'Review expired. Create a new review.'});
            return result();
        }
        if (this.now()-op.createdAt>5*3600000) {await this.fail(id,'The deployment exceeded its monitoring window. Inspect the resource and rollback diagnostics in this graph before retrying.');return result(true);}
        if (op.state==='planning') {
            // The privileged worker independently validates the stored input.
            const checked=prepareReview({id:op.graphId,nodes:[{id:op.nodeId,properties:{iac:{stack:op.input.stack,
                template:{text:op.input.text,format:op.input.format},parameters:op.input.parameters,capabilities:op.input.capabilities}}}]},op.nodeId,this.policy());
            if (!checked.validation.ok || checked.inputDigest!==op.inputDigest || checked.policyDigest!==op.policyDigest
                || checked.validation.resourceTypes.some(t=>!(isolationEnabled()?ISOLATED_TYPES:APPLY_TYPES).includes(t))) {
                await this.fail(id,'The stored template no longer passes deployment validation.');return result();
            }
            this.checkPrivateBuckets(checked);
            if(cloud.prepare){await this.progress().append(op,[{id:'guardrails-start',source:'worker',kind:'phase',phase:'guardrails',status:'IN_PROGRESS',reason:'Preparing platform-managed stack guardrails.'}]);if(!await cloud.prepare(op))return result();}
            await this.progress().append(op,[{id:'planning-changes',source:'worker',kind:'phase',phase:'planning',status:'IN_PROGRESS',reason:'Guardrails are ready. Preparing the exact CloudFormation change set.'}]);
            if(op.action==='destroy'){
                if(!cloud.resources||!cloud.destroy)throw new Error('Reviewed destroy is unavailable');
                const resources=await cloud.resources(op);
                const plan={changes:this.removalPlan(op,resources),destructive:true,changeSetRetained:false,stackExists:true};
                await save({state:'awaiting-review',plan,reviewDigest:hash({inputDigest:op.inputDigest,policyDigest:op.policyDigest,action:'destroy',plan}),expiresAt:this.now()+3600000});return result();
            }
            if (!op.changeSetId) {
                const stack=await cloud.stack(op.input.stack.name,op);
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
            const definitions=parseTemplate(op.input.text,op.input.format).doc?.Resources||{};
            const binding=await this.read(`iac/deployed/${op.graphId}/${op.nodeId}.json`);
            const previous=binding?.value.operationId && await this.read(IacReviewService.key(binding.value.operationId));
            const old=previous?parseTemplate(previous.value.input.text,previous.value.input.format).doc?.Resources||{}:{};
            const changes=described.changes.map((c:any)=>{
                const definition=c.action==='Remove'?old[c.logicalId]:definitions[c.logicalId];
                return {...c,access:accessChange(c.resourceType,old[c.logicalId],definitions[c.logicalId]),deletionPolicy:definition?(definition.DeletionPolicy||'Delete'):'Not recorded',updateReplacePolicy:definition?(definition.UpdateReplacePolicy||'Delete'):'Not recorded'};
            });
            const plan={changeSetId:op.changeSetId,changes,destructive:changes.some((c:any)=>c.action==='Remove'||c.action==='Replace'||(c.action==='Modify' && c.replacement && c.replacement!=='False')),changeSetRetained:true,stackExists:op.stackExists};
            await save({state:'awaiting-review',plan,reviewDigest:hash({inputDigest:op.inputDigest,policyDigest:op.policyDigest,plan}),expiresAt:this.now()+3600000});
            return result();
        }
        if (op.state==='apply-requested') {
            if (!op.approval || op.approval.reviewDigest!==op.reviewDigest || hash(isolationEnabled()?scopedPolicy(stackScope(op.graphId,op.nodeId,this.policy()),this.policy()):this.policy())!==op.policyDigest) {await this.fail(id,'The approval or deployment policy is no longer valid.');return result(true);}
            if(op.action==='destroy'){
                const stack=await cloud.stack(op.input.stack.name,op);
                // AWS may have accepted a previous DeleteStack before the durable state write failed.
                if(stack.exists && stack.status!=='DELETE_IN_PROGRESS' && stack.status!=='DELETE_COMPLETE') {
                    const listed=this.removalPlan(op,await cloud.resources!(op));
                    if(hash(listed)!==hash(op.plan.changes)){await this.fail(id,'The deployed resource list changed after destroy review.');return result(true);}
                    await cloud.destroy!(op);
                }
                await save({state:'applying',startedAt:this.now()});return result();
            }
            const described=await cloud.describe(op);
            if (described.executionStatus==='AVAILABLE') await cloud.execute(op);
            else if (!['EXECUTE_IN_PROGRESS','EXECUTE_COMPLETE'].includes(described.executionStatus)) {await this.fail(id,'This CloudFormation change set is no longer executable. Create a new review.');return result(true);}
            await save({state:'applying',startedAt:this.now()});return result();
        }
        if (op.state==='applying') {
            const stack=await cloud.stack(op.stackId || op.input.stack.name,op);
            await this.progress().append(op,[{id:'stack:'+stack.status,source:'worker',kind:'stack',phase:/ROLLBACK.*IN_PROGRESS/.test(stack.status)?'rolling-back':'deploying',status:stack.status||'NOT_CREATED',stackName:op.input.stack.name,reason:stack.reason}]);
            if(op.action==='destroy'&&(!stack.exists||stack.status==='DELETE_COMPLETE')){if(await save({state:'destroyed',outputs:[],resources:[]}))await this.finish(op);return result(true);}
            if (!stack.exists || stack.status==='REVIEW_IN_PROGRESS' || /IN_PROGRESS$/.test(stack.status)) return result();
            const state=['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack.status) ? 'succeeded'
                : /ROLLBACK_FAILED$/.test(stack.status) ? 'rollback-failed'
                : /ROLLBACK_COMPLETE$/.test(stack.status) ? 'rolled-back' : 'failed';
            const saved=await save({state,stackStatus:stack.status,reason:stack.reason,outputs:stack.outputs || [],
                resources:state==='succeeded'&&cloud.resources?await cloud.resources(op):[],
                effectiveInputDigest:state==='succeeded' ? op.inputDigest : undefined,manualRecoveryRequired:state==='rollback-failed'||(op.action==='destroy'&&state==='failed')});
            if(saved)await this.finish(op);return result(true);
        }
        await this.fail(id,'Unknown infrastructure operation state.');return result(true);
    }
}
