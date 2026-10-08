const {DeploymentProgress}=require('../iac/progress');
const {DeploymentDiagnostics,diagnosticTarget}=require('../iac/diagnostics');
const {IacReviewService}=require('../iac/review');
const {ObservationJournal}=require('../runtime/journal');
const {DelegationStore}=require('../policy/delegation');
const {diagnosticText}=require('../iac/diagnosticSafety');
const {deploymentProgressContract}=require('../discovery/deploymentProgress');
const {stackScope}=require('../iac/isolation');
const Store=require('../__testHelpers__/fakeS3');
const id='01M4CSD7D7H7YM2HKY2Z5AJRHZ',human={sub:'owner',kind:'human',scopes:[]};
const policy={accounts:['230639770018'],regions:['us-west-1'],stackPrefix:'pio-dev-',substrateStacks:['graph-server']};
const save=(store,key,v)=>new Promise((resolve,reject)=>store.set(key,v,{},e=>e?reject(e):resolve()));
const time=Date.parse('2026-10-08T03:37:00Z');
function fixture(over={}){
 const op={operationId:id,graphId:'g',nodeId:'stack',revisionId:'rev_accepted',inputDigest:'a'.repeat(64),state:'failed',createdAt:time,updatedAt:time+60000,history:[],reason:'Original guardrail error',
  input:{stack:{name:'pio-dev-example',account:policy.accounts[0],region:policy.regions[0]},parameters:{Secret:'parameter-private'},text:JSON.stringify({Parameters:{Private:{NoEcho:true,Default:'default-private'}},Resources:{Backend:{Properties:{Environment:{Variables:{PRIVATE:'environment-private'}}}}}}),format:'json'},...over};
 const store=new Store(),sent=[],notify=jest.fn(async(g,e)=>sent.push(e)),progress=new DeploymentProgress(store,notify);
 const clients={cloud:jest.fn(async(method,args)=>{
  if(method==='describeStacks')return {Stacks:[{StackName:args.StackName,StackStatus:'CREATE_COMPLETE'}]};
  return {StackEvents:[]};
 }),states:jest.fn(async method=>method==='describeExecution'?{status:'RUNNING'}:{events:[]}),logs:jest.fn(async()=>({events:[]}))};
 const target=()=>({stack:op.input.stack.name,guardrail:'graph-guardrails-example',executionArn:'arn:aws:states:us-west-1:230639770018:execution:server:operation',logGroup:'/aws/lambda/platform-iacWorker'});
 const collector=new DeploymentDiagnostics(progress,clients,target);
 const reviews=new IacReviewService(store,{notify,cloud:{remove:jest.fn(async()=>{throw new Error('must not assume an absent role');})}});
 const seed=async()=>{await save(store,IacReviewService.key(id),op);await save(store,IacReviewService.index('g','stack'),{operationId:id});};
 return {op,store,sent,notify,progress,clients,collector,reviews,seed};
}
const resource=(status,reason,extra={})=>({EventId:status,LogicalResourceId:'WorkerRole',PhysicalResourceId:'gapp-example-worker',ResourceType:'AWS::IAM::Role',ResourceStatus:status,ResourceStatusReason:reason,Timestamp:new Date(time+10000),...extra});

