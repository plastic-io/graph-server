const {fixture,environment}=require('../__testHelpers__/lifecycleCloud');
const {policyCoverage}=require('../iac/lifecycleAws');
const {executionPolicy,resourceArns}=require('../iac/isolation');
const {deploymentCapabilities}=require('../iac/capabilities');
const {lifecycleResultSchemas}=require('../discovery/lifecycle');
let env;beforeEach(()=>{env={...process.env};environment();});afterEach(()=>{process.env=env;});

async function failedCreation(){
 const f=await fixture('generic-role-path-regression','stack');f.installRoles();
 f.stacks.get(f.s.guardrailStack).StackStatus='CREATE_COMPLETE';
 const template=JSON.parse(f.input.text),name=template.Resources.Role.Properties.RoleName;
 f.stack(f.s.namespace+'stack','ROLLBACK_FAILED',template,[{LogicalResourceId:'Role',PhysicalResourceId:name,ResourceType:'AWS::IAM::Role',ResourceStatus:'DELETE_FAILED'}]);
 return {...f,name};
}
test('incident policy regression: absent role name probes are explicitly denied by the original NotResource rule',async()=>{
 const f=await failedCreation(),current=executionPolicy(f.s);
 const old={...current,Statement:[...current.Statement.filter(s=>!['ReadAssignedRoleExistence','DenyIamOutsideAssignedRoles','DenyNameOnlyRoleMutation'].includes(s.Sid)),{Effect:'Deny',Action:['iam:*'],NotResource:resourceArns(f.s).iam}]};
 const role=f.roles.get(f.s.namespace+'execution');role.policy=old;
 const inspection=await f.aws.inspect(f.source),r=inspection.applicationRoleLifecycle.roles[0];
 expect(r).toMatchObject({exists:false,cloudFormationStatus:'DELETE_FAILED',actualArn:null});
 expect(r.checks.filter(c=>c.phase==='before-creation').map(c=>c.result)).toEqual(['explicit-deny','explicit-deny']);
 const root=`arn:aws:iam::${f.s.account}:role/${f.name}`;
 for(const action of ['iam:GetRole','iam:GetRolePolicy','iam:ListRolePolicies','iam:DeleteRolePolicy'])expect(policyCoverage(old,action,root)).toBe('explicit-deny');
 expect(inspection.applicationRoleLifecycle.deploymentTested).toBe(false);
 expect(inspection.awsVerification.checks).toContainEqual(expect.objectContaining({component:'application-role',action:'iam:GetRole',result:'absent'}));
 expect(f.calls.every(c=>!['deleteStack','updateStack','createStack','putRolePolicy','deleteRolePolicy','deleteRole'].includes(c.method))).toBe(true);
});
test('new execution policy and physical absence are reported separately from historical CloudFormation failure',async()=>{
 const f=await failedCreation(),i=await f.aws.inspect(f.source),r=i.applicationRoleLifecycle.roles[0];
 expect(r.checks.filter(c=>c.phase==='before-creation').every(c=>c.result==='allowed-by-document')).toBe(true);
 expect(r.checks.filter(c=>c.action==='iam:CreateRole')[0].result).toBe('conditional-or-unknown');
 expect(i.application.resources[0]).toMatchObject({status:'DELETE_FAILED',exists:false});
 const parsed=lifecycleResultSchemas['iac.inspect'].safeParse({...i,operationId:f.source.operationId,nextActions:{retryable:false,automaticRetry:false,blockingPrerequisites:[],actions:[]}});
 expect(parsed.success).toBe(true);
});
test('application IAM denial is unknown, never physical absence or permission to clean up',async()=>{
 const f=await failedCreation(),read=f.clients.iam.getMockImplementation();
 f.clients.iam.mockImplementation(async(m,a)=>{if(m==='getRole'&&a.RoleName===f.name)throw Object.assign(new Error('access denied'),{code:'AccessDenied'});return read(m,a);});
 const i=await f.aws.inspect(f.source);
 expect(i.application.resources[0].exists).toBe('unknown');expect(i.applicationRoleLifecycle.roles[0].exists).toBe('unknown');
 expect(i.blockers).toContainEqual(expect.objectContaining({code:'AWS_CHECK_FAILED',component:'application-role',kind:'platform-permission'}));
 expect(i.canReview).toBe(false);
});
test.each(['wrong-path','wrong-boundary'])('actual application role %s blocks ownership and cannot be repaired as graph-owned',async which=>{
 const f=await failedCreation();f.roles.set(f.name,{Arn:`arn:aws:iam::${f.s.account}:role/${which==='wrong-path'?'other':'graph-app'}/${f.name}`,RoleId:'fixture-role',PermissionsBoundary:{PermissionsBoundaryArn:which==='wrong-boundary'?'arn:aws:iam::230639770018:policy/foreign':f.s.boundaryArn}});
 const i=await f.aws.inspect(f.source);
 expect(i.blockers).toContainEqual(expect.objectContaining({code:'APPLICATION_ROLE_OWNERSHIP_UNVERIFIED'}));
 expect(i.application.resources[0]).toMatchObject({exists:true,ownershipVerified:false});expect(i.canReview).toBe(false);
});
test('policy document analysis honours negative selectors and does not claim conditional grants are effective permissions',()=>{
 const p={Statement:[{Effect:'Allow',Action:'iam:*',Resource:'*'},{Effect:'Deny',NotAction:'iam:GetRole',Resource:'arn:aws:iam::1:role/name'}]};
 expect(policyCoverage(p,'iam:DeleteRolePolicy','arn:aws:iam::1:role/name')).toBe('explicit-deny');
 expect(policyCoverage(p,'iam:GetRole','arn:aws:iam::1:role/name')).toBe('allowed-by-document');
 p.Statement.push({Effect:'Deny',Action:'iam:GetRole',Resource:'*',Condition:{StringEquals:{some:'value'}}});
 expect(policyCoverage(p,'iam:GetRole','arn:aws:iam::1:role/name')).toBe('conditional-or-unknown');
});
test('static deployability never claims verified CloudFormation IAM execution',async()=>{
 const f=await failedCreation(),c=deploymentCapabilities(f.s.graphId,f.s.nodeId,f.graph.nodes[0].properties.iac,undefined,true);
 expect(c.effectivePermissions).toMatchObject({status:'unverified',inspect:'iac.inspect'});
 expect(c.evidence.awsPermissionsVerified).toBe(false);
 expect(c.effectivePermissions.applicationRoles.absentRoleCleanup).toMatch(/intentionally denied/);
});
