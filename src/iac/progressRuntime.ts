import BroadcastService from '../broadcastService';
import {DeploymentProgress} from './progress';
import {Lambda} from 'aws-sdk';
export function progressNotifier(){const bus=new BroadcastService();return (graphId:string,event:any)=>new Promise<void>((resolve,reject)=>bus._sendToChannel('graph-notify-'+graphId,event,err=>err?reject(err):resolve()));}
export function diagnosticRefresh(store:any){return async(operationId:string)=>{
 if(!process.env.IAC_DIAGNOSTICS_FUNCTION)return;
 const head=await new DeploymentProgress(store).head(operationId);
 if(head?.collectingUntil>Date.now()||head?.collectedAt&&Date.now()-head.collectedAt<15000)return;
 const result=await new Lambda({region:process.env.API_REGION,maxRetries:0,httpOptions:{connectTimeout:1500,timeout:25000}}).invoke({FunctionName:process.env.IAC_DIAGNOSTICS_FUNCTION,Payload:JSON.stringify({operationId})}).promise();
 if(result.FunctionError){
  let detail:any;try{detail=JSON.parse(String(result.Payload));}catch{/* Keep a bounded fallback if Lambda did not provide JSON. */}
  throw Object.assign(new Error(String(detail?.errorMessage||'Diagnostic collector is unavailable; stored diagnostics remain accessible.').slice(0,2000)),{code:'DIAGNOSTIC_COLLECTION_FAILED'});
 }
};}
