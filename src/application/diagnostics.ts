import {ulid} from 'ulid';
import {scopeFor,refused,digest} from '../iac/lifecycleModel';
import {diagnosticText,diagnosticError} from '../iac/diagnosticSafety';
import {policyFromEnv} from '../iac/validator';

type Call=(method:string,args:any)=>Promise<any>;
/** Default to diagnostic records, not arbitrary console payloads or application data. */
export function applicationLog(row:any,op:any):any {
 const text=String(row.message||''),requestId=text.match(/(?:RequestId:|\t)\s*([a-f0-9-]{36})\b/i)?.[1];
 if(/^(START|END|REPORT) RequestId:/.test(text))return {message:diagnosticText(text,op,1200),requestId};
 let record:any;try{record=JSON.parse(text.slice(text.indexOf('{')));}catch{return null;}
 if(record.type==='platform.report')return {message:'Lambda runtime report',requestId:record.record?.requestId};
 const structured=record.type==='graph.application.diagnostic';
 const runtimeError=record.errorType&&typeof record.errorMessage==='string'||record.level==='ERROR'&&(record.message?.errorType||record.errorType);
 if(!structured&&!runtimeError)return null;
 const error=structured?record.error:record.message?.errorType?record.message:record;
 const safe=error?diagnosticError(error,op):undefined;
 return {message:safe?.message||diagnosticText(record.message,op,1200),...(safe?{error:safe}:{}),
  requestId:diagnosticText(record.requestId||requestId||'',op,160),correlationId:structured?diagnosticText(record.correlationId||'',op,160):undefined};
}
/** Resource identifiers come from both the approved binding and the current owned CloudFormation inventory. */
export class ApplicationDiagnostics {
 constructor(private store:any,private deps:{cloud:Call;logs:Call;policy?:()=>any;now?:()=>number}){}
 private readObject(key:string):Promise<any>{return new Promise((resolve,reject)=>this.store.get(key,(e,v)=>e&&!/NoSuchKey|NotFound|not found/i.test(String(e.code||e.message))?reject(e):resolve(e?null:v)));}
 private put(key:string,v:any):Promise<void>{return new Promise((resolve,reject)=>this.store.compareAndSet(key,v,null,e=>e&&(e.statusCode===412||e.code==='PreconditionFailed')?resolve():e?reject(e):resolve()));}
 async read(op:any,options:any) {
  const s=scopeFor(op,(this.deps.policy||policyFromEnv)()),now=this.deps.now?.()??Date.now();
  if(op.state!=='succeeded'||!op.approval)refused('DEPLOYMENT_REQUIRED','Logs require an approved completed application deployment.');
  for(const key of Object.keys(options))if(!['schemaVersion','graphId','nodeId','operationId','logicalId','startTime','endTime','requestId','invocationId','correlationId','cursor','limit'].includes(key))refused('SCHEMA_INVALID','Unknown application log filter: '+key,400);
  if(!/^[A-Za-z0-9]{1,64}$/.test(options.logicalId||''))refused('SCHEMA_INVALID','A Lambda logicalId from the approved stack is required.',400);
  for(const key of ['requestId','correlationId'])if(options[key]&&!/^[A-Za-z0-9_.:-]{1,128}$/.test(options[key]))refused('SCHEMA_INVALID','Invalid '+key,400);
  if(options.invocationId&&!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(options.invocationId))refused('SCHEMA_INVALID','Invalid invocationId.',400);
  if(['requestId','correlationId','invocationId'].filter(k=>options[k]).length>1)refused('SCHEMA_INVALID','Choose one correlationId, invocationId or requestId filter per log query.',400);
  const resource=op.resources?.find(r=>r.logicalId===options.logicalId&&r.resourceType==='AWS::Lambda::Function');
  if(!resource||!resource.physicalId?.startsWith(s.namespace)||!/^[A-Za-z0-9-_]+$/.test(resource.physicalId))refused('RESOURCE_NOT_OWNED','The requested function is not owned by this approved application stack.',403);
  const prefix=`iac/runtime-diagnostics/${op.operationId}/`,binding={graphId:op.graphId,nodeId:op.nodeId,operationId:op.operationId,logicalId:options.logicalId,requestId:options.requestId||null,correlationId:options.correlationId||null,invocationId:options.invocationId||null,startTime:options.startTime||null,endTime:options.endTime||null};
  let queryId=ulid(),step=0,query:any,nextToken:string|undefined;
  if(options.cursor){
   let c:any;try{c=JSON.parse(Buffer.from(options.cursor,'base64url').toString());}catch{refused('SCHEMA_INVALID','Invalid application log cursor.',400);}
   if(!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(c.id)||!Number.isSafeInteger(c.step)||c.step<1||c.step>100)refused('SCHEMA_INVALID','Invalid application log cursor.',400);
   queryId=c.id;step=c.step;query=await this.readObject(prefix+queryId+'/query.json');
   if(!query||digest(query.binding)!==digest(binding))refused('SCHEMA_INVALID','Log cursor belongs to different filters or a different graph resource.',400);
   if(now-query.createdAt>86400000)refused('CURSOR_EXPIRED','This log query expired. Start a new bounded query; already published diagnostics remain in iac.events.');
   const cached=await this.readObject(prefix+queryId+'/'+step+'.json');if(cached)return cached.public;
   const prior=await this.readObject(prefix+queryId+'/'+(step-1)+'.json');if(!prior?.awsNextToken)refused('SCHEMA_INVALID','No next page exists for this cursor.',400);nextToken=prior.awsNextToken;
  } else {
   const end=options.endTime?Date.parse(options.endTime):now,start=options.startTime?Date.parse(options.startTime):end-900000;
   if(!Number.isFinite(start)||!Number.isFinite(end)||start>end||end>now+5000||end-start>3600000||start<now-7*86400000)refused('SCHEMA_INVALID','Use a window of at most one hour within the last seven days.',400);
   query={binding,window:{startTime:new Date(start).toISOString(),endTime:new Date(end).toISOString()},start,end,createdAt:now,limit:Math.max(1,Math.min(Number(options.limit)||50,100))};
   await this.put(prefix+queryId+'/query.json',query);
  }
  const cached=await this.readObject(prefix+queryId+'/'+step+'.json');if(cached)return cached.public;
  const response:any={events:[],window:query.window,truncated:false,hasMore:false,omitted:0,nextCursor:null,unavailable:false,diagnosticPolicy:'Lambda system records, runtime exceptions and graph.application.diagnostic records only; arbitrary console payloads are omitted.'};
  try {
   const stack=(await this.deps.cloud('describeStacks',{StackName:op.input.stack.name})).Stacks?.[0];
   const tags=Object.fromEntries((stack?.Tags||[]).map(t=>[t.Key,t.Value]));
   if(!stack?.StackId?.startsWith(`arn:aws:cloudformation:${s.region}:${s.account}:stack/${op.input.stack.name}/`)||tags.GraphId!==op.graphId||tags.NodeId!==op.nodeId||tags.GraphStack!==s.namespace||stack.RoleARN!==s.roleArn)refused('RESOURCE_NOT_OWNED','Current application stack ownership could not be verified.',403);
   const inventory=await this.deps.cloud('listStackResources',{StackName:stack.StackId});
   if(inventory.NextToken||!inventory.StackResourceSummaries?.some(r=>r.LogicalResourceId===options.logicalId&&r.PhysicalResourceId===resource.physicalId&&r.ResourceType==='AWS::Lambda::Function'))refused('RESOURCE_NOT_OWNED','The current stack resource does not match the approved function binding.',403);
   let ids:string[]=[];
   if(options.requestId)ids=[options.requestId];
   else if(options.invocationId){const mapping=await this.readObject(`iac/invocations/by-id/${op.operationId}/${options.invocationId}.json`);if(mapping?.logicalId===options.logicalId&&mapping.requestId)ids=[mapping.requestId];else {response.unavailable=true;response.reason='This application invocation has no Lambda request ID for the requested logical function.';}}
   else if(options.correlationId){
    const mapping=await this.readObject(`iac/invocations/${op.operationId}/${encodeURIComponent(options.correlationId)}.json`);
    ids=(mapping?.entries||[]).filter(e=>e.logicalId===options.logicalId&&e.requestId).map(e=>e.requestId).slice(-10);
    if(!ids.length){response.unavailable=true;response.reason='No Lambda request ID is recorded for this correlation. Inspect application invocation events; the call may have failed before Lambda execution.';}
   }
   if(!response.unavailable){
    const page=await this.deps.logs('filterLogEvents',{logGroupName:'/aws/lambda/'+resource.physicalId,startTime:query.start,endTime:query.end,limit:query.limit,
      ...(ids.length?{filterPattern:ids.length===1?'"'+ids[0]+'"':ids.map(id=>'?"'+id+'"').join(' ')}:{}),...(nextToken?{nextToken}:{})});
    let bytes=0;
    for(const row of page.events||[]) {
     const safe=applicationLog(row,op);if(!safe){response.omitted++;continue;}
     const entry={id:'application-log:'+row.eventId,at:new Date(row.timestamp).toISOString(),...safe,logicalId:options.logicalId,resourceType:'AWS::Lambda::Function',physicalId:resource.physicalId,logGroup:'/aws/lambda/'+resource.physicalId,logStream:diagnosticText(row.logStreamName,op,256),status:safe.error?'ERROR':'LOG',correlationId:options.correlationId||safe.correlationId};
     const size=Buffer.byteLength(JSON.stringify(entry));if(bytes+size>80000){response.truncated=true;response.omitted++;continue;}bytes+=size;response.events.push(entry);
    }
    const more=page.nextToken&&page.nextToken!==nextToken;
    response.hasMore=!!more;response.truncated=response.truncated||!!more;
    if(more&&step<99)response.nextCursor=Buffer.from(JSON.stringify({id:queryId,step:step+1})).toString('base64url');
    if(more&&step>=99)response.reason='Query page limit reached. Narrow the time window.';
    await this.put(prefix+queryId+'/'+step+'.json',{public:response,awsNextToken:more?page.nextToken:undefined});
    return response;
   }
  }catch(e){if(e.status===403)throw e;response.unavailable=true;response.error=diagnosticError(e,op);response.permissionFailure=/AccessDenied|Unauthorized|not authorized/i.test(response.error.code+' '+response.error.message);}
  await this.put(prefix+queryId+'/'+step+'.json',{public:response});return response;
 }
}
