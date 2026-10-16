/** Browser opt-in changes who clicks approval, never its digest or safety checks. */
export type AiPermissionMode = 'manual' | 'safe-actions' | 'fully-automatic';
export function automaticApproval(op:any, mode:AiPermissionMode='fully-automatic') {
 const deny=(reason:string)=>({allowed:false,reason});
 if(mode==='manual')return deny('Manual mode requires a separate human approval.');
 if(!op||op.supersededBy)return deny('Only the current review can be approved.');
 if(op.action==='destroy'||op.recoveryPlan?.actions?.some((a:any)=>a.kind==='delete-stack'))return deny('Stack deletion is never eligible for auto-approval.');
 if(!Number.isFinite(op.expiresAt)||op.expiresAt<Date.now())return deny('The review expired.');
 if(op.action==='recover'){
  if(op.state!=='recovery-ready'||!op.recoveryPlan?.digest||op.recoveryPlan.prerequisites?.length)return deny('Recovery is not awaiting an executable approval.');
  if(op.recoveryPlan.preservesData!==true||!op.recoveryPlan.actions?.length||op.recoveryPlan.actions.some((a:any)=>a.dataLoss?.length||!['import-retained','reconcile-guardrails','release-operation'].includes(a.kind)))return deny('Recovery with deletion, rollback, data loss or unsupported actions requires manual review.');
  if(mode==='safe-actions'&&op.recoveryPlan.actions.some((a:any)=>a.kind!=='release-operation'))return deny('Safe Actions leaves recovery that changes AWS resources for manual review.');
 }else{
  if(op.action!=='apply'||op.state!=='awaiting-review'||!op.reviewDigest||!Array.isArray(op.plan?.changes))return deny('Deployment is not awaiting approval.');
  if(op.plan.destructive!==false||op.plan.changes.some((c:any)=>!['Add','Modify'].includes(c.action)||c.replacement&&c.replacement!=='False'||c.resourceType==='AWS::CloudFormation::Stack'))return deny('Resource removal, replacement or an uncertain change requires manual review.');
  if(mode==='safe-actions'){
   const retainedTypes=['AWS::S3::Bucket','AWS::DynamoDB::Table','AWS::SQS::Queue','AWS::Logs::LogGroup'];
   if(!op.plan.changes.length||op.plan.changes.some((c:any)=>c.action!=='Add'||!retainedTypes.includes(c.resourceType)||c.access||c.deletionPolicy!=='Retain'||c.updateReplacePolicy!=='Retain'))return deny('Safe Actions only approves additions of retained buckets, tables, queues and log groups without access-policy changes. Updates, IAM and other resource types need manual review.');
  }
 }
 return {allowed:true,reason:'Eligible only while a human has enabled auto-approval for this graph in the current editor session. Exact-digest and freshness checks still apply.'};
}
export function automaticApprovalOptions(op:any){
 return {...automaticApproval(op),modes:{'safe-actions':automaticApproval(op,'safe-actions'),'fully-automatic':automaticApproval(op,'fully-automatic')}};
}
export function checkApprovalMode(op:any,body:any) {
 if(body.approvalMode!==undefined&&!['manual','automatic'].includes(body.approvalMode))throw Object.assign(new Error('approvalMode must be manual or automatic.'),{code:'SCHEMA_INVALID',status:400});
 if(body.aiPermissionMode!==undefined&&(!['manual','safe-actions','fully-automatic'].includes(body.aiPermissionMode)||(body.approvalMode==='automatic')!==(body.aiPermissionMode!=='manual')))throw Object.assign(new Error('aiPermissionMode must match manual or automatic approvalMode.'),{code:'SCHEMA_INVALID',status:400});
 if(body.approvalMode==='automatic'){
  const decision=automaticApproval(op,body.aiPermissionMode||'fully-automatic');
  if(!decision.allowed)throw Object.assign(new Error(decision.reason),{code:'AUTO_APPROVAL_FORBIDDEN',status:409});
 }
}
