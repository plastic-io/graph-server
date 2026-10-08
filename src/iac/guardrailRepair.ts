import {IAM,CloudFormation} from 'aws-sdk';
import {scopeFor,platformDefinition,validRecoveryDigest,digest,operationKey,indexKey,lockKey,refused} from './lifecycleModel';
import {policyFromEnv} from './validator';

/** Privileged platform repair accepts only an operation ID/fence, never IAM JSON or resource identifiers. */
export async function repairApprovedGuardrails(store:any,request:any,iamCall=(m,a)=>(new IAM() as any)[m](a).promise(),policy=policyFromEnv(),cloudCall=(m,a)=>(new CloudFormation() as any)[m](a).promise()) {
 if(Object.keys(request||{}).some(k=>!['operationId','leaseId'].includes(k)))refused('SCHEMA_INVALID','Guardrail repair accepts only an operation ID and active worker lease.',400);
 const read=(key:string):Promise<any>=>new Promise((resolve,reject)=>store.get(key,(e,v)=>e?reject(e):resolve(v)));
 if(!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(request.operationId||''))refused('SCHEMA_INVALID','Invalid recovery ID.',400);
 const op=await read(operationKey(request.operationId)),s=scopeFor(op,policy),definition=platformDefinition(s);
 const [index,lock]=await Promise.all([read(indexKey(op.graphId,op.nodeId)),read(lockKey(op.input.stack))]);
 if(op.action!=='recover'||op.state!=='recovering'||op.recoveryApproval?.digest!==op.recoveryPlan?.digest||!validRecoveryDigest(op.recoveryPlan)||op.recoveryPlan.approvedGuardrailDigest!==digest(definition)||op.recoveryPlan.prerequisites.length||op.recoveryPlan.actions[op.recoveryIndex]?.kind!=='reconcile-guardrails'||op.recoveryLease?.id!==request.leaseId||op.recoveryLease.until<Date.now()||index.operationId!==op.operationId||lock.operationId!==op.operationId)
  refused('RECOVERY_APPROVAL_REQUIRED','An active, fenced, exact-digest human recovery approval is required to restore guardrails.',403);
 const stack=(await cloudCall('describeStacks',{StackName:s.guardrailStack})).Stacks?.[0],tags=Object.fromEntries((stack?.Tags||[]).map(t=>[t.Key,t.Value]));
 if(!stack?.StackId?.startsWith(`arn:aws:cloudformation:${s.region}:${s.account}:stack/${s.guardrailStack}/`)||stack.RoleARN!==process.env.IAC_GUARDRAIL_ROLE_ARN||tags.GraphId!==s.graphId||tags.NodeId!==s.nodeId||tags.IsolationVersion!==s.version||!['CREATE_COMPLETE','UPDATE_COMPLETE','IMPORT_COMPLETE','UPDATE_ROLLBACK_COMPLETE'].includes(stack.StackStatus))refused('OWNERSHIP_UNVERIFIED','Current guardrail stack ownership or state changed before repair.',403);
 const inventory=await cloudCall('listStackResources',{StackName:stack.StackId});
 if(inventory.NextToken||!['RuntimeBoundary','WorkerRole','ExecutionRole'].every(id=>inventory.StackResourceSummaries?.some(r=>r.LogicalResourceId===id&&r.ResourceType===definition.Resources[id].Type&&r.PhysicalResourceId===(id==='RuntimeBoundary'?s.boundaryArn:definition.Resources[id].Properties.RoleName))))refused('OWNERSHIP_UNVERIFIED','Current guardrail resources do not match the approved namespace.',403);
 for(const logical of ['WorkerRole','ExecutionRole']) {
  const desired=definition.Resources[logical].Properties,arn=logical==='WorkerRole'?s.workerRoleArn:s.roleArn;
  const actual=await iamCall('getRole',{RoleName:desired.RoleName});
  if(actual.Role.Arn!==arn||actual.Role.PermissionsBoundary)refused('OWNERSHIP_UNVERIFIED','Guardrail role path or boundary changed before repair.',403);
  const [inline,attached]=await Promise.all([iamCall('listRolePolicies',{RoleName:desired.RoleName}),iamCall('listAttachedRolePolicies',{RoleName:desired.RoleName})]);
  if(inline.IsTruncated||attached.IsTruncated||attached.AttachedPolicies?.length||inline.PolicyNames?.some(n=>n!==desired.Policies[0].PolicyName))refused('PLATFORM_MAINTENANCE_REQUIRED','Unreviewed additional role policies require a platform administrator.');
  await iamCall('putRolePolicy',{RoleName:desired.RoleName,PolicyName:desired.Policies[0].PolicyName,PolicyDocument:JSON.stringify(desired.Policies[0].PolicyDocument)});
  await iamCall('updateAssumeRolePolicy',{RoleName:desired.RoleName,PolicyDocument:JSON.stringify(desired.AssumeRolePolicyDocument)});
 }
 for(const usage of ['PermissionsBoundary','PermissionsPolicy']) {
  const list=await iamCall('listEntitiesForPolicy',{PolicyArn:s.boundaryArn,PolicyUsageFilter:usage,MaxItems:100});
  if(list.IsTruncated||list.PolicyGroups?.length||list.PolicyUsers?.length||list.PolicyRoles?.some(r=>usage==='PermissionsPolicy'||!r.RoleName.startsWith(s.namespace)))refused('OWNERSHIP_UNVERIFIED','Boundary ownership changed before repair.',403);
  if(usage==='PermissionsBoundary')for(const role of list.PolicyRoles||[]) {
   const actual=await iamCall('getRole',{RoleName:role.RoleName});
   if(!actual.Role.Arn.startsWith(`arn:aws:iam::${s.account}:role/graph-app/${s.namespace}`))refused('OWNERSHIP_UNVERIFIED','A foreign role consumes this boundary.',403);
  }
 }
 const policyRow=await iamCall('getPolicy',{PolicyArn:s.boundaryArn}),current=await iamCall('getPolicyVersion',{PolicyArn:s.boundaryArn,VersionId:policyRow.Policy.DefaultVersionId});
 const value=typeof current.PolicyVersion.Document==='string'?JSON.parse(decodeURIComponent(current.PolicyVersion.Document)):current.PolicyVersion.Document;
 if(digest(value)!==digest(definition.Resources.RuntimeBoundary.Properties.PolicyDocument)) {
  const versions=await iamCall('listPolicyVersions',{PolicyArn:s.boundaryArn});
  if(versions.IsTruncated)refused('INVENTORY_TRUNCATED','Cannot verify boundary policy versions.');
  if(versions.Versions.length>=5){const old=versions.Versions.filter(v=>!v.IsDefaultVersion).sort((a,b)=>new Date(a.CreateDate).getTime()-new Date(b.CreateDate).getTime())[0];if(!old)refused('PLATFORM_MAINTENANCE_REQUIRED','No removable nondefault boundary version.');await iamCall('deletePolicyVersion',{PolicyArn:s.boundaryArn,VersionId:old.VersionId});}
  await iamCall('createPolicyVersion',{PolicyArn:s.boundaryArn,PolicyDocument:JSON.stringify(definition.Resources.RuntimeBoundary.Properties.PolicyDocument),SetAsDefault:true});
 }
 return {restored:true,definitionDigest:digest(definition),namespace:s.namespace};
}
