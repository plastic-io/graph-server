const {fixture,environment,human,read,save}=require('../__testHelpers__/lifecycleCloud');
const {operationKey,indexKey,lockKey}=require('../iac/lifecycleModel');
const {preservationTemplateProblems,preservationChangeProblems,assertGuardrailPreservation}=require('../iac/preservation');
const {ObservationJournal}=require('../runtime/journal');
const {DelegationStore}=require('../policy/delegation');
let env;
beforeEach(()=>{env={...process.env};environment();});
afterEach(()=>{process.env=env;});
const cancel=(f,op,p=human)=>f.reviews.cancel(f.source.graphId,f.source.nodeId,p,{operationId:op.operationId,reason:'Preserve existing stacks; discard unwanted review.'});
const mutation=c=>/^(delete|create|update|execute|put|purge|rollback|continue)/i.test(c.method);
function retainedTemplate(f){
 // A disposable storage-only fixture; no application code or scheduled expiry.
 const source=JSON.parse(f.graph.nodes[0].properties.iac.template.text),template={Resources:{Records:source.Resources.Records}};
 template.Resources.Records.DeletionPolicy='Retain';template.Resources.Records.UpdateReplacePolicy='Retain';
 f.graph.nodes[0].properties.iac.template.text=JSON.stringify(template);
 f.deployCloud.describe.mockResolvedValue({status:'CREATE_COMPLETE',executionStatus:'AVAILABLE',changes:[{action:'Add',logicalId:'Records',resourceType:'AWS::DynamoDB::Table'}]});
 return template;
}
async function healthyFixture(){
 const f=await fixture('preservation-fixture','stack');
 f.installRoles();f.stacks.get(f.s.guardrailStack).StackStatus='CREATE_COMPLETE';
 await save(f.store,operationKey(f.source.operationId),{...f.source,manualRecoveryRequired:false});
 return f;
}
async function deployment(preservation){
 const f=await healthyFixture();if(preservation)retainedTemplate(f);
 const started=await f.reviews.begin(f.source.graphId,f.source.nodeId,human,false,'apply',undefined,preservation);
 await f.reviews.step(started.operationId);await f.reviews.step(started.operationId);
 const op=await f.reviews.current(f.source.graphId,f.source.nodeId,human,undefined,false);
 expect(op.state).toBe('awaiting-review');return {f,op};
}
function pauseCas(f,state){
 const original=f.store.compareAndSet.bind(f.store);let resume,ready;
 const paused=new Promise(resolve=>{ready=resolve;});
 f.store.compareAndSet=(key,value,etag,cb)=>{
  if(value.state===state&&!resume){resume=()=>original(key,value,etag,cb);ready();}
  else original(key,value,etag,cb);
 };
 return {paused,resume:()=>resume()};
}

test('cancel an unwanted recovery without any AWS call; fresh review reaches current state and preserves historical evidence',async()=>{
 const f=await fixture('preservation-fixture','stack'),op=await f.plan();
 expect(op.state).toBe('recovery-ready');expect(op.recoveryPlan.actions.some(a=>a.kind==='delete-stack')).toBe(true);
 const calls=f.calls.length,stacks=JSON.stringify([...f.stacks]),roles=JSON.stringify([...f.roles]),policies=JSON.stringify([...f.policies]);
 const result=await cancel(f,op);
 expect(result).toMatchObject({state:'cancelled',reviewDigest:null,recoveryPlan:{digest:null},cancellation:{awsMutations:false,invalidatedDigests:{recovery:op.recoveryPlan.digest}}});
 expect(await read(f.store,lockKey(f.input.stack))).toEqual({operationId:null});
 expect(f.calls).toHaveLength(calls);expect(f.start).not.toHaveBeenCalled();
 await expect(f.reviews.begin(f.source.graphId,f.source.nodeId,human,false,'apply',op.operationId,'strict')).rejects.toMatchObject({code:'PRESERVATION_BLOCKED',problems:expect.arrayContaining([expect.objectContaining({code:'PRESERVATION_IN_PLACE_UNSUPPORTED',component:'guardrail',stackStatus:'ROLLBACK_FAILED',limitation:'aws-stack-state'})])});
 expect(f.calls.some(mutation)).toBe(false);
 expect(JSON.stringify([...f.stacks])).toBe(stacks);expect(JSON.stringify([...f.roles])).toBe(roles);expect(JSON.stringify([...f.policies])).toBe(policies);
 expect((await read(f.store,operationKey(f.source.operationId))).originalError).toEqual(f.source.originalError);
 await expect(f.approve(op)).rejects.toMatchObject({code:'STALE_RECOVERY'});
 expect((await f.reviews.lifecycle.step(op.operationId)).done).toBe(true);
 expect(f.calls.some(mutation)).toBe(false);
});

