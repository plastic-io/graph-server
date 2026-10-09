import {CloudFormation,IAM,STS,StepFunctions,Lambda} from 'aws-sdk';
import {scopeFor,digest,blocker,platformDefinition,inspectionFingerprint,refused,retained,recoveryPlan,importPreparationTemplate} from './lifecycleModel';
import {diagnosticError} from './diagnosticSafety';
import {parseTemplate,policyFromEnv} from './validator';
import {awsResourceAbsent} from './awsErrors';
import {inspectionRead,transientInspectionError} from './inspectionRead';
import {strict,preservationActionProblems,preservationStateProblems,assertGuardrailPreservation,refusePreservation} from './preservation';
import {ROLE_EXISTENCE_READS} from './isolation';
import {verifyReviewStack} from './reviewStack';

type Call=(method:string,args:any)=>Promise<any>;
export interface LifecycleClients {cloud:Call;iam:Call;states:Call;assume:(scope:any)=>Promise<any>;application:(scope:any)=>Promise<Call>;repair?:(op:any)=>Promise<any>;}
export function lifecycleClients(region:string):LifecycleClients {
 const options={region,maxRetries:0,httpOptions:{connectTimeout:1500,timeout:5000}};
 const cf=new CloudFormation(options),iam=new IAM(options),states=new StepFunctions(options),sts=new STS(options);
 const assume=async s=>(await sts.assumeRole({RoleArn:s.workerRoleArn,RoleSessionName:'graph-lifecycle',DurationSeconds:900}).promise()).Credentials!;
 return {cloud:(m,a)=>(cf as any)[m](a).promise(),iam:(m,a)=>(iam as any)[m](a).promise(),states:(m,a)=>(states as any)[m](a).promise(),assume,
  repair:async op=>{if(!process.env.IAC_GUARDRAIL_REPAIR_FUNCTION)refused('CAPABILITY_UNAVAILABLE','The approved guardrail repair function is not configured.');const r=await new Lambda({region}).invoke({FunctionName:process.env.IAC_GUARDRAIL_REPAIR_FUNCTION,Payload:JSON.stringify({operationId:op.operationId,leaseId:op.recoveryLease?.id})}).promise();const body=JSON.parse(String(r.Payload||'null'));if(r.FunctionError||!body?.restored)throw new Error(body?.errorMessage||'Guardrail repair failed');return body;},
  application:async s=>{const c=await assume(s),client=new CloudFormation({...options,credentials:{accessKeyId:c.AccessKeyId,secretAccessKey:c.SecretAccessKey,sessionToken:c.SessionToken}});return (m,a)=>(client as any)[m](a).promise();}};
}
const document=(value:any)=>typeof value==='string'?JSON.parse(decodeURIComponent(value)):value;
const tags=(items:any[])=>Object.fromEntries((items||[]).map(t=>[t.Key,t.Value]));
const match=(pattern:string,value:string)=>new RegExp('^'+pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.')+'$','i').test(value);
/** Structural evidence only. Conditions, SCPs, session policies and resource policies can still deny a real call. */
export function policyCoverage(doc:any,action:string,resource:string) {
 const any=(patterns:any,value:string)=>[].concat(patterns||[]).some(p=>match(p,value));
 const statements=[].concat(doc?.Statement||[]).filter(s=>(s.Action?any(s.Action,action):s.NotAction&&!any(s.NotAction,action))&&(s.Resource?any(s.Resource,resource):s.NotResource&&!any(s.NotResource,resource)));
 if(statements.some(s=>s.Effect==='Deny'&&!s.Condition))return 'explicit-deny';
 if(statements.some(s=>s.Effect==='Deny'&&s.Condition))return 'conditional-or-unknown';
 if(statements.some(s=>s.Effect==='Allow'&&!s.Condition))return 'allowed-by-document';
 return statements.length?'conditional-or-unknown':'not-granted';
}

export class LifecycleAws {
 constructor(private clients:LifecycleClients,private policy=policyFromEnv){}
 async inspect(op:any,options:{ownRecovery?:boolean}={}) {
  const s=scopeFor(op,this.policy()),approved=platformDefinition(s),blockers:any[]=[],actualChecks:any[]=[];
  const deadline=Date.now()+18000;
  let iamTail:Promise<any>=Promise.resolve();
  const check=(component:string,action:string,resource:string,call:()=>Promise<any>,missingOkay=false)=>{
   const read=async()=>{
   if(Date.now()>deadline){if(!blockers.some(b=>b.code==='INSPECTION_INCOMPLETE'))blockers.push(blocker('INSPECTION_INCOMPLETE','transient','AWS verification exceeded its bounded time budget. These partial reads do not establish readiness. Retry inspection after a short delay; no permission change is established by a timeout.',{component,action,resource,retryable:true,retryAfterMs:5000}));return undefined;}
   try {const {value,attempts}=await inspectionRead(call,deadline);actualChecks.push({component,action,resource,result:'succeeded',attempts});return value;}
   catch(e){if(missingOkay&&awsResourceAbsent(e,action)){actualChecks.push({component,action,resource,result:'absent',code:e.code||e.name,attempts:e.inspectionAttempts});return null;}
    const error=diagnosticError(e,op);actualChecks.push({component,action,resource,result:'failed',error,attempts:e.inspectionAttempts});
    const transient=transientInspectionError(e);
    blockers.push(blocker(transient?'AWS_CHECK_RETRYABLE':'AWS_CHECK_FAILED',transient?'transient':/AccessDenied|Unauthorized|not authorized/i.test(error.code+' '+error.message)?'platform-permission':'platform-maintenance',error.message,{component,action,resource,error,attempts:e.inspectionAttempts,...(transient?{retryable:true,retryAfterMs:5000}:{}),verification:transient?'Wait briefly, then repeat iac.inspect or prepare a fresh recovery plan. Temporary AWS throttling or transport failure does not establish a missing permission.':'Repeat iac.inspect after the approved platform prerequisite has been restored.'}));return undefined;}
   };
   // IAM's account-level limits are low; do not burst parallel role inventories.
   if(!action.startsWith('iam:'))return read();
   const pending=iamTail.then(read,read);iamTail=pending.then(()=>undefined,()=>undefined);return pending;
  };
  const readStack=async(target:string)=>{
   const guardrail=target==='guardrail',name=guardrail?s.guardrailStack:op.input.stack.name;
   const prior=op.recoveryPlan?.ownershipEvidence?.[target]||op.inspection?.[target]||op.ownershipEvidence?.[target];
   const current=await check(target,'cloudformation:DescribeStacks',name,()=>this.clients.cloud('describeStacks',{StackName:name}),true);
   let stack=current?.Stacks?.[0],archived=false;
   const previousArn=prior?.lastStackId||prior?.stackId;
   if(!stack&&current!==undefined&&previousArn?.startsWith(`arn:aws:cloudformation:${s.region}:${s.account}:stack/${name}/`)){
    const past=await check(target,'cloudformation:DescribeStacks',previousArn,()=>this.clients.cloud('describeStacks',{StackName:previousArn}),true);
    if(past?.Stacks?.[0]){stack=past.Stacks[0];archived=true;}
   }
   const value:any={name,status:current===undefined?'UNKNOWN':stack&&!archived?stack.StackStatus:'NOT_CREATED',ownership:stack?'unverified':'absent',resources:[]};
   if(!stack)return value;
   const expectedRole=guardrail?process.env.IAC_GUARDRAIL_ROLE_ARN:s.roleArn,t=tags(stack.Tags);
   const owned=stack.StackId?.startsWith(`arn:aws:cloudformation:${s.region}:${s.account}:stack/${name}/`)&&t.GraphId===s.graphId&&t.NodeId===s.nodeId&&stack.RoleARN===expectedRole&&(guardrail?t.IsolationVersion===s.version:t.GraphStack===s.namespace);
   Object.assign(value,{...(archived?{lastStackId:stack.StackId}:{stackId:stack.StackId}),roleArn:stack.RoleARN,ownership:owned?'verified':'unverified',ownershipEvidence:{tags:t,expectedRole,namespace:s.namespace}});
   if(!guardrail&&!archived&&stack.StackStatus==='REVIEW_IN_PROGRESS'){
    const proof=await verifyReviewStack(s,stack,op,(method,args)=>check(target,method==='describeChangeSet'?'cloudformation:DescribeChangeSet':'cloudformation:ListStackResources',method==='describeChangeSet'?args.ChangeSetName:args.StackName,()=>this.clients.cloud(method,args)));
    if(proof){value.ownership='verified';value.reviewStackProof=proof;value.ownershipEvidence.reviewStackProof=proof;return value;}
    value.ownership='unverified';
    blockers.push(blocker('OWNERSHIP_UNVERIFIED','ownership','The empty review stack must match a server-recorded change set, its graph ownership tags, the assigned role, and a complete empty resource inventory.',{component:target,resource:stack.StackId}));return value;
   }
   if(!owned){blockers.push(blocker('OWNERSHIP_UNVERIFIED','ownership','Stack ownership tags, service role or ARN do not match the authenticated graph namespace.',{component:target,resource:stack.StackId}));return value;}
   const [listed,template]=await Promise.all([
    check(target,'cloudformation:ListStackResources',stack.StackId,()=>this.clients.cloud('listStackResources',{StackName:stack.StackId})),
    check(target,'cloudformation:GetTemplate',stack.StackId,()=>this.clients.cloud('getTemplate',{StackName:stack.StackId,TemplateStage:'Original'})),
   ]);
   if(listed?.NextToken)blockers.push(blocker('INVENTORY_TRUNCATED','platform-maintenance','Resource inventory exceeds the supported single-stack resource limit. Recovery is blocked until the full inventory can be proven.',{component:target}));
   let doc:any;
   try{doc=typeof template?.TemplateBody==='string'?parseTemplate(template.TemplateBody,'yaml').doc:template?.TemplateBody;}catch{}
   if(!doc?.Resources){if(template!==undefined)blockers.push(blocker('TEMPLATE_UNAVAILABLE','platform-maintenance','The deployed resource retention policies could not be verified.',{component:target}));return value;}
   value.templateDigest=digest(doc);
   value.resources=(listed?.StackResourceSummaries||[]).slice(0,100).map(r=>({logicalId:r.LogicalResourceId,physicalId:r.PhysicalResourceId,resourceType:r.ResourceType,status:r.ResourceStatus,
    deletionPolicy:doc.Resources[r.LogicalResourceId]?.DeletionPolicy||'Delete',definitionDigest:digest(doc.Resources[r.LogicalResourceId]||null),
    ownershipVerified:true,...(archived?{orphaned:r.ResourceStatus==='DELETE_SKIPPED'}:{})})).sort((a,b)=>a.logicalId.localeCompare(b.logicalId));
   if(guardrail){
    // Ownership of the stack is not permission to delete a foreign resource inserted into it.
    const permitted=(id:string)=>{
     const expected=approved.Resources[id],actual=doc.Resources[id];
     if(!expected||actual?.Type!==expected.Type||actual.Properties?.Path!==expected.Properties.Path)return false;
     const key=id==='RuntimeBoundary'?'ManagedPolicyName':'RoleName';
     return actual.Properties[key]===expected.Properties[key];
    };
    const placeholder=importPreparationTemplate();
    const validPlaceholder=!!doc.Resources.GraphRecoveryPlaceholder&&digest(doc.Resources.GraphRecoveryPlaceholder)===digest(placeholder.Resources.GraphRecoveryPlaceholder)&&digest(doc.Conditions)===digest(placeholder.Conditions)&&!value.resources.some(r=>r.logicalId==='GraphRecoveryPlaceholder');
    const invalid=Object.keys(doc.Resources).filter(id=>!(id==='GraphRecoveryPlaceholder'&&validPlaceholder)&&!permitted(id));
    for(const r of value.resources){
     const expected=approved.Resources[r.logicalId],physical=expected&&(r.logicalId==='RuntimeBoundary'?s.boundaryArn:expected.Properties.RoleName);
     r.ownershipVerified=permitted(r.logicalId)&&r.resourceType===expected?.Type&&(!r.physicalId||r.physicalId===physical);
     if(!r.ownershipVerified)invalid.push(r.logicalId);
    }
    if(invalid.length)blockers.push(blocker('GUARDRAIL_RESOURCE_UNVERIFIED','ownership','Guardrail inventory or resource names/paths differ from the assigned platform definition. Recovery cannot delete or adopt these resources.',{component:target,logicalIds:[...new Set(invalid)].sort()}));
   }
   // A failed import can leave a verified empty preparation stack. Preserve the
   // prior deleted stack's ownership record so a new plan can still import its data.
   value.importPreparation=digest(doc)===digest(importPreparationTemplate())&&value.resources.length===0;
   if(value.importPreparation&&previousArn&&previousArn!==stack.StackId){
    const past=await check(target,'cloudformation:DescribeStacks',previousArn,()=>this.clients.cloud('describeStacks',{StackName:previousArn}),true);
    const old=past?.Stacks?.[0],oldTags=tags(old?.Tags);
    if(!old||old.StackStatus!=='DELETE_COMPLETE'||!previousArn.startsWith(`arn:aws:cloudformation:${s.region}:${s.account}:stack/${name}/`)||old.RoleARN!==expectedRole||oldTags.GraphId!==s.graphId||oldTags.NodeId!==s.nodeId||(guardrail?oldTags.IsolationVersion!==s.version:oldTags.GraphStack!==s.namespace)){
     blockers.push(blocker('RETAINED_RESOURCE_OWNERSHIP','ownership','The empty import stack has no verifiable deleted-stack ownership record. Retained resources will not be adopted.',{component:target,resource:previousArn}));
    }else{
     const [oldList,oldTemplate]=await Promise.all([
      check(target,'cloudformation:ListStackResources',previousArn,()=>this.clients.cloud('listStackResources',{StackName:previousArn})),
      check(target,'cloudformation:GetTemplate',previousArn,()=>this.clients.cloud('getTemplate',{StackName:previousArn,TemplateStage:'Original'})),
     ]);
     let oldDoc:any;try{oldDoc=typeof oldTemplate?.TemplateBody==='string'?parseTemplate(oldTemplate.TemplateBody,'yaml').doc:oldTemplate?.TemplateBody;}catch{}
     if(!oldDoc?.Resources||oldList?.NextToken)blockers.push(blocker('RETAINED_RESOURCE_OWNERSHIP','ownership','Retained-resource history could not be verified completely.',{component:target}));
     else {
      value.lastStackId=previousArn;
      value.resources=(oldList?.StackResourceSummaries||[]).filter(r=>r.ResourceStatus==='DELETE_SKIPPED'&&r.PhysicalResourceId).map(r=>({logicalId:r.LogicalResourceId,physicalId:r.PhysicalResourceId,resourceType:r.ResourceType,status:r.ResourceStatus,deletionPolicy:oldDoc.Resources[r.LogicalResourceId]?.DeletionPolicy||'Delete',definitionDigest:digest(oldDoc.Resources[r.LogicalResourceId]||null),ownershipVerified:!!prior?.resources?.some(p=>p.ownershipVerified&&p.logicalId===r.LogicalResourceId&&p.physicalId===r.PhysicalResourceId&&p.resourceType===r.ResourceType&&p.definitionDigest===digest(oldDoc.Resources[r.LogicalResourceId]||null)),orphaned:true}));
      if(value.resources.some(r=>!r.ownershipVerified))blockers.push(blocker('RETAINED_RESOURCE_OWNERSHIP','ownership','Retained resource history differs from its reviewed ownership evidence.',{component:target}));
     }
    }
   }
   return value;
  };
  const [application,guardrail]=await Promise.all([readStack('application'),readStack('guardrail')]);
  let installedExecutionPolicy:any;
  const roles=await Promise.all(['WorkerRole','ExecutionRole'].map(async logicalId=>{
   const definition=approved.Resources[logicalId].Properties,arn=logicalId==='WorkerRole'?s.workerRoleArn:s.roleArn,name=definition.RoleName;
   const got=await check('guardrail','iam:GetRole',arn,()=>this.clients.iam('getRole',{RoleName:name}),true);
   if(got===undefined)return {logicalId,arn,exists:'unknown',matches:false};
   if(!got)return {logicalId,arn,exists:false,matches:false};
   const role=got.Role;
   if(role.Arn!==arn){blockers.push(blocker('ROLE_OWNERSHIP_UNVERIFIED','ownership','A same-named role exists outside the assigned deployment path.',{resource:role.Arn}));return {logicalId,arn,exists:true,matches:false};}
   const [policy,inline,attached]=await Promise.all([
    check('guardrail','iam:GetRolePolicy',arn,()=>this.clients.iam('getRolePolicy',{RoleName:name,PolicyName:definition.Policies[0].PolicyName}),true),
    check('guardrail','iam:ListRolePolicies',arn,()=>this.clients.iam('listRolePolicies',{RoleName:name})),
    check('guardrail','iam:ListAttachedRolePolicies',arn,()=>this.clients.iam('listAttachedRolePolicies',{RoleName:name})),
   ]);
   if(inline?.IsTruncated||attached?.IsTruncated||attached?.AttachedPolicies?.length||inline?.PolicyNames?.some(n=>n!==definition.Policies[0].PolicyName)||role.PermissionsBoundary)
    blockers.push(blocker('UNAPPROVED_ROLE_POLICY','platform-maintenance','The guardrail role has extra policies or a boundary outside the approved definition. A platform administrator must review them; graph recovery cannot grant or detach arbitrary permissions.',{resource:arn}));
   const policyDigest=digest(policy?document(policy.PolicyDocument):null),trustDigest=digest(document(role.AssumeRolePolicyDocument));
   if(logicalId==='ExecutionRole'&&policy)installedExecutionPolicy=document(policy.PolicyDocument);
   const row=guardrail.resources.find(r=>r.logicalId===logicalId);
   if(!row?.ownershipVerified||row.physicalId!==name)blockers.push(blocker('ORPHAN_OWNERSHIP_UNVERIFIED','ownership','Role exists but no verified CloudFormation ownership record was found. Prefix alone does not prove ownership.',{resource:arn}));
   if(row){row.exists=true;row.physicalIdentity=role.RoleId;}
   return {logicalId,arn,exists:true,policyDigest,trustDigest,boundary:role.PermissionsBoundary?.PermissionsBoundaryArn||null,
    matches:policyDigest===digest(definition.Policies[0].PolicyDocument)&&trustDigest===digest(definition.AssumeRolePolicyDocument)};
  }));
  for(const r of roles)if(r.exists===false){const item=guardrail.resources.find(x=>x.logicalId===r.logicalId);if(item)item.exists=false;}
  // A DELETE_FAILED CloudFormation record does not prove a physical role exists.
  // Read only names proven by this graph's owned resource inventory. Unknown or
  // denied reads must never be treated as absence or authority for cleanup.
  const applicationRoles:any[]=[];
  for(const r of application.resources.filter(r=>r.resourceType==='AWS::IAM::Role'&&r.physicalId&&r.status!=='DELETE_COMPLETE')){
   const name=r.physicalId,expectedArn=`arn:aws:iam::${s.account}:role/graph-app/${name}`;
   if(!r.ownershipVerified||!name.startsWith(s.namespace)||!/^[\w+=,.@-]{1,64}$/.test(name)){
    blockers.push(blocker('APPLICATION_ROLE_OWNERSHIP_UNVERIFIED','ownership','Application role inventory is outside the assigned namespace.',{component:'application',logicalId:r.logicalId}));continue;
   }
   const got=await check('application-role','iam:GetRole',expectedArn,()=>this.clients.iam('getRole',{RoleName:name}),true);
   r.exists=got===undefined?'unknown':!!got?.Role;
   if(got?.Role){r.physicalIdentity=got.Role.RoleId;if(got.Role.Arn!==expectedArn||got.Role.PermissionsBoundary?.PermissionsBoundaryArn!==s.boundaryArn){
    r.ownershipVerified=false;blockers.push(blocker('APPLICATION_ROLE_OWNERSHIP_UNVERIFIED','ownership','The actual role path or boundary does not match this graph namespace. No role mutation is authorized.',{component:'application',logicalId:r.logicalId,resource:got.Role.Arn}));
   }}
   const rootArn=`arn:aws:iam::${s.account}:role/${name}`;
   const checks=[...ROLE_EXISTENCE_READS.map(action=>({phase:'before-creation',action,resource:rootArn})),...['iam:CreateRole','iam:GetRole','iam:GetRolePolicy','iam:PutRolePolicy','iam:DeleteRolePolicy','iam:DeleteRole'].map(action=>({phase:'path-scoped-lifecycle',action,resource:expectedArn}))];
   applicationRoles.push({logicalId:r.logicalId,name,expectedArn,actualArn:got?.Role?.Arn||null,exists:r.exists,cloudFormationStatus:r.status,
    checks:checks.map(c=>({...c,result:installedExecutionPolicy?policyCoverage(installedExecutionPolicy,c.action,c.resource):'unavailable'}))});
  }
  let boundary:any={arn:s.boundaryArn,exists:false,matches:false};
  const got=await check('guardrail','iam:GetPolicy',s.boundaryArn,()=>this.clients.iam('getPolicy',{PolicyArn:s.boundaryArn}),true);
  if(got?.Policy){
   const version=await check('guardrail','iam:GetPolicyVersion',s.boundaryArn,()=>this.clients.iam('getPolicyVersion',{PolicyArn:s.boundaryArn,VersionId:got.Policy.DefaultVersionId}));
   boundary={arn:s.boundaryArn,exists:true,physicalIdentity:got.Policy.PolicyId,versionId:got.Policy.DefaultVersionId,policyDigest:version?digest(document(version.PolicyVersion.Document)):null};
   boundary.matches=boundary.policyDigest===digest(approved.Resources.RuntimeBoundary.Properties.PolicyDocument);
   for(const usage of ['PermissionsBoundary','PermissionsPolicy']){
    const entities=await check('guardrail','iam:ListEntitiesForPolicy',s.boundaryArn,()=>this.clients.iam('listEntitiesForPolicy',{PolicyArn:s.boundaryArn,PolicyUsageFilter:usage,MaxItems:100}));
    if(entities?.IsTruncated||entities?.PolicyGroups?.length||entities?.PolicyUsers?.length||entities?.PolicyRoles?.some(r=>usage==='PermissionsPolicy'||!r.RoleName.startsWith(s.namespace)))
     blockers.push(blocker('BOUNDARY_EXTERNAL_ATTACHMENT','ownership','The retained boundary is attached outside its approved application namespace, or attachment enumeration was incomplete. It will not be modified.',{resource:s.boundaryArn}));
    if(usage==='PermissionsBoundary'&&entities?.PolicyRoles?.length&&!entities.IsTruncated)for(const role of entities.PolicyRoles){
     if(!role.RoleName.startsWith(s.namespace))continue;
     const actual=await check('boundary-attachment','iam:GetRole',role.RoleName,()=>this.clients.iam('getRole',{RoleName:role.RoleName}));
     if(actual&&!actual.Role.Arn.startsWith(`arn:aws:iam::${s.account}:role/graph-app/${s.namespace}`))blockers.push(blocker('BOUNDARY_EXTERNAL_ATTACHMENT','ownership','A boundary consumer is outside the approved application role path.',{resource:actual.Role.Arn}));
    }
   }
   const resource=guardrail.resources.find(r=>r.logicalId==='RuntimeBoundary'&&r.physicalId===s.boundaryArn);
   if(resource){resource.exists=true;resource.physicalIdentity=got.Policy.PolicyId;resource.orphaned=resource.status==='DELETE_SKIPPED';}
   else blockers.push(blocker('RETAINED_BOUNDARY_OWNERSHIP','ownership','The retained boundary exists but no matching owned CloudFormation resource record was found. Recovery will not adopt a policy based only on its name.',{resource:s.boundaryArn}));
  } else if(got===undefined)boundary.exists='unknown';
  else {const r=guardrail.resources.find(r=>r.logicalId==='RuntimeBoundary');if(r)r.exists=false;}
  // Current IAM document analysis is deliberately separate from actual AWS reads/assumption.
  const platformArn=process.env.IAC_GUARDRAIL_ROLE_ARN||'',platformName=platformArn.split('/').pop();
  const [platform,platformRole]=await Promise.all([
   check('platform-guardrail-role','iam:GetRolePolicy',platformArn,()=>this.clients.iam('getRolePolicy',{RoleName:platformName,PolicyName:'provision-platform-guardrails'})),
   check('platform-guardrail-role','iam:GetRole',platformArn,()=>this.clients.iam('getRole',{RoleName:platformName})),
  ]);
  const platformTrust=platformRole?document(platformRole.Role.AssumeRolePolicyDocument):null;
  if(platformRole&&(platformRole.Role.Arn!==platformArn||platformRole.Role.PermissionsBoundary))blockers.push(blocker('PLATFORM_ROLE_CONSTRAINT_CHANGED','platform-maintenance','The platform guardrail role ARN or permissions boundary differs from the approved platform definition. An administrator must review this prerequisite.',{component:'IacGuardrailRole',resource:platformArn}));
  const approvedTrust={Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'cloudformation.amazonaws.com'},Action:'sts:AssumeRole'}]};
  if(platformTrust&&digest(platformTrust)!==digest(approvedTrust))blockers.push(blocker('PLATFORM_TRUST_REQUIRED','platform-maintenance','The platform guardrail role trust differs from the approved CloudFormation service trust. A platform administrator must review and restore it.',{component:'IacGuardrailRole',action:'iam:UpdateAssumeRolePolicy',resource:platformArn}));
  // Fixed guardrails contain inline policies and an unattached boundary; they
  // never attach managed policies, alter role boundaries or list account IAM.
  const required=[...roles.flatMap(r=>['iam:GetRole','iam:GetRolePolicy','iam:ListRolePolicies','iam:ListAttachedRolePolicies','iam:DeleteRolePolicy','iam:CreateRole','iam:PutRolePolicy','iam:DeleteRole','iam:UpdateAssumeRolePolicy','iam:TagRole','iam:UntagRole'].map(action=>({action,resource:r.exists===false&&['iam:GetRole','iam:GetRolePolicy','iam:DeleteRolePolicy'].includes(action)?`arn:aws:iam::${s.account}:role/${r.arn.split('/').pop()}`:r.arn}))),
   ...['iam:GetPolicy','iam:GetPolicyVersion','iam:ListEntitiesForPolicy','iam:CreatePolicy','iam:CreatePolicyVersion','iam:DeletePolicyVersion','iam:ListPolicyVersions','iam:DeletePolicy'].map(action=>({action,resource:s.boundaryArn}))];
  const policyAnalysis=required.map(r=>({...r,result:platform?policyCoverage(document(platform.PolicyDocument),r.action,r.resource):'unavailable'}));
  for(const r of policyAnalysis)if(['not-granted','explicit-deny'].includes(r.result))blockers.push(blocker('PLATFORM_PERMISSION_REQUIRED','platform-permission','The platform guardrail role’s current approved policy does not grant '+r.action+'.',{component:'IacGuardrailRole',action:r.action,resource:r.resource,verification:'Review the platform policy change separately, deploy through platform CI, then run iac.inspect. Policy analysis is not proof of AWS execution success.'}));
  let assumption:any={result:'not-tested',reason:'The assigned worker role is absent or its approved trust/policy has not been restored.'};
  if(roles.find(r=>r.logicalId==='WorkerRole')?.matches){
   const credentials=await check('worker-assumption','sts:AssumeRole',s.workerRoleArn,()=>this.clients.assume(s));
   assumption={result:credentials?'succeeded':'failed',roleArn:s.workerRoleArn}; // Never return or persist the session credentials.
  }
  let workflow:any={status:'NOT_STARTED'};
  const sourceId=op.operationId;
  if(sourceId&&!op.inspectionOnly){
   const machine=process.env.IAC_REVIEW_STATE_MACHINE;
   if(!machine?.startsWith(`arn:aws:states:${s.region}:${s.account}:stateMachine:`))blockers.push(blocker('WORKFLOW_VERIFICATION_UNAVAILABLE','capability','The platform worker lacks the configured workflow address; current execution ownership cannot be verified.'));
   else {const arn=machine.replace(':stateMachine:',':execution:')+':'+sourceId;
    const state=await check('workflow','states:DescribeExecution',arn,()=>this.clients.states('describeExecution',{executionArn:arn}),true);
    workflow={executionArn:arn,status:state?.status||(state===null?'NOT_STARTED':'UNKNOWN')};
    if(workflow.status==='RUNNING'&&!(options.ownRecovery&&op.action==='recover'&&op.recoveryLease?.until>Date.now()))blockers.push(blocker('WORKFLOW_ACTIVE','busy','This operation’s workflow is still active. Wait or discard its pending deployment review before recovering.',{resource:arn}));
   }
  }
  for(const target of ['application','guardrail']) {const stack=target==='application'?application:guardrail;
   if(/IN_PROGRESS$/.test(stack.status)&&stack.status!=='REVIEW_IN_PROGRESS')blockers.push(blocker('STACK_BUSY','busy','CloudFormation is still changing this stack.',{component:target,resource:stack.stackId}));
  }
  const guardrailsMatch=roles.every(r=>r.matches)&&boundary.matches;
  if(application.importPreparation||guardrail.importPreparation)blockers.push(blocker('IMPORT_PREPARATION_PENDING','recovery','An owned empty stack is waiting for its retained resources to be imported. Prepare a fresh recovery review.'));
  const healthy=['CREATE_COMPLETE','UPDATE_COMPLETE','IMPORT_COMPLETE','UPDATE_ROLLBACK_COMPLETE'];
  const missingManagedRoles=roles.filter(r=>r.exists===false&&guardrail.resources.some(x=>x.logicalId===r.logicalId));
  if(healthy.includes(guardrail.status)&&missingManagedRoles.length)blockers.push(blocker('GUARDRAIL_ROLE_RECREATE_UNSUPPORTED','capability','The stable guardrail stack still owns a role record whose IAM resource was deleted. CloudFormation will not recreate it from an unchanged template, and the private repair function cannot create roles. A separately reviewed platform replacement procedure is required; graph recovery will not delete a healthy guardrail stack.',{component:'guardrail',logicalIds:missingManagedRoles.map(r=>r.logicalId),verification:'Restore the missing role through an approved platform replacement procedure, then run iac.inspect and prepare a fresh recovery plan.'}));
  const emptyReview=application.status==='REVIEW_IN_PROGRESS'&&!!application.reviewStackProof;
  const needsRecovery=application.importPreparation||guardrail.importPreparation||!emptyReview&&!['NOT_CREATED',...healthy].includes(application.status)||!['NOT_CREATED',...healthy].includes(guardrail.status)||guardrail.status!=='NOT_CREATED'&&!guardrailsMatch||guardrail.status==='NOT_CREATED'&&boundary.exists===true;
  if(needsRecovery)blockers.push(blocker('RECOVERY_REQUIRED','recovery','Prepare a recovery plan for the current failed, retained or drifted resources.'));
  const result:any={version:1,checkedAt:new Date().toISOString(),graphId:op.graphId,nodeId:op.nodeId,sourceOperationId:sourceId,scope:s,
   application,guardrail,roles,boundary,guardrailsMatch,assumption,workflow,
   applicationRoleLifecycle:{kind:'document-analysis-and-physical-role-reads',executionRoleArn:s.roleArn,roles:applicationRoles,
    deploymentTested:false,limitations:'Role reads run as the platform inspector, not as CloudFormation. Document checks include NotResource/NotAction but do not evaluate conditions, SCPs or session policies. Name-only reads are allowed solely within this namespace; writes and PassRole still require /graph-app/. Cleanup of a never-created role is not authorized on the root-path ARN.'},
   policyAnalysis:{kind:'document-analysis',verifiedDeployment:false,checks:policyAnalysis,platformRole:{arn:platformArn,trustDigest:digest(platformTrust),boundary:platformRole?.Role.PermissionsBoundary?.PermissionsBoundaryArn||null},limitations:'This is not IAM simulation or a deployment test. SCPs, session policies, service checks and eventual consistency can still deny operations.'},
   awsVerification:{kind:'actual-read-and-assume-calls',checks:actualChecks,deploymentTested:false},
   approvedGuardrailTemplate:approved,approvedGuardrailDigest:digest(approved),blockers,canReview:!blockers.length};
  const preview=recoveryPlan(op,result);
  result.recoveryReadiness={state:preview.prerequisites.length?'blocked':needsRecovery?'review-available':'not-required',
   prerequisites:preview.prerequisites,missingRoles:roles.filter(r=>r.exists===false).map(r=>r.logicalId),
   executionAuthority:'Platform worker and approved guardrail service role; per-stack roles are not assumed to restore guardrails.',
   requiredApproval:'human-exact-recovery-digest',requiresPlatformAdmin:preview.prerequisites.some(b=>['platform-permission','platform-maintenance','capability'].includes(b.kind))};
  result.fingerprint=inspectionFingerprint(result);return result;
 }

 /** Execute one fixed, human-reviewed action. Returns a short polling state. */
 async advance(op:any,action:any,index:number) {
  const s=scopeFor(op,this.policy()),plan=op.recoveryPlan;
  if(strict(op))refusePreservation(preservationActionProblems([action]));
  if(action.kind==='release-operation')return {done:true};
  if(plan.approvedGuardrailDigest!==digest(platformDefinition(s)))refused('STALE_RECOVERY','The approved platform definition changed. Prepare a new recovery review.');
  const guardrail=action.target==='guardrail',name=guardrail?s.guardrailStack:op.input.stack.name;
  const roleArn=guardrail?process.env.IAC_GUARDRAIL_ROLE_ARN:s.roleArn;
  const cloud=guardrail?this.clients.cloud:await this.clients.application(s);
  const token='recovery-'+s.namespace+op.operationId+'-'+index;
  let stack:any;
  try{stack=(await cloud('describeStacks',{StackName:name})).Stacks?.[0];}catch(e){if(!awsResourceAbsent(e,'cloudformation:DescribeStacks'))throw e;}
  if(stack){const t=tags(stack.Tags);
   if(!stack.StackId?.startsWith(`arn:aws:cloudformation:${s.region}:${s.account}:stack/${name}/`)||stack.RoleARN!==roleArn||t.GraphId!==s.graphId||t.NodeId!==s.nodeId||(guardrail?t.IsolationVersion!==s.version:t.GraphStack!==s.namespace))refused('OWNERSHIP_UNVERIFIED','Recovery target ownership changed. No action was taken.',403);
  }
  const status=stack?.StackStatus||'NOT_CREATED';
  if(strict(op)&&!action.submitted)refusePreservation(preservationStateProblems({[action.target]:{name,stackId:stack?.StackId,status}}));
  const verifyGuardrailIdentity=async(logicalId:string)=>{
   const expected=plan.ownershipEvidence.guardrail.resources.find(r=>r.logicalId===logicalId);
   if(!expected?.ownershipVerified)refused('OWNERSHIP_UNVERIFIED','Retained guardrails require a reviewed CloudFormation resource record.',403);
   const boundary=logicalId==='RuntimeBoundary',method=boundary?'getPolicy':'getRole',actionName=boundary?'iam:GetPolicy':'iam:GetRole';
   let current:any;
   try{const response=await this.clients.iam(method,boundary?{PolicyArn:s.boundaryArn}:{RoleName:platformDefinition(s).Resources[logicalId].Properties.RoleName});current=boundary?response.Policy:response.Role;}
   catch(e){if(!awsResourceAbsent(e,actionName))throw e;}
   if(expected.exists===false){if(current)refused('STALE_RECOVERY','A previously absent guardrail resource now exists. Prepare a fresh ownership review.');return;}
   const arn=boundary?s.boundaryArn:logicalId==='WorkerRole'?s.workerRoleArn:s.roleArn;
   if(!current||current.Arn!==arn||expected.physicalIdentity&&(current.PolicyId||current.RoleId)!==expected.physicalIdentity)refused('STALE_RECOVERY','A reviewed guardrail resource disappeared or was replaced. It will not be imported or deleted.');
   if(boundary){
    const version=await this.clients.iam('getPolicyVersion',{PolicyArn:s.boundaryArn,VersionId:current.DefaultVersionId});
    if(digest(document(version.PolicyVersion.Document))!==op.inspection.boundary.policyDigest)refused('STALE_RECOVERY','The retained boundary changed after review. Prepare a fresh recovery plan.');
    await Promise.all(['PermissionsBoundary','PermissionsPolicy'].map(async usage=>{
     const entities=await this.clients.iam('listEntitiesForPolicy',{PolicyArn:s.boundaryArn,PolicyUsageFilter:usage,MaxItems:100});
     if(entities.IsTruncated||entities.PolicyGroups?.length||entities.PolicyUsers?.length||entities.PolicyRoles?.some(r=>usage==='PermissionsPolicy'||!r.RoleName.startsWith(s.namespace)))refused('OWNERSHIP_UNVERIFIED','Boundary consumers changed. Recovery will preserve it and stop.',403);
     await Promise.all((entities.PolicyRoles||[]).map(async r=>{const role=await this.clients.iam('getRole',{RoleName:r.RoleName});if(!role.Role.Arn.startsWith(`arn:aws:iam::${s.account}:role/graph-app/${s.namespace}`))refused('OWNERSHIP_UNVERIFIED','The retained boundary has a foreign consumer.',403);}));
    }));
   }
  };
  const verifyReviewedInventory=async()=>{
   const expected=plan.ownershipEvidence[action.target];
   const [listed,template]=await Promise.all([cloud('listStackResources',{StackName:stack.StackId}),cloud('getTemplate',{StackName:stack.StackId,TemplateStage:'Original'})]);
   const doc=typeof template.TemplateBody==='string'?parseTemplate(template.TemplateBody,'yaml').doc:template.TemplateBody;
   const actual=(listed.StackResourceSummaries||[]).map(r=>({logicalId:r.LogicalResourceId,physicalId:r.PhysicalResourceId,resourceType:r.ResourceType,status:r.ResourceStatus})).sort((a,b)=>a.logicalId.localeCompare(b.logicalId));
   const prior=expected.resources.filter(r=>!expected.importPreparation||!r.orphaned).map(r=>({logicalId:r.logicalId,physicalId:r.physicalId,resourceType:r.resourceType,status:r.status})).sort((a,b)=>a.logicalId.localeCompare(b.logicalId));
   if(listed.NextToken||digest(doc)!==expected.templateDigest||digest(actual)!==digest(prior))refused('STALE_RECOVERY','Resource inventory or retention changed after review. No further recovery mutation was performed.');
  };
  if(action.kind==='delete-stack') {
   if(!stack||status==='DELETE_COMPLETE')return {done:true,status:'DELETE_COMPLETE'};
   if(action.stackId!==stack.StackId)refused('STALE_RECOVERY','The stack was replaced after recovery review.');
   if(status==='DELETE_IN_PROGRESS')return {done:false,status};
   if(action.submitted&&status==='DELETE_FAILED')throw new Error('Recovery deletion failed; inspect resource events and prepare a new recovery plan.');
   if(status!==plan.ownershipEvidence[action.target].status)refused('STALE_RECOVERY','The stack state changed after recovery review.');
   if(!['ROLLBACK_FAILED','ROLLBACK_COMPLETE','CREATE_FAILED','DELETE_FAILED','REVIEW_IN_PROGRESS'].includes(status))refused('STALE_RECOVERY','The stack is no longer in the reviewed failed creation/deletion state.');
   await verifyReviewedInventory();
   if(guardrail)await Promise.all(plan.ownershipEvidence.guardrail.resources.map(r=>verifyGuardrailIdentity(r.logicalId)));
   await cloud('deleteStack',{StackName:stack.StackId,RoleARN:roleArn,ClientRequestToken:token,...(status==='DELETE_FAILED'&&action.retainIds.length?{RetainResources:action.retainIds}:{})});
   return {done:false,submitted:true,status:'DELETE_IN_PROGRESS'};
  }
  if(action.kind==='continue-update-rollback'||action.kind==='rollback-stack') {
   if(stack&&stack.StackId!==action.stackId)refused('STALE_RECOVERY','The rollback target was replaced after review.');
   if(['UPDATE_ROLLBACK_COMPLETE','ROLLBACK_COMPLETE','NOT_CREATED','DELETE_COMPLETE'].includes(status))return {done:true,status};
   if(/IN_PROGRESS$/.test(status))return {done:false,status};
   if(action.submitted)throw new Error('The approved rollback failed. Inspect events and prepare a new recovery plan.');
   const expected=action.kind==='continue-update-rollback'?'UPDATE_ROLLBACK_FAILED':'UPDATE_FAILED';
   if(status!==expected||stack.StackId!==action.stackId)refused('STALE_RECOVERY','The stack no longer matches the reviewed rollback action.');
   await verifyReviewedInventory();
   await cloud(action.kind==='continue-update-rollback'?'continueUpdateRollback':'rollbackStack',{StackName:stack.StackId,RoleARN:roleArn,ClientRequestToken:token});return {done:false,submitted:true,status:'ROLLBACK_IN_PROGRESS'};
  }
  const ownershipTags=[{Key:'GraphId',Value:s.graphId},{Key:'NodeId',Value:s.nodeId},guardrail?{Key:'IsolationVersion',Value:s.version}:{Key:'GraphStack',Value:s.namespace}];
  if(action.kind==='import-retained') {
   const preparation=importPreparationTemplate(),changeSetName=token,template={...preparation,Resources:{...preparation.Resources,...Object.fromEntries(action.resources.map(r=>[r.logicalId,r.definition]))}};
   if(action.preparation?.templateDigest!==digest(preparation))refused('STALE_RECOVERY','This import needs a new recovery review including its empty-stack preparation.');
   if(guardrail)await Promise.all(action.resources.map(r=>verifyGuardrailIdentity(r.logicalId)));
   if(status==='NOT_CREATED'){
    if(action.submitted)refused('STALE_RECOVERY','The import preparation stack disappeared. Prepare a new recovery review.');
    await cloud('createStack',{StackName:name,RoleARN:roleArn,TemplateBody:JSON.stringify(preparation),Tags:ownershipTags,ClientRequestToken:token+'-prepare'});
    return {done:false,submitted:true,status:'IMPORT_PREPARING_STACK',reason:'Creating an empty owned stack to establish the reviewed role and tags; no application resources are created.'};
   }
   if(status==='CREATE_IN_PROGRESS')return {done:false,status:'IMPORT_PREPARING_STACK'};
   if(status==='CREATE_COMPLETE'){
    const [listed,current]=await Promise.all([cloud('listStackResources',{StackName:stack.StackId}),cloud('getTemplate',{StackName:stack.StackId,TemplateStage:'Original'})]);
    const doc=typeof current.TemplateBody==='string'?parseTemplate(current.TemplateBody,'yaml').doc:current.TemplateBody;
    if(listed.NextToken||listed.StackResourceSummaries?.length||digest(doc)!==digest(preparation))refused('STALE_RECOVERY','Only the verified empty preparation stack can receive this import.');
   }
   if(status==='IMPORT_COMPLETE'){
    const [listed,current]=await Promise.all([cloud('listStackResources',{StackName:stack.StackId}),cloud('getTemplate',{StackName:stack.StackId,TemplateStage:'Original'})]);
    const doc=typeof current.TemplateBody==='string'?parseTemplate(current.TemplateBody,'yaml').doc:current.TemplateBody;
    if(listed.NextToken||digest(doc)!==digest(template)||listed.StackResourceSummaries?.length!==action.resources.length||!action.resources.every(r=>listed.StackResourceSummaries?.some(a=>a.LogicalResourceId===r.logicalId&&a.PhysicalResourceId===r.physicalId&&a.ResourceType===r.resourceType)))refused('STALE_RECOVERY','Completed import does not match the reviewed retained resources.');
    return {done:true,status};
   }
   if(status==='IMPORT_IN_PROGRESS')return {done:false,status};
   if(!['CREATE_COMPLETE','REVIEW_IN_PROGRESS'].includes(status))refused('STALE_RECOVERY','A retained-resource import cannot replace or modify an existing application stack.');
   let changes:any;
   try{changes=await cloud('describeChangeSet',{StackName:name,ChangeSetName:changeSetName});}catch(e){if(!awsResourceAbsent(e,'cloudformation:DescribeChangeSet'))throw e;}
   if(!changes){if(guardrail)await Promise.all(action.resources.map(r=>verifyGuardrailIdentity(r.logicalId)));await cloud('createChangeSet',{StackName:name,ChangeSetName:changeSetName,ClientToken:token,ChangeSetType:'IMPORT',RoleARN:roleArn,Capabilities:['CAPABILITY_NAMED_IAM'],TemplateBody:JSON.stringify(template),Tags:ownershipTags,
     ResourcesToImport:action.resources.map(r=>({ResourceType:r.resourceType,LogicalResourceId:r.logicalId,ResourceIdentifier:{[r.identifier]:r.physicalId}}))});return {done:false,submitted:true,status:'IMPORT_PLANNING'};}
   if(['CREATE_PENDING','CREATE_IN_PROGRESS'].includes(changes.Status))return {done:false,status:changes.Status};
   if(changes.Status!=='CREATE_COMPLETE')throw new Error('Retained-resource import failed: '+changes.StatusReason);
   if(changes.NextToken||changes.Changes?.length!==action.resources.length||!action.resources.every(r=>changes.Changes.some(c=>c.ResourceChange?.Action==='Import'&&c.ResourceChange.LogicalResourceId===r.logicalId&&c.ResourceChange.ResourceType===r.resourceType)))refused('STALE_RECOVERY','The import change set contains actions outside the reviewed retained resources.');
   if(changes.ExecutionStatus==='AVAILABLE'){if(guardrail)await Promise.all(action.resources.map(r=>verifyGuardrailIdentity(r.logicalId)));await cloud('executeChangeSet',{StackName:name,ChangeSetName:changeSetName,ClientRequestToken:token});}
   else if(!['EXECUTE_IN_PROGRESS','EXECUTE_COMPLETE'].includes(changes.ExecutionStatus))throw new Error('Retained-resource import is no longer executable: '+changes.ExecutionStatus);
   return {done:false,submitted:true,status:'IMPORT_IN_PROGRESS'};
  }
  if(action.kind==='reconcile-guardrails'&&guardrail) {
   if(/IN_PROGRESS$/.test(status))return {done:false,status};
   if(action.submitted){if(!['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(status))throw new Error('Guardrail reconciliation failed: '+status);if(!this.clients.repair)refused('CAPABILITY_UNAVAILABLE','Approved guardrail repair is not configured.');await this.clients.repair(op);return {done:true,status};}
   const definition=platformDefinition(s);
   if(strict(op)&&status!=='NOT_CREATED'){
    const current=await cloud('getTemplate',{StackName:stack.StackId,TemplateStage:'Original'});
    assertGuardrailPreservation(parseTemplate(current.TemplateBody,'yaml').doc,definition);
   }
   const args={StackName:name,RoleARN:roleArn,Capabilities:['CAPABILITY_NAMED_IAM'],TemplateBody:JSON.stringify(definition),Tags:ownershipTags,ClientRequestToken:token,
    // SDK v2 has DisableRollback but predates RetainExceptOnCreate. Omit the
    // latter (AWS defaults it to false) instead of sending an unsupported key.
    ...(strict(op)?{DisableRollback:true}:{})};
   if(status==='NOT_CREATED')await cloud('createStack',args);
   else if(['IMPORT_COMPLETE','CREATE_COMPLETE','UPDATE_COMPLETE','UPDATE_ROLLBACK_COMPLETE'].includes(status)){
    try{await cloud('updateStack',args);}catch(e){if(/No updates are to be performed/i.test(e.message)){if(!this.clients.repair)refused('CAPABILITY_UNAVAILABLE','Approved guardrail repair is not configured.');await this.clients.repair(op);return {done:true,status};}throw e;}
   }else refused('STALE_RECOVERY','Guardrails must finish rollback or deletion before reconciliation.');
   return {done:false,submitted:true,status:status==='NOT_CREATED'?'CREATE_IN_PROGRESS':'UPDATE_IN_PROGRESS'};
  }
  refused('RECOVERY_ACTION_UNSUPPORTED','This platform does not support the stored recovery action.');
 }
}
