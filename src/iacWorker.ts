import S3Service from './s3Service';
import {IacReviewService} from './iac/review';
import {reviewCloud} from './iac/reviewAws';

const reviews=new IacReviewService(new S3Service(process.env.S3_BUCKET),{
    cloud:reviewCloud(process.env.API_REGION || process.env.AWS_REGION,process.env.IAC_EXECUTION_ROLE_ARN),
});
/** Invoked only by the state machine. There is no public event or Function URL. */
export async function handler(event: any) {
    const id=event?.operationId;
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id || '')) throw new Error('Invalid operation ID');
    if (event.fatal) await reviews.fail(id,'The deployment workflow failed. Check the operation in AWS before retrying.');
    return reviews.step(id);
}
