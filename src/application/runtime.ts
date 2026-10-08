import {Lambda} from 'aws-sdk';
import {ApplicationService,ApplicationRequest} from './service';
/** Only graph execution calls the private bridge; graph code never receives AWS credentials. */
export function applicationInvoker(store:any,publish:(graphId:string,event:any)=>Promise<void>){
 const remote=new Lambda();
 return async(req:ApplicationRequest)=>{
  if(!process.env.APPLICATION_BRIDGE_FUNCTION)throw new Error('Application invocation bridge is not configured');
  // Resolve locally as well to provide consistent observations and graph bus fan-out.
  const service=new ApplicationService(store,{publish,invokeWithMetadata:async(_arn,event)=>{
   const result=await remote.invoke({FunctionName:process.env.APPLICATION_BRIDGE_FUNCTION,InvocationType:'RequestResponse',Payload:JSON.stringify({...req,bridgeProtocolVersion:1,invocationId:event.context.invocationId,correlationId:event.context.correlationId,principal:{...event.context.caller,scopes:['graph:execute']}})}).promise();
   const response=JSON.parse(String(result.Payload||'null'));
   if(result.FunctionError||response?.bridgeProtocolVersion===1&&response.ok!==true)throw Object.assign(new Error(response?.error?.message||response?.errorMessage||'Application bridge failed'),{code:response?.error?.code,requestId:response?.requestId,bridgeRequestId:response?.bridgeRequestId});
   // During a rolling platform release an older bridge returns the raw body.
   return response?.bridgeProtocolVersion===1?response:{body:response};
  }});
  return service.invoke(req);
 };
}
