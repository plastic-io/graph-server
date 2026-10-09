const {CloudFormationClient}=require('@aws-sdk/client-cloudformation');
const {verifyReviewStack}=require('../iac/reviewStack');
const {Guardrails}=require('../iac/guardrails');
const {fixture,environment,human,read,save}=require('../__testHelpers__/lifecycleCloud');
const {IacReviewService}=require('../iac/review');
const {recoveryPlan}=require('../iac/lifecycleModel');
let env;
beforeEach(()=>{env={...process.env};environment();});
afterEach(()=>{jest.restoreAllMocks();process.env=env;});

async function reviewFixture(){
 const f=await fixture('empty-review-regression','stack');f.installRoles();
 const guard=f.stacks.get(f.s.guardrailStack);guard.StackStatus='CREATE_COMPLETE';
 guard.resources=guard.resources.map(r=>({...r,ResourceStatus:'CREATE_COMPLETE'}));
 const stack=f.stack(f.s.namespace+'stack','REVIEW_IN_PROGRESS',undefined,[]);stack.Tags=[];
 const op={...f.source,manualRecoveryRequired:false,stackExists:false,stackId:stack.StackId,
  changeSetName:'review-'+f.s.namespace+f.source.operationId,
  changeSetId:`arn:aws:cloudformation:${f.s.region}:${f.s.account}:changeSet/review-${f.s.namespace}${f.source.operationId}/recorded-change-set`};
 const changes={ChangeSetName:op.changeSetName,ChangeSetId:op.changeSetId,StackId:stack.StackId,StackName:stack.StackName,
  Description:'Reviewed graph infrastructure '+op.operationId,Status:'CREATE_COMPLETE',ExecutionStatus:'AVAILABLE',
  Tags:[{Key:'GraphId',Value:f.s.graphId},{Key:'NodeId',Value:f.s.nodeId},{Key:'GraphStack',Value:f.s.namespace}]};
 const original=f.clients.cloud.getMockImplementation();
 f.clients.cloud.mockImplementation(async(method,args)=>method==='describeChangeSet'?changes:original(method,args));
 await save(f.store,IacReviewService.key(op.operationId),op);
 return {...f,op,app:stack,changes};
}

test('a recorded CREATE change set proves an empty untagged review stack without reading a nonexistent deployed template',async()=>{
 const f=await reviewFixture(),inspection=await f.aws.inspect(f.op);
 expect(inspection.application).toMatchObject({status:'REVIEW_IN_PROGRESS',ownership:'verified',resources:[],reviewStackProof:{operationId:f.op.operationId,stackId:f.app.StackId,changeSetId:f.op.changeSetId}});
 expect(inspection.blockers).toEqual([]);expect(inspection.canReview).toBe(true);
 expect(inspection.recoveryReadiness.state).toBe('not-required');
 expect(f.calls.some(c=>c.method==='getTemplate'&&c.args.StackName===f.app.StackId)).toBe(false);
 expect(recoveryPlan(f.op,inspection,{preservation:'strict'}).actions.map(a=>a.kind)).toEqual(['release-operation']);
 expect(f.calls.every(c=>/^(get|list|describe)/i.test(c.method))).toBe(true);
});

test('strict guardrail polling accepts only the recorded empty review stack and performs no preparatory mutation',async()=>{
 const f=await reviewFixture(),guard=f.stacks.get(f.s.guardrailStack);
 const send=jest.spyOn(CloudFormationClient.prototype,'send').mockImplementation(async command=>{
  const type=command.constructor.name;
  if(type==='DescribeStacksCommand')return {Stacks:[command.input.StackName===f.s.guardrailStack?guard:f.app]};
  if(type==='DescribeChangeSetCommand')return f.changes;
  if(type==='ListStackResourcesCommand')return {StackResourceSummaries:[]};
  if(type==='GetTemplateCommand')return {TemplateBody:JSON.stringify(f.approved)};
  throw new Error('Unexpected mutation: '+type);
 });
 expect(await new Guardrails(f.s.region,process.env.IAC_GUARDRAIL_ROLE_ARN,process.env.IAC_WORKER_ROLE_ARN).ensure(f.s,'strict',f.op)).toBe(true);
 expect(send.mock.calls.every(([c])=>/^(Describe|Get|List)/.test(c.constructor.name))).toBe(true);
});

