import {createHash} from 'crypto';
import {parseTemplate} from './validator';
import {IacPolicy} from './types';

export const ISOLATION_VERSION='stack-namespace-v1';
export const ISOLATED_TYPES=[
 'AWS::S3::Bucket','AWS::S3::BucketPolicy','AWS::DynamoDB::Table','AWS::SQS::Queue','AWS::SQS::QueuePolicy','AWS::SNS::Topic','AWS::SNS::TopicPolicy','AWS::Logs::LogGroup',
 'AWS::Lambda::Function','AWS::Lambda::Permission','AWS::Lambda::Version','AWS::Lambda::Alias',
 'AWS::IAM::Role','AWS::IAM::Policy',
 'AWS::ApiGateway::RestApi','AWS::ApiGateway::Resource','AWS::ApiGateway::Method','AWS::ApiGateway::Deployment','AWS::ApiGateway::Stage','AWS::ApiGateway::Authorizer',
];
export interface StackScope {version:string;graphId:string;nodeId:string;namespace:string;account:string;region:string;roleArn:string;boundaryArn:string;workerRoleArn:string;guardrailStack:string;}
export function scopedPolicy(scope:StackScope,policy:IacPolicy):IacPolicy{return {...policy,accounts:[scope.account],regions:[scope.region],stackPrefix:scope.namespace,permissionsBoundaryArn:scope.boundaryArn};}
/** Assigned by the platform. No namespace, role ARN, boundary or account comes from a client claim. */
export function stackScope(graphId:string,nodeId:string,policy:IacPolicy):StackScope {
 if(!/^[A-Za-z0-9_.-]{1,64}$/.test(graphId)||!/^[A-Za-z0-9_.-]{1,64}$/.test(nodeId))throw new Error('Invalid stack binding');
 const account=policy.accounts[0]||'',region=policy.regions[0]||'';
 const hash=createHash('sha256').update(JSON.stringify([process.env.SERVICE_NAME||'graph-server',process.env.STAGE||'local',account,region,graphId,nodeId])).digest('hex').slice(0,24);
 const namespace='gapp-'+hash+'-';
 const arn=`arn:aws:iam::${account}`;
 return {version:ISOLATION_VERSION,graphId,nodeId,namespace,account,region,roleArn:`${arn}:role/graph-deploy/${namespace}execution`,boundaryArn:`${arn}:policy/graph-guardrails/${namespace}runtime`,workerRoleArn:`${arn}:role/graph-deploy/${namespace}worker`,guardrailStack:`graph-guardrails-${hash}`};
}
export const DATA_ACTIONS={
 s3:['s3:GetObject','s3:PutObject','s3:DeleteObject','s3:ListBucket','s3:GetBucketLocation'],
 dynamodb:['dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:Query','dynamodb:Scan','dynamodb:BatchGetItem','dynamodb:BatchWriteItem','dynamodb:ConditionCheckItem','dynamodb:DescribeTable'],
 sqs:['sqs:SendMessage','sqs:ReceiveMessage','sqs:DeleteMessage','sqs:ChangeMessageVisibility','sqs:GetQueueAttributes','sqs:GetQueueUrl'],
 sns:['sns:Publish'],logs:['logs:CreateLogStream','logs:PutLogEvents'],
};
export function resourceArns(s:StackScope):Record<string,string[]> {
 const p=s.namespace,r=s.region,a=s.account;
 return {s3:[`arn:aws:s3:::${p}*`,`arn:aws:s3:::${p}*/*`],dynamodb:[`arn:aws:dynamodb:${r}:${a}:table/${p}*`],sqs:[`arn:aws:sqs:${r}:${a}:${p}*`],sns:[`arn:aws:sns:${r}:${a}:${p}*`],logs:[`arn:aws:logs:${r}:${a}:log-group:/aws/lambda/${p}*`,`arn:aws:logs:${r}:${a}:log-group:${p}*`],lambda:[`arn:aws:lambda:${r}:${a}:function:${p}*`],iam:[`arn:aws:iam::${a}:role/graph-app/${p}*`]};
}
// IAM resolves name-only reads of an absent role against role/<RoleName>,
// before there is a stored Path. Do not extend write or PassRole permissions to
// that ARN: an existing root-path role with the same prefix is not graph-owned.
export const ROLE_EXISTENCE_READS=['iam:GetRole','iam:GetRolePolicy'];
export const roleNameProbeArn=(s:StackScope)=>`arn:aws:iam::${s.account}:role/${s.namespace}*`;
const statements=(s:StackScope,actions:Record<string,string[]>)=>Object.entries(actions).map(([service,Action])=>({Effect:'Allow',Action,Resource:resourceArns(s)[service]}));
export function runtimeBoundary(s:StackScope){
 const own=Object.entries(resourceArns(s)).filter(([k])=>k!=='iam'&&k!=='lambda').flatMap(([,v])=>v);
 return {Version:'2012-10-17',Statement:[...statements(s,DATA_ACTIONS),
  {Effect:'Deny',NotAction:Object.values(DATA_ACTIONS).flat(),Resource:'*'},
  {Effect:'Deny',Action:'*',NotResource:own},
 ]};
}
/** Every AWS grant is either namespace-scoped, or a documented tag-gated API creation action. */
export function executionPolicy(s:StackScope){
 const r=resourceArns(s),api=`arn:aws:apigateway:${s.region}::`,tag={'aws:ResourceTag/GraphStack':s.namespace};
 const allowed=[
  ...statements(s,{s3:['s3:*'],dynamodb:['dynamodb:*'],sqs:['sqs:*'],sns:['sns:*'],logs:['logs:CreateLogGroup','logs:DeleteLogGroup','logs:PutRetentionPolicy','logs:DeleteRetentionPolicy','logs:TagResource','logs:UntagResource','logs:ListTagsForResource'],lambda:['lambda:CreateFunction','lambda:DeleteFunction','lambda:GetFunction','lambda:GetFunctionConfiguration','lambda:UpdateFunctionCode','lambda:UpdateFunctionConfiguration','lambda:TagResource','lambda:UntagResource','lambda:ListTags','lambda:PublishVersion','lambda:ListVersionsByFunction','lambda:CreateAlias','lambda:GetAlias','lambda:UpdateAlias','lambda:DeleteAlias','lambda:RemovePermission','lambda:GetPolicy']}),
  {Effect:'Allow',Action:'lambda:AddPermission',Resource:r.lambda,Condition:{StringEquals:{'lambda:Principal':'apigateway.amazonaws.com'}}},
  {Effect:'Allow',Action:['iam:CreateRole','iam:PutRolePermissionsBoundary'],Resource:r.iam,Condition:{StringEquals:{'iam:PermissionsBoundary':s.boundaryArn}}},
  {Effect:'Allow',Action:['iam:GetRole','iam:DeleteRole','iam:PutRolePolicy','iam:GetRolePolicy','iam:DeleteRolePolicy','iam:ListRolePolicies','iam:ListAttachedRolePolicies','iam:ListInstanceProfilesForRole','iam:TagRole','iam:UntagRole','iam:UpdateAssumeRolePolicy','iam:UpdateRole','iam:UpdateRoleDescription','iam:ListRoleTags'],Resource:r.iam},
  {Sid:'ReadAssignedRoleExistence',Effect:'Allow',Action:ROLE_EXISTENCE_READS,Resource:roleNameProbeArn(s)},
  {Effect:'Allow',Action:'iam:PassRole',Resource:r.iam,Condition:{StringEquals:{'iam:PassedToService':'lambda.amazonaws.com'}}},
  // API IDs are assigned by AWS, not chosen by the graph. REST API child resources inherit tags for ABAC.
  {Effect:'Allow',Action:'apigateway:POST',Resource:api+'/restapis',Condition:{StringEquals:{'aws:RequestTag/GraphStack':s.namespace},StringLike:{'apigateway:Request/ApiName':s.namespace+'*'}}},
  {Effect:'Allow',Action:['apigateway:GET','apigateway:POST','apigateway:PUT','apigateway:PATCH','apigateway:DELETE'],Resource:api+'/restapis/*',Condition:{StringEquals:tag}},
  // AWS separately checks GET/PATCH on the target API (tag-gated above) and the
  // /tags endpoint. /tags itself does not support aws:ResourceTag. The second
  // authorization cannot grant access to a foreign target or alter ownership.
  // https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-tagging-iam-policy.html
  {Effect:'Allow',Action:['apigateway:GET','apigateway:PUT','apigateway:POST','apigateway:DELETE'],Resource:api+'/tags/*',Condition:{'ForAllValues:StringNotEquals':{'aws:TagKeys':'GraphStack'}}},
 ];
 return {Version:'2012-10-17',Statement:[...allowed,
  {Effect:'Deny',Action:['iam:DeleteRolePermissionsBoundary','iam:AttachRolePolicy','iam:DetachRolePolicy','iam:CreatePolicy','iam:CreatePolicyVersion','iam:SetDefaultPolicyVersion','iam:DeletePolicy','iam:DeletePolicyVersion'],Resource:'*'},
  {Effect:'Deny',Action:['iam:CreateRole','iam:PutRolePermissionsBoundary'],Resource:'*',Condition:{StringNotEquals:{'iam:PermissionsBoundary':s.boundaryArn}}},
  {Effect:'Deny',Action:'apigateway:*',Resource:api+'/tags/*',Condition:{'ForAnyValue:StringEquals':{'aws:TagKeys':'GraphStack'}}},
  {Effect:'Deny',Action:'apigateway:*',Resource:api+'/restapis/*',Condition:{StringNotEquals:{'aws:ResourceTag/GraphStack':s.namespace}}},
  {Sid:'DenyIamOutsideAssignedRoles',Effect:'Deny',Action:['iam:*'],NotResource:[...r.iam,roleNameProbeArn(s)]},
  {Sid:'DenyNameOnlyRoleMutation',Effect:'Deny',NotAction:ROLE_EXISTENCE_READS,Resource:roleNameProbeArn(s)},
  // Explicit denies still apply when a foreign resource policy grants a role session direct access.
  ...Object.entries(r).filter(([service])=>service!=='iam'&&service!=='logs').map(([service,Resource])=>({Effect:'Deny',Action:service+':*',NotResource:Resource})),
  {Effect:'Allow',Action:'logs:DescribeLogGroups',Resource:'*'},
  {Effect:'Deny',Action:['logs:CreateLogGroup','logs:DeleteLogGroup','logs:PutRetentionPolicy','logs:DeleteRetentionPolicy','logs:TagResource','logs:UntagResource'],NotResource:r.logs},
  {Effect:'Deny',Action:'apigateway:*',NotResource:[api+'/restapis',api+'/restapis/*',api+'/tags/*']},
 ]};
}
const names:any={'AWS::S3::Bucket':'BucketName','AWS::DynamoDB::Table':'TableName','AWS::SQS::Queue':'QueueName','AWS::SNS::Topic':'TopicName','AWS::Lambda::Function':'FunctionName','AWS::IAM::Role':'RoleName','AWS::Logs::LogGroup':'LogGroupName','AWS::ApiGateway::RestApi':'Name'};
/** Fail closed on expressions that cannot be proved local. This is intentionally a supported subset of CFN. */
export function validateIsolation(text:string,format:'yaml'|'json',s:StackScope):any[]{
 const parsed=parseTemplate(text,format);if(!parsed.doc)return [{code:'TEMPLATE_UNREADABLE',message:parsed.error,path:'template'}];
 const doc=parsed.doc,resources=doc.Resources||{},errors:any[]=[];
 const issue=(path:string,message:string)=>errors.push({code:'STACK_ISOLATION',path,message});
 const localRef=(v:any,type?:string)=>v&&Object.keys(v).length===1&&typeof v.Ref==='string'&&resources[v.Ref]&&(!type||resources[v.Ref].Type===type);
 const localArn=(v:any,type?:string)=>v&&Object.keys(v).length===1&&Array.isArray(v['Fn::GetAtt'])&&v['Fn::GetAtt'][1]==='Arn'&&resources[v['Fn::GetAtt'][0]]&&(!type||resources[v['Fn::GetAtt'][0]].Type===type);
 const owned=(v:any):boolean=>{
  if(localArn(v))return !/^AWS::IAM::/.test(resources[v['Fn::GetAtt'][0]].Type);
  if(typeof v==='string')return Object.entries(resourceArns(s)).filter(([k])=>k!=='iam'&&k!=='lambda').some(([,patterns])=>patterns.some(p=>v.startsWith(p.slice(0,p.indexOf('*')))&&!v.slice(0,p.indexOf('*')).includes('*')));
  if(v?.['Fn::Sub']&&typeof v['Fn::Sub']==='string'){
   const str=v['Fn::Sub'];const replaced=str.replace(/\$\{AWS::(AccountId|Region|Partition)\}/g,(_,k)=>k==='AccountId'?s.account:k==='Region'?s.region:'aws');
   if(!replaced.includes('${'))return owned(replaced);
   return /^\$\{[A-Za-z0-9]+\.Arn\}(\/\*)?$/.test(str)&&localArn({'Fn::GetAtt':[str.match(/^\$\{([^.]+)/)[1],'Arn']});
  }return false;
 };
 const policy=(p:any,path:string,resourcePolicy=false)=>{
  if(!p||p.Version!=='2012-10-17'||!Array.isArray(p.Statement)){issue(path,'Use an explicit 2012-10-17 policy with a Statement array.');return;}
  p.Statement.forEach((st:any,i:number)=>{
   const at=path+'.Statement['+i+']';
   if(!st||typeof st!=='object'||Array.isArray(st)){issue(at,'A statement must be an object.');return;}
   if(st.NotAction||st.NotResource||st.NotPrincipal){issue(at,'Negated IAM elements are not supported in graph policies.');return;}
   if(!['Allow','Deny'].includes(st.Effect))issue(at,'Effect must be Allow or Deny.');
   const actions=[].concat(st.Action||[]);if(!actions.length)issue(at+'.Action','An action is required.');
   if(st.Effect==='Allow'&&actions.some(a=>typeof a!=='string'||!Object.values(DATA_ACTIONS).flat().includes(a)))issue(at+'.Action','Only explicitly enumerated application data actions are allowed; no IAM, STS, deployment, wildcard, or account-wide grants.');
   if(![].concat(st.Resource||[]).length||[].concat(st.Resource||[]).some(v=>!owned(v)))issue(at+'.Resource','Every resource must resolve to data owned by this stack namespace.');
   if(resourcePolicy&&st.Effect==='Allow'){
    if(!st.Principal||Object.keys(st.Principal).join()!=='AWS'||![].concat(st.Principal.AWS).every(v=>localArn(v,'AWS::IAM::Role')))issue(at+'.Principal','Resource grants may name only roles declared in this stack.');
   }else if(!resourcePolicy&&st.Principal)issue(at+'.Principal','Identity policies cannot name a Principal.');
  });
 };
 if(doc.Transform||doc.Mappings||doc.Conditions)issue('template','Transforms, mappings and conditions are outside the isolated deployment subset.');
 if(Object.values<any>(doc.Outputs||{}).some(o=>o?.Export))issue('Outputs','Account-wide exports are outside the stack namespace; use MCP stack outputs instead.');
 const walk=(v:any,path:string)=>{if(!v||typeof v!=='object')return;for(const [k,x]of Object.entries(v)){
  if(['Fn::ImportValue','Fn::Transform','Fn::If','Fn::FindInMap','Fn::Join','Fn::Select','Fn::Split'].includes(k))issue(path+'.'+k,'External or unresolved expressions cannot prove stack ownership.');
  if(k==='Ref'&&!resources[String(x)]&&!['AWS::AccountId','AWS::Region','AWS::Partition','AWS::StackName'].includes(String(x)))issue(path+'.Ref','Only local resources and supported AWS pseudo parameters may be referenced.');
  if(typeof x==='string'&&x.includes('{{resolve:'))issue(path+'.'+k,'Dynamic secret references require a separately reviewed platform integration.');
  walk(x,path+'.'+k);
 }};walk(doc,'template');
 for(const [id,r]of Object.entries<any>(resources)){
  if(!r||typeof r!=='object'||Array.isArray(r)){issue('Resources.'+id,'A resource must be an object.');continue;}
  const at='Resources.'+id,p=r.Properties||{},t=r.Type;
  if(!ISOLATED_TYPES.includes(t)){issue(at+'.Type',t+' is not deployable by this isolated role.');continue;}
  if(p.KMSMasterKeyId||p.KmsKeyId||p.KMSKeyId||p.SSESpecification?.KMSMasterKeyId||p.RedrivePolicy||p.RedriveAllowPolicy||p.Subscription||p.DataProtectionPolicy||p.ResourcePolicyDocument)issue(at+'.Properties','External encryption keys, queue destinations, subscriptions and data policies require additional scoped capabilities.');
  if(t==='AWS::DynamoDB::Table'&&(p.ImportSourceSpecification||p.Replicas||p.KinesisStreamSpecification||p.ResourcePolicy))issue(at+'.Properties','Imports, replicas, external streams and inline resource policies are not supported.');
  if(r.Condition)issue(at+'.Condition','Conditional resources are not supported.');
  if(r.DeletionPolicy==='Snapshot'||r.UpdateReplacePolicy==='Snapshot')issue(at,'None of the supported resource types supports CloudFormation Snapshot retention; use Retain or an application-owned backup capability.');
  const name=names[t];if(name&&(typeof p[name]!=='string'||!(p[name].startsWith(s.namespace)||(t==='AWS::Logs::LogGroup'&&p[name].startsWith('/aws/lambda/'+s.namespace)))||/[*$?{}]/.test(p[name])))issue(at+'.Properties.'+name,'Use a literal name beginning with '+s.namespace+'.');
  if(p.Tags){
   const entries=Array.isArray(p.Tags)?p.Tags:null;
   if(entries?.some((v:any)=>!v||typeof v.Key!=='string'||typeof v.Value!=='string'))issue(at+'.Properties.Tags','Tags must contain string Key and Value pairs.');
   const tags=entries?Object.fromEntries(entries.filter((v:any)=>v&&typeof v.Key==='string').map((v:any)=>[v.Key,v.Value])):p.Tags;
   if(tags.GraphStack&&tags.GraphStack!==s.namespace)issue(at+'.Properties.Tags','GraphStack must match the assigned namespace.');
  }
  if(t==='AWS::IAM::Role'){
   if(p.Path!=='/graph-app/')issue(at+'.Properties.Path','Application roles require /graph-app/.');
   if(p.PermissionsBoundary!==s.boundaryArn)issue(at+'.Properties.PermissionsBoundary','Use the server-assigned immutable permissions boundary.');
   if(p.ManagedPolicyArns?.length)issue(at+'.Properties.ManagedPolicyArns','Managed policy attachments are not allowed; use scoped inline policies.');
   const trust=p.AssumeRolePolicyDocument,st=trust?.Statement;
   // Compare structure, not property order, and reject malformed input as a
   // field error rather than throwing while trying to inspect a null statement.
   if(trust?.Version!=='2012-10-17'||!Array.isArray(st)||st.length!==1||!st[0]||st[0].Effect!=='Allow'||st[0].Action!=='sts:AssumeRole'||Object.keys(st[0]).some(k=>!['Effect','Principal','Action'].includes(k))||JSON.stringify(st[0].Principal)!==JSON.stringify({Service:'lambda.amazonaws.com'}))issue(at+'.Properties.AssumeRolePolicyDocument','Trust only lambda.amazonaws.com with sts:AssumeRole.');
   if(p.Policies&&!Array.isArray(p.Policies))issue(at+'.Properties.Policies','Policies must be an array.');
   else for(const [i,ip]of(p.Policies||[]).entries())policy(ip?.PolicyDocument,at+'.Properties.Policies['+i+']');
  }
  if(t==='AWS::IAM::Policy'){
   if(p.Users||p.Groups||!Array.isArray(p.Roles)||!p.Roles.length||p.Roles.some((v:any)=>!localRef(v,'AWS::IAM::Role')))issue(at+'.Properties.Roles','Policies may attach only to roles declared in this template.');
   policy(p.PolicyDocument,at+'.Properties.PolicyDocument');
  }
  if(t==='AWS::S3::Bucket'){
   if(!['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets'].every(k=>p.PublicAccessBlockConfiguration?.[k]===true))issue(at+'.Properties.PublicAccessBlockConfiguration','All four public-access blocks must be true.');
   if(p.AccessControl&&p.AccessControl!=='Private')issue(at+'.Properties.AccessControl','Buckets must remain private.');
   if(p.NotificationConfiguration||p.ReplicationConfiguration||p.WebsiteConfiguration)issue(at+'.Properties','External notifications, replication and public websites are not supported.');
   if(p.BucketEncryption?.ServerSideEncryptionConfiguration?.some((rule:any)=>rule?.ServerSideEncryptionByDefault?.SSEAlgorithm!=='AES256'))issue(at+'.Properties.BucketEncryption','Only S3-managed AES256 encryption is supported; KMS needs a separately scoped capability.');
  }
  if(t.endsWith('::BucketPolicy')||t.endsWith('::QueuePolicy')||t.endsWith('::TopicPolicy')){
   const target=t.endsWith('::BucketPolicy')?['Bucket','AWS::S3::Bucket']:t.endsWith('::QueuePolicy')?['Queues','AWS::SQS::Queue']:['Topics','AWS::SNS::Topic'];
   if(![].concat(p[target[0]]||[]).length||[].concat(p[target[0]]||[]).some(v=>!localRef(v,target[1])))issue(at+'.Properties.'+target[0],'Only resources created in this stack may receive policies.');
   policy(p.PolicyDocument,at+'.Properties.PolicyDocument',true);
  }
  if(t==='AWS::Lambda::Function'){
   if(!localArn(p.Role,'AWS::IAM::Role'))issue(at+'.Properties.Role','Function role must be an application role declared here.');
   if(!p.Code?.ZipFile||Object.keys(p.Code).length!==1||!['nodejs22.x','python3.12','python3.13'].includes(p.Runtime))issue(at+'.Properties.Code','Use inline ZipFile code and a supported runtime; external code and images are not approved by this review.');
   if(p.Layers||p.VpcConfig||p.FileSystemConfigs||p.KmsKeyArn||p.DeadLetterConfig||p.CodeSigningConfigArn||p.LoggingConfig||p.ReservedConcurrentExecutions!==undefined)issue(at+'.Properties','Layers, VPC, filesystems, external keys, destinations, signing, custom logging and reserved concurrency require additional scoped capabilities.');
   if((p.Timeout||3)>30||(p.MemorySize||128)>512)issue(at+'.Properties','Functions are limited to 30 seconds and 512 MB.');
  }
  if(t.startsWith('AWS::Lambda::')&&p.ProvisionedConcurrencyConfig)issue(at+'.Properties.ProvisionedConcurrencyConfig','Provisioned concurrency is outside this deployment subset.');
  if(['AWS::Lambda::Alias','AWS::Lambda::Version','AWS::Lambda::Permission'].includes(t)&&!localRef(p.FunctionName,'AWS::Lambda::Function'))issue(at+'.Properties.FunctionName','Use Ref to a function declared in this template.');
  if(t==='AWS::Lambda::Permission'){
   if(p.Principal!=='apigateway.amazonaws.com'||p.Action!=='lambda:InvokeFunction'||p.SourceAccount!==s.account)issue(at+'.Properties','Lambda grants must bind API Gateway, this account and this stack API.');
   const arn=p.SourceArn?.['Fn::Sub'];const match=typeof arn==='string'&&/^arn:\$\{AWS::Partition\}:execute-api:\$\{AWS::Region\}:\$\{AWS::AccountId\}:\$\{([A-Za-z0-9]+)\}\/\*\/\*\/\*$/.exec(arn);
   if(!match||resources[match[1]]?.Type!=='AWS::ApiGateway::RestApi')issue(at+'.Properties.SourceArn','SourceArn must be the execute-api ARN of a REST API declared here.');
   if(p.FunctionUrlAuthType||p.PrincipalOrgID||p.EventSourceToken)issue(at+'.Properties','Additional permission grants are not supported.');
  }
  if(t==='AWS::ApiGateway::RestApi'){
   if(p.Body||p.BodyS3Location||p.CloneFrom||p.Policy)issue(at+'.Properties','Use explicit local resources and authenticated methods; imported API definitions and policies are not supported.');
   if(JSON.stringify(p.EndpointConfiguration?.Types)!==JSON.stringify(['REGIONAL']))issue(at+'.Properties.EndpointConfiguration','Use a REGIONAL API.');
   const tags=Object.fromEntries((Array.isArray(p.Tags)?p.Tags:[]).map((v:any)=>[v?.Key,v?.Value]));if(tags.GraphStack!==s.namespace)issue(at+'.Properties.Tags','REST APIs require the immutable GraphStack tag for AWS isolation.');
  }
  if(t.startsWith('AWS::ApiGateway::')&&t!=='AWS::ApiGateway::RestApi'){
   if(!localRef(p.RestApiId,'AWS::ApiGateway::RestApi'))issue(at+'.Properties.RestApiId','API children must belong to this stack\'s REST API.');
  }
  if(t==='AWS::ApiGateway::Resource'&&!localRef(p.ParentId,'AWS::ApiGateway::Resource')&&!(p.ParentId?.['Fn::GetAtt']?.[1]==='RootResourceId'&&resources[p.ParentId['Fn::GetAtt'][0]]?.Type==='AWS::ApiGateway::RestApi'))issue(at+'.Properties.ParentId','Parent must be a resource or API root in this template.');
  if(t==='AWS::ApiGateway::Stage'&&!localRef(p.DeploymentId,'AWS::ApiGateway::Deployment'))issue(at+'.Properties.DeploymentId','Stage must use a deployment declared here.');
  if(t==='AWS::ApiGateway::Deployment'&&(p.StageName||p.StageDescription||p.DeploymentCanarySettings))issue(at+'.Properties','Declare a separate Stage; embedded stage configuration and canary routing cannot bypass stage isolation checks.');
  if(t==='AWS::ApiGateway::Stage'&&(p.AccessLogSetting||p.TracingEnabled||p.CacheClusterEnabled||p.CanarySetting||p.MethodSettings))issue(at+'.Properties','Access/execution logs, metrics, tracing, caches and canary routing require additional scoped capabilities; the platform API Gateway account role is not an application role.');
  if(t==='AWS::ApiGateway::Method'){
   if(!localRef(p.ResourceId,'AWS::ApiGateway::Resource')&&!(p.ResourceId?.['Fn::GetAtt']?.[1]==='RootResourceId'&&resources[p.ResourceId['Fn::GetAtt'][0]]?.Type==='AWS::ApiGateway::RestApi'))issue(at+'.Properties.ResourceId','Method resource must be declared here.');
   if(!['AWS_IAM','COGNITO_USER_POOLS'].includes(p.AuthorizationType))issue(at+'.Properties.AuthorizationType','Every method requires AWS_IAM or COGNITO_USER_POOLS authentication.');
   if(p.AuthorizationType==='COGNITO_USER_POOLS'&&!localRef(p.AuthorizerId,'AWS::ApiGateway::Authorizer'))issue(at+'.Properties.AuthorizerId','Use this template\'s authorizer.');
   const integration=p.Integration||{};
   const uri=integration.Uri?.['Fn::Sub'];const match=typeof uri==='string'&&/^arn:\$\{AWS::Partition\}:apigateway:\$\{AWS::Region\}:lambda:path\/2015-03-31\/functions\/\$\{([A-Za-z0-9]+)\.Arn\}\/invocations$/.exec(uri);
   if(integration.Type!=='AWS_PROXY'||integration.IntegrationHttpMethod!=='POST'||!match||resources[match[1]]?.Type!=='AWS::Lambda::Function'||integration.Credentials)issue(at+'.Properties.Integration','Only Lambda proxy integration with a local function is supported.');
  }
  if(t==='AWS::ApiGateway::Authorizer'){
   if(p.AuthorizerCredentials||p.AuthorizerUri)issue(at+'.Properties','External authorizer roles and Lambda authorizers are not supported.');
   const pool=process.env.COGNITO_USER_POOL_ARN;
   if(p.Type!=='COGNITO_USER_POOLS'||!pool||JSON.stringify(p.ProviderARNs)!==JSON.stringify([pool])||p.IdentitySource!=='method.request.header.Authorization')issue(at+'.Properties','Use the platform-approved Cognito user pool authorizer; discovery reports when unavailable.');
  }
 }
 return errors;
}
