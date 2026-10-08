const {fixture,environment,policy,human,read,save}=require('../__testHelpers__/lifecycleCloud');
const {recoveryPlan,inspectionFingerprint,operationKey,indexKey,lockKey,digest}=require('../iac/lifecycleModel');
const {ObservationJournal}=require('../runtime/journal');
const {ApplicationService}=require('../application/service');
const {repairApprovedGuardrails}=require('../iac/guardrailRepair');
const {DelegationStore}=require('../policy/delegation');
const {deploymentProgressContract}=require('../discovery/deploymentProgress');
const Ajv=require('ajv').default;
let env;
beforeEach(()=>{env={...process.env};environment();});
afterEach(()=>{process.env=env;});

test('Chess regression: current permission checks distinguish old IAM failures, recover retained guardrails, then require a new approved deployment',async()=>{
 const f=await fixture('f1963a3b-7e9a-43b3-87ee-068d56431374','node-chess-storage-stack'),g=f.source.graphId,n=f.source.nodeId;
 const inspect=await f.reviews.lifecycle.inspect(g,n,human);
 expect(inspect).toMatchObject({application:{status:'NOT_CREATED'},guardrail:{status:'ROLLBACK_FAILED',ownership:'verified'},boundary:{exists:true},historicalFailure:{message:'Historical iam:GetRole failure'},canReview:false});
 expect(inspect.policyAnalysis.verifiedDeployment).toBe(false);expect(inspect.awsVerification.deploymentTested).toBe(false);
 expect(JSON.stringify(inspect)).not.toContain('never-return');
 const op=await f.plan();expect(op.state).toBe('recovery-ready');expect(op.recoveryPlan.actions.map(a=>a.kind)).toEqual(['delete-stack','import-retained','reconcile-guardrails','release-operation']);
 expect(op.recoveryPlan.actions[1].resources[0]).toMatchObject({logicalId:'RuntimeBoundary',physicalId:f.s.boundaryArn});
 expect(f.calls.filter(c=>['deleteStack','updateStack','createChangeSet','executeChangeSet'].includes(c.method))).toEqual([]);
 await f.approve(op);for(let i=0;i<20;i++)if((await f.reviews.lifecycle.step(op.operationId)).done)break;
 const recovered=await f.reviews.current(g,n,human,undefined,false);expect(recovered.state).toBe('recovered');expect(recovered.approval).toBeUndefined();expect(recovered.recoveryApproval.digest).toBe(op.recoveryPlan.digest);
 expect((await read(f.store,operationKey(f.source.operationId))).reason).toContain('Historical');
 expect(f.calls.filter(c=>c.method==='deleteStack')).toHaveLength(1);expect(f.clients.repair).toHaveBeenCalledTimes(1);
 const retry=await f.reviews.begin(g,n,human,false,'apply',recovered.operationId);expect(retry.retryOf).toBe(recovered.operationId);
 await f.reviews.step(retry.operationId);await f.reviews.step(retry.operationId);
 const review=await f.reviews.current(g,n,human,undefined,false);expect(review.state).toBe('awaiting-review');expect(f.deployCloud.execute).not.toHaveBeenCalled();
 await f.reviews.approve(g,n,human,{operationId:review.operationId,reviewDigest:review.reviewDigest});await f.reviews.step(review.operationId);await f.reviews.step(review.operationId);
 expect((await f.reviews.current(g,n,human,undefined,false)).state).toBe('succeeded');
 const app=new ApplicationService(f.store,{policy:()=>policy,invokeWithMetadata:async()=>{throw Object.assign(new Error('Application health invariant failed'),{requestId:'abcde000-0000-0000-0000-000000000000',bridgeRequestId:'bridge'});},publish:async(g,e)=>f.sent.push(e)});
 await expect(app.invoke({graphId:g,nodeId:'backend',stackNodeId:n,logicalFunctionId:'Backend',value:{action:'health'},principal:human,correlationId:'request-1',executionId:'execution-1'})).rejects.toThrow('health invariant');
 const observed=await new ObservationJournal(f.store).read(g,{filter:{operationId:review.operationId}});
 expect(observed.observations.some(e=>e.kind==='deployment.runtime-invocation'&&e.requestId==='abcde000-0000-0000-0000-000000000000'&&e.correlationId==='request-1'&&e.lifecycle.bridgeRequestId==='bridge')).toBe(true);
 const page=await f.reviews.events(g,n,human,{operationId:op.operationId,limit:100});
 const watched=await new ObservationJournal(f.store).read(g,{filter:{operationId:op.operationId}});
 expect(page.events.map(e=>e.id)).toEqual(watched.observations.map(e=>e.id));
 expect(watched.observations).toEqual(f.sent.filter(e=>e.operationId===op.operationId));
 expect((await f.reviews.operations(g,n,human)).operations.map(o=>o.operationId)).toEqual([review.operationId,op.operationId,f.source.operationId]);
 await expect(f.approve(op)).rejects.toMatchObject({code:'STALE_RECOVERY'});
});

