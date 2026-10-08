const {fixture,environment,policy,human,read,save}=require('../__testHelpers__/lifecycleCloud');
const {ApplicationDiagnostics}=require('../application/diagnostics');
const {ApplicationService}=require('../application/service');
const {IacLifecycleService}=require('../iac/lifecycle');
const {IacReviewService,prepareReview}=require('../iac/review');
const {DelegationStore}=require('../policy/delegation');
const {ObservationJournal}=require('../runtime/journal');
const {operationKey}=require('../iac/lifecycleModel');
let environmentBefore;
beforeEach(()=>{environmentBefore={...process.env};environment();});
afterEach(()=>{process.env=environmentBefore;jest.restoreAllMocks();});
const requestId='abcdef00-0000-0000-0000-000000000000';
async function setup(){
 const f=await fixture();
 const op={...f.source,state:'succeeded',manualRecoveryRequired:false,approval:{sub:'owner',reviewDigest:'approved'},resources:f.resources};
 op.input.parameters={Private:'known-private-value'};
 f.stack(f.s.namespace+'stack','CREATE_COMPLETE',JSON.parse(f.input.text),f.resources.map(r=>({LogicalResourceId:r.logicalId,PhysicalResourceId:r.physicalId,ResourceType:r.resourceType,ResourceStatus:'CREATE_COMPLETE'})));
 await save(f.store,operationKey(op.operationId),op);await save(f.store,'iac/deployed/g/stack.json',{operationId:op.operationId});
 const logs=jest.fn(async()=>({events:[]})),reader=new ApplicationDiagnostics(f.store,{cloud:f.clients.cloud,logs,policy:()=>policy});
 const service=new IacLifecycleService(f.store,{logs:(op,options)=>reader.read(op,options),notify:async(g,e)=>f.sent.push(e),policy:()=>policy});
 return {...f,op,logs,reader,service};
}
test('approved function diagnostics are bounded, redacted, paged and identical through UI service, graph bus and MCP journal',async()=>{
 const f=await setup(),now=Date.now();
 f.logs.mockResolvedValueOnce({events:[
  {eventId:'system',timestamp:now,logStreamName:'owned',message:`START RequestId: ${requestId} Version: $LATEST`},
  {eventId:'private',timestamp:now,logStreamName:'owned',message:JSON.stringify({players:['private-user'],password:'private-password'})},
  {eventId:'diagnostic',timestamp:now,logStreamName:'owned',message:JSON.stringify({type:'graph.application.diagnostic',correlationId:'correlation-1',requestId,error:{code:'UNHEALTHY',message:'known-private-value password="private-password"',stack:'runtime.js:12'},payload:'private-application-payload'})},
 ],nextToken:'private-aws-token'}).mockResolvedValueOnce({events:[{eventId:'late',timestamp:now-1000,message:JSON.stringify({errorType:'TypeError',errorMessage:'Cannot read score',stack:['index.js:4']})}]});
 const first=await f.service.runtimeLogs('g','stack',human,{logicalId:'Backend'});
 expect(first.events).toHaveLength(2);expect(first.omitted).toBe(1);expect(first.truncated).toBe(true);expect(first.hasMore).toBe(true);
 const serialized=JSON.stringify(first);for(const value of ['known-private-value','private-password','private-user','private-application-payload','private-aws-token'])expect(serialized).not.toContain(value);
 const second=await f.service.runtimeLogs('g','stack',human,{logicalId:'Backend',cursor:first.nextCursor});expect(second.events[0].error.message).toBe('Cannot read score');
 const replay=await f.service.runtimeLogs('g','stack',human,{logicalId:'Backend',cursor:first.nextCursor});expect(replay.events).toEqual(second.events);expect(f.logs).toHaveBeenCalledTimes(2);
 const observed=(await new ObservationJournal(f.store).read('g',{filter:{kind:'deployment.runtime-log'}})).observations;
 expect(observed.map(({arrival,...row})=>row)).toEqual([...first.events,...second.events]);
 expect(f.sent.filter(e=>e.kind==='deployment.runtime-log')).toEqual(observed);
 expect(f.logs.mock.calls[0][1]).toMatchObject({logGroupName:'/aws/lambda/'+f.s.namespace+'backend',limit:50});
 expect(f.logs.mock.calls[0][1].endTime-f.logs.mock.calls[0][1].startTime).toBeLessThanOrEqual(3600000);expect(f.logs.mock.calls[0][1].unmask).toBeUndefined();
});
test('invocation and correlation IDs resolve to trusted Lambda request IDs; calls rejected before Lambda are explicit',async()=>{
 const f=await setup();
 const app=new ApplicationService(f.store,{policy:()=>policy,invokeWithMetadata:async()=>({body:{result:'ok',updates:[]},requestId,bridgeRequestId:'bridge-1'})});
 await app.invoke({graphId:'g',nodeId:'backend',stackNodeId:'stack',logicalFunctionId:'Backend',value:{},principal:human,correlationId:'correlation-1',executionId:'execution-1'});
 const mapping=await read(f.store,`iac/invocations/${f.op.operationId}/correlation-1.json`);
 await f.reader.read(f.op,{logicalId:'Backend',correlationId:'correlation-1'});expect(f.logs.mock.calls[0][1].filterPattern).toBe('"'+requestId+'"');
 await f.reader.read(f.op,{logicalId:'Backend',invocationId:mapping.entries[0].id});expect(f.logs.mock.calls[1][1].filterPattern).toBe('"'+requestId+'"');
 const absent=await f.reader.read(f.op,{logicalId:'Backend',correlationId:'missing'});expect(absent.unavailable).toBe(true);expect(absent.reason).toContain('before Lambda');expect(f.logs).toHaveBeenCalledTimes(2);
});

