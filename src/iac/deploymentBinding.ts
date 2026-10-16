import {canonical,validRecoveryDigest,digest} from './lifecycleModel';
import {parseTemplate} from './validator';

/** Recovery can resume an existing approval only when its application was untouched.
 * This never creates a binding or grants approval to a different template. */
export function preservesApprovedDeployment(recovery:any,deployment:any):boolean {
 const plan=recovery?.recoveryPlan,inspection=recovery?.inspection;
 if(recovery?.action!=='recover'||recovery.state!=='recovered'||!recovery.completedAt||recovery.manualRecoveryRequired||recovery.recoveryLease||recovery.reviewInvalidatedAt||recovery.supersededBy)return false;
 if(!deployment||deployment.state!=='succeeded'||!deployment.finalizedAt||deployment.manualRecoveryRequired||!deployment.reviewDigest||deployment.approval?.reviewDigest!==deployment.reviewDigest)return false;
 if(recovery.graphId!==deployment.graphId||recovery.nodeId!==deployment.nodeId||recovery.inputDigest!==deployment.inputDigest||canonical(recovery.input?.isolation)!==canonical(deployment.input?.isolation))return false;
 if(!validRecoveryDigest(plan)||recovery.recoveryApproval?.digest!==plan.digest||plan.graphId!==deployment.graphId||plan.nodeId!==deployment.nodeId||plan.inputDigest!==deployment.inputDigest||plan.preservation!=='strict'||recovery.preservation!=='strict'||!plan.preservesData||plan.allowDataLoss||plan.prerequisites?.length)return false;
 if(!plan.actions?.length||!plan.actions.every(a=>!a.dataLoss?.length&&(a.kind==='reconcile-guardrails'&&a.target==='guardrail'||a.kind==='release-operation'&&a.target==='operation')))return false;
 const before=plan.ownershipEvidence?.application,after=inspection?.application;
 if(!inspection?.guardrailsMatch||!inspection.canReview||inspection.blockers?.length||!before||!after||after.ownership!=='verified'||after.stackId!==deployment.stackId||!['CREATE_COMPLETE','UPDATE_COMPLETE','UPDATE_ROLLBACK_COMPLETE'].includes(after.status))return false;
 const sorted=(resources:any[])=>[...(resources||[])].sort((a,b)=>a.logicalId.localeCompare(b.logicalId));
 if(canonical({...before,resources:sorted(before.resources)})!==canonical({...after,resources:sorted(after.resources)}))return false;
 const template=parseTemplate(deployment.input.text,deployment.input.format).doc;
 if(!template||digest(template)!==after.templateDigest||!after.resources?.every(r=>r.ownershipVerified&&r.physicalId))return false;
 const inventory=(resources:any[])=>sorted(resources).map(r=>({logicalId:r.logicalId,physicalId:r.physicalId,resourceType:r.resourceType}));
 return canonical(inventory(deployment.resources))===canonical(inventory(after.resources));
}