test('a current platform permission denial produces a graph-native maintenance request, separately reviewed by a configured administrator',async()=>{
 const f=await fixture();f.permissions(false);
 const inspection=await f.reviews.lifecycle.inspect('g','stack',human);expect(inspection.blockers).toEqual(expect.arrayContaining([expect.objectContaining({kind:'platform-permission',action:'iam:GetRole'})]));
 const op=await f.plan();expect(op.state).toBe('recovery-blocked');await expect(f.approve(op)).rejects.toMatchObject({code:'STALE_RECOVERY'});
 const request=await f.reviews.lifecycle.maintenance('g','stack',human,{operationId:op.operationId});expect(request.state).toBe('requested');
 const body={operationId:op.operationId,maintenanceDigest:request.digest};
 await expect(f.reviews.lifecycle.maintenance('g','stack',human,body,'approve')).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});
 const admin={...human,sub:'admin'};expect((await f.reviews.lifecycle.maintenance('g','stack',admin,body,'approve')).state).toBe('approved-awaiting-platform-release');
 expect((await f.reviews.lifecycle.maintenance('g','stack',admin,body,'verify')).state).toBe('verification-blocked');
 f.permissions(true);expect((await f.reviews.lifecycle.maintenance('g','stack',admin,body,'verify')).state).toBe('verified');
 expect(f.calls.some(c=>['deleteStack','createStack','updateStack'].includes(c.method))).toBe(false);
});

test('duplicate plans/approvals and worker deliveries serialize; changed state and forged digests cannot execute',async()=>{
 const f=await fixture(),plans=await Promise.all([f.plan(),f.plan()]);expect(plans[0].operationId).toBe(plans[1].operationId);
 const op=plans[0];await expect(f.reviews.lifecycle.approve('g','stack',human,{operationId:op.operationId,recoveryDigest:'forged'})).rejects.toMatchObject({code:'STALE_RECOVERY'});
 f.stacks.get(f.s.guardrailStack).StackStatus='DELETE_FAILED';await expect(f.approve(op)).rejects.toMatchObject({code:'STALE_RECOVERY'});f.stacks.get(f.s.guardrailStack).StackStatus='ROLLBACK_FAILED';
 await f.approve(op);await f.approve(op);expect(f.start).toHaveBeenCalledTimes(1);
 await Promise.all([f.reviews.lifecycle.step(op.operationId),f.reviews.lifecycle.step(op.operationId)]);expect(f.calls.filter(c=>c.method==='deleteStack')).toHaveLength(1);
 await expect(f.reviews.begin('g','stack',human)).rejects.toMatchObject({code:'CONFLICT'});
 await expect(f.plan({idempotencyKey:'concurrent'})).rejects.toMatchObject({code:'OPERATION_ACTIVE'});
});

test('ownership mismatch, foreign graph/node, and a delegated agent without this graph cannot inspect or change resources',async()=>{
 const f=await fixture();await expect(f.reviews.lifecycle.inspect('other','stack',human,{operationId:f.source.operationId})).rejects.toMatchObject({code:'NOT_FOUND'});
 const agent={sub:'agent',kind:'agent',scopes:[]};await new DelegationStore(f.store).put({agentSub:agent.sub,graphId:'other',delegatedBy:'owner',scopes:['graph:read','iac:read-status','iac:propose'],expiresAt:null,createdAt:new Date().toISOString()});
 await expect(f.reviews.lifecycle.plan('g','stack',agent,{operationId:f.source.operationId,idempotencyKey:'one'})).rejects.toMatchObject({code:'ADMISSION_DENIED'});
 f.stacks.get(f.s.guardrailStack).Tags[0].Value='other';const op=await f.plan();expect(op.recoveryPlan.prerequisites.some(p=>p.code==='OWNERSHIP_UNVERIFIED')).toBe(true);expect(op.state).toBe('recovery-blocked');
 expect(f.calls.some(c=>['deleteStack','updateStack'].includes(c.method))).toBe(false);
});

