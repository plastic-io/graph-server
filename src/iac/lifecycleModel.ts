import {createHash} from 'crypto';
import {stackScope} from './isolation';
import {guardrailTemplate} from './guardrails';
import {policyFromEnv,parseTemplate} from './validator';
import {preservationMode,preservationStateProblems,preservationActionProblems} from './preservation';

export const LIFECYCLE_VERSION='1.3.0';
export const terminalStates=new Set(['succeeded','failed','rolled-back','rollback-failed','cancelled','expired','stale','no-changes','destroyed','recovered','recovery-blocked','inspected']);
export function pendingReview(op:any){return !!op&&!op.approval&&!op.recoveryApproval&&!op.startedAt&&!op.recoveryDispatchedAt&&
 !op.reviewInvalidatedAt&&['awaiting-review','recovery-ready','recovery-blocked','expired','stale'].includes(op.state);}
export function canonical(value:any):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 return JSON.stringify(value);
}
export const digest=(value:any)=>createHash('sha256').update(canonical(value)).digest('hex');
export function refused(code:string,message:string,status=409,details?:any):never {throw Object.assign(new Error(message),{code,status,problems:details});}
export const operationKey=(id:string)=>'iac/reviews/'+id+'.json';
export const indexKey=(g:string,n:string)=>'iac/review-index/'+encodeURIComponent(g)+'/'+encodeURIComponent(n)+'.json';
export const lockKey=(s:any)=>'iac/stacks/'+s.account+'/'+s.region+'/'+s.name+'/review-lock.json';
export function scopeFor(op:any,policy=policyFromEnv()) {
 const s=stackScope(op.graphId,op.nodeId,policy);
 if(!op.input?.isolation||canonical(op.input.isolation)!==canonical(s)||op.input.stack.name!==s.namespace+'stack'||op.input.stack.account!==s.account||op.input.stack.region!==s.region)
  refused('OWNERSHIP_UNVERIFIED','The operation is not bound to this graph/node’s assigned isolated stack.',403);
 return s;
}
export function blocker(code:string,kind:string,message:string,extra:any={}) {return {code,kind,message,...extra};}
export const dataType=(t:string)=>['AWS::S3::Bucket','AWS::DynamoDB::Table','AWS::SQS::Queue','AWS::SNS::Topic','AWS::Logs::LogGroup'].includes(t);
export const importIdentifiers:any={'AWS::IAM::ManagedPolicy':'PolicyArn','AWS::IAM::Role':'RoleName','AWS::S3::Bucket':'BucketName','AWS::DynamoDB::Table':'TableName','AWS::SQS::Queue':'QueueUrl','AWS::SNS::Topic':'TopicArn','AWS::Logs::LogGroup':'LogGroupName'};
// Establish the stack's role and tags before IMPORT, which cannot add either.
// The false condition creates no resource and requires no additional AWS authority.
export const importPreparationTemplate=()=>({AWSTemplateFormatVersion:'2010-09-09',Conditions:{GraphRecoveryEmpty:{'Fn::Equals':['empty','never']}},Resources:{GraphRecoveryPlaceholder:{Type:'AWS::CloudFormation::WaitConditionHandle',Condition:'GraphRecoveryEmpty',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain'}}});
export const retained=(r:any)=>r.status==='DELETE_SKIPPED'||r.deletionPolicy==='Retain'||r.deletionPolicy==='RetainExceptOnCreate';

/** Stable reviewed content excludes observation timestamps, error prose, and transient request IDs. */
export function inspectionFingerprint(i:any) {
 const stack=(s:any)=>({name:s.name,stackId:s.stackId||null,status:s.status,roleArn:s.roleArn||null,ownership:s.ownership,templateDigest:s.templateDigest,lastStackId:s.lastStackId,importPreparation:s.importPreparation,reviewStackProof:s.reviewStackProof,
  resources:(s.resources||[]).map((r:any)=>({logicalId:r.logicalId,physicalId:r.physicalId,physicalIdentity:r.physicalIdentity,resourceType:r.resourceType,status:r.status,deletionPolicy:r.deletionPolicy,exists:r.exists,definitionDigest:r.definitionDigest,orphaned:r.orphaned})).sort((a,b)=>a.logicalId.localeCompare(b.logicalId))});
 return digest({version:LIFECYCLE_VERSION,scope:i.scope,application:stack(i.application),guardrail:stack(i.guardrail),
  roles:i.roles?.map((r:any)=>({arn:r.arn,exists:r.exists,policyDigest:r.policyDigest,trustDigest:r.trustDigest,boundary:r.boundary,matches:r.matches})),
  boundary:i.boundary,approvedGuardrailDigest:i.approvedGuardrailDigest});
}

/** No client can choose AWS commands, resource ARNs, guardrail policies, or role contents. */
export function recoveryPlan(op:any,inspection:any,options:any={}) {
 const actions:any[]=[],prerequisites=[...(inspection.blockers||[]).filter((b:any)=>b.kind!=='recovery')];
 const preservation=preservationMode(options.preservation,op.preservation);
 const allowDataLoss=options.allowDataLoss===true;
 if(preservation&&allowDataLoss)refused('SCHEMA_INVALID','Strict preservation and allowDataLoss cannot be combined.',400);
 const preservationBlockers=preservation?preservationStateProblems(inspection):[];
 prerequisites.push(...preservationBlockers);
 const action=(kind:string,target:string,extra:any={})=>actions.push({kind,target,...extra});
 for(const target of ['guardrail','application']) {
  const stack=inspection[target],resources=stack.resources||[],guardrail=target==='guardrail';
  if(preservationBlockers.some(p=>p.component===target))continue;
  if(stack.ownership!=='verified'&&stack.status!=='NOT_CREATED')continue;
  // CREATE change sets have an empty stack record, not a failed deployment.
  // A verified record can receive a fresh review without deletion or recovery.
  if(!guardrail&&stack.status==='REVIEW_IN_PROGRESS'&&stack.reviewStackProof&&!resources.length)continue;
  if(stack.status==='UNKNOWN'||/IN_PROGRESS$/.test(stack.status)&&stack.status!=='REVIEW_IN_PROGRESS') {
   prerequisites.push(blocker('STACK_BUSY','busy','Wait for the current CloudFormation operation to finish.',{component:target,resource:stack.stackId||stack.name}));continue;
  }
  let rebuild=stack.importPreparation===true;
  if(['ROLLBACK_FAILED','ROLLBACK_COMPLETE','CREATE_FAILED','DELETE_FAILED','REVIEW_IN_PROGRESS'].includes(stack.status)) {
   const unsafe=resources.filter((r:any)=>dataType(r.resourceType)&&r.physicalId&&r.exists!==false&&r.status!=='DELETE_COMPLETE'&&!retained(r));
   // RetainResources is valid only in DELETE_FAILED. Never silently delete data in a failed create.
   const retainIds=stack.status==='DELETE_FAILED'?resources.filter((r:any)=>r.physicalId&&r.status!=='DELETE_COMPLETE'&&r.status!=='DELETE_SKIPPED'&&(
    r.exists!==false&&(dataType(r.resourceType)||retained(r))||guardrail&&r.resourceType==='AWS::IAM::Role'&&r.exists===false&&r.ownershipVerified
   )).map((r:any)=>r.logicalId):[];
   if(!allowDataLoss&&unsafe.length&&stack.status!=='DELETE_FAILED')prerequisites.push(blocker('DATA_PRESERVATION_REQUIRED','human-approval','This failed stack has data without a retention policy. Prepare an explicit allowDataLoss plan only if its listed deletions are acceptable; otherwise a platform administrator must arrange a backup or preservation procedure.',{component:target,resources:unsafe.map((r:any)=>r.logicalId)}));
   action('delete-stack',target,{stackId:stack.stackId,retainIds,
    reason:stack.status==='DELETE_FAILED'?'Delete the owned failed stack while retaining listed data and skipping deletion handlers for verified-absent deployment roles. Absent role records do not represent live IAM resources.':'Delete the owned failed stack; CloudFormation retention policies preserve the listed survivors.',
    dataLoss:unsafe.filter((r:any)=>!retainIds.includes(r.logicalId)).map((r:any)=>r.logicalId),resources:resources.map((r:any)=>({logicalId:r.logicalId,physicalId:r.physicalId,resourceType:r.resourceType,outcome:r.exists===false?'Already absent':retained(r)||retainIds.includes(r.logicalId)?'Retain':'Delete'}))});
   rebuild=true;
  } else if(stack.status==='UPDATE_ROLLBACK_FAILED') {
   action('continue-update-rollback',target,{stackId:stack.stackId,resourcesToSkip:[],dataLoss:[]});
  } else if(stack.status==='UPDATE_FAILED') {
   const unsafe=resources.filter((r:any)=>dataType(r.resourceType)&&r.physicalId&&r.exists!==false&&r.status!=='DELETE_COMPLETE'&&r.deletionPolicy!=='Retain');
   if(unsafe.length&&!allowDataLoss)prerequisites.push(blocker('ROLLBACK_DATA_REVIEW','human-approval','Rollback could remove data resources without retention. Explicit data-loss approval or a separately reviewed preservation procedure is required.',{component:target,resources:unsafe.map((r:any)=>r.logicalId)}));
   action('rollback-stack',target,{stackId:stack.stackId,dataLoss:unsafe.map((r:any)=>r.logicalId)});
  } else if(['IMPORT_ROLLBACK_FAILED','IMPORT_ROLLBACK_COMPLETE'].includes(stack.status)) {
   prerequisites.push(blocker('IMPORT_RECOVERY_REQUIRED','platform-maintenance','The import needs a platform-admin preservation review; automatic deletion of imported resources is disabled.',{component:target,resource:stack.stackId}));
  } else if(stack.status==='NOT_CREATED'||stack.status==='DELETE_COMPLETE')rebuild=true;
  if(rebuild) {
   const survivors=resources.filter((r:any)=>r.physicalId&&r.exists!==false&&r.status!=='DELETE_COMPLETE'&&(retained(r)||r.orphaned||(stack.status==='DELETE_FAILED'&&dataType(r.resourceType))));
   const definitions=guardrail?inspection.approvedGuardrailTemplate.Resources:parseTemplate(op.input.text,op.input.format).doc?.Resources||{};
   const imports:any[]=[];
   for(const r of survivors) {
    if(!r.ownershipVerified||!importIdentifiers[r.resourceType]||!definitions[r.logicalId]||!guardrail&&r.definitionDigest!==digest(definitions[r.logicalId])) {
     prerequisites.push(blocker('RETAINED_RESOURCE_COLLISION','platform-maintenance','A retained resource needs proven ownership and a supported import before its name can be reused. It will not be deleted.',{component:target,resource:r.physicalId,logicalId:r.logicalId}));continue;
    }
    imports.push({logicalId:r.logicalId,resourceType:r.resourceType,physicalId:r.physicalId,physicalIdentity:r.physicalIdentity,identifier:importIdentifiers[r.resourceType],definition:{...definitions[r.logicalId],DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain'}});
   }
   if(imports.length) {
    const ids=new Set(imports.map(r=>r.logicalId));
    const check=(v:any)=>{if(!v||typeof v!=='object')return;for(const [k,x]of Object.entries<any>(v)){
     if(k==='Ref'&&!String(x).startsWith('AWS::')&&!ids.has(x)||k==='Fn::GetAtt'&&!ids.has(Array.isArray(x)?x[0]:String(x).split('.')[0]))prerequisites.push(blocker('RETAINED_RESOURCE_DEPENDENCY','template','Retained import requires a resource absent from the import set. Preserve the resource and request a platform import review.',{component:target}));
     if(k==='Fn::Sub'&&typeof x==='string'&&[...x.matchAll(/\$\{([^}!]+)\}/g)].some(m=>!m[1].startsWith('AWS::')&&!ids.has(m[1].split('.')[0])))prerequisites.push(blocker('RETAINED_RESOURCE_DEPENDENCY','template','Retained import has an unresolved resource reference.',{component:target}));check(x);
    }};imports.forEach(r=>check(r.definition));
    action('import-retained',target,{resources:imports,dataLoss:[],preparation:{kind:'owned-empty-stack',templateDigest:digest(importPreparationTemplate()),createsResources:false,roleArn:guardrail?process.env.IAC_GUARDRAIL_ROLE_ARN:inspection.scope.roleArn},reason:'Establish an empty owned stack with its assigned service role and ownership tags, then import the retained resources without changing stack settings. No application resource is created or deleted.'});
   }
  }
  if(guardrail&&(rebuild||!inspection.guardrailsMatch||stack.status==='UPDATE_ROLLBACK_FAILED'||stack.status==='UPDATE_FAILED'))action('reconcile-guardrails',target,{definitionDigest:inspection.approvedGuardrailDigest,dataLoss:[],resources:(inspection.roles||[]).filter((r:any)=>r.exists===false).map((r:any)=>({logicalId:r.logicalId,physicalId:r.arn,outcome:'Create from approved platform definition'})),reason:'Restore only the platform-approved definition for this graph/node namespace. Uses the platform guardrail service role; absent per-stack roles are created before any application role is assumed.'});
 }
 action('release-operation','operation',{dataLoss:[],reason:'Retire stale reviews and release the operation lock. A new application deployment requires a fresh review and human approval.'});
 if(preservation){
  const unsafe=preservationActionProblems(actions);
  prerequisites.push(...unsafe);
  // A blocked preservation review never presents destructive actions for approval.
  for(let i=actions.length-1;i>=0;i--)if(preservationActionProblems([actions[i]]).length)actions.splice(i,1);
 }
 const content={version:LIFECYCLE_VERSION,graphId:op.graphId,nodeId:op.nodeId,sourceOperationId:op.operationId,namespace:inspection.scope.namespace,
  inputDigest:op.inputDigest,inspectionDigest:inspectionFingerprint(inspection),approvedGuardrailDigest:inspection.approvedGuardrailDigest,
  allowDataLoss,actions,prerequisites,preservesData:actions.every(a=>!a.dataLoss.length),...(preservation?{preservation}:{}),ownershipEvidence:{application:inspection.application,guardrail:inspection.guardrail},
  approvalRequirements:{kind:'infrastructure-recovery',exactDigest:true,platformAdministrator:false,applicationDeployment:false},
  approval:'An authenticated human with graph infrastructure approval authority must approve this exact recovery digest. Platform-maintenance administrator membership is not required. It never approves a new application template.'};
 return {...content,digest:digest(content)};
}
export function validRecoveryDigest(plan:any) {const {digest:expected,...content}=plan||{};return !!expected&&expected===digest(content);}
export function platformDefinition(s:any) {return guardrailTemplate(s,process.env.IAC_WORKER_ROLE_ARN);}

export function nextActions(op:any,inspection=op?.inspection) {
 const state=op?.state,leased=op?.recoveryLease?.until>Date.now(),blocked=[...(inspection?.blockers||[]),...(op?.preservationBlockers||[]),...(op?.recoveryPlan?.prerequisites||[]),...(leased?[{code:'WORKER_ACTIVE',kind:'busy',message:'A previous worker may still be finishing. Wait for its bounded lease before recovery.',leaseUntil:op.recoveryLease.until}]:[])];
 const expired=op?.action==='recover'&&state==='recovery-ready'&&op.expiresAt<Date.now();
 const active=leased||state&&!terminalStates.has(state),recovery=op?.action==='recover';
 const current=!op?.supersededBy;
 return {retryable:current&&!active&&!!inspection?.canReview,automaticRetry:false,blockingPrerequisites:blocked,
  actions:[
   {tool:'iac.inspect',allowed:true,requiredApproval:null},
   {tool:'iac.cancel',allowed:current&&(pendingReview(op)||!!op?.cancellation),requiredApproval:null,reason:'Cancel only this unapproved review; no AWS resources are changed. Expired reviews can also be cancelled.'},
   {tool:'iac.recovery.plan',allowed:current&&!!op&&(!active||recovery&&state==='recovery-ready'),requiredApproval:null,reason:expired?'Recovery review expired. Prepare a fresh plan.':active?'A fresh plan replaces the unapproved recovery review; an executing operation cannot be replaced.':undefined},
   {action:'approve-recovery-in-graph',allowed:current&&recovery&&state==='recovery-ready'&&!expired,requiredApproval:'human-exact-recovery-digest'},
   {tool:'iac.maintenance.request',allowed:blocked.some((b:any)=>b.kind==='platform-permission'||b.kind==='platform-maintenance'),requiredApproval:'separate-platform-admin-review'},
   {tool:'iac.review',allowed:current&&!active&&(!!inspection?.canReview||state==='cancelled'),requiredApproval:'new-human-exact-deployment-digest',...(state==='cancelled'?{reason:'Cancellation released the review. A fresh review must still pass current AWS state, ownership and preservation checks; deployment readiness is not established.'}:{})},
   {action:'approve-deployment-in-graph',allowed:current&&!recovery&&state==='awaiting-review',requiredApproval:'human-exact-deployment-digest'},
   {tool:'iac.runtime.logs',allowed:!!op?.approval&&state==='succeeded',requiredApproval:null},
   {tool:'iac.readiness',allowed:!!op?.approval&&state==='succeeded',requiredApproval:'declared-in-approved-deployment'},
  ]};
}
