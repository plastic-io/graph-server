import {CloudFormation,CloudWatchLogs,StepFunctions} from 'aws-sdk';
import {DeploymentProgress,phaseFor} from './progress';
import {diagnosticError} from './diagnosticSafety';
import {policyFromEnv} from './validator';
import {stackScope} from './isolation';

type Call=(method:string,args:any)=>Promise<any>;
export interface DiagnosticClients { cloud:Call; states:Call; logs:Call; }
export function diagnosticClients(region:string):DiagnosticClients {
 const options={region,maxRetries:1,httpOptions:{connectTimeout:1500,timeout:4000}};
 const cf=new CloudFormation(options),states=new StepFunctions(options),logs=new CloudWatchLogs(options);
 return {cloud:(m,a)=>(cf as any)[m](a).promise(),states:(m,a)=>(states as any)[m](a).promise(),logs:(m,a)=>(logs as any)[m](a).promise()};
}
const gone=(e:any)=>/does not exist|not found|ResourceNotFound/i.test(String(e?.message||e?.code));
/** AWS identifiers are derived exclusively from the stored operation, never supplied by UI/MCP requests. */
export function diagnosticTarget(op:any,policy=policyFromEnv()) {
 const scope=stackScope(op.graphId,op.nodeId,policy),stack=op.input.stack;
 if(!policy.accounts.includes(stack.account)||!policy.regions.includes(stack.region))throw new Error('Diagnostic target is outside the configured deployment account/region');
 if(op.input.isolation){if(op.input.isolation.namespace!==scope.namespace||stack.name!==scope.namespace+'stack')throw new Error('Diagnostic operation namespace does not match its graph and node');}
 else if(!stack.name.startsWith(policy.stackPrefix)||policy.substrateStacks.includes(stack.name))throw new Error('Diagnostic stack is outside the deployment namespace');
 const machine=process.env.IAC_REVIEW_STATE_MACHINE||'';
 if(!machine.startsWith(`arn:aws:states:${stack.region}:${stack.account}:stateMachine:`))throw new Error('Deployment orchestration target is not configured for this account');
 return {stack:stack.name,guardrail:op.input.isolation?scope.guardrailStack:undefined,namespace:op.input.isolation?.namespace,
  executionArn:machine.replace(':stateMachine:',':execution:')+':'+op.operationId,
  logGroup:`/aws/lambda/${process.env.SERVICE_NAME}-${process.env.STAGE}-iacWorker`};
}

