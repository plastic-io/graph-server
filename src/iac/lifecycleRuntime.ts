import {Lambda} from 'aws-sdk';
import {refused} from './lifecycleModel';

/** UI and MCP use the same private worker; application credentials never cross this boundary. */
export function lifecycleRemote() {
 const call=async(mode:string,op:any,options?:any)=>{
  if(!process.env.IAC_LIFECYCLE_FUNCTION)refused('CAPABILITY_UNAVAILABLE','A platform administrator must bootstrap lifecycle support through platform CI. This graph cannot provision its own worker or grant itself platform authority.');
  const result=await new Lambda({region:process.env.API_REGION,maxRetries:0,httpOptions:{connectTimeout:1500,timeout:26000}}).invoke({FunctionName:process.env.IAC_LIFECYCLE_FUNCTION,Payload:JSON.stringify({mode,operationId:op.operationId,options})}).promise();
  let body:any;try{body=JSON.parse(String(result.Payload||'null'));}catch{refused('LIFECYCLE_UNAVAILABLE','The lifecycle worker returned an unreadable response.');}
  if(result.FunctionError||body?.error)refused(body?.error?.code||'LIFECYCLE_UNAVAILABLE',body?.error?.message||body?.errorMessage||'Lifecycle worker failed.',body?.error?.status||409,body?.error?.problems);
  return body;
 };
 return {inspect:op=>call('inspect',op),logs:(op,options)=>call('runtime-logs',op,options)};
}
