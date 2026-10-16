/** DescribeExecution is eventually consistent. A review can be observed before
 * StartExecution returns, but absence after a bounded start window is an error. */
export const WORKFLOW_START_VISIBILITY_MS=60000;
export function missingWorkflow(op:any,now=Date.now(),previouslySeen=false) {
 if(op.inspectionOnly||op.action==='recover'&&!op.recoveryApproval)return {
  status:'NOT_STARTED',expected:true,reason:'This inspection or unapproved recovery review has not started a workflow. Monitoring does not approve it.'};
 const start=op.recoveryDispatchedAt||op.recoveryApproval?.at||op.createdAt;
 const starting=op.action==='recover'?op.state==='recovery-requested':op.state==='planning';
 if(!previouslySeen&&!op.originalError&&starting&&Number.isFinite(start)&&now>=start&&now-start<WORKFLOW_START_VISIBILITY_MS)return {
  status:'STARTING',expected:true,reason:'The operation is being dispatched or Step Functions has not made its execution visible yet. Poll again; the start visibility window is bounded to 60 seconds.'};
 return {status:'EXECUTION_MISSING',expected:false,reason:'The recorded Step Functions execution is missing outside the initial visibility window, or disappeared after being observed. Inspect platform orchestration; no AWS mutation or retry is implied.'};
}