test.each([
 ['another graph',f=>{f.op.graphId='another-graph';}],
 ['another node',f=>{f.op.nodeId='another-node';}],
 ['another role',f=>{f.app.RoleARN=f.s.workerRoleArn;}],
 ['another stack identity',f=>{f.app.StackId+='-replaced';}],
 ['unrecorded change set',f=>{delete f.op.changeSetId;}],
 ['mismatched change set',f=>{f.changes.ChangeSetId+='-other';}],
 ['wrong change-set graph tag',f=>{f.changes.Tags[0].Value='another-graph';}],
 ['conflicting stack tags',f=>{f.app.Tags=[{Key:'GraphId',Value:'another-graph'}];}],
 ['wrong operation description',f=>{f.changes.Description='unrelated';}],
 ['executing change set',f=>{f.changes.ExecutionStatus='EXECUTE_IN_PROGRESS';}],
 ['non-review state',f=>{f.app.StackStatus='CREATE_COMPLETE';}],
])('rejects %s even when names share a namespace',async(_name,alter)=>{
 const f=await reviewFixture();alter(f);
 expect(await verifyReviewStack(f.s,f.app,f.op,f.clients.cloud)).toBeUndefined();
});

test.each([
 ['existing resources',{StackResourceSummaries:[{LogicalResourceId:'Data'}]}],
 ['truncated inventory',{StackResourceSummaries:[],NextToken:'more'}],
 ['missing inventory',{}],
])('does not infer an empty review from %s',async(_name,inventory)=>{
 const f=await reviewFixture(),call=async method=>method==='describeChangeSet'?f.changes:inventory;
 expect(await verifyReviewStack(f.s,f.app,f.op,call)).toBeUndefined();
});

test('access denial remains an actionable AWS failure and cannot authorize guardrail mutation',async()=>{
 const f=await reviewFixture(),denied=Object.assign(new Error('CloudFormation read denied'),{code:'AccessDenied'}),original=f.clients.cloud.getMockImplementation();
 f.clients.cloud.mockRejectedValue(denied);
 await expect(verifyReviewStack(f.s,f.app,f.op,f.clients.cloud)).rejects.toBe(denied);
 f.clients.cloud.mockImplementation(async(method,args)=>method==='describeChangeSet'?Promise.reject(denied):original(method,args));
 const inspected=await f.aws.inspect(f.op);
 expect(inspected.canReview).toBe(false);
 expect(inspected.blockers.some(b=>b.code==='AWS_CHECK_FAILED'&&b.action==='cloudformation:DescribeChangeSet')).toBe(true);
});

test('a fresh strict review carries verified ownership, needs a new approval and retains the old change set',async()=>{
 const f=await reviewFixture();
 f.graph.nodes[0].properties.iac.template={format:'json',text:JSON.stringify({Resources:{Queue:{Type:'AWS::SQS::Queue',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{QueueName:f.s.namespace+'probe'}}}})};
 const next=await f.reviews.begin(f.s.graphId,f.s.nodeId,human,false,'apply',f.op.operationId,'strict');
 expect(next).toMatchObject({state:'planning',preservation:'strict',previousOperationId:f.op.operationId,reviewStackProof:{operationId:f.op.operationId,stackId:f.app.StackId,changeSetId:f.op.changeSetId}});
 expect(next.approval).toBeUndefined();expect(next.reviewDigest).toBeUndefined();
 expect(f.deployCloud.execute).not.toHaveBeenCalled();expect(f.deployCloud.remove).not.toHaveBeenCalled();
 const stored=await read(f.store,IacReviewService.key(next.operationId));
 expect(await verifyReviewStack(f.s,f.app,stored,f.clients.cloud)).toEqual(next.reviewStackProof);
 await expect(f.reviews.approve(f.s.graphId,f.s.nodeId,human,{operationId:f.op.operationId,reviewDigest:'old-digest'})).rejects.toMatchObject({code:'STALE_REVIEW'});
});