test('cancelled status, history, bus and cursor replay expose the same durable event exactly once',async()=>{
 const f=await fixture('preservation-fixture','stack'),op=await f.plan();
 const g=f.source.graphId,n=f.source.nodeId,before=await f.reviews.events(g,n,human,{operationId:op.operationId,limit:100});
 await cancel(f,op);await cancel(f,op);await f.reviews.current(g,n,human,undefined,false);
 const events=(await f.reviews.events(g,n,human,{operationId:op.operationId,cursor:before.nextCursor})).events;
 expect(events.filter(e=>e.kind==='deployment.review.cancelled')).toHaveLength(1);
 const event=events.find(e=>e.kind==='deployment.review.cancelled');
 expect(event).toMatchObject({graphId:g,nodeId:n,operationId:op.operationId,reviewDigest:null,state:'cancelled',lifecycle:{approvalValid:false,lockReleased:true,cancellation:{awsMutations:false}}});
 const watched=await new ObservationJournal(f.store).read(g,{from:'beginning',filter:{operationId:op.operationId},limit:100});
 expect(watched.observations.find(e=>e.id===event.id)).toEqual({...event,arrival:expect.any(Number)});
 expect(f.sent.filter(e=>e.id===event.id)).toHaveLength(1);
 expect((await f.reviews.operations(g,n,human)).operations[0]).toMatchObject({state:'cancelled',cancellation:{awsMutations:false}});
});

test('retry heals an interrupted owner-only fence cleanup and cannot release a newer operation',async()=>{
 const f=await fixture('preservation-fixture','stack'),op=await f.plan(),key=lockKey(f.input.stack),original=f.store.compareAndSet.bind(f.store);
 let broken=true;f.store.compareAndSet=(k,v,e,cb)=>k===key&&v.operationId===null&&broken?cb(new Error('temporary storage outage')):original(k,v,e,cb);
 await expect(cancel(f,op)).rejects.toThrow('temporary storage outage');
 expect((await read(f.store,operationKey(op.operationId))).state).toBe('cancelled');
 await expect(f.approve(op)).rejects.toMatchObject({code:'STALE_RECOVERY'});
 broken=false;await cancel(f,op);expect(await read(f.store,key)).toEqual({operationId:null});
 await save(f.store,key,{operationId:f.source.operationId});await save(f.store,indexKey(f.source.graphId,f.source.nodeId),{operationId:f.source.operationId});
 await cancel(f,op);expect(await read(f.store,key)).toEqual({operationId:f.source.operationId});
 expect(f.calls.some(mutation)).toBe(false);
});

test.each(['recovery-ready','recovery-blocked','expired','stale'])('unapproved %s can release its expired lock',async state=>{
 const f=await fixture('preservation-fixture','stack'),op=await f.plan(),row=await read(f.store,operationKey(op.operationId));
 await save(f.store,operationKey(op.operationId),{...row,state,expiresAt:Date.now()-1000});
 expect((await cancel(f,op)).state).toBe('cancelled');expect(await read(f.store,lockKey(f.input.stack))).toEqual({operationId:null});
 expect(f.calls.some(mutation)).toBe(false);
});

test.each(['planning','apply-requested','applying','recovery-requested','recovering'])('pending-review cancellation cannot stop %s',async state=>{
 const f=await fixture('preservation-fixture','stack'),op=await f.plan(),row=await read(f.store,operationKey(op.operationId));
 await save(f.store,operationKey(op.operationId),{...row,state});
 await expect(cancel(f,op)).rejects.toMatchObject({code:'REVIEW_NOT_CANCELLABLE'});
 expect((await read(f.store,lockKey(f.input.stack))).operationId).toBe(op.operationId);
 expect(f.calls.some(mutation)).toBe(false);
});

