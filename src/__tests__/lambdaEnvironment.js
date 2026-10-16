const {runtimeBoundary,stackScope,validateIsolation,DATA_ACTIONS,resourceArns}=require('../iac/isolation');
const {lambdaEnvironmentAccess,lambdaEnvironmentContract}=require('../iac/lambdaEnvironment');
const {dynamoDbEncryptionContract,dynamoDbEncryptionAccess}=require('../iac/runtimeEncryption');
const {guardrailTemplate}=require('../iac/guardrails');
const {DEFAULT_POLICY}=require('../iac/types');
const {deploymentCapabilities}=require('../iac/capabilities');
const {fixture,environment,policy,read,save}=require('../__testHelpers__/lifecycleCloud');
const {operationKey}=require('../iac/lifecycleModel');
const {repairApprovedGuardrails}=require('../iac/guardrailRepair');
let env;beforeEach(()=>{env={...process.env};environment();});afterEach(()=>{process.env=env;});
const clone=x=>JSON.parse(JSON.stringify(x));
const scope=()=>stackScope('generic-lambda-env','stack',policy);
const match=(p,v)=>new RegExp('^'+p.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.')+'$').test(v);
const any=(ps,v)=>[].concat(ps||[]).some(p=>match(p,v));
// A test evaluator of this generated subset. Not an AWS simulation or service
// integration test: callers must separately verify real Lambda initialization.
function decision(doc,action,resource,context={},sessionGrant=false){
 const applicable=doc.Statement.filter(s=>{
  if(s.Action?!any(s.Action,action):any(s.NotAction,action))return false;
  if(s.Resource?!any(s.Resource,resource):any(s.NotResource,resource))return false;
  return Object.entries(s.Condition||{}).every(([operator,values])=>Object.entries(values).every(([key,want])=>{
   const actual=[].concat(context[key]||[]),expected=[].concat(want),eq=x=>expected.some(w=>operator.includes('Like')?match(w,x):w===x);
   if(['StringEquals','StringLike','ArnLike','ForAnyValue:StringEquals'].includes(operator))return actual.some(eq);
   if(['StringNotEquals','StringNotLike','ArnNotLike','ForAllValues:StringNotEquals'].includes(operator))return actual.every(x=>!eq(x));
   throw new Error('Untested IAM condition '+operator);
  }));
 });
 return applicable.some(s=>s.Effect==='Deny')?'explicitDeny':sessionGrant||applicable.some(s=>s.Effect==='Allow')?'allowed':'implicitDeny';
}
function request(s=scope()) {const a=lambdaEnvironmentAccess(s);return {key:a.keyResource.replace('*','fixture-key'),context:{'kms:ResourceAliases':[a.alias],'kms:CallerAccount':a.account,[a.contextKey]:a.functionArn.replace('*','writer')}};}
function legacy(s){const p=clone(runtimeBoundary(s));p.Statement=p.Statement.filter(x=>!x.Sid?.includes('Decrypt'));p.Statement.find(x=>x.NotAction).NotAction=Object.values(DATA_ACTIONS).flat();p.Statement.find(x=>x.NotResource).NotResource=Object.entries(resourceArns(s)).filter(([k])=>!['lambda','iam'].includes(k)).flatMap(([,v])=>v);return p;}

test('both original explicit denials independently block default environment decrypt; the fixed policy permits only the intended request',()=>{
 const s=scope(),{key,context}=request(s),p=runtimeBoundary(s),old=legacy(s);
 expect(decision(old,'kms:Decrypt',key,context,true)).toBe('explicitDeny');
 for(const field of ['NotAction','NotResource']){
  const broken=clone(p);broken.Statement[broken.Statement.findIndex(x=>x[field])]=old.Statement.find(x=>x[field]);
  expect(decision(broken,'kms:Decrypt',key,context,true)).toBe('explicitDeny');
 }
 expect(decision(p,'kms:Decrypt',key,context)).toBe('allowed');
 expect(JSON.stringify(p)).not.toMatch(/lambda:SourceFunctionArn/);expect(JSON.stringify(p.Statement.find(x=>x.Sid==='AllowOwnLambdaEnvironmentDecrypt'))).not.toMatch(/kms:ViaService/);
 expect(JSON.stringify(p).length).toBeLessThan(6144);
 expect(guardrailTemplate(s,'worker').Resources.RuntimeBoundary.Properties.PolicyDocument).toEqual(p);
});
test.each(['unrelated-key','no-alias','other-graph','no-context','other-account','no-account','other-region','foreign-key-account'])('boundary explicitly rejects %s even with a direct session resource-policy grant',which=>{
 const s=scope(),r=request(s),c=r.context,a=lambdaEnvironmentAccess(s);
 if(which==='unrelated-key')c['kms:ResourceAliases']=['alias/customer'];
 if(which==='no-alias')delete c['kms:ResourceAliases'];
 if(which==='other-graph')c[a.contextKey]=lambdaEnvironmentAccess(stackScope('other','stack',policy)).functionArn.replace('*','writer');
 if(which==='no-context')delete c[a.contextKey];
 if(which==='other-account')c['kms:CallerAccount']='111111111111';
 if(which==='no-account')delete c['kms:CallerAccount'];
 if(which==='other-region')r.key=r.key.replace('us-west-1','us-east-1');
 if(which==='foreign-key-account')r.key=r.key.replace(s.account,'111111111111');
 expect(decision(runtimeBoundary(s),'kms:Decrypt',r.key,c,true)).toBe('explicitDeny');
});
test.each(['kms:Encrypt','kms:GenerateDataKey','kms:CreateGrant','kms:PutKeyPolicy','iam:PassRole','sts:AssumeRole'])('the change grants no %s authority',action=>{
 const s=scope(),r=request(s);expect(decision(runtimeBoundary(s),action,r.key,r.context,true)).toBe('explicitDeny');
});
function tableRequest(){const s=scope(),d=dynamoDbEncryptionAccess(s);return {key:lambdaEnvironmentAccess(s).keyResource.replace('*','table-key'),context:{'kms:ResourceAliases':[d.alias],'kms:CallerAccount':d.account,'kms:ViaService':d.viaService,[d.tableContext]:s.namespace+'events',[d.subscriberContext]:d.account}};}
test('AWS-managed DynamoDB permits table-key decrypt through the service for this namespace; Lambda and table contexts remain separate',()=>{
 const s=scope(),p=runtimeBoundary(s),r=tableRequest(),l=request(s);
 expect(decision(p,'kms:Decrypt',r.key,r.context)).toBe('allowed');
 expect(decision(p,'kms:Decrypt',l.key,l.context)).toBe('allowed');
 for(const alias of ['alias/aws/lambda','alias/customer'])expect(decision(p,'kms:Decrypt',r.key,{...r.context,'kms:ResourceAliases':[alias]},true)).toBe('explicitDeny');
 expect(decision(p,'kms:Decrypt',l.key,{...l.context,'kms:ResourceAliases':['alias/aws/dynamodb']},true)).toBe('explicitDeny');
 for(const action of ['kms:Encrypt','kms:GenerateDataKey','kms:CreateGrant','kms:DescribeKey'])expect(decision(p,action,r.key,r.context,true)).toBe('explicitDeny');
 expect(JSON.stringify(p).length).toBeLessThan(6144);
});
test.each(['foreign-table','missing-table','foreign-subscriber','missing-subscriber','foreign-service','direct-kms','foreign-account','missing-account','foreign-region','no-alias'])('DynamoDB decrypt explicitly denies %s even with a session resource-policy grant',which=>{
 const s=scope(),d=dynamoDbEncryptionAccess(s),r=tableRequest();
 if(which==='foreign-table')r.context[d.tableContext]='gapp-other-events';
 if(which==='missing-table')delete r.context[d.tableContext];
 if(which==='foreign-subscriber')r.context[d.subscriberContext]='111111111111';
 if(which==='missing-subscriber')delete r.context[d.subscriberContext];
 if(which==='foreign-service')r.context['kms:ViaService']='s3.us-west-1.amazonaws.com';
 if(which==='direct-kms')delete r.context['kms:ViaService'];
 if(which==='foreign-account')r.context['kms:CallerAccount']='111111111111';
 if(which==='missing-account')delete r.context['kms:CallerAccount'];
 if(which==='foreign-region')r.key=r.key.replace('us-west-1','us-east-1');
 if(which==='no-alias')delete r.context['kms:ResourceAliases'];
 expect(decision(runtimeBoundary(s),'kms:Decrypt',r.key,r.context,true)).toBe('explicitDeny');
});
test('preflight distinguishes AWS-owned, AWS-managed and unsupported customer DynamoDB keys without rewriting encryption',()=>{
 const s=scope(),doc={Resources:{Owned:{Type:'AWS::DynamoDB::Table',Properties:{TableName:s.namespace+'owned'}},Managed:{Type:'AWS::DynamoDB::Table',Properties:{TableName:s.namespace+'managed',SSESpecification:{SSEEnabled:true}}},Custom:{Type:'AWS::DynamoDB::Table',Properties:{TableName:s.namespace+'custom',SSESpecification:{SSEEnabled:true,KMSMasterKeyId:'customer'}}}}};
 const original=JSON.stringify(doc),contract=dynamoDbEncryptionContract(s,doc);
 expect(contract.tables.map(t=>t.mode)).toEqual(['aws-owned-default','aws-managed-default','unsupported-customer-key']);
 expect(contract.awsExecutionVerified).toBe(false);expect(JSON.stringify(doc)).toBe(original);
});
test('existing data isolation remains enforced and author environment settings are not rewritten',()=>{
 const s=scope(),p=runtimeBoundary(s),own=`arn:aws:dynamodb:${s.region}:${s.account}:table/${s.namespace}events`;
 expect(decision(p,'dynamodb:PutItem',own)).toBe('allowed');expect(decision(p,'dynamodb:PutItem',own.replace(s.namespace,'gapp-another-'),{},true)).toBe('explicitDeny');
 const doc={Resources:{Writer:{Type:'AWS::Lambda::Function',Properties:{FunctionName:s.namespace+'writer',Environment:{Variables:{TABLE:s.namespace+'events'}}}}}},text=JSON.stringify(doc);
 expect(lambdaEnvironmentContract(s,doc)).toMatchObject({awsExecutionVerified:false,functions:[{logicalId:'Writer',mode:'aws-managed-default',environmentDeclared:true}]});
 expect(validateIsolation(text,'json',s).some(x=>x.code==='LAMBDA_ENCRYPTION_UNSUPPORTED')).toBe(false);
 doc.Resources.Writer.Properties.KMSKeyArn='arn:aws:kms:us-west-1:230639770018:key/customer';const custom=JSON.stringify(doc);
 expect(validateIsolation(custom,'json',s)).toContainEqual(expect.objectContaining({code:'LAMBDA_ENCRYPTION_UNSUPPORTED',path:'Resources.Writer.Properties.KMSKeyArn'}));
 expect(JSON.stringify(doc)).toBe(custom);
});
async function oldBoundary(){
 const f=await fixture('default-env-regression','stack');f.installRoles();
 const st=f.stacks.get(f.s.guardrailStack);st.StackStatus='CREATE_COMPLETE';st.template=clone(f.approved);st.template.Resources.RuntimeBoundary.Properties.PolicyDocument=legacy(f.s);f.policies.set(f.s.boundaryArn,legacy(f.s));
 return f;
}
test('inspection distinguishes installed incompatibility, actual read calls and unverified runtime; strict exact-digest recovery changes only guardrail policy',async()=>{
 const f=await oldBoundary(),i=await f.aws.inspect(f.source);
 expect(i.lambdaEnvironmentEncryption).toMatchObject({installedBoundaryMatches:false,installedDecryptAnalysis:'explicit-deny',effectivePermissionsVerified:false,actualLambdaConfigurationVerified:false});
 expect(i.boundary.versionInventory).toMatchObject({complete:true,freeSlots:4});expect(i.recoveryReadiness.state).toBe('review-available');
 const preflight=deploymentCapabilities(f.s.graphId,f.s.nodeId,f.graph.nodes[0].properties.iac,policy,true);
 expect(preflight.lambdaEnvironmentEncryption.awsExecutionVerified).toBe(false);
 const op=await f.plan({preservation:'strict'});
 expect(op.state).toBe('recovery-ready');expect(op.recoveryPlan.actions.map(a=>a.kind)).toEqual(['reconcile-guardrails','release-operation']);
 expect(op.recoveryPlan.actions[0].resources).toContainEqual(expect.objectContaining({logicalId:'RuntimeBoundary',physicalId:f.s.boundaryArn,outcome:'Update approved policy in place',retention:'Retain'}));
 expect(f.calls.some(c=>c.method==='updateStack')).toBe(false);
 await f.approve(op);for(let n=0;n<12;n++)if((await f.reviews.lifecycle.step(op.operationId)).done)break;
 expect((await read(f.store,operationKey(op.operationId))).state).toBe('recovered');
 expect(f.calls.filter(c=>c.method==='updateStack')).toHaveLength(1);expect(f.calls.some(c=>/^(delete|rollback|continue)/i.test(c.method))).toBe(false);
 expect(f.deployCloud.execute).not.toHaveBeenCalled();expect(f.policies.get(f.s.boundaryArn)).toEqual(runtimeBoundary(f.s));
 const after=await f.aws.inspect(f.source);expect(after.lambdaEnvironmentEncryption).toMatchObject({installedBoundaryMatches:true,installedDecryptAnalysis:'conditional-or-unknown',effectivePermissionsVerified:false});
});
test.each(['full','truncated','denied'])('boundary migration stops before mutation when policy-version inventory is %s',async which=>{
 const f=await oldBoundary(),iam=f.clients.iam.getMockImplementation();
 f.clients.iam.mockImplementation((m,a)=>{
  if(m!=='listPolicyVersions')return iam(m,a);
  if(which==='denied')throw Object.assign(new Error('ListPolicyVersions denied'),{code:'AccessDenied'});
  return {IsTruncated:which==='truncated',Versions:Array.from({length:which==='full'?5:1},(_,i)=>({VersionId:'v'+(i+1),IsDefaultVersion:!i}))};
 });
 const op=await f.plan({preservation:'strict'});expect(op.state).toBe('recovery-blocked');expect(op.recoveryPlan.prerequisites.some(b=>b.code==='BOUNDARY_VERSION_CAPACITY')).toBe(true);
 expect(f.calls.some(c=>/^(delete|put|create|update)/i.test(c.method))).toBe(false);
});
test('stale boundary versions invalidate recovery approval and never reach CloudFormation',async()=>{
 const f=await oldBoundary(),op=await f.plan({preservation:'strict'}),iam=f.clients.iam.getMockImplementation();
 f.clients.iam.mockImplementation((m,a)=>m==='listPolicyVersions'?{Versions:[{VersionId:'v1',IsDefaultVersion:true},{VersionId:'v2',IsDefaultVersion:false}]}:iam(m,a));
 await expect(f.approve(op)).rejects.toMatchObject({code:'STALE_RECOVERY'});expect(f.calls.some(c=>c.method==='updateStack')).toBe(false);
});
test('private repair validates all consumers before any IAM writes and never prunes policy history',async()=>{
 const f=await oldBoundary(),op=await f.plan({preservation:'strict'});await f.approve(op);
 const row=await read(f.store,operationKey(op.operationId));row.state='recovering';row.recoveryIndex=0;row.recoveryLease={id:'owned',until:Date.now()+90000};await save(f.store,operationKey(op.operationId),row);
 const calls=[],iam=async(m,a)=>{calls.push([m,a]);if(['putRolePolicy','updateAssumeRolePolicy','createPolicyVersion'].includes(m))return {};return f.clients.iam(m,a);};
 await repairApprovedGuardrails(f.store,{operationId:op.operationId,leaseId:'owned'},iam,policy,f.clients.cloud);
 expect(calls.filter(([m])=>m==='createPolicyVersion')).toHaveLength(1);expect(calls.some(([m])=>m.startsWith('delete'))).toBe(false);
 calls.length=0;const unsafe=(m,a)=>m==='listEntitiesForPolicy'?{PolicyRoles:[{RoleName:'gapp-foreign-writer'}]}:iam(m,a);
 await expect(repairApprovedGuardrails(f.store,{operationId:op.operationId,leaseId:'owned'},unsafe,policy,f.clients.cloud)).rejects.toMatchObject({code:'OWNERSHIP_UNVERIFIED'});
 expect(calls.some(([m])=>/^(put|update|create|delete)/i.test(m))).toBe(false);
});