test('the actual private bridge adapter preserves invocation/correlation IDs from graph invocation through Lambda and the bus',async()=>{
 const f=await setup();Object.assign(process.env,{IAC_ACCOUNTS:'230639770018',IAC_REGIONS:'us-west-1',APPLICATION_BRIDGE_FUNCTION:'private-bridge'});
 let lambdaEvent;
 const inner=new ApplicationService(f.store,{journal:false,rawResponse:true,returnMetadata:true,policy:()=>policy,invokeWithMetadata:async(_arn,event)=>{lambdaEvent=event;return {body:{result:'ok',updates:[{topic:'ready',value:true}]},requestId};}});
 const sdk=require('aws-sdk'),prior=sdk.Lambda;
 sdk.Lambda=function(){return {invoke:args=>({promise:async()=>({Payload:JSON.stringify({bridgeProtocolVersion:1,ok:true,...await inner.invoke(JSON.parse(args.Payload)),bridgeRequestId:'bridge-request'})})})};};
 try{
  const invoke=require('../application/runtime').applicationInvoker(f.store,async(g,e)=>f.sent.push(e));
  expect(await invoke({graphId:'g',nodeId:'backend',stackNodeId:'stack',logicalFunctionId:'Backend',value:{},principal:human,executionId:'graph-execution'})).toBe('ok');
  const update=f.sent.find(e=>e.eventType==='application.update');
  expect(lambdaEvent.context.correlationId).toBe('graph-execution');expect(lambdaEvent.context.invocationId).toBe(update.invocationId);
  expect(update.requestId).toBe(requestId);expect(update.bridgeRequestId).toBe('bridge-request');
  const mapping=await read(f.store,`iac/invocations/by-id/${f.op.operationId}/${update.invocationId}.json`);expect(mapping.requestId).toBe(requestId);
 }finally{if(prior)sdk.Lambda=prior;else delete sdk.Lambda;}
});