test('state-specific planning preserves data, resolves owned retained names, and never skips rollback resources',async()=>{
 const f=await fixture(),base=await f.aws.inspect(f.source);
 for(const [status,kind]of [['UPDATE_ROLLBACK_FAILED','continue-update-rollback'],['UPDATE_FAILED','rollback-stack'],['DELETE_FAILED','delete-stack'],['ROLLBACK_FAILED','delete-stack']]){
  const inspection={...base,guardrail:{...base.guardrail,status,resources:[]},blockers:[]};
  expect(recoveryPlan(f.source,inspection).actions[0].kind).toBe(kind);
 }
 const definition=JSON.parse(f.input.text).Resources.Records;
 const resource={logicalId:'Records',physicalId:f.s.namespace+'records',resourceType:'AWS::DynamoDB::Table',status:'CREATE_COMPLETE',deletionPolicy:'Delete',ownershipVerified:true,definitionDigest:digest(definition)};
 const inspected={...base,application:{name:f.s.namespace+'stack',status:'ROLLBACK_FAILED',ownership:'verified',stackId:'owned',resources:[resource]},blockers:[]};
 expect(recoveryPlan(f.source,inspected).prerequisites.some(p=>p.code==='DATA_PRESERVATION_REQUIRED')).toBe(true);
 expect(recoveryPlan(f.source,inspected,{allowDataLoss:true}).preservesData).toBe(false);
 inspected.application.status='DELETE_FAILED';const plan=recoveryPlan(f.source,inspected);expect(plan.prerequisites).toEqual([]);
 expect(plan.actions.find(a=>a.target==='application'&&a.kind==='delete-stack').retainIds).toEqual(['Records']);
 expect(plan.actions.some(a=>a.target==='application'&&a.kind==='import-retained')).toBe(true);
 expect(inspectionFingerprint({...base,checkedAt:'later'})).toBe(inspectionFingerprint(base));
});

test('worker rechecks freshness, lease/fence and immutable plan content immediately before executing',async()=>{
 const f=await fixture(),op=await f.plan();await f.approve(op);
 const row=await read(f.store,operationKey(op.operationId));row.recoveryPlan.actions[0].stackId='foreign';await save(f.store,operationKey(op.operationId),row);
 await f.reviews.lifecycle.step(op.operationId);expect((await read(f.store,operationKey(op.operationId))).state).toBe('failed');expect(f.calls.some(c=>c.method==='deleteStack')).toBe(false);
});

test('private guardrail repair refuses unauthorised, stale, foreign and arbitrary-policy requests',async()=>{
 const f=await fixture(),op=await f.plan(),iam=jest.fn();
 await expect(repairApprovedGuardrails(f.store,{operationId:op.operationId,leaseId:'invented'},iam,policy)).rejects.toMatchObject({code:'RECOVERY_APPROVAL_REQUIRED'});
 await f.approve(op);const row=await read(f.store,operationKey(op.operationId));row.state='recovering';row.recoveryIndex=2;row.recoveryLease={id:'owned',until:Date.now()+90000};await save(f.store,operationKey(op.operationId),row);
 f.installRoles();f.stacks.get(f.s.guardrailStack).StackStatus='UPDATE_COMPLETE';const calls=[];const iamRepair=async(m,a)=>{calls.push([m,a]);if(['putRolePolicy','updateAssumeRolePolicy'].includes(m))return {};return f.clients.iam(m,a);};
 await expect(repairApprovedGuardrails(f.store,{operationId:op.operationId,leaseId:'owned',PolicyDocument:{Statement:'attacker input'}},iamRepair,policy)).rejects.toMatchObject({code:'SCHEMA_INVALID'});
 const result=await repairApprovedGuardrails(f.store,{operationId:op.operationId,leaseId:'owned'},iamRepair,policy,f.clients.cloud);
 expect(result.restored).toBe(true);expect(calls.filter(([m])=>m==='putRolePolicy')).toHaveLength(2);
 expect(JSON.stringify(calls)).not.toContain('attacker');expect(calls.filter(([m])=>m==='putRolePolicy').every(([,a])=>a.RoleName.startsWith(f.s.namespace))).toBe(true);
 await save(f.store,indexKey('g','stack'),{operationId:f.source.operationId});await expect(repairApprovedGuardrails(f.store,{operationId:op.operationId,leaseId:'owned'},iamRepair,policy)).rejects.toMatchObject({code:'RECOVERY_APPROVAL_REQUIRED'});
});