test('Chess regression: a guardrail failure before application creation retains IAM causes over secondary AssumeRole failure',async()=>{
 const f=fixture({reason:'The deployment workflow failed. Check the operation in AWS before retrying.'});await f.seed();
 f.clients.cloud.mockImplementation(async(method,args)=>{
  if(args.StackName==='pio-dev-example')throw Object.assign(new Error('Stack does not exist'),{code:'ValidationError'});
  if(method==='describeStacks')return {Stacks:[{StackStatus:'ROLLBACK_FAILED',StackStatusReason:'Resources failed to delete: WorkerRole, ExecutionRole'}]};
  return {StackEvents:[resource('CREATE_FAILED','The platform guardrail role is not authorized to perform iam:GetRole on role gapp-example-worker'),resource('DELETE_FAILED','Not authorized to perform iam:DeleteRolePolicy',{Timestamp:new Date(time+20000)}),resource('DELETE_SKIPPED','Retained boundary',{LogicalResourceId:'RuntimeBoundary',ResourceType:'AWS::IAM::ManagedPolicy'})]};
 });
 f.clients.states.mockImplementation(async method=>method==='describeExecution'?{status:'FAILED',error:'AccessDenied',cause:JSON.stringify({errorType:'AccessDenied',errorMessage:'Not authorized to perform sts:AssumeRole on the absent worker',unrelated:'never disclose'}),stopDate:new Date(time+30000)}:{events:[{id:1,type:'LambdaFunctionFailed',timestamp:new Date(time+15000),lambdaFunctionFailedEventDetails:{error:'Error',cause:JSON.stringify({errorMessage:'Platform guardrail provisioning failed: ROLLBACK_FAILED'})}}]});
 await f.collector.collect(f.op);
 const status=await f.reviews.current('g','stack',human);
 expect(status.reason).toContain('iam:GetRole');expect(status.manualRecoveryRequired).toBe(true);
 expect(status.recovery.category).toBe('platform-intervention');
 const events=(await f.reviews.events('g','stack',human,{operationId:id,limit:100})).events;
 expect(events.some(e=>e.stackName==='pio-dev-example'&&e.status==='NOT_CREATED')).toBe(true);
 expect(events.some(e=>e.reason?.includes('iam:DeleteRolePolicy'))).toBe(true);
 expect(events.some(e=>e.reason?.includes('sts:AssumeRole'))).toBe(true);
 expect(events.some(e=>e.status==='DELETE_SKIPPED')).toBe(true);
 expect(JSON.stringify(events)).not.toContain('never disclose');
 const watched=(await new ObservationJournal(f.store).read('g',{filter:{operationId:id}})).observations;
 expect(watched).toEqual(f.sent);
 expect(events.map(e=>e.id)).toEqual(watched.map(e=>e.id));
 expect(watched.every(e=>e.graphId==='g'&&e.nodeId==='stack'&&e.revisionId==='rev_accepted'&&e.inputDigest===f.op.inputDigest)).toBe(true);
 // Failure recording/terminal handling must not call remove(), which assumes the deployment role.
 await f.reviews.step(id);
 expect(f.reviews.deps.cloud.remove).not.toHaveBeenCalled();
});

test.each(['CREATE_FAILED','UPDATE_FAILED','DELETE_FAILED'])('resource %s and rollback are inspectable with their original reasons',async(status)=>{
 const f=fixture({state:'rolled-back',approval:{reviewDigest:'approved'}});await f.seed();
 f.clients.cloud.mockImplementation(async method=>method==='describeStacks'?{Stacks:[{StackStatus:'UPDATE_ROLLBACK_COMPLETE'}]}:{StackEvents:[resource(status,'Invalid application resource configuration'),resource('UPDATE_ROLLBACK_IN_PROGRESS','Reverting resource',{EventId:'rollback',Timestamp:new Date(time+20000)})]});
 await f.collector.collect(f.op);const response=await f.reviews.current('g','stack',human);
 expect(response.reason).toBe('Invalid application resource configuration');
 expect((await f.progress.page(f.op)).events.some(e=>e.phase==='rolling-back')).toBe(true);
 expect(response.progress.resources.some(e=>e.status==='UPDATE_ROLLBACK_IN_PROGRESS')).toBe(true);
});

test('change-set planning failure and worker exception survive diagnostic permission denials',async()=>{
 const f=fixture({changeSetId:'review-test',state:'planning'});await f.seed();
 await f.reviews.recordException(id,Object.assign(new Error('Original invalid template'),{code:'ValidationError'}),'lambda-request');
 await f.reviews.fail(id,{Error:'SecondaryError',Cause:'Later failure must not overwrite the original'});
 f.clients.cloud.mockImplementation(async method=>{if(method==='describeChangeSet')return {Status:'FAILED',StatusReason:'Unresolved resource dependency: MissingRole'};throw Object.assign(new Error('diagnostic reads denied'),{code:'AccessDenied'});});
 f.clients.logs.mockRejectedValue(Object.assign(new Error('log retrieval denied'),{code:'AccessDenied'}));
 await f.collector.collect(f.op);
 const status=await f.reviews.current('g','stack',human),events=(await f.progress.page(f.op)).events;
 expect(status.reason).toBe('Original invalid template');expect(status.originalError.code).toBe('ValidationError');
 expect(events.some(e=>e.source==='changeset'&&e.reason.includes('MissingRole'))).toBe(true);
 expect(events.some(e=>e.source==='diagnostics'&&e.error?.code==='AccessDenied')).toBe(true);
 expect(status.recovery.category).toBe('template-correction');
});

