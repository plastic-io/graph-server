import {LambdaClient,InvokeCommand} from '@aws-sdk/client-lambda';
import S3Service from './s3Service';
import {ApplicationService} from './application/service';
import {lambdaRequestId} from './application/requestId';
const lambda=new LambdaClient({});
const applications=new ApplicationService(new S3Service(process.env.S3_BUCKET),{journal:false,rawResponse:true,returnMetadata:true,invokeWithMetadata:async(FunctionName,event)=>{
 const response=await lambda.send(new InvokeCommand({FunctionName,InvocationType:'RequestResponse',LogType:'Tail',Payload:Buffer.from(JSON.stringify(event))}));
 const log=Buffer.from(response.LogResult||'','base64').toString();
 const requestId=lambdaRequestId(log);
 const body=JSON.parse(Buffer.from(response.Payload||[]).toString()||'null');
 if(response.FunctionError)throw Object.assign(new Error(String(body?.errorMessage||'Application function failed').slice(0,1000)),{code:body?.errorType||'APPLICATION_FUNCTION_ERROR',requestId});return {body,requestId};
}});
/** Private IAM-only entry point; no public API/URL, no application resource may invoke it. */
export async function handler(request:any,context?:any){
 try{const result=await applications.invoke(request);return request.bridgeProtocolVersion===1?{bridgeProtocolVersion:1,ok:true,...result,bridgeRequestId:context?.awsRequestId}:result.body;}
 catch(e){if(request.bridgeProtocolVersion!==1)throw e;return {bridgeProtocolVersion:1,ok:false,error:{code:e.code||'APPLICATION_INVOCATION_FAILED',message:e.message},requestId:e.requestId,bridgeRequestId:context?.awsRequestId};}
}
