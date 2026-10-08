import S3Service from './s3Service';
import {IacReviewService} from './iac/review';
import {reviewCloud} from './iac/reviewAws';
import {diagnosticRefresh,progressNotifier} from './iac/progressRuntime';

const store=new S3Service(process.env.S3_BUCKET);
const refresh=diagnosticRefresh(store);
const reviews=new IacReviewService(store,{
    cloud:reviewCloud(process.env.API_REGION || process.env.AWS_REGION,process.env.IAC_EXECUTION_ROLE_ARN),
    notify:progressNotifier(),
});
/** Invoked only by the state machine. There is no public event or Function URL. */
export async function handler(event: any,context?:any) {
    const id=event?.operationId;
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id || '')) throw new Error('Invalid operation ID');
    try {
        if(event.fatal){await reviews.fail(id,event.fatal);return {operationId:id,done:true};}
        return await reviews.step(id);
    } catch(error) {
        try{await reviews.recordException(id,error,context?.awsRequestId);}catch{/* Keep the deployment exception if its diagnostic store fails too. */}
        throw error;
    } finally {
        try{await refresh(id);}catch(e){console.warn('Deployment diagnostics pending',id,String(e?.code||e?.name||'unavailable'));}
    }
}
