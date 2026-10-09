/** Browser opt-in changes who clicks approval, never its digest or safety checks. */
export function automaticApproval(op:any) {
 const deny=(reason:string)=>({allowed:false,reason});
 if(!op||op.supersededBy)return deny('Only the current review can be approved.');
 if(op.action==='destroy'||op.recoveryPlan?.actions?.some((a:any)=>a.kind==='delete-stack'))return deny('Stack deletion is never eligible for auto-approval.');
 if(!Number.isFinite(op.expiresAt)||op.expiresAt<Date.now())return deny('The review expired.');
 if(op.action==='recover'){
  if(op.state!=='recovery-ready'||!op.recoveryPlan?.digest||op.recoveryPlan.prerequisites?.length)return deny('Recovery is not awaiting an executable approval.');
  if(op.recoveryPlan.preservesData!==true||!op.recoveryPlan.actions?.length||op.recoveryPlan.actions.some((a:any)=>a.dataLoss?.length||!['import-retained','reconcile-guardrails','release-operation'].includes(a.kind)))return deny('Recovery with deletion, rollback, data loss or unsupported actions requires manual review.');
 }else{
  if(op.action!=='apply'||op.state!=='awaiting-review'||!op.reviewDigest||!Array.isArray(op.plan?.changes))return deny('Deployment is not awaiting approval.');
  if(op.plan.destructive!==false||op.plan.changes.some((c:any)=>!['Add','Modify'].includes(c.action)||c.replacement&&c.replacement!=='False'||c.resourceType==='AWS::CloudFormation::Stack'))return deny('Resource removal, replacement or an uncertain change requires manual review.');
 }
 return {allowed:true,reason:'Eligible only while a human has enabled auto-approval for this graph in the current editor session. Exact-digest and freshness checks still apply.'};
}
export function checkApprovalMode(op:any,body:any) {
 if(body.approvalMode!==undefined&&!['manual','automatic'].includes(body.approvalMode))throw Object.assign(new Error('approvalMode must be manual or automatic.'),{code:'SCHEMA_INVALID',status:400});
 if(body.approvalMode==='automatic'){
  const decision=automaticApproval(op);
  if(!decision.allowed)throw Object.assign(new Error(decision.reason),{code:'AUTO_APPROVAL_FORBIDDEN',status:409});
 }
}
