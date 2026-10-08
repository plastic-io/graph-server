const {IacReviewService}=require('../iac/review');
const {stackScope,executionPolicy,runtimeBoundary}=require('../iac/isolation');
const {DEFAULT_POLICY}=require('../iac/types');
const {authenticatedApplicationExample}=require('../discovery/example');
const {ApplicationService}=require('../application/service');
const Store=require('../__testHelpers__/fakeS3');
const policy={...DEFAULT_POLICY,accounts:['230639770018'],regions:['us-west-1']};
const human={sub:'owner',kind:'human',tenant:'test',scopes:[]};
const get=(store,key)=>new Promise((resolve,reject)=>store.get(key,(e,v)=>e?reject(e):resolve(v)));
let environment;
beforeEach(()=>{environment={...process.env};Object.assign(process.env,{IAC_STACK_ISOLATION:'true',IAC_GUARDRAIL_ROLE_ARN:'arn:aws:iam::230639770018:role/platform-guardrails',IAC_REVIEW_STATE_MACHINE:'configured'});});
afterEach(()=>{process.env=environment;});
function fixture(){
 const scope=stackScope('g','stack',policy),example=authenticatedApplicationExample(scope),store=new Store();
 const graph={id:'g',nodes:[{id:'stack',properties:{iac:example.configuration}}]};
 let stack={exists:false};
 const resources=Object.entries(JSON.parse(example.configuration.template.text).Resources).map(([id,r])=>({logicalId:id,resourceType:r.Type,physicalId:scope.namespace+(id==='Backend'?'backend':id.toLowerCase())}));
 const cloud={prepare:jest.fn(async()=>true),stack:jest.fn(async()=>stack),resources:jest.fn(async()=>resources),create:jest.fn(async()=>({changeSetId:'cs',stackId:scope.namespace+'stack'})),describe:jest.fn(async()=>({status:'CREATE_COMPLETE',executionStatus:'AVAILABLE',changes:resources.map(r=>({action:'Add',...r}))})),execute:jest.fn(async()=>{stack={exists:true,status:'CREATE_COMPLETE'};}),remove:jest.fn(async()=>{}),destroy:jest.fn(async()=>{stack={exists:true,status:'DELETE_IN_PROGRESS'};})};
 const service=new IacReviewService(store,{enabled:true,policy:()=>policy,projection:async()=>graph,start:async()=>{},cloud});
 const planned=async(action='apply')=>{const op=await service.begin('g','stack',human,false,action);await service.step(op.operationId);if(action==='apply')await service.step(op.operationId);return service.current('g','stack',human);};
 const approve=async op=>service.approve('g','stack',human,{operationId:op.operationId,reviewDigest:op.reviewDigest,confirmDestructive:true});
 const deploy=async()=>{const op=await planned();expect(op.state).toBe('awaiting-review');await approve(op);await service.step(op.operationId);await service.step(op.operationId);return service.current('g','stack',human);};
 return {scope,store,graph,cloud,service,planned,approve,deploy,setStack:s=>{stack=s;}};
}
test('isolated create and update require separate approvals; backend remains bound to last successful deployment',async()=>{
 const f=fixture(),created=await f.deploy();
 expect(created.state).toBe('succeeded');expect(created.finalizedAt).toEqual(expect.any(Number));
 expect(created.preflight.isolation.namespace).toBe(f.scope.namespace);
 expect(created.plan.changes.find(r=>r.logicalId==='Role').access).toMatchObject({before:null,after:{PermissionsBoundary:f.scope.boundaryArn}});
 const invoke=jest.fn(async()=>({result:'ok'})),app=new ApplicationService(f.store,{invoke,policy:()=>policy});
 const request={graphId:'g',nodeId:'backend',stackNodeId:'stack',logicalFunctionId:'Backend',value:{},principal:human};
 expect(await app.invoke(request)).toBe('ok');
 f.graph.nodes[0].properties.iac.template.text+='\n';
 const updated=await f.planned();expect(updated.operationId).not.toBe(created.operationId);
 expect(await app.invoke(request)).toBe('ok');
 await f.approve(updated);await expect(app.invoke(request)).rejects.toMatchObject({code:'DEPLOYMENT_UNAVAILABLE'});
 await f.service.step(updated.operationId);await f.service.step(updated.operationId);
 expect((await get(f.store,'iac/deployed/g/stack.json')).operationId).toBe(updated.operationId);
 expect(await app.invoke(request)).toBe('ok');
 expect(f.cloud.execute).toHaveBeenCalledTimes(2);
});
test('destroy reviews deployed retention; an accepted AWS delete is not repeated after a storage failure',async()=>{
 const f=fixture();await f.deploy();
 const changed=JSON.parse(f.graph.nodes[0].properties.iac.template.text);changed.Resources.Records.DeletionPolicy='Delete';f.graph.nodes[0].properties.iac.template.text=JSON.stringify(changed);
 const op=await f.planned('destroy');
 expect(op.plan.changes.find(r=>r.logicalId==='Records')).toMatchObject({outcome:'Retain',deletionPolicy:'Retain'});
 await f.approve(op);
 const cas=f.store.compareAndSet.bind(f.store);let fail=true;
 f.store.compareAndSet=(key,value,etag,cb)=>{if(fail&&value.state==='applying'){fail=false;return cb(new Error('temporary storage failure'));}return cas(key,value,etag,cb);};
 await expect(f.service.step(op.operationId)).rejects.toThrow(/storage/);
 await f.service.step(op.operationId);expect(f.cloud.destroy).toHaveBeenCalledTimes(1);
 f.setStack({exists:false});await f.service.step(op.operationId);
 expect((await f.service.current('g','stack',human)).state).toBe('destroyed');
 expect((await get(f.store,'iac/deployed/g/stack.json')).operationId).toBeNull();
 expect((await f.approve(op)).state).toBe('destroyed');
});
test('a successful AWS deployment is finalized on retry if the graph binding write failed',async()=>{
 const f=fixture(),op=await f.planned();await f.approve(op);await f.service.step(op.operationId);
 const cas=f.store.compareAndSet.bind(f.store);let fail=true;
 f.store.compareAndSet=(key,value,etag,cb)=>{if(fail&&key==='iac/deployed/g/stack.json'){fail=false;return cb(new Error('temporary binding failure'));}return cas(key,value,etag,cb);};
 await expect(f.service.step(op.operationId)).rejects.toThrow(/binding/);
 expect((await f.service.begin('g','stack',human)).operationId).toBe(op.operationId);
 await f.service.step(op.operationId);
 expect((await get(f.store,'iac/deployed/g/stack.json')).operationId).toBe(op.operationId);
 expect(f.cloud.execute).toHaveBeenCalledTimes(1);
});
test('guardrails finish before an application change set is created',async()=>{
 const f=fixture();f.cloud.prepare.mockResolvedValueOnce(false);
 const op=await f.service.begin('g','stack',human);await f.service.step(op.operationId);
 expect(f.cloud.create).not.toHaveBeenCalled();await f.service.step(op.operationId);expect(f.cloud.create).toHaveBeenCalledTimes(1);
});
test('destroy retains RetainExceptOnCreate data and blocks invocation after a partial deletion failure',async()=>{
 const f=fixture(),template=JSON.parse(f.graph.nodes[0].properties.iac.template.text);
 template.Resources.Records.DeletionPolicy='RetainExceptOnCreate';f.graph.nodes[0].properties.iac.template.text=JSON.stringify(template);
 await f.deploy();const op=await f.planned('destroy');expect(op.plan.changes.find(r=>r.logicalId==='Records').outcome).toBe('Retain');
 await f.approve(op);await f.service.step(op.operationId);f.setStack({exists:true,status:'DELETE_FAILED',reason:'resource busy'});await f.service.step(op.operationId);
 expect((await f.service.current('g','stack',human)).manualRecoveryRequired).toBe(true);
 const invoke=jest.fn(),app=new ApplicationService(f.store,{invoke,policy:()=>policy});
 await expect(app.invoke({graphId:'g',nodeId:'backend',stackNodeId:'stack',logicalFunctionId:'Backend',value:{},principal:human})).rejects.toMatchObject({code:'DEPLOYMENT_UNAVAILABLE'});
 expect(invoke).not.toHaveBeenCalled();
});

