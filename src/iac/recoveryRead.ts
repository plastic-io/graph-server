import {inspectionRead} from './inspectionRead';
import {awsResourceAbsent} from './awsErrors';

/** Retry only read-only prerequisite checks, within the worker lease. Never
 * replay an infrastructure mutation or reinterpret denial as absence. */
export async function recoveryRead(service:string,method:string,args:any,call:()=>Promise<any>,deadline=Date.now()+18000) {
 try{return (await inspectionRead(call,deadline)).value;}
 catch(error){
  const action=service+':'+method[0].toUpperCase()+method.slice(1);
  if(awsResourceAbsent(error,action))throw error;
  const resource=args.PolicyArn||args.RoleName||args.StackName||args.ChangeSetName||'assigned resource';
  error.message=`${action} on ${resource}: ${error.message}`;
  throw error;
 }
}
