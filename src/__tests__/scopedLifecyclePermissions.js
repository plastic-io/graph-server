const fs=require('fs'),path=require('path'),yaml=require('yaml');
const {environment,fixture}=require('../__testHelpers__/lifecycleCloud');
const {policyCoverage}=require('../iac/lifecycleAws');
const {guardrailTemplate}=require('../iac/guardrails');
const {executionPolicy}=require('../iac/isolation');
const provider=require('../__testHelpers__/guardrailProviderContracts.json');
const service=yaml.parse(fs.readFileSync(path.join(__dirname,'../../serverless.yaml'),'utf8'),{logLevel:'silent'});
let env;beforeEach(()=>{env={...process.env};environment();});afterEach(()=>{process.env=env;});
function platformPolicy(name){return JSON.parse(JSON.stringify(service.resources.Resources[name].Properties.Policies[0].PolicyDocument).replaceAll('${AWS::Partition}','aws').replaceAll('${AWS::Region}','us-west-1').replaceAll('${AWS::AccountId}','230639770018'));}

test('fixed guardrail creation, read, policy update and legacy cleanup have scoped document grants; historical denials are not new missing permissions',async()=>{
 const f=await fixture('permission-audit-fixture','stack'),doc=platformPolicy('IacGuardrailRole'),defined=guardrailTemplate(f.s,process.env.IAC_WORKER_ROLE_ARN);
 // Provider operations for optional properties are not a reason to grant broad
 // IAM. The fixed platform definition cannot request those properties.
 for(const logical of ['ExecutionRole','WorkerRole'])for(const key of ['ManagedPolicyArns','PermissionsBoundary','MaxSessionDuration','Description'])expect(defined.Resources[logical].Properties[key]).toBeUndefined();
 for(const key of ['Roles','Users','Groups'])expect(defined.Resources.RuntimeBoundary.Properties[key]).toBeUndefined();
 const roleConditional=new Set(['iam:AttachRolePolicy','iam:DetachRolePolicy','iam:DeleteRolePermissionsBoundary','iam:PutRolePermissionsBoundary','iam:UpdateRole','iam:UpdateRoleDescription']);
 const boundaryConditional=new Set(['iam:AttachGroupPolicy','iam:AttachUserPolicy','iam:AttachRolePolicy','iam:DetachGroupPolicy','iam:DetachUserPolicy','iam:DetachRolePolicy']);
 for(const type of ['AWS::IAM::Role','AWS::IAM::ManagedPolicy'])for(const phase of ['create','read','update','delete'])for(const action of provider.resources[type].handlerPermissions[phase]){
  if((type==='AWS::IAM::Role'?roleConditional:boundaryConditional).has(action))continue;
  expect(policyCoverage(doc,action,type==='AWS::IAM::Role'?f.s.roleArn:f.s.boundaryArn)).toBe('allowed-by-document');
  expect(policyCoverage(doc,action,type==='AWS::IAM::Role'?'arn:aws:iam::230639770018:role/shared-platform':'arn:aws:iam::230639770018:policy/shared-platform')).toBe('not-granted');
 }
 for(const action of ['iam:GetRole','iam:GetRolePolicy','iam:DeleteRolePolicy'])expect(policyCoverage(doc,action,'arn:aws:iam::230639770018:role/'+f.s.namespace+'worker')).toBe('allowed-by-document');
 for(const action of ['iam:CreateRole','iam:PutRolePolicy','iam:DeleteRole','iam:ListRoles','iam:ListPolicies'])expect(policyCoverage(doc,action,'arn:aws:iam::230639770018:role/'+f.s.namespace+'worker')).toBe('not-granted');
 const current=await f.aws.inspect(f.source);
 expect(current.policyAnalysis.checks).toHaveLength(30);expect(current.policyAnalysis.checks.every(c=>c.result==='allowed-by-document')).toBe(true);
 expect(current.awsVerification.deploymentTested).toBe(false);expect(current.assumption.result).toBe('not-tested');
});

test('platform worker and one-stack worker cover their actual CF calls without giving applications guardrail or shared-stack access',async()=>{
 const f=await fixture('permission-audit-fixture','stack'),platform=platformPolicy('IacWorkerRole');
 const definition=guardrailTemplate(f.s,process.env.IAC_WORKER_ROLE_ARN),worker=definition.Resources.WorkerRole.Properties.Policies[0].PolicyDocument;
 const guardArn=`arn:aws:cloudformation:${f.s.region}:${f.s.account}:stack/${f.s.guardrailStack}/fixture`,appArn=`arn:aws:cloudformation:${f.s.region}:${f.s.account}:stack/${f.s.namespace}stack/fixture`;
 for(const action of ['CreateStack','UpdateStack','DescribeStacks','GetTemplate','ListStackResources','CreateChangeSet','DescribeChangeSet','ExecuteChangeSet','ContinueUpdateRollback','RollbackStack','DeleteStack'])expect(policyCoverage(platform,'cloudformation:'+action,guardArn)).toBe('allowed-by-document');
 for(const action of ['CreateChangeSet','DescribeChangeSet','ExecuteChangeSet','DeleteChangeSet','DescribeStacks','DescribeStackResources','ListStackResources','GetTemplate','DeleteStack','ContinueUpdateRollback','RollbackStack']){
  expect(policyCoverage(worker,'cloudformation:'+action,appArn)).toBe('allowed-by-document');
  expect(policyCoverage(worker,'cloudformation:'+action,guardArn)).toBe('not-granted');
  expect(policyCoverage(worker,'cloudformation:'+action,'arn:aws:cloudformation:us-west-1:230639770018:stack/unrelated-project/id')).toBe('not-granted');
 }
 expect(worker.Statement.find(s=>s.Effect==='Allow'&&s.Action==='iam:PassRole')).toEqual({Effect:'Allow',Action:'iam:PassRole',Resource:f.s.roleArn,Condition:{StringEquals:{'iam:PassedToService':'cloudformation.amazonaws.com'}}});
 const deploy=executionPolicy(f.s),role='arn:aws:iam::230639770018:role/graph-app/'+f.s.namespace+'runtime';
 for(const action of ['iam:GetRole','iam:GetRolePolicy','iam:DeleteRolePolicy','iam:DeleteRole','iam:ListRolePolicies','iam:ListAttachedRolePolicies','iam:PutRolePolicy','iam:UpdateAssumeRolePolicy']){
  expect(policyCoverage(deploy,action,role)).toBe('allowed-by-document');
  expect(policyCoverage(deploy,action,f.s.workerRoleArn)).toBe('not-granted');
 }
 expect(policyCoverage(deploy,'iam:DeleteRolePermissionsBoundary',role)).toBe('explicit-deny');
 expect(policyCoverage(deploy,'iam:CreatePolicyVersion',f.s.boundaryArn)).toBe('explicit-deny');
});