// Local evaluation of the generated statement subset, not a substitute for AWS IAM simulation/live acceptance.
const match=(pattern,value)=>new RegExp('^'+pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.')+'$','i').test(value);
const any=(patterns,value)=>[].concat(patterns||[]).some(p=>match(p,value));
function allowed(doc,action,resource,context={},resourcePolicyAllow=false){
 const matches=doc.Statement.filter(s=>{
  if(s.Action?!any(s.Action,action):any(s.NotAction,action))return false;
  if(s.Resource?!any(s.Resource,resource):any(s.NotResource,resource))return false;
  return Object.entries(s.Condition||{}).every(([op,values])=>Object.entries(values).every(([key,want])=>{
   const actual=[].concat(context[key]||[]),expected=[].concat(want),eq=(x)=>expected.some(w=>op.includes('Like')?match(w,x):w===x);
   if(op==='StringNotEquals')return !actual.some(eq);
   if(op==='ForAllValues:StringNotEquals')return actual.every(x=>!eq(x));
   if(op==='ForAnyValue:StringEquals')return actual.some(eq);
   return actual.some(eq);
  }));
 });
 return !matches.some(s=>s.Effect==='Deny')&&(resourcePolicyAllow||matches.some(s=>s.Effect==='Allow'));
}
test('AWS policy matrix: stack A cannot mutate B, server resources, deployment roles, or its guardrails',()=>{
 const a=stackScope('g','a',policy),b=stackScope('g','b',policy),deploy=executionPolicy(a),app=runtimeBoundary(a);
 const table=s=>'arn:aws:dynamodb:us-west-1:230639770018:table/'+s;
 expect(allowed(deploy,'dynamodb:DeleteTable',table(a.namespace+'data'))).toBe(true);
 for(const name of [b.namespace+'data','plastic-io-graph-server']){
  expect(allowed(deploy,'dynamodb:DeleteTable',table(name),{},true)).toBe(false);
  expect(allowed(app,'dynamodb:PutItem',table(name),{},true)).toBe(false);
 }
 expect(allowed(app,'dynamodb:PutItem',table(a.namespace+'data'))).toBe(true);
 for(const target of [a.roleArn,b.roleArn,a.workerRoleArn])expect(allowed(deploy,'iam:PutRolePolicy',target,{},true)).toBe(false);
 for(const action of ['iam:DeletePolicy','iam:CreatePolicyVersion'])expect(allowed(deploy,action,a.boundaryArn,{},true)).toBe(false);
 const ownRole='arn:aws:iam::230639770018:role/graph-app/'+a.namespace+'runtime';
 expect(allowed(deploy,'iam:CreateRole',ownRole,{'iam:PermissionsBoundary':a.boundaryArn})).toBe(true);
 expect(allowed(deploy,'iam:CreateRole',ownRole,{},true)).toBe(false);
 expect(allowed(deploy,'iam:DeleteRolePermissionsBoundary',ownRole,{},true)).toBe(false);
 expect(allowed(deploy,'iam:PassRole',ownRole,{'iam:PassedToService':'lambda.amazonaws.com'})).toBe(true);
 expect(allowed(deploy,'iam:PassRole',ownRole,{'iam:PassedToService':'ec2.amazonaws.com'})).toBe(false);
 const api='arn:aws:apigateway:us-west-1::/restapis/abc/resources/def';
 expect(allowed(deploy,'apigateway:DELETE',api,{'aws:ResourceTag/GraphStack':a.namespace})).toBe(true);
 expect(allowed(deploy,'apigateway:PATCH',api,{'aws:ResourceTag/GraphStack':b.namespace},true)).toBe(false);
 expect(allowed(deploy,'apigateway:PUT','arn:aws:apigateway:us-west-1::/tags/abc',{'aws:ResourceTag/GraphStack':a.namespace,'aws:TagKeys':['GraphStack']},true)).toBe(false);
 // API Gateway authorizes both endpoints for a tagging request; the tags ARN
 // does not carry ResourceTag context. Model both checks, as AWS documents.
 const canTag=(target,keys)=>allowed(deploy,'apigateway:PUT','arn:aws:apigateway:us-west-1::/tags/abc',{'aws:TagKeys':keys})&&allowed(deploy,'apigateway:PATCH',api,{'aws:ResourceTag/GraphStack':target});
 expect(canTag(a.namespace,['Description'])).toBe(true);
 expect(canTag(b.namespace,['Description'])).toBe(false);
 expect(canTag(a.namespace,['GraphStack'])).toBe(false);
});
