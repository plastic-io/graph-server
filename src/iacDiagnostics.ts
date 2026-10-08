import S3Service from './s3Service';
import {DeploymentProgress} from './iac/progress';
import {DeploymentDiagnostics,diagnosticClients} from './iac/diagnostics';
import {progressNotifier} from './iac/progressRuntime';

/** Private read-only AWS collector. It cannot deploy, approve, change IAM, or modify review records. */
export async function handler(event:any){
 const id=event?.operationId||String(event?.detail?.executionArn||'').split(':').pop();
 if(!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id||''))throw new Error('Invalid operation ID');
 const store=new S3Service(process.env.S3_BUCKET),progress=new DeploymentProgress(store,progressNotifier());
 const op:any=await new Promise((resolve,reject)=>store.get('iac/reviews/'+id+'.json',(e,v)=>e?reject(e):resolve(v)));
 if(event.detail&&event.detail.stateMachineArn!==process.env.IAC_REVIEW_STATE_MACHINE)throw new Error('Unexpected workflow event');
 if(!await progress.claimCollection(id,!!event.detail)){
  if(event.detail)throw new Error('A diagnostic collection is in progress; retry this terminal workflow notification.');
  await progress.flush(op);return {operationId:id,collected:false};
 }
 await new DeploymentDiagnostics(progress,diagnosticClients(op.input.stack.region)).collect(op);
 return {operationId:id,collected:true};
}