test('Lambda request correlation uses the final system report and discards application text in its tail',()=>{
 const {lambdaRequestId}=require('../application/requestId');
 expect(lambdaRequestId(`START RequestId: ${requestId}\napplication text with REPORT RequestId: 00000000-0000-0000-0000-000000000000\nREPORT RequestId: ${requestId}\tDuration: 12ms`)).toBe(requestId);
 expect(lambdaRequestId(JSON.stringify({type:'platform.report',record:{requestId}}))).toBe(requestId);
 expect(lambdaRequestId('A private application payload without a system record')).toBeUndefined();
});
test('arbitrary log groups, mismatched ownership, cross-graph cursors and undelegated readers cannot access application logs',async()=>{
 const f=await setup();
 await expect(f.reader.read(f.op,{logicalId:'Backend',logGroup:'/aws/lambda/server'})).rejects.toMatchObject({code:'SCHEMA_INVALID'});
 await expect(f.reader.read(f.op,{logicalId:'NotOwned'})).rejects.toMatchObject({code:'RESOURCE_NOT_OWNED'});
 await expect(f.reader.read(f.op,{logicalId:'Backend',requestId,correlationId:'ambiguous'})).rejects.toMatchObject({code:'SCHEMA_INVALID'});
 await expect(f.reader.read(f.op,{logicalId:'Backend',startTime:new Date(Date.now()-7200000).toISOString()})).rejects.toMatchObject({code:'SCHEMA_INVALID'});
 const agent={sub:'reader',kind:'agent',scopes:[]};await new DelegationStore(f.store).put({agentSub:agent.sub,graphId:'g',delegatedBy:'owner',scopes:['graph:read','iac:read-status','graph:observe'],expiresAt:null,createdAt:new Date().toISOString()});
 await expect(f.service.runtimeLogs('g','stack',agent,{logicalId:'Backend'})).rejects.toMatchObject({code:'ADMISSION_DENIED'});
 f.logs.mockResolvedValue({events:[],nextToken:'second'});const first=await f.reader.read(f.op,{logicalId:'Backend'});
 await expect(f.reader.read(f.op,{logicalId:'Backend',requestId, cursor:first.nextCursor})).rejects.toMatchObject({code:'SCHEMA_INVALID'});
 f.stacks.get(f.s.namespace+'stack').Tags[0].Value='other';await expect(f.reader.read(f.op,{logicalId:'Backend'})).rejects.toMatchObject({code:'RESOURCE_NOT_OWNED'});
 expect(f.logs).toHaveBeenCalledTimes(1);
});

