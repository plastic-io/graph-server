const {fixture,environment,policy,human,read,save}=require('../__testHelpers__/lifecycleCloud');
const {prepareReview}=require('../iac/review');
const {operationKey,digest}=require('../iac/lifecycleModel');
const {preservesApprovedDeployment}=require('../iac/deploymentBinding');
const {ApplicationService}=require('../application/service');
const {IacLifecycleService}=require('../iac/lifecycle');
const {recoveryRead}=require('../iac/recoveryRead');
let env;beforeEach(()=>{env={...process.env};environment();});afterEach(()=>{process.env=env;});
const clone=x=>JSON.parse(JSON.stringify(x));

async function recoveredFixture(){
 const f=await fixture('guardrail-resume','stack');f.installRoles();
 f.graph.nodes[0].properties.iac.readiness=[{id:'health',nodeUrl:'health',field:'in',value:{action:'health'}}];
 const input=prepareReview(f.graph,'stack',policy),doc=JSON.parse(input.text);
 const resources=Object.entries(doc.Resources).map(([logicalId,r])=>({logicalId,resourceType:r.Type,physicalId:r.Properties.FunctionName||r.Properties.RoleName||r.Properties.TableName||r.Properties.LogGroupName,status:'CREATE_COMPLETE'}));
 for(const r of Object.values(doc.Resources))if(r.Type==='AWS::IAM::Role')f.roles.set(r.Properties.RoleName,{Arn:`arn:aws:iam::${f.s.account}:role/graph-app/${r.Properties.RoleName}`,PermissionsBoundary:{PermissionsBoundaryArn:f.s.boundaryArn}});
 const app=f.stack(f.s.namespace+'stack','CREATE_COMPLETE',doc,resources.map(r=>({LogicalResourceId:r.logicalId,ResourceType:r.resourceType,PhysicalResourceId:r.physicalId,ResourceStatus:r.status})));
 const source={...f.source,input,inputDigest:input.inputDigest,state:'succeeded',stackId:app.StackId,resources,reviewDigest:'approved-template',approval:{reviewDigest:'approved-template'},manualRecoveryRequired:false,finalizedAt:Date.now()};
 delete source.originalError;delete source.reason;
 await save(f.store,operationKey(source.operationId),source);await save(f.store,`iac/deployed/${source.graphId}/${source.nodeId}.json`,{operationId:source.operationId});
 const guard=f.stacks.get(f.s.guardrailStack);guard.StackStatus='CREATE_COMPLETE';guard.resources.forEach(r=>r.ResourceStatus='CREATE_COMPLETE');
 guard.template=clone(f.approved);guard.template.Resources.RuntimeBoundary.Properties.PolicyDocument={Version:'2012-10-17',Statement:[]};
 f.policies.set(f.s.boundaryArn,guard.template.Resources.RuntimeBoundary.Properties.PolicyDocument);
 const plan=await f.plan({preservation:'strict'});expect(plan.state).toBe('recovery-ready');await f.approve(plan);
 for(let i=0;i<15;i++)if((await f.reviews.lifecycle.step(plan.operationId)).done)break;
 const recovery=await read(f.store,operationKey(plan.operationId));expect(recovery.state).toBe('recovered');
 return {...f,source,recovery};
}
test('exact-approved guardrail repair resumes invocation and declared readiness of the unchanged bound deployment',async()=>{
 const f=await recoveredFixture(),{source,recovery}=f;
 expect(preservesApprovedDeployment(recovery,source)).toBe(true);
 const invoke=jest.fn(async()=>({ok:true})),app=new ApplicationService(f.store,{policy:()=>policy,invoke,journal:false});
 await expect(app.invoke({graphId:source.graphId,nodeId:'health',stackNodeId:'stack',logicalFunctionId:'Backend',value:{action:'health'},principal:human})).resolves.toEqual({ok:true});
 expect(invoke).toHaveBeenCalledTimes(1);
 f.reviews.runtimeInvoker=async()=>({summary:{state:'completed',executionId:'owned-execution',errors:0,effects:{denied:0}}});
 const run=await f.reviews.lifecycle.readiness(source.graphId,'stack',human,{checkId:'health',idempotencyKey:'health-1'});expect(run.state).toBe('verified');
 const status=await f.reviews.current(source.graphId,'stack',human,undefined,false);
 expect(status).toMatchObject({state:'recovered',runtimeDeployment:{operationId:source.operationId,retainedAfterRecovery:true},runtimeReadiness:{state:'verified'}});
 expect(status.nextActions.actions.find(a=>a.tool==='iac.readiness').allowed).toBe(true);
 expect(status.approval).toBeUndefined();expect(f.deployCloud.execute).not.toHaveBeenCalled();
 const logs=jest.fn(async()=>({events:[]})),lifecycle=new IacLifecycleService(f.store,{policy:()=>policy,logs});
 expect((await lifecycle.runtimeLogs(source.graphId,'stack',human,{operationId:recovery.operationId,logicalId:'Backend'})).operationId).toBe(source.operationId);
 expect(logs.mock.calls[0][0].operationId).toBe(source.operationId);
 expect(f.sent.some(e=>e.operationId===source.operationId&&e.kind==='deployment.runtime.readiness')).toBe(true);
});
test('changed, unapproved, active and cross-graph recovery never resumes the old deployment',async()=>{
 const f=await recoveredFixture(),{source,recovery}=f;
 const changes=[r=>r.state='recovering',r=>r.manualRecoveryRequired=true,r=>r.recoveryLease={id:'active'},r=>r.reviewInvalidatedAt=Date.now(),r=>r.supersededBy='another',r=>r.graphId='another',r=>r.inputDigest='changed',r=>r.recoveryApproval.digest='stale',r=>r.inspection.guardrailsMatch=false,r=>r.inspection.application.stackId+='replaced',r=>r.inspection.application.resources[0].physicalId+='replaced',r=>r.inspection.application.templateDigest='changed',r=>r.inspection.application.resources[0].ownershipVerified=false,
  r=>{r.recoveryPlan.actions.push({kind:'rollback-stack',target:'application',dataLoss:[]});const {digest:old,...content}=r.recoveryPlan;r.recoveryPlan.digest=digest(content);r.recoveryApproval.digest=r.recoveryPlan.digest;}];
 const invoke=jest.fn(),app=new ApplicationService(f.store,{policy:()=>policy,invoke,journal:false});
 for(const change of changes){const r=clone(recovery);change(r);expect(preservesApprovedDeployment(r,source)).toBe(false);await save(f.store,operationKey(r.operationId),r);
  await expect(app.invoke({graphId:source.graphId,nodeId:'health',stackNodeId:'stack',logicalFunctionId:'Backend',value:{},principal:human})).rejects.toMatchObject({code:'DEPLOYMENT_UNAVAILABLE'});
 }
 expect(invoke).not.toHaveBeenCalled();
 expect(preservesApprovedDeployment(recovery,{...source,approval:null})).toBe(false);
});
test('recovery prerequisite reads retry throttling and attribute exhausted checks without swallowing authorization failures',async()=>{
 const call=jest.fn().mockRejectedValueOnce(Object.assign(new Error('Rate exceeded'),{code:'Throttling'})).mockResolvedValue({ok:true});
 expect(await recoveryRead('iam','listEntitiesForPolicy',{PolicyArn:'owned-boundary'},call)).toEqual({ok:true});expect(call).toHaveBeenCalledTimes(2);
 const denied=jest.fn(async()=>{throw Object.assign(new Error('Denied'),{code:'AccessDenied',requestId:'aws-request'});});
 await expect(recoveryRead('iam','getPolicy',{PolicyArn:'owned-boundary'},denied)).rejects.toMatchObject({code:'AccessDenied',requestId:'aws-request',message:'iam:GetPolicy on owned-boundary: Denied'});expect(denied).toHaveBeenCalledTimes(1);
});
