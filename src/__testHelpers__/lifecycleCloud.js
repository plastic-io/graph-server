const {stackScope}=require('../iac/isolation');
const {guardrailTemplate}=require('../iac/guardrails');
const {DEFAULT_POLICY}=require('../iac/types');
const {authenticatedApplicationExample}=require('../discovery/example');
const {prepareReview,IacReviewService}=require('../iac/review');
const {LifecycleAws}=require('../iac/lifecycleAws');
const Store=require('./fakeS3');
const {ulid}=require('ulid');
const platformGuardrailPolicy=require('yaml').parse(require('fs').readFileSync(require('path').join(__dirname,'../../serverless.yaml'),'utf8'),{logLevel:'silent'}).resources.Resources.IacGuardrailRole.Properties.Policies[0].PolicyDocument;
const policy={...DEFAULT_POLICY,accounts:['230639770018'],regions:['us-west-1']};
const human={sub:'owner',kind:'human',tenant:'personal:owner',scopes:[]};
const save=(store,key,value)=>new Promise((resolve,reject)=>store.set(key,value,{},e=>e?reject(e):resolve()));
const read=(store,key)=>new Promise((resolve,reject)=>store.get(key,(e,v)=>e?reject(e):resolve(v)));
const missingRole=name=>Object.assign(new Error(`The role with name ${name} cannot be found.`),{code:'NoSuchEntity',statusCode:404});
const missingStack=name=>Object.assign(new Error(`Stack with id ${name} does not exist`),{code:'ValidationError',statusCode:400});
function environment(){Object.assign(process.env,{IAC_STACK_ISOLATION:'true',IAC_GUARDRAIL_ROLE_ARN:'arn:aws:iam::230639770018:role/platform-guardrails',IAC_WORKER_ROLE_ARN:'arn:aws:iam::230639770018:role/platform-worker',IAC_REVIEW_STATE_MACHINE:'arn:aws:states:us-west-1:230639770018:stateMachine:platform-iac',PLATFORM_ADMIN_SUBS:'admin'});}
async function fixture(graphId='g',nodeId='stack',options={}) {
 const store=options.store||new Store(),s=stackScope(graphId,nodeId,policy),approved=guardrailTemplate(s,process.env.IAC_WORKER_ROLE_ARN),example=authenticatedApplicationExample(s);
 const graph={id:graphId,nodes:[{id:nodeId,properties:{iac:example.configuration}}]},input=prepareReview(graph,nodeId,policy);
 const id='01M4CSD7D7H7YM2HKY2Z5AJRHZ';
 const source={operationId:id,graphId,nodeId,input,inputDigest:input.inputDigest,policyDigest:input.policyDigest,revisionId:'rev_01M4CS9QTFQWS4GVV07CYN4Y0H',state:'failed',action:'apply',reason:'Historical iam:GetRole failure',originalError:{code:'AccessDenied',message:'Historical iam:GetRole failure'},manualRecoveryRequired:true,createdAt:Date.now()-3600000,updatedAt:Date.now()-3500000,history:[]};
 const stacks=new Map(),archived=new Map(),roles=new Map(),policies=new Map(),changes=new Map(),calls=[];
 function stack(name,status,template,resources) {
  const guard=name===s.guardrailStack,record={StackName:name,StackId:`arn:aws:cloudformation:${s.region}:${s.account}:stack/${name}/${ulid()}`,StackStatus:status,RoleARN:guard?process.env.IAC_GUARDRAIL_ROLE_ARN:s.roleArn,Tags:[{Key:'GraphId',Value:graphId},{Key:'NodeId',Value:nodeId},guard?{Key:'IsolationVersion',Value:s.version}:{Key:'GraphStack',Value:s.namespace}],template,resources};
  stacks.set(name,record);return record;
 }
 function installRoles() {for(const logical of ['WorkerRole','ExecutionRole']){const d=approved.Resources[logical].Properties;roles.set(d.RoleName,{Arn:logical==='WorkerRole'?s.workerRoleArn:s.roleArn,AssumeRolePolicyDocument:d.AssumeRolePolicyDocument,policy:d.Policies[0].PolicyDocument,policyName:d.Policies[0].PolicyName});}}
 const guardResources=Object.entries(approved.Resources).map(([logical,r])=>({LogicalResourceId:logical,PhysicalResourceId:logical==='RuntimeBoundary'?s.boundaryArn:r.Properties.RoleName,ResourceType:r.Type,ResourceStatus:logical==='RuntimeBoundary'?'DELETE_SKIPPED':'DELETE_FAILED'}));
 stack(s.guardrailStack,'ROLLBACK_FAILED',approved,guardResources);
 policies.set(s.boundaryArn,approved.Resources.RuntimeBoundary.Properties.PolicyDocument);
 const platformRole=process.env.IAC_GUARDRAIL_ROLE_ARN.split('/').pop();
 let permissions=true,workflow='FAILED';
 const cloud=jest.fn(async(method,args)=>{
  calls.push({service:'cloud',method,args});
  let st=stacks.get(args.StackName)||[...stacks.values(),...archived.values()].find(r=>r.StackId===args.StackName);
  if(method==='describeStacks'){if(!st)throw missingStack(args.StackName);return {Stacks:[st]};}
  if(method==='listStackResources'){if(!st)throw missingStack(args.StackName);return {StackResourceSummaries:st.resources};}
  if(method==='getTemplate'){if(!st)throw missingStack(args.StackName);return {TemplateBody:JSON.stringify(st.template)};}
  if(method==='deleteStack'){st.StackStatus='DELETE_COMPLETE';st.resources=st.resources.map(r=>({...r,ResourceStatus:st.template.Resources[r.LogicalResourceId].DeletionPolicy==='Retain'||args.RetainResources?.includes(r.LogicalResourceId)?'DELETE_SKIPPED':'DELETE_COMPLETE'}));archived.set(st.StackId,st);stacks.delete(st.StackName);return {};}
  if(method==='describeChangeSet'){if(!changes.has(args.ChangeSetName))throw Object.assign(new Error(`ChangeSet [${args.ChangeSetName}] does not exist`),{code:'ChangeSetNotFound'});return changes.get(args.ChangeSetName);}
  if(method==='createChangeSet') {
   const template=JSON.parse(args.TemplateBody);changes.set(args.ChangeSetName,{Status:'CREATE_COMPLETE',ExecutionStatus:'AVAILABLE',args,template});
   stack(args.StackName,'REVIEW_IN_PROGRESS',template,args.ResourcesToImport.map(r=>({LogicalResourceId:r.LogicalResourceId,PhysicalResourceId:Object.values(r.ResourceIdentifier)[0],ResourceType:r.ResourceType,ResourceStatus:'IMPORT_PENDING'})));return {Id:args.ChangeSetName};
  }
  if(method==='executeChangeSet'){const cs=changes.get(args.ChangeSetName);cs.ExecutionStatus='EXECUTE_COMPLETE';stacks.get(args.StackName).StackStatus='IMPORT_COMPLETE';return {};}
  if(method==='updateStack'||method==='createStack'){const template=JSON.parse(args.TemplateBody);installRoles();stack(args.StackName,method==='createStack'?'CREATE_COMPLETE':'UPDATE_COMPLETE',template,guardResources.map(r=>({...r,ResourceStatus:'CREATE_COMPLETE'})));return {};}
  if(method==='continueUpdateRollback'||method==='rollbackStack'){st.StackStatus='UPDATE_ROLLBACK_COMPLETE';return {};}
  throw new Error('Unexpected CloudFormation call '+method);
 });
 const iam=jest.fn(async(method,args)=>{
  calls.push({service:'iam',method,args});
  if(method==='getRole'){if(args.RoleName===platformRole)return {Role:{Arn:process.env.IAC_GUARDRAIL_ROLE_ARN,AssumeRolePolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'cloudformation.amazonaws.com'},Action:'sts:AssumeRole'}]}}};const role=roles.get(args.RoleName);if(!role)throw missingRole(args.RoleName);return {Role:role};}
  if(method==='getRolePolicy'){if(args.RoleName===platformRole)return {PolicyDocument:permissions?JSON.parse(JSON.stringify(platformGuardrailPolicy).replaceAll('${AWS::Partition}','aws').replaceAll('${AWS::AccountId}',s.account)):{Version:'2012-10-17',Statement:[]}};if(!roles.has(args.RoleName))throw missingRole(args.RoleName);return {PolicyDocument:roles.get(args.RoleName).policy};}
  if(method==='listRolePolicies')return {PolicyNames:[roles.get(args.RoleName).policyName]};
  if(method==='listAttachedRolePolicies')return {AttachedPolicies:[]};
  if(method==='getPolicy'){if(!policies.has(args.PolicyArn))throw Object.assign(new Error(`Policy ${args.PolicyArn} was not found.`),{code:'NoSuchEntity'});return {Policy:{Arn:args.PolicyArn,DefaultVersionId:'v1'}};}
  if(method==='getPolicyVersion')return {PolicyVersion:{Document:policies.get(args.PolicyArn)}};
  if(method==='listEntitiesForPolicy')return {PolicyRoles:[],PolicyUsers:[],PolicyGroups:[]};
  throw new Error('Unexpected IAM call '+method);
 });
 const clients={cloud,iam,states:jest.fn(async()=>({status:workflow})),assume:jest.fn(async()=>({AccessKeyId:'never-return-credentials',SecretAccessKey:'never-return-secret'})),application:jest.fn(async()=>{
  if(!roles.has(approved.Resources.WorkerRole.Properties.RoleName))throw Object.assign(new Error('Assigned worker cannot be assumed before guardrail restoration'),{code:'AccessDenied'});
  return cloud;
 }),repair:jest.fn(async()=>({restored:true}))};
 const aws=new LifecycleAws(clients,()=>policy),sent=[],start=jest.fn(async()=>{});
 const resources=Object.entries(JSON.parse(input.text).Resources).map(([logical,r])=>({logicalId:logical,resourceType:r.Type,physicalId:r.Type==='AWS::Lambda::Function'?s.namespace+'backend':s.namespace+logical.toLowerCase()}));
 let appStatus={exists:false};
 const deployCloud={prepare:jest.fn(async()=>true),stack:jest.fn(async()=>appStatus),resources:jest.fn(async()=>resources),create:jest.fn(async()=>({changeSetId:'cs',stackId:s.namespace+'stack'})),describe:jest.fn(async()=>({status:'CREATE_COMPLETE',executionStatus:'AVAILABLE',changes:resources.map(r=>({action:'Add',...r}))})),execute:jest.fn(async()=>{appStatus={exists:true,status:'CREATE_COMPLETE'};stack(s.namespace+'stack','CREATE_COMPLETE',JSON.parse(input.text),resources.map(r=>({LogicalResourceId:r.logicalId,ResourceType:r.resourceType,PhysicalResourceId:r.physicalId,ResourceStatus:'CREATE_COMPLETE'})));}),remove:jest.fn(async()=>{})};
 const reviews=new IacReviewService(store,{enabled:true,policy:()=>policy,projection:options.projection||async function(){return graph;},start,notify:async(g,e)=>sent.push(e),cloud:deployCloud,lifecycle:{inspect:(op,options)=>aws.inspect(op,options),advance:(op,a,i)=>aws.advance(op,a,i)}});
 await save(store,IacReviewService.key(id),source);await save(store,IacReviewService.index(graphId,nodeId),{operationId:id});await save(store,`iac/stacks/${s.account}/${s.region}/${s.namespace}stack/review-lock.json`,{operationId:id});
 const plan=(extra={})=>reviews.lifecycle.plan(graphId,nodeId,human,{operationId:id,idempotencyKey:'recover-1',...extra});
 const approve=op=>reviews.lifecycle.approve(graphId,nodeId,human,{operationId:op.operationId,recoveryDigest:op.recoveryPlan.digest});
 const recover=async()=>{const op=await plan();await approve(op);for(let i=0;i<20;i++){const answer=await reviews.lifecycle.step(op.operationId);if(answer.done)break;}return reviews.current(graphId,nodeId,human,undefined,false);};
 return {store,s,graph,input,source,approved,roles,policies,stacks,archived,clients,aws,reviews,deployCloud,start,sent,calls,resources,stack,installRoles,plan,approve,recover,permissions:v=>{permissions=v;},workflow:v=>{workflow=v;}};
}
module.exports={fixture,environment,policy,human,read,save};