test.each(['ROLLBACK_FAILED','DELETE_FAILED'])('application %s preserves retained data, imports the surviving name and never creates a new template without approval',async status=>{
 const f=await fixture();await f.recover();
 const recovery=await f.reviews.current('g','stack',human,undefined,false);
 const template=JSON.parse(f.input.text),table=template.Resources.Records;
 f.stack(f.s.namespace+'stack',status,{Resources:{Records:table}},[{LogicalResourceId:'Records',PhysicalResourceId:f.s.namespace+'records',ResourceType:table.Type,ResourceStatus:'CREATE_COMPLETE'}]);
 const op=await f.reviews.lifecycle.plan('g','stack',human,{operationId:recovery.operationId,idempotencyKey:'recover-data'});
 expect(op.recoveryPlan.prerequisites).toEqual([]);expect(op.recoveryPlan.actions.map(a=>a.kind)).toEqual(['delete-stack','import-retained','release-operation']);
 await f.approve(op);for(let i=0;i<15;i++)if((await f.reviews.lifecycle.step(op.operationId)).done)break;
 expect((await f.reviews.current('g','stack',human,undefined,false)).state).toBe('recovered');
 const deletion=f.calls.filter(c=>c.method==='deleteStack'&&c.args.StackName.includes(f.s.namespace+'stack/'))[0];
 expect(deletion.args.RetainResources).toEqual(status==='DELETE_FAILED'?['Records']:undefined);
 const imported=f.calls.filter(c=>c.method==='createChangeSet'&&c.args.StackName===f.s.namespace+'stack')[0];
 expect(imported.args.ChangeSetType).toBe('IMPORT');expect(imported.args.ResourcesToImport).toHaveLength(1);
 expect(Object.keys(JSON.parse(imported.args.TemplateBody).Resources)).toEqual(['Records']);
 expect(f.deployCloud.execute).not.toHaveBeenCalled();
});

test.each([['UPDATE_ROLLBACK_FAILED','continueUpdateRollback'],['UPDATE_FAILED','rollbackStack']])('application %s selects %s without skipping resources',async(status,method)=>{
 const f=await fixture(),recovered=await f.recover(),template=JSON.parse(f.input.text);
 f.stack(f.s.namespace+'stack',status,template,[{LogicalResourceId:'Records',PhysicalResourceId:f.s.namespace+'records',ResourceType:'AWS::DynamoDB::Table',ResourceStatus:'UPDATE_FAILED'}]);
 const op=await f.reviews.lifecycle.plan('g','stack',human,{operationId:recovered.operationId,idempotencyKey:'rollback'});expect(op.state).toBe('recovery-ready');
 await f.approve(op);for(let i=0;i<10;i++)if((await f.reviews.lifecycle.step(op.operationId)).done)break;
 expect((await f.reviews.current('g','stack',human,undefined,false)).state).toBe('recovered');
 const calls=f.calls.filter(c=>c.method===method);expect(calls).toHaveLength(1);expect(calls[0].args.ResourcesToSkip).toBeUndefined();
});

