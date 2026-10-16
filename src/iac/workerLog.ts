import {diagnosticError} from './diagnosticSafety';
import {phaseFor} from './progress';

/** Only fixed platform metadata is logged. Never spread an event, template,
 * invocation input, credentials, or a worker result into CloudWatch. */
export function workerDiagnostic(op:any,requestId:string|undefined,status:'STEP_STARTED'|'STEP_COMPLETED'|'ERROR',error?:any) {
 return {type:'deployment.diagnostic',operationId:op.operationId,requestId,
  phase:phaseFor(op.state),status,
  ...(error?{error:diagnosticError(error,op)}:{message:status==='STEP_STARTED'?'Deployment worker step started.':'Deployment worker step completed.'})};
}
