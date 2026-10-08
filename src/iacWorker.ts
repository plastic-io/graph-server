import S3Service from './s3Service';
import {IacReviewService} from './iac/review';
import {reviewCloud} from './iac/reviewAws';
import {diagnosticRefresh,progressNotifier} from './iac/progressRuntime';
import {LifecycleAws,lifecycleClients} from './iac/lifecycleAws';
import {ApplicationDiagnostics} from './application/diagnostics';
import {CloudWatchLogs} from 'aws-sdk';
import {diagnosticError} from './iac/diagnosticSafety';

const store=new S3Service(process.env.S3_BUCKET);
const refresh=diagnosticRefresh(store);
const clients=lifecycleClients(process.env.API_REGION||process.env.AWS_REGION);
const lifecycle=new LifecycleAws(clients);
const logClient=new CloudWatchLogs({region:process.env.API_REGION,maxRetries:0,httpOptions:{connectTimeout:1500,timeout:5000}});
const reviews=new IacReviewService(store,{
    cloud:reviewCloud(process.env.API_REGION || process.env.AWS_REGION,process.env.IAC_EXECUTION_ROLE_ARN),
    notify:progressNotifier(),
    lifecycle:{inspect:(op,options)=>lifecycle.inspect(op,options),advance:(op,a,i)=>lifecycle.advance(op,a,i)},
});
/** Invoked only by the state machine. There is no public event or Function URL. */
export async function handler(event: any,context?:any) {
    const id=event?.operationId;
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id || '')) throw new Error('Invalid operation ID');
    const op:any=await new Promise((resolve,reject)=>store.get('iac/reviews/'+id+'.json',(e,v)=>e?reject(e):resolve(v)));
    if(event.mode){
        try{
            if(event.mode==='inspect')return await lifecycle.inspect(op);
            if(event.mode==='runtime-logs')return await new ApplicationDiagnostics(store,{cloud:clients.cloud,logs:(m,a)=>(logClient as any)[m](a).promise()}).read(op,event.options||{});
            throw Object.assign(new Error('Unknown lifecycle read mode'),{code:'SCHEMA_INVALID',status:400});
        }catch(e){return {error:{...diagnosticError(e,op),status:e.status||409,problems:e.problems}};}
    }
    try {
        if(event.fatal){await reviews.fail(id,event.fatal);return {operationId:id,done:true};}
        return op.action==='recover'?await reviews.lifecycle.step(id):await reviews.step(id);
    } catch(error) {
        try{await reviews.recordException(id,error,context?.awsRequestId);}catch{/* Keep the deployment exception if its diagnostic store fails too. */}
        throw error;
    } finally {
        try{await refresh(id);}catch(e){console.warn('Deployment diagnostics pending',id,String(e?.code||e?.name||'unavailable'));}
    }
}