test('inventory changes between recovery actions fail closed and leave original evidence available for a fresh plan',async()=>{
 const f=await fixture(),template=JSON.parse(f.input.text);
 f.stack(f.s.namespace+'stack','ROLLBACK_FAILED',template,[{LogicalResourceId:'Records',PhysicalResourceId:f.s.namespace+'records',ResourceType:'AWS::DynamoDB::Table',ResourceStatus:'CREATE_COMPLETE'}]);
 const op=await f.plan();await f.approve(op);
 for(let i=0;i<15;i++){await f.reviews.lifecycle.step(op.operationId);const stored=await read(f.store,operationKey(op.operationId));if(stored.recoveryPlan.actions[stored.recoveryIndex]?.target==='application')break;}
 f.stacks.get(f.s.namespace+'stack').template.Resources.Records.DeletionPolicy='Delete';
 await f.reviews.lifecycle.step(op.operationId);const failure=await f.reviews.current('g','stack',human,undefined,false);
 expect(failure.state).toBe('failed');expect(failure.originalError.code).toBe('STALE_RECOVERY');
 expect(f.calls.filter(c=>c.method==='deleteStack'&&c.args.StackName.includes(f.s.namespace+'stack/'))).toHaveLength(0);
 expect((await read(f.store,operationKey(f.source.operationId))).originalError.message).toBe('Historical iam:GetRole failure');
 const fresh=await f.reviews.lifecycle.plan('g','stack',human,{operationId:op.operationId,idempotencyKey:'correct'});
 expect(fresh.state).toBe('recovery-blocked');expect(fresh.recoveryPlan.prerequisites.some(p=>p.code==='DATA_PRESERVATION_REQUIRED')).toBe(true);
});

test('expired, superseded and running-source plans cannot execute, while unapproved plans can be refreshed',async()=>{
 const f=await fixture();f.workflow('RUNNING');await expect(f.plan()).rejects.toMatchObject({code:'OPERATION_ACTIVE'});f.workflow('FAILED');
 const op=await f.plan(),record=await read(f.store,operationKey(op.operationId));record.expiresAt=Date.now()-1;await save(f.store,operationKey(op.operationId),record);
 await expect(f.approve(op)).rejects.toMatchObject({code:'STALE_RECOVERY'});
 const replacement=await f.reviews.lifecycle.plan('g','stack',human,{operationId:op.operationId,idempotencyKey:'new-review'});expect(replacement.state).toBe('recovery-ready');
 await expect(f.approve(op)).rejects.toMatchObject({code:'STALE_RECOVERY'});
 await expect(f.reviews.lifecycle.plan('g','stack',human,{operationId:f.source.operationId,idempotencyKey:'old-source'})).rejects.toMatchObject({code:'OPERATION_ACTIVE'});
 expect(f.calls.some(c=>c.method==='deleteStack')).toBe(false);
});

test('deployment and recovery leases prevent overlapping AWS work even if orchestration reports it stopped',async()=>{
 const f=await fixture(),recovered=await f.recover(),op=await f.reviews.begin('g','stack',human,false,'apply',recovered.operationId);
 let started,finish;const active=new Promise(r=>started=r);f.deployCloud.prepare.mockImplementationOnce(async()=>{started();return await new Promise(r=>finish=r);});
 const running=f.reviews.step(op.operationId);await active;
 await expect(f.reviews.lifecycle.plan('g','stack',human,{operationId:op.operationId,idempotencyKey:'while-worker-running'})).rejects.toMatchObject({code:'OPERATION_ACTIVE'});
 await f.reviews.step(op.operationId);expect(f.deployCloud.prepare).toHaveBeenCalledTimes(1);
 finish(true);await running;
 // A terminated worker's still-valid lease remains a conflict after reconnect.
 await save(f.store,lockKey(f.input.stack),{operationId:op.operationId,lease:'prior-worker',leaseUntil:Date.now()+60000});
 await expect(f.reviews.lifecycle.plan('g','stack',human,{operationId:op.operationId,idempotencyKey:'reconnect'})).rejects.toMatchObject({code:'OPERATION_ACTIVE'});
});

test('a lost plan-publication response resumes the same reserved operation and approval dispatch is recoverable',async()=>{
 const f=await fixture(),cas=f.store.compareAndSet.bind(f.store);let lost=true;
 f.store.compareAndSet=(key,value,etag,cb)=>{if(lost&&key===indexKey('g','stack')){lost=false;return cb(new Error('Storage unavailable'));}return cas(key,value,etag,cb);};
 await expect(f.plan()).rejects.toThrow('Storage unavailable');
 const reserved=(await read(f.store,lockKey(f.input.stack))).operationId,op=await f.plan();expect(op.operationId).toBe(reserved);
 expect((await read(f.store,indexKey('g','stack'))).operationId).toBe(reserved);
 expect((await f.plan()).operationId).toBe(reserved);
 // Simulate a server stop after recording exact human approval, before dispatch.
 const row=await read(f.store,operationKey(reserved));row.state='recovery-requested';row.recoveryApproval={sub:human.sub,at:Date.now(),digest:op.recoveryPlan.digest};await save(f.store,operationKey(reserved),row);
 await f.approve(op);await f.approve(op);expect(f.start).toHaveBeenCalledTimes(1);
 expect((await read(f.store,operationKey(reserved))).recoveryDispatchedAt).toBeTruthy();expect(f.calls.some(c=>c.method==='deleteStack')).toBe(false);
});