test('cancellation requires proposal authority for this graph, exact node and operation',async()=>{
 const f=await fixture('preservation-fixture','stack'),op=await f.plan(),agent={sub:'agent',kind:'agent',tenant:human.tenant,scopes:[]};
 await new DelegationStore(f.store).put({agentSub:agent.sub,graphId:f.source.graphId,delegatedBy:human.sub,scopes:['graph:read','iac:propose'],expiresAt:null});
 await expect(f.reviews.cancel('other','stack',agent,{operationId:op.operationId})).rejects.toMatchObject({code:'ADMISSION_DENIED'});
 await expect(f.reviews.cancel(f.source.graphId,'other',agent,{operationId:op.operationId})).rejects.toMatchObject({code:'NOT_FOUND'});
 await expect(f.reviews.cancel(f.source.graphId,'stack',human,{operationId:'invented'})).rejects.toMatchObject({code:'SCHEMA_INVALID'});
 await expect(f.reviews.cancel(f.source.graphId,'stack',undefined,{operationId:op.operationId})).rejects.toMatchObject({code:'ADMISSION_DENIED'});
 // An iac:propose delegation can cancel; iac:approve is deliberately unnecessary.
 const other=await fixture('another-fixture','stack'),next=await other.plan();
 await new DelegationStore(other.store).put({agentSub:agent.sub,graphId:other.source.graphId,delegatedBy:human.sub,scopes:['graph:read','iac:propose'],expiresAt:null});
 expect((await cancel(other,next,agent)).state).toBe('cancelled');
});

test.each(['deployment','recovery'])('%s approval and cancellation race: the winning CAS determines the only valid outcome',async type=>{
 for(const winner of ['cancel','approve']){
  const {f,op}=type==='deployment'?await deployment():(await(async()=>{const f=await fixture('preservation-fixture','stack');return {f,op:await f.plan()};})());
  const approve=()=>type==='deployment'?f.reviews.approve(f.source.graphId,f.source.nodeId,human,{operationId:op.operationId,reviewDigest:op.reviewDigest}):f.approve(op);
  const gate=pauseCas(f,winner==='cancel'?(type==='deployment'?'apply-requested':'recovery-requested'):'cancelled');
  const losing=(winner==='cancel'?approve():cancel(f,op)).then(value=>({value}),error=>({error}));
  await gate.paused;
  await (winner==='cancel'?cancel(f,op):approve());gate.resume();
  const outcome=await losing;expect(outcome.error).toBeDefined();
  const row=await read(f.store,operationKey(op.operationId));
  expect(row.state).toBe(winner==='cancel'?'cancelled':type==='deployment'?'apply-requested':'recovery-requested');
  if(winner==='cancel'){
   const calls=f.calls.length;await (type==='deployment'?f.reviews.step(op.operationId):f.reviews.lifecycle.step(op.operationId));
   expect(f.calls).toHaveLength(calls);expect(f.deployCloud.execute).not.toHaveBeenCalled();
  }else expect((await read(f.store,lockKey(f.input.stack))).operationId).toBe(op.operationId);
 }
});

test('strict recovery of ROLLBACK_FAILED returns a precise limitation with no destructive action to approve',async()=>{
 const f=await fixture('preservation-fixture','stack'),op=await f.plan({preservation:'strict'});
 expect(op).toMatchObject({state:'recovery-blocked',preservation:'strict',recoveryPlan:{preservation:'strict'}});
 expect(op.recoveryPlan.prerequisites).toEqual(expect.arrayContaining([expect.objectContaining({code:'PRESERVATION_IN_PLACE_UNSUPPORTED',stackStatus:'ROLLBACK_FAILED'})]));
 expect(op.recoveryPlan.actions.every(a=>a.kind==='release-operation')).toBe(true);
 await expect(f.approve(op)).rejects.toMatchObject({code:'STALE_RECOVERY'});
 expect(f.calls.some(mutation)).toBe(false);expect(f.start).not.toHaveBeenCalled();
 await cancel(f,op);
 // Omitting the constraint cannot silently downgrade it on the next review.
 await expect(f.reviews.begin(f.source.graphId,f.source.nodeId,human)).rejects.toMatchObject({code:'PRESERVATION_BLOCKED'});
 await expect(f.reviews.lifecycle.plan(f.source.graphId,f.source.nodeId,human,{operationId:op.operationId,idempotencyKey:'unsafe',allowDataLoss:true})).rejects.toMatchObject({code:'SCHEMA_INVALID'});
});