test('an orchestration timeout makes a nonterminal record observably failed without approving or mutating its review',async()=>{
 const f=fixture({state:'awaiting-review',reviewDigest:'exact'});await f.seed();
 f.clients.states.mockResolvedValue({status:'TIMED_OUT',error:'States.Timeout',cause:'Workflow monitoring timed out'});
 await f.collector.collect(f.op);
 expect(await f.reviews.current('g','stack',human)).toMatchObject({state:'failed',workflowState:'awaiting-review',manualRecoveryRequired:true});
 await expect(f.reviews.approve('g','stack',human,{operationId:id,reviewDigest:'exact'})).rejects.toMatchObject({code:'STALE_REVIEW'});
 const persisted=JSON.parse(f.store.objects.get(IacReviewService.key(id)).toString());expect(persisted.state).toBe('awaiting-review');expect(persisted.approval).toBeUndefined();
});

test('only bounded operation-correlated platform logs are published; secrets and application payloads are removed',async()=>{
 const f=fixture();
 const secret='parameter-private environment-private default-private Authorization=Bearer abcdefghijklmnop api_key="top-secret" https://example.test/?X-Amz-Signature=signed-secret';
 const log={type:'deployment.diagnostic',operationId:id,status:'ERROR',error:{code:'Denied',message:secret,trace:Array(20).fill(secret)},requestId:'request',applicationPayload:'private-body'};
 f.clients.logs.mockResolvedValue({events:[{eventId:'foreign',message:JSON.stringify({...log,operationId:'another'}),timestamp:time}, {eventId:'legacy',message:secret,timestamp:time},...Array.from({length:25},(_,i)=>({eventId:'safe-'+i,message:JSON.stringify(log),timestamp:time+i,logStreamName:'worker'}))]});
 f.clients.cloud.mockImplementation(async method=>method==='describeStacks'?{Stacks:[{StackStatus:'CREATE_FAILED',Outputs:[{OutputValue:'private-output'}]}]}:{StackEvents:[resource('CREATE_FAILED',secret,{ResourceProperties:'private-properties'})]});
 await f.collector.collect(f.op);const entries=(await f.progress.page(f.op,{limit:100})).events,serialized=JSON.stringify(entries);
 for(const value of ['parameter-private','environment-private','default-private','top-secret','signed-secret','private-body','private-output','private-properties','abcdefghijklmnop'])expect(serialized).not.toContain(value);
 expect(entries.filter(e=>e.source==='cloudwatch')).toHaveLength(20);
 expect(entries.some(e=>e.truncated)).toBe(true);expect(entries.every(e=>!e.error||e.error.trace.length<=6)).toBe(true);
 for(const [,args]of f.clients.logs.mock.calls){expect(args.logGroupName).toBe('/aws/lambda/platform-iacWorker');expect(args.filterPattern).toBe('"'+id+'"');expect(args.endTime-args.startTime).toBeLessThanOrEqual(300000);expect(args.unmask).toBeUndefined();}
 expect(diagnosticText('password="hello" -----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----',f.op)).not.toMatch(/hello|private-key-material/);
 expect(diagnosticText('AWS_SECRET_ACCESS_KEY=secret-value https://name:password-value@example.test',f.op)).not.toMatch(/secret-value|password-value/);
});

test('AWS pagination resumes older events while observing new arrivals; duplicate collection is idempotent',async()=>{
 const f=fixture({state:'applying'});let fresh=0;
 f.clients.cloud.mockImplementation(async(method,args)=>{
  if(method==='describeStacks')return {Stacks:[{StackStatus:'CREATE_IN_PROGRESS'}]};
  const n=args.NextToken?Number(args.NextToken):0;
  return {StackEvents:[resource('CREATE_IN_PROGRESS','phase '+n,{EventId:'event-'+(n||fresh),Timestamp:new Date(time+(7-n)*1000)})],...(n<6?{NextToken:String(n+1)}:{})};
 });
 await f.collector.collect(f.op);expect((await f.progress.view(f.op)).collectionPending).toBe(true);
 const initial=await f.progress.page(f.op,{limit:100});fresh=20;
 await f.collector.collect(f.op);await f.collector.collect(f.op);
 const tail=await f.progress.page(f.op,{cursor:initial.nextCursor,limit:100});
 expect(tail.events.some(e=>e.reason==='phase 6')).toBe(true);
 expect(tail.events.every(e=>e.sequence>initial.receivedThrough)).toBe(true);
 expect((await f.progress.view(f.op)).collectionPending).toBe(false);
 const head=(await f.progress.head(id)).seq;await f.collector.collect(f.op);expect((await f.progress.head(id)).seq).toBe(head);
});