test('an uncertain AWS response preserves its error and holds the worker lease before graph-native recovery can resume',async()=>{
 const f=await fixture(),op=await f.plan();await f.approve(op);
 const implementation=f.clients.cloud.getMockImplementation();
 f.clients.cloud.mockImplementation(async(m,a)=>{const result=await implementation(m,a);if(m==='deleteStack')throw Object.assign(new Error('Response lost after AWS accepted deletion'),{code:'NetworkingError'});return result;});
 await f.reviews.lifecycle.step(op.operationId);
 const failed=await f.reviews.current('g','stack',human,undefined,false);expect(failed.state).toBe('failed');expect(failed.originalError.code).toBe('NetworkingError');
 expect(failed.nextActions.actions.find(a=>a.tool==='iac.recovery.plan').allowed).toBe(false);
 await expect(f.reviews.lifecycle.plan('g','stack',human,{operationId:op.operationId,idempotencyKey:'after-uncertain'})).rejects.toMatchObject({code:'OPERATION_ACTIVE'});
 const record=await read(f.store,operationKey(op.operationId));record.recoveryLease.until=Date.now()-1;await save(f.store,operationKey(op.operationId),record);
 const fence=await read(f.store,lockKey(f.input.stack));fence.leaseUntil=Date.now()-1;await save(f.store,lockKey(f.input.stack),fence);
 const resumed=await f.reviews.lifecycle.plan('g','stack',human,{operationId:op.operationId,idempotencyKey:'after-uncertain'});
 expect(resumed.state).toBe('recovery-ready');expect(resumed.recoveryPlan.actions[0].kind).toBe('import-retained');expect(f.calls.filter(c=>c.method==='deleteStack')).toHaveLength(1);
});

test('large redacted lifecycle reports fit socket frames and reassemble identically after paged MCP reconnect',async()=>{
 const f=await fixture(),{DeploymentProgress}=require('../iac/progress'),{createHash}=require('crypto');
 const progress=new DeploymentProgress(f.store,async(g,e)=>f.sent.push(e));
 const detail={resources:Array.from({length:100},(_,i)=>({logicalId:'Record'+i,message:'Retained data 💾 '.repeat(60)})),secret:'private-secret'};
 await progress.append(f.source,[{id:'large-report',source:'lifecycle',phase:'recovering',kind:'inspection',lifecycle:detail}]);
 let cursor,events=[];do{const page=await progress.page(f.source,{cursor,limit:3});events.push(...page.events);cursor=page.nextCursor;if(!page.hasMore)break;}while(true);
 expect(events.length).toBeGreaterThan(3);expect(events.every(e=>Buffer.byteLength(JSON.stringify(e))<24000)).toBe(true);
 const validate=new Ajv({strict:false,validateFormats:false}).compile(deploymentProgressContract.schema);expect(events.every(e=>validate(e))).toBe(true);
 const fragments=events.map(e=>e.lifecycle.fragment).sort((a,b)=>a.index-b.index),joined=Buffer.concat(fragments.map(p=>Buffer.from(p.data,'base64')));
 expect(createHash('sha256').update(joined).digest('hex')).toBe(fragments[0].reportId);
 expect(JSON.parse(joined.toString())).toEqual({...detail,secret:'[redacted]'});
 await progress.append(f.source,[{id:'large-report',source:'lifecycle',phase:'recovering',kind:'inspection',lifecycle:detail}]);
 const watch=new ObservationJournal(f.store);cursor=undefined;let observed=[];do{const page=await watch.read('g',{cursor,filter:{operationId:f.source.operationId},limit:3});observed.push(...page.observations);cursor=page.nextCursor;if(!page.hasMore)break;}while(true);
 expect(observed.map(({arrival,...e})=>e)).toEqual(events);expect(f.sent).toEqual(observed);
});