test.each(['Remove','Replace','Import','Modify-True','Modify-Conditional','Modify-unknown'])('strict change set rejects %s before approval and execution',async action=>{
 const f=await healthyFixture();retainedTemplate(f);
 const [kind,replacement]=action.split('-');f.deployCloud.describe.mockResolvedValue({status:'CREATE_COMPLETE',executionStatus:'AVAILABLE',changes:[{logicalId:'Records',resourceType:'AWS::DynamoDB::Table',action:kind,replacement:replacement==='unknown'?undefined:replacement}]});
 const started=await f.reviews.begin(f.source.graphId,f.source.nodeId,human,false,'apply',undefined,'strict');
 await f.reviews.step(started.operationId);await f.reviews.step(started.operationId);
 const current=await f.reviews.current(f.source.graphId,f.source.nodeId,human,undefined,false);
 expect(current).toMatchObject({state:'failed',originalError:{code:'PRESERVATION_BLOCKED'},preservationBlockers:[{code:'PRESERVATION_RESOURCE_CHANGE'}]});
 expect(current.reviewDigest).toBeUndefined();expect(f.deployCloud.execute).not.toHaveBeenCalled();
 expect(f.sent.some(e=>e.lifecycle?.preservationBlockers?.[0]?.code==='PRESERVATION_RESOURCE_CHANGE')).toBe(true);
});

test('strict additive deployment requires a fresh exact approval and binds preservation into the digest',async()=>{
 const {f,op}=await deployment('strict');
 expect(op.preservation).toBe('strict');expect(f.deployCloud.execute).not.toHaveBeenCalled();
 const key=operationKey(op.operationId),row=await read(f.store,key);
 await save(f.store,key,{...row,preservation:undefined});
 await expect(f.reviews.approve(f.source.graphId,f.source.nodeId,human,{operationId:op.operationId,reviewDigest:op.reviewDigest})).rejects.toMatchObject({code:'STALE_REVIEW'});
 await save(f.store,key,row);
 await f.reviews.approve(f.source.graphId,f.source.nodeId,human,{operationId:op.operationId,reviewDigest:op.reviewDigest});
 await f.reviews.step(op.operationId);await f.reviews.step(op.operationId);
 expect((await f.reviews.current(f.source.graphId,f.source.nodeId,human,undefined,false)).state).toBe('succeeded');
 expect(f.deployCloud.execute).toHaveBeenCalledTimes(1);
 await expect(f.reviews.begin(f.source.graphId,f.source.nodeId,human,false,'destroy')).rejects.toMatchObject({code:'PRESERVATION_BLOCKED'});
});

test.each([
 ['AWS::S3::Bucket',{LifecycleConfiguration:{Rules:[{Status:'Enabled',ExpirationInDays:1}]}}],
 ['AWS::DynamoDB::Table',{TimeToLiveSpecification:{Enabled:true,AttributeName:'expires'}}],
 ['AWS::Logs::LogGroup',{RetentionInDays:1}],
 ['AWS::SQS::Queue',{MessageRetentionPeriod:60}],
])('strict retention refuses data removal in %s',async(Type,Properties)=>{
 const text=JSON.stringify({Resources:{Data:{Type,Properties,DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain'}}});
 expect(preservationTemplateProblems({text,format:'json'})).toEqual(expect.arrayContaining([expect.objectContaining({code:'PRESERVATION_DATA_REMOVAL'})]));
});

test('privileged recovery refuses destructive actions even with a forged strict operation payload',async()=>{
 const f=await fixture('preservation-fixture','stack'),op=await f.plan();
 const stored=await read(f.store,operationKey(op.operationId));stored.preservation='strict';
 for(const kind of ['delete-stack','rollback-stack','continue-update-rollback','import-retained'])await expect(f.aws.advance(stored,{...stored.recoveryPlan.actions[0],kind},0)).rejects.toMatchObject({code:'PRESERVATION_BLOCKED'});
 expect(f.calls.some(mutation)).toBe(false);
});

test('strict guardrail reconciliation permits fixed in-place role policies but blocks replacement, removal and boundary-version deletion',async()=>{
 const f=await healthyFixture(),before=JSON.parse(JSON.stringify(f.approved));
 before.Resources.WorkerRole.Properties.Policies[0].PolicyDocument.Statement=[];
 expect(()=>assertGuardrailPreservation(before,f.approved)).not.toThrow();
 for(const edit of [d=>delete d.Resources.WorkerRole,d=>d.Resources.WorkerRole.Properties.RoleName='other',d=>d.Resources.RuntimeBoundary.Properties.PolicyDocument.Statement=[]]){
  const after=JSON.parse(JSON.stringify(f.approved));edit(after);expect(()=>assertGuardrailPreservation(f.approved,after)).toThrow();
 }
 expect(preservationChangeProblems([{action:'Modify',replacement:'False',logicalId:'Safe'}])).toEqual([]);
});
