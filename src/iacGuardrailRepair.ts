import S3Service from './s3Service';
import {repairApprovedGuardrails} from './iac/guardrailRepair';
/** No HTTP event or Function URL. Only the lifecycle worker may invoke this platform repair. */
export async function handler(request:any){return repairApprovedGuardrails(new S3Service(process.env.S3_BUCKET),request);}
