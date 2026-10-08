import {Lambda} from 'aws-sdk';
import {ApplicationService,ApplicationRequest} from './service';
/** Only graph execution calls the private bridge; graph code never receives AWS credentials. */
export function applicationInvoker(store:any,publish:(graphId:string,event:any)=>Promise<void>){
 const remote=new Lambda();
 return async(req:ApplicationRequest)=>{
  if(!process.env.APPLICATION_BRIDGE_FUNCTION)throw new Error('Application invocation bridge is not configured');
  // Resolve locally as well to provide consistent observations and graph bus fan-out.
  const service=new ApplicationService(store,{publish,invoke:async(_arn,event)=>{
   const result=await remote.invoke({FunctionName:process.env.APPLICATION_BRIDGE_FUNCTION,InvocationType:'RequestResponse',Payload:JSON.stringify({...req,principal:{...event.context.caller,scopes:['graph:execute']}})}).promise();
   const response=JSON.parse(String(result.Payload||'null'));if(result.FunctionError)throw new Error(response?.errorMessage||'Application bridge failed');return response;
  }});
  return service.invoke(req);
 };
}
