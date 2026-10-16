const {CloudFormationClient}=require('@aws-sdk/client-cloudformation');
const {Guardrails,guardrailTemplate}=require('../iac/guardrails');
const {reviewCloud}=require('../iac/reviewAws');
const {fixture,environment,human,read,save}=require('../__testHelpers__/lifecycleCloud');
const {operationKey}=require('../iac/lifecycleModel');
const {stackScope}=require('../iac/isolation');
const {DEFAULT_POLICY}=require('../iac/types');
let env,send;
beforeEach(()=>{env={...process.env};environment();send=jest.spyOn(CloudFormationClient.prototype,'send');});
afterEach(()=>{jest.restoreAllMocks();process.env=env;});
const scope=()=>stackScope('preservation-aws-fixture','stack',{...DEFAULT_POLICY,accounts:['230639770018'],regions:['us-west-1']});
const absent=()=>Object.assign(new Error('Stack with id fixture does not exist'),{name:'ValidationError'});

test('strict guardrail creation preserves provisioned resources on failure and uses only the platform guardrail service role',async()=>{
 const s=scope();send.mockImplementation(async command=>{if(command.constructor.name==='DescribeStacksCommand')throw absent();if(command.constructor.name==='CreateStackCommand')return {};throw new Error('Unexpected AWS call');});
 const guardrails=new Guardrails(s.region,process.env.IAC_GUARDRAIL_ROLE_ARN,process.env.IAC_WORKER_ROLE_ARN);
 expect(await guardrails.ensure(s,'strict')).toBe(false);
 const create=send.mock.calls.find(([c])=>c.constructor.name==='CreateStackCommand')[0].input;
 expect(create).toMatchObject({StackName:s.guardrailStack,RoleARN:process.env.IAC_GUARDRAIL_ROLE_ARN,DisableRollback:true,RetainExceptOnCreate:false});
 expect(JSON.parse(create.TemplateBody)).toEqual(guardrailTemplate(s,process.env.IAC_WORKER_ROLE_ARN));
 expect(send.mock.calls.map(([c])=>c.constructor.name)).toEqual(['DescribeStacksCommand','DescribeStacksCommand','CreateStackCommand']);
});

test.each(['ROLLBACK_FAILED','DELETE_FAILED','UPDATE_ROLLBACK_FAILED'])('strict %s application blocks even preparatory guardrail mutation',async StackStatus=>{
 const s=scope();send.mockResolvedValue({Stacks:[{StackStatus,RoleARN:s.roleArn,Tags:[{Key:'GraphId',Value:s.graphId},{Key:'NodeId',Value:s.nodeId},{Key:'GraphStack',Value:s.namespace}]}]});
 await expect(new Guardrails(s.region,process.env.IAC_GUARDRAIL_ROLE_ARN,process.env.IAC_WORKER_ROLE_ARN).ensure(s,'strict')).rejects.toMatchObject({code:'PRESERVATION_BLOCKED'});
 expect(send.mock.calls.map(([c])=>c.constructor.name)).toEqual(['DescribeStacksCommand']);
});

test('an AWS access denial is never classified as stack absence or permission to create guardrails',async()=>{
 const s=scope();send.mockRejectedValue(Object.assign(new Error('AccessDenied: resource not found'),{name:'AccessDenied'}));
 await expect(new Guardrails(s.region,process.env.IAC_GUARDRAIL_ROLE_ARN,process.env.IAC_WORKER_ROLE_ARN).ensure(s,'strict')).rejects.toMatchObject({name:'AccessDenied'});
 expect(send.mock.calls.map(([c])=>c.constructor.name)).toEqual(['DescribeStacksCommand']);
});

test('supported strict guardrail policy reconciliation executes in place, preserves the boundary, and requires separate deployment approval',async()=>{
 const f=await fixture('preservation-aws-fixture','stack');f.installRoles();
 const st=f.stacks.get(f.s.guardrailStack);st.StackStatus='CREATE_COMPLETE';
 // Induce only a policy drift in this disposable fixture, with unchanged names.
 st.template=JSON.parse(JSON.stringify(f.approved));st.template.Resources.WorkerRole.Properties.Policies[0].PolicyDocument.Statement=[];
 f.roles.get(f.s.namespace+'worker').policy=st.template.Resources.WorkerRole.Properties.Policies[0].PolicyDocument;
 const op=await f.plan({preservation:'strict'});expect(op.state).toBe('recovery-ready');expect(op.recoveryPlan.actions.map(a=>a.kind)).toEqual(['reconcile-guardrails','release-operation']);
 await f.approve(op);for(let i=0;i<12;i++)if((await f.reviews.lifecycle.step(op.operationId)).done)break;
 const state=await read(f.store,operationKey(op.operationId));expect(state.state).toBe('recovered');expect(state.approval).toBeUndefined();
 const updates=f.calls.filter(c=>c.method==='updateStack');expect(updates).toHaveLength(1);
 expect(updates[0].args).toMatchObject({StackName:f.s.guardrailStack,RoleARN:process.env.IAC_GUARDRAIL_ROLE_ARN,DisableRollback:true});
 // The deployed v2 adapter must not send newer, unsupported request keys.
 const members=require('aws-sdk/apis/cloudformation-2010-05-15.min.json').operations.UpdateStack.input.members;
 expect(Object.keys(updates[0].args).every(k=>members[k])).toBe(true);
 expect(f.calls.some(c=>/^(delete|rollback|continue)/i.test(c.method))).toBe(false);
 expect(f.policies.get(f.s.boundaryArn)).toEqual(f.approved.Resources.RuntimeBoundary.Properties.PolicyDocument);
 expect(f.deployCloud.execute).not.toHaveBeenCalled();
});
