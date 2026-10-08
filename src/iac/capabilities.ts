import {policyFromEnv,validateTemplate,validateStack,parseTemplate} from './validator';
import {assemble} from './assemble';
import {IacPolicy,DEFAULT_POLICY} from './types';
import {ISOLATED_TYPES,ISOLATION_VERSION,scopedPolicy,stackScope,validateIsolation} from './isolation';
export const LEGACY_APPLY_TYPES=['AWS::S3::Bucket','AWS::S3::BucketPolicy','AWS::DynamoDB::Table','AWS::SQS::Queue','AWS::SQS::QueuePolicy','AWS::SNS::Topic','AWS::SNS::TopicPolicy','AWS::Logs::LogGroup'];
export function isolationEnabled(){return process.env.IAC_STACK_ISOLATION==='true';}
/** Inline templates and graph-assembled templates must go through the same preflight. */
export function graphDeploymentCapabilities(graph:any,nodeId:string,policy:IacPolicy=policyFromEnv(),enabled?:boolean){
 const carried=graph?.nodes?.find((n:any)=>n.id===nodeId)?.properties?.iac;
 if(!carried?.stack)return deploymentCapabilities(graph.id,nodeId,carried,policy,enabled);
 const scope=stackScope(graph.id,nodeId,policy),built=assemble(graph,nodeId,isolationEnabled()?scopedPolicy(scope,policy):policy);
 const fromGraph=built.fragments.length>0||typeof carried.template?.text!=='string';
 const result=deploymentCapabilities(graph.id,nodeId,fromGraph?{...carried,template:{text:built.text,format:'json'}}:carried,policy,enabled);
 if(fromGraph&&!built.ok){result.problems.push(...built.problems);result.deployable=false;}
 return {...result,source:fromGraph?'graph':'inline'};
}
export function deploymentCapabilities(graphId:string,nodeId:string,configuration?:any,policy:IacPolicy=policyFromEnv(),enabled=!!process.env.IAC_REVIEW_STATE_MACHINE){
 policy={...DEFAULT_POLICY,...policy};
 const isolated=isolationEnabled(),scope=stackScope(graphId,nodeId,policy);
 const supported=isolated?ISOLATED_TYPES:LEGACY_APPLY_TYPES;
 const configured=enabled&&!!scope.account&&!!scope.region;
 const effectivePolicy=isolated?scopedPolicy(scope,policy):policy;
 const problems:any[]=[];
 let validation:any=null;
 if(configuration){
  if(configuration.template?.text){
   validation=validateTemplate(configuration.template.text,configuration.template.format||'yaml',effectivePolicy);
   problems.push(...validation.problems,...validateStack(configuration.stack,effectivePolicy));
   if(isolated&&configuration.stack?.name!==scope.namespace+'stack')problems.push({code:'STACK_ISOLATION',path:'stack.name',message:'Use the server-assigned stack name '+scope.namespace+'stack. Renaming the graph or node does not rename its AWS stack.'});
   const types=validation.resourceTypes;
   for(const type of types)if(!supported.includes(type))problems.push({code:'NOT_DEPLOYABLE',path:'Resources',message:type+' can be represented by the template schema but is not deployable by this environment.'});
   if(isolated)problems.push(...validateIsolation(configuration.template.text,configuration.template.format||'yaml',scope));
  }else problems.push({code:'MISSING_TEMPLATE',path:'template.text',message:'Provide the assembled or inline template before requesting deployment.'});
 }
 if(!configured)problems.push({code:'DEPLOYMENT_UNAVAILABLE',path:'environment',message:'Reviewed deployment requires a configured workflow, target account and region.'});
 if(isolated&&!process.env.IAC_GUARDRAIL_ROLE_ARN)problems.push({code:'GUARDRAILS_UNAVAILABLE',path:'environment',message:'The platform guardrail provisioning role has not been deployed.'});
 return {schemaVersion:1,capabilityVersion:ISOLATION_VERSION,validationResourceTypes:policy.allowedResourceTypes,deployableResourceTypes:configured?supported.filter(t=>policy.allowedResourceTypes.includes(t)):[],
  target:{account:scope.account,region:scope.region},targetAccounts:isolated?[scope.account].filter(Boolean):policy.accounts,targetRegions:isolated?[scope.region].filter(Boolean):policy.regions,
  isolation:isolated?{...scope,required:true}:{required:false,mode:'legacy-shared-prefix',namespace:policy.stackPrefix},
  deploymentRole:isolated?scope.roleArn:process.env.IAC_EXECUTION_ROLE_ARN||null,permissionsBoundary:isolated?scope.boundaryArn:policy.permissionsBoundaryArn||null,
  authenticatedApiAuthorizer:{supported:!!process.env.COGNITO_USER_POOL_ARN,userPoolArn:process.env.COGNITO_USER_POOL_ARN||null,alternative:'AWS_IAM'},
  operations:{plan:configured,apply:configured,destroy:configured&&isolated,automaticApply:false,import:false,continueRollback:false,deleteRetainedResources:false},
  requirements:['Run this preflight before implementation. Template validity is distinct from deployment capability.','Only an authenticated human may approve the exact reviewed digest in the graph.','Names, IAM policy resources and role passing are restricted to the assigned stack namespace.','REST API creation uses a required GraphStack tag; child resources inherit ownership. API Gateway V2 is not in this deployment subset.','Runtime roles cannot alter IAM, invoke deployment APIs, pass roles, or read resources outside their stack.','Application roles receive no unscoped AWS actions. The CloudFormation execution role may list log-group metadata with logs:DescribeLogGroups on * because AWS does not support a resource ARN for that read; writes remain namespace-scoped.'],
  evidence:{level:'configuration-and-template-validation',awsPermissionsVerified:false,missingPermissions:'AWS permission failures are reported by the reviewed worker; preflight does not simulate effective AWS policies.',runtimeVerified:false,liveMultiplayerVerified:false},
  roleLifecycle:'Platform-managed roles and the boundary are provisioned during the first reviewed plan; graph templates cannot edit them.',validation,deployable:configuration?configured&&problems.length===0:null,problems};
}
/** Review resources before and after assembly, including removed resources and policy contents. */
export function infrastructureImpact(before:any,after:any){
 const base=policyFromEnv();
 const configuration=(graph:any,node:any)=>{
  const iac=node?.properties?.iac;
  if(!iac?.stack)return iac;
  const scope=stackScope(graph.id,node.id,base),policy=isolationEnabled()?scopedPolicy(scope,base):base;
  const built=assemble(graph,node.id,policy);
  return built.fragments.length||typeof iac.template?.text!=='string'?{...iac,template:{text:built.text,format:'json'}}:iac;
 };
 const previous=new Map((before?.nodes||[]).map((n:any)=>[n.id,n]));
 const next=new Map((after?.nodes||[]).map((n:any)=>[n.id,n]));
 const result:any[]=[];
 for(const id of new Set([...previous.keys(),...next.keys()])){
  const old:any=configuration(before,previous.get(id)),iac:any=configuration(after,next.get(id));
  if(JSON.stringify(old)===JSON.stringify(iac))continue;
  const definitions=(c:any)=>c?.template?.text?parseTemplate(c.template.text,c.template.format||'yaml').doc?.Resources||{}:{};
  const oldResources=definitions(old),newResources=definitions(iac);
  const resources=[...new Set([...Object.keys(oldResources),...Object.keys(newResources)])].flatMap(logicalId=>{
   const was=oldResources[logicalId],now=newResources[logicalId];
   if(JSON.stringify(was)===JSON.stringify(now))return [];
   const r=now||was;
   return [{logicalId,action:!was?'Add':!now?'Remove':'Modify',type:r.Type,deletionPolicy:r.DeletionPolicy||'Delete',updateReplacePolicy:r.UpdateReplacePolicy||'Delete',iam:r.Type?.startsWith('AWS::IAM::')?{before:was?.Properties,after:now?.Properties}:undefined}];
  });
  result.push({nodeId:id,stack:iac?.stack||old?.stack,resources,resourceFragment:iac?.resource,
   ...(!iac?{removedFromGraph:true,lifecycle:'Removing a graph node or its IaC configuration does not delete AWS resources. Request a reviewed destroy first.'}:{}),
   prerequisites:iac?.stack?deploymentCapabilities(after.id,String(id),iac):{message:'Connect this fragment to a stack and preflight the assembled template.'}});
 }
 return result;
}
