import {LambdaClient,InvokeCommand} from '@aws-sdk/client-lambda';
import S3Service from './s3Service';
import {ApplicationService} from './application/service';
const lambda=new LambdaClient({});
const applications=new ApplicationService(new S3Service(process.env.S3_BUCKET),{journal:false,rawResponse:true,invoke:async(FunctionName,event)=>{
 const response=await lambda.send(new InvokeCommand({FunctionName,InvocationType:'RequestResponse',Payload:Buffer.from(JSON.stringify(event))}));
 const body=JSON.parse(Buffer.from(response.Payload||[]).toString()||'null');
 if(response.FunctionError)throw new Error(String(body?.errorMessage||'Application function failed').slice(0,1000));return body;
}});
/** Private IAM-only entry point; no public API/URL, no application resource may invoke it. */
export async function handler(request:any){return applications.invoke(request);}