test('reconnect cursors keep late events, outbox retries preserve IDs, and graph/node/operation boundaries are enforced',async()=>{
 const f=fixture();await f.seed();f.notify.mockRejectedValueOnce(new Error('socket unavailable'));
 await f.progress.append(f.op,[{id:'one',source:'worker',phase:'planning',status:'IN_PROGRESS',at:time+5000}]);
 expect((await f.progress.head(id)).published).toBe(0);
 const first=await f.progress.page(f.op);await f.progress.flush(f.op);
 await f.progress.append(f.op,[{id:'late',source:'cloudformation',phase:'planning',status:'CREATE_FAILED',logicalId:'Role',reason:'permission denied',at:time}]);
 const resumed=await f.progress.page(f.op,{cursor:first.nextCursor});expect(resumed.events).toHaveLength(1);expect(resumed.events[0].at).toBe(new Date(time).toISOString());
 expect(f.sent[0].id).toBe(first.events[0].id);
 await expect(f.progress.page({...f.op,nodeId:'other'},{cursor:first.nextCursor})).rejects.toMatchObject({code:'SCHEMA_INVALID'});
 await expect(f.reviews.current('other','stack',human,id)).rejects.toMatchObject({code:'NOT_FOUND'});
 await expect(f.reviews.events('g','stack',undefined,{operationId:id})).rejects.toMatchObject({code:'ADMISSION_DENIED'});
 const agent={sub:'agent',kind:'agent',scopes:[]};await expect(f.reviews.current('g','stack',agent)).rejects.toMatchObject({code:'ADMISSION_DENIED'});
 await new DelegationStore(f.store).put({agentSub:'agent',graphId:'g',delegatedBy:'owner',scopes:['graph:read','iac:read-status'],expiresAt:null});
 expect((await f.reviews.current('g','stack',agent)).operationId).toBe(id);
 await expect(f.reviews.events('other','stack',agent,{operationId:id})).rejects.toMatchObject({code:'ADMISSION_DENIED'});
});

test('the event schema validates real stored and bus records, with bounded batches and pages',async()=>{
 const Ajv=require('ajv'),validate=new Ajv({strict:false,validateFormats:false}).compile(deploymentProgressContract.schema),f=fixture();
 await f.progress.append(f.op,Array.from({length:1100},(_,i)=>({id:'event-'+i,source:'worker',phase:'planning',reason:'x'.repeat(3000)})));
 expect((await f.progress.head(id)).seq).toBe(1100);
 const page=await f.progress.page(f.op,{limit:100});expect(page.hasMore).toBe(true);expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThan(121000);
 for(const e of [...page.events,...f.sent])expect(validate(e)).toBe(true);
});

test('diagnostic targets are derived from graph ownership and configured account, never from requested AWS identifiers',()=>{
 const old={...process.env};try{
  Object.assign(process.env,{SERVICE_NAME:'platform',STAGE:'test',IAC_REVIEW_STATE_MACHINE:'arn:aws:states:us-west-1:230639770018:stateMachine:platform-test-iac-review'});
  const f=fixture(),scope=stackScope('g','stack',policy);f.op.input.isolation=scope;f.op.input.stack.name=scope.namespace+'stack';
  expect(diagnosticTarget(f.op,policy)).toMatchObject({stack:scope.namespace+'stack',guardrail:scope.guardrailStack,executionArn:process.env.IAC_REVIEW_STATE_MACHINE.replace(':stateMachine:',':execution:')+':'+id});
  expect(()=>diagnosticTarget({...f.op,graphId:'other'},policy)).toThrow(/namespace/);
  expect(()=>diagnosticTarget({...f.op,input:{...f.op.input,stack:{...f.op.input.stack,account:'111111111111'}}},policy)).toThrow(/account/);
 }finally{process.env=old;}
});

test('a diagnostic store outage preserves the original deployment response',async()=>{
 const f=fixture({originalError:{code:'AccessDenied',message:'iam:GetRole denied',trace:[]},reason:'iam:GetRole denied'});await f.seed();
 const get=f.store.get.bind(f.store);f.store.get=(key,cb)=>key.startsWith('iac/progress/')?cb(new Error('diagnostic store unavailable')):get(key,cb);
 expect(await f.reviews.current('g','stack',human)).toMatchObject({reason:'iam:GetRole denied',error:{code:'AccessDenied'},progress:{collectionWarning:{reason:expect.stringContaining('unavailable')}}});
});