test('adding readiness to an unchanged application template still needs fresh exact-digest human approval',async()=>{
 const f=await fixture(),recovered=await f.recover();
 let op=await f.reviews.begin('g','stack',human,false,'apply',recovered.operationId);
 await f.reviews.step(op.operationId);await f.reviews.step(op.operationId);op=await f.reviews.current('g','stack',human,undefined,false);
 await f.reviews.approve('g','stack',human,{operationId:op.operationId,reviewDigest:op.reviewDigest});await f.reviews.step(op.operationId);await f.reviews.step(op.operationId);
 f.graph.nodes[0].properties.iac.readiness=[{id:'health',nodeUrl:'health',value:{action:'health'}}];
 f.deployCloud.describe.mockResolvedValue({status:'FAILED',reason:"The submitted information didn't contain changes."});
 const fresh=await f.reviews.begin('g','stack',human);await f.reviews.step(fresh.operationId);await f.reviews.step(fresh.operationId);
 const review=await f.reviews.current('g','stack',human,undefined,false);expect(review.state).toBe('awaiting-review');expect(review.plan.metadataOnly).toBe(true);
 expect((await read(f.store,'iac/deployed/g/stack.json')).operationId).toBe(op.operationId);
 await expect(f.reviews.approve('g','stack',human,{operationId:review.operationId,reviewDigest:op.reviewDigest})).rejects.toMatchObject({code:'STALE_REVIEW'});
 await f.reviews.approve('g','stack',human,{operationId:review.operationId,reviewDigest:review.reviewDigest});await f.reviews.step(review.operationId);await f.reviews.step(review.operationId);
 expect((await read(f.store,'iac/deployed/g/stack.json')).operationId).toBe(review.operationId);expect(f.deployCloud.execute).toHaveBeenCalledTimes(1);
});
test('unavailable logs and permission failures preserve a structured diagnostic and never escalate permissions',async()=>{
 const f=await setup();f.logs.mockRejectedValue(Object.assign(new Error('not authorized: logs:FilterLogEvents'),{code:'AccessDenied'}));
 const result=await f.service.runtimeLogs('g','stack',human,{logicalId:'Backend'});expect(result).toMatchObject({unavailable:true,permissionFailure:true,error:{code:'AccessDenied'}});
 expect(f.calls.some(c=>c.service==='iam'&&/put|create|delete/i.test(c.method))).toBe(false);
});
test('runtime log inspection authority is enforced for status pages as well as observations and bus delivery',async()=>{
 const f=await setup();f.logs.mockResolvedValue({events:[{eventId:'error',timestamp:Date.now(),message:JSON.stringify({errorType:'Error',errorMessage:'A private diagnostic'})}]});
 await f.service.runtimeLogs('g','stack',human,{logicalId:'Backend'});
 const agent={sub:'reader',kind:'agent',scopes:[]};await new DelegationStore(f.store).put({agentSub:agent.sub,graphId:'g',delegatedBy:'owner',scopes:['graph:read','iac:read-status','graph:observe'],expiresAt:null,createdAt:new Date().toISOString()});
 const page=await f.reviews.events('g','stack',agent,{operationId:f.op.operationId});expect(page.events.some(e=>e.kind==='deployment.runtime-log')).toBe(false);
 const {progressAllowed}=require('../iac/progressAccess');expect(progressAllowed({...agent,scopes:['graph:read','iac:read-status','graph:observe']},{kind:'deployment.runtime-log'})).toBe(false);
 expect(progressAllowed(human,{kind:'deployment.runtime-log'})).toBe(true);
});
test('declared readiness uses graph invocation, preserves idempotency, and never equates successful deployment with runtime readiness',async()=>{
 const f=await setup();f.graph.nodes[0].properties.iac.readiness=[{id:'health',nodeUrl:'health',value:{action:'health'}}];
 const input=prepareReview(f.graph,'stack',policy),op={...f.op,input,inputDigest:input.inputDigest};await save(f.store,operationKey(op.operationId),op);
 const invoke=jest.fn(async()=>({summary:{state:'completed',errors:0,effects:{denied:0},executionId:'runtime-check',revisionId:'rev_actual'}}));
 const service=new IacLifecycleService(f.store,{invoke,input:async()=>prepareReview(f.graph,'stack',policy),policy:()=>policy});
 const one=await service.readiness('g','stack',human,{checkId:'health',idempotencyKey:'one'}),duplicate=await service.readiness('g','stack',human,{checkId:'health',idempotencyKey:'one'});
 expect(one).toEqual(duplicate);expect(one.state).toBe('verified');expect(invoke).toHaveBeenCalledTimes(1);
 expect((await read(f.store,operationKey(op.operationId))).runtimeReadiness.state).toBe('verified');
 invoke.mockResolvedValue({summary:{state:'failed',errors:1,effects:{denied:0},executionId:'failed-check'}});const failure=await service.readiness('g','stack',human,{checkId:'health',idempotencyKey:'two'});expect(failure.state).toBe('failed');expect((await read(f.store,operationKey(op.operationId))).state).toBe('succeeded');
 await expect(service.readiness('g','stack',human,{checkId:'unknown',idempotencyKey:'three'})).rejects.toMatchObject({code:'READINESS_UNDECLARED'});
});