/** Bounded read-only collection. A failed source becomes a warning, never a replacement for the original error. */
export class DeploymentDiagnostics {
 constructor(private progress:DeploymentProgress,private clients:DiagnosticClients,private target=diagnosticTarget){}
 async collect(op:any){
  const target=this.target(op),events:any[]=[];const now=Date.now(),deadline=now+18000;
  const sources={...(await this.progress.head(op.operationId))?.collectionSources};
  const warning=(source:string,e:any)=>events.push({id:'diagnostic-warning:'+source+':'+String(e.code||e.name),source:'diagnostics',kind:'diagnostic-warning',phase:op.phase||phaseFor(op.state),status:'UNAVAILABLE',reason:`Could not collect ${source}; other diagnostics and the original error are preserved.`,error:diagnosticError(e,op),at:now});
  const protect=async(source:string,fn:()=>Promise<void>)=>{try{await fn();}catch(e){warning(source,e);}};
  const bounded=async<T>(promise:Promise<T>):Promise<T>=>{
   let timer:any;
   try{return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Diagnostic collection time budget reached; partial results are retained.'),{code:'COLLECTION_TIMEOUT'})),Math.max(1,deadline-Date.now()));})]);}finally{clearTimeout(timer);}
  };
  const call=(client:Call,method:string,args:any)=>{if(Date.now()>=deadline)throw Object.assign(new Error('Diagnostic collection time budget reached.'),{code:'COLLECTION_TIMEOUT'});return bounded(client(method,args));};
  // Always read the newest page, then resume older pages. Continuations are server-owned;
  // public cursors address only the redacted journal, never arbitrary AWS resources.
  const pages=async(key:string,limit:number,fetch:(token?:string)=>Promise<any>,consume:(page:any)=>void,tokenField='NextToken')=>{
   const saved=sources[key]||{queue:[],completed:[]};sources[key]=saved;
   const enqueue=(token:string)=>{if(token&&!saved.queue.includes(token)&&!saved.completed.includes(token)){
    if(saved.queue.length>=64){warning(key,{code:'COLLECTION_BACKLOG',message:'AWS event pagination backlog reached 64 pages; newest events continue to be collected.'});return;}
    saved.queue.push(token);
   }};
   const newest=await fetch();consume(newest);enqueue(newest[tokenField]);
   for(let n=1;n<limit&&saved.queue.length;n++){
    const token=saved.queue[0];let page:any;
    try{page=await fetch(token);}catch(e){if(/Invalid.*Token|Expired.*Token/i.test(String(e?.code||e?.name))){saved.queue.shift();saved.completed=[];}throw e;}
    consume(page);saved.queue.shift();saved.completed=[...saved.completed,token].slice(-128);enqueue(page[tokenField]);
   }
   if(saved.queue.length)events.push({id:'history-pending:'+key+':'+saved.queue[0],source:'diagnostics',kind:'diagnostic-warning',phase:phaseFor(op.state),status:'COLLECTING',reason:'More AWS event history is being collected. Refresh iac.status and continue iac.events from nextCursor; older events arrive with new sequence numbers.',at:now});
  };
  const inspectStack=async(name:string,guardrail:boolean)=>{
   let stack:any;
   try{stack=(await call(this.clients.cloud,'describeStacks',{StackName:op.stackId&&!guardrail?op.stackId:name})).Stacks?.[0];}
   catch(e){if(!gone(e))throw e;}
   const phase=guardrail?'guardrails':phaseFor(op.state);
   if(!stack){events.push({id:'stack-absent:'+name,source:'cloudformation',kind:'stack',phase,status:'NOT_CREATED',stackName:name,reason:guardrail?'Guardrail stack has not been created.':'Application stack has not been created.',at:now});return;}
   events.push({id:'stack-status:'+name+':'+stack.StackStatus+':'+(stack.StackStatusReason||''),source:'cloudformation',kind:'stack',phase:/ROLLBACK.*IN_PROGRESS/.test(stack.StackStatus)?'rolling-back':phase,status:stack.StackStatus,stackName:name,reason:stack.StackStatusReason,at:now});
   // CloudFormation pages include ResourceProperties. Deliberately copy only diagnostic fields.
   await pages('stack:'+name,4,next=>call(this.clients.cloud,'describeStackEvents',{StackName:stack.StackId||name,...(next?{NextToken:next}:{})}),result=>{
    for(const e of result.StackEvents||[]){
     const at=new Date(e.Timestamp).getTime();
     if(!Number.isFinite(at))continue;
     if(at<op.createdAt-5000&&!guardrail)continue;
     // Old guardrail failures explain why a retry cannot proceed. Never import another application's events.
     events.push({id:'cf:'+name+':'+e.EventId,source:'cloudformation',kind:'resource',phase:/ROLLBACK.*IN_PROGRESS/.test(e.ResourceStatus)?'rolling-back':guardrail?'guardrails':phase,
      stackName:name,logicalId:e.LogicalResourceId,physicalId:e.PhysicalResourceId,resourceType:e.ResourceType,status:e.ResourceStatus,reason:e.ResourceStatusReason,at});
    }
   });
  };
  await Promise.allSettled([
   protect('application stack',()=>inspectStack(target.stack,false)),
   ...(target.guardrail?[protect('guardrail stack',()=>inspectStack(target.guardrail,true))]:[]),
   protect('change set',async()=>{
    if(!op.changeSetId)return;
    const c=await call(this.clients.cloud,'describeChangeSet',{StackName:target.stack,ChangeSetName:op.changeSetId});
    events.push({id:'changeset:'+op.changeSetId+':'+c.Status+':'+c.ExecutionStatus,source:'changeset',kind:'change-set',phase:'planning',status:c.Status,reason:c.StatusReason,physicalId:op.changeSetId,stackName:target.stack,at:now});
   }),
   protect('orchestration',async()=>{
    const e=await call(this.clients.states,'describeExecution',{executionArn:target.executionArn});
    const original=e.error?diagnosticError({Error:e.error,Cause:e.cause},op):undefined;
    events.push({id:'workflow:'+e.status,source:'orchestration',kind:'orchestration',phase:phaseFor(op.state),status:e.status,executionArn:target.executionArn,reason:original?.message,...(original?{error:original}:{}),at:e.stopDate||now});
    if(!['FAILED','TIMED_OUT','ABORTED'].includes(e.status)&&!['failed','rollback-failed','rolled-back'].includes(op.state))return;
    await pages('workflow',3,next=>call(this.clients.states,'getExecutionHistory',{executionArn:target.executionArn,includeExecutionData:false,reverseOrder:true,maxResults:100,...(next?{nextToken:next}:{})}),history=>{
     for(const event of history.events||[]){
      if(!/Failed|TimedOut|Aborted/.test(event.type))continue;
      const details=event.lambdaFunctionFailedEventDetails||event.taskFailedEventDetails||event.executionFailedEventDetails||event.executionAbortedEventDetails||event.executionTimedOutEventDetails||event.lambdaFunctionTimedOutEventDetails||{};
      const error=diagnosticError({Error:details.error||event.type,Cause:details.cause},op);
      events.push({id:'workflow-event:'+event.id,source:'orchestration',kind:'exception',phase:op.phase||phaseFor(op.state),status:event.type,error,reason:error.message,executionArn:target.executionArn,at:event.timestamp});
     }
    },'nextToken');
   }),
   protect('worker log tail',async()=>{
    const end=Math.min(now,(['planning','awaiting-review','apply-requested','applying'].includes(op.state)?now:op.updatedAt+120000));
    const start=Math.max(op.createdAt-1000,end-300000);
    // No application log-group access: only this platform worker, this operation/time window.
    let next:string|undefined;const collected:any[]=[];
    for(let page=0;page<2;page++){
     const result=await call(this.clients.logs,'filterLogEvents',{logGroupName:target.logGroup,startTime:start,endTime:end,filterPattern:'"'+op.operationId+'"',limit:50,...(next?{nextToken:next}:{})});
     for(const row of result.events||[]){
      let message:any;try{message=JSON.parse(row.message.slice(row.message.indexOf('{')));}catch{continue;}
      if(message.type!=='deployment.diagnostic'||message.operationId!==op.operationId)continue;
      const error=message.error?diagnosticError(message.error,op):undefined;
      collected.push({id:'log:'+row.eventId,source:'cloudwatch',kind:'log',phase:message.phase||phaseFor(op.state),status:message.status||'LOG',message:error?.message||message.message,error,logGroup:target.logGroup,logStream:row.logStreamName,requestId:message.requestId,at:row.timestamp});
     }
     next=result.nextToken;if(!next)break;
    }
    events.push(...collected.slice(-20));
    if(next||collected.length>20)events.push({id:'log-tail-bound',source:'diagnostics',kind:'diagnostic-warning',phase:phaseFor(op.state),status:'TRUNCATED',truncated:true,reason:'Worker logs are a redacted tail of at most 20 operation-correlated entries within five minutes. Application logs and uncorrelated legacy lines are not exposed.',at:now});
    if(!collected.length)events.push({id:'log-tail-empty',source:'diagnostics',kind:'diagnostic-warning',phase:phaseFor(op.state),status:'UNAVAILABLE',reason:'No operation-correlated worker log lines are available. Legacy worker logs without an operation ID are excluded; stack and orchestration diagnostics remain available.',at:now});
   }),
  ]);
  events.sort((a,b)=>new Date(a.at).getTime()-new Date(b.at).getTime());
  await this.progress.append(op,events);
  await this.progress.mark(op.operationId,{collectedAt:now,collectingUntil:0,collectionSources:sources});
  return this.progress.view(op);
 }
}
