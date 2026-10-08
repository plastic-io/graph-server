import {createHash} from 'crypto';
import {ulid} from 'ulid';
import {ObservationJournal} from '../runtime/journal';
import {readJournalObject} from '../runtime/journalStorage';
import {diagnosticText,diagnosticError,recoveryFor} from './diagnosticSafety';

const hash=(x:any)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const phaseFor=(state:string)=>({planning:'planning','awaiting-review':'awaiting-approval','apply-requested':'deploying',applying:'deploying'}[state]||'terminal');

/** Immutable operation pages plus a CAS head/outbox. The bus and MCP receive the same stored event. */
export class DeploymentProgress {
 constructor(private store:any,private notify?:(graphId:string,event:any)=>Promise<void>){}
 static prefix(id:string){if(!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))throw Object.assign(new Error('Invalid operation ID'),{code:'SCHEMA_INVALID',status:400});return `iac/progress/${id}/`;}
 private get(key:string,versioned=false):Promise<any>{return readJournalObject(this.store,key,versioned);}
 private cas(key:string,value:any,etag:string|null):Promise<boolean>{return new Promise((resolve,reject)=>this.store.compareAndSet(key,value,etag,(e)=>e&&(e.statusCode===412||e.code==='PreconditionFailed')?resolve(false):e?reject(e):resolve(true)));}
 async head(id:string){return (await this.get(DeploymentProgress.prefix(id)+'HEAD.json',true))?.value;}
 async mark(id:string,patch:any){const key=DeploymentProgress.prefix(id)+'HEAD.json';for(let i=0;i<12;i++){const row=await this.get(key,true);if(await this.cas(key,{seq:0,published:0,seen:[],...row?.value,...patch},row?.etag||null))return;}throw new Error('Deployment diagnostic metadata contention');}
 async claimCollection(id:string,force=false){
  const key=DeploymentProgress.prefix(id)+'HEAD.json';
  for(let i=0;i<8;i++){const row=await this.get(key,true),head=row?.value||{},now=Date.now();
   if(head.collectingUntil>now||(!force&&head.collectedAt&&now-head.collectedAt<15000))return false;
   if(await this.cas(key,{seq:0,published:0,seen:[],...head,collectingUntil:now+35000},row?.etag||null))return true;
  }return false;
 }
 private event(op:any,input:any){
  const clean:any={};
  clean.source=['worker','cloudformation','changeset','orchestration','cloudwatch','diagnostics'].includes(input.source)?input.source:'diagnostics';
  clean.phase=['planning','guardrails','awaiting-approval','deploying','rolling-back','cleanup','terminal'].includes(input.phase)?input.phase:phaseFor(op.state);
  for(const key of ['state','status','reason','code','stackName','logicalId','physicalId','resourceType','requestId','executionArn','logGroup','logStream','message'])if(input[key]!==undefined)clean[key]=diagnosticText(input[key],op,key==='reason'||key==='message'?2000:512);
  if(input.error)clean.error=diagnosticError(input.error,op);
  if(input.recovery)clean.recovery={category:diagnosticText(input.recovery.category,op,80),retryable:input.recovery.retryable===true,message:diagnosticText(input.recovery.message,op)};
  if(input.truncated)clean.truncated=true;
  const id='deployment:'+op.operationId+':'+hash(input.id||clean).slice(0,32);
  return {...clean,id,eventType:'deployment.progress',kind:'deployment.'+(input.kind||input.state||'progress'),schemaVersion:1,provenance:'server',
   graphId:op.graphId,nodeId:op.nodeId,operationId:op.operationId,correlationId:op.operationId,revisionId:op.revisionId||op.input.revisionId||'unknown',inputDigest:op.inputDigest,reviewDigest:op.reviewDigest||null,
   at:new Date(input.at||Date.now()).toISOString(),receivedAt:new Date().toISOString()};
 }
 async append(op:any,inputs:any[]){
  // Bound each stored batch; never discard the rest of a collected AWS page.
  for(let offset=0;offset<inputs.length;offset+=200)await this.persist(op,inputs.slice(offset,offset+200));
  await this.flush(op);
 }
 private async persist(op:any,inputs:any[]){
  if(!inputs.length)return;
  const key=DeploymentProgress.prefix(op.operationId)+'HEAD.json';
  const events=inputs.map(e=>this.event(op,e));
  for(let attempt=0;attempt<16;attempt++){
   const row=await this.get(key,true),head=row?.value||{seq:0,published:0,seen:[]};
   const seen=new Set(head.seen||[]),fresh=events.filter(e=>{if(seen.has(e.id))return false;seen.add(e.id);return true;});
   if(!fresh.length)return;
   const entries=fresh.map((e,i)=>({...e,sequence:head.seq+i+1}));
   const snapshot={...head.snapshot,resources:{...head.snapshot?.resources},failures:[...(head.snapshot?.failures||[])]};
   for(const e of entries){
    snapshot.lastEvent=e;
    if(e.source==='diagnostics'){snapshot.collectionWarning=e;continue;}
    if(e.source!=='cloudwatch'&&e.source!=='diagnostics'&&(!snapshot.latest||e.at>=snapshot.latest.at))snapshot.latest=e;
    if(e.source==='worker'&&e.kind==='deployment.phase')snapshot.workerPhase=e.phase;
    if(e.kind==='deployment.stack'&&e.stackName===op.input.stack.name&&(!snapshot.applicationStack||e.at>=snapshot.applicationStack.at))snapshot.applicationStack=e;
    if(e.kind==='deployment.cleanup')snapshot.cleanup=e;
    if(e.logicalId){const rk=e.stackName+'/'+e.logicalId,previous=snapshot.resources[rk];if(!previous||e.at>=previous.at)snapshot.resources[rk]=e;}
    if(e.error||/FAILED|ROLLBACK_COMPLETE|TIMED_OUT|ABORTED/.test(e.status||'')||e.state==='failed'){
     snapshot.failures=[...snapshot.failures.filter(x=>x.id!==e.id),e].slice(-20);
     // Keep the actual resource failure ahead of rollback/cancellation/cleanup noise.
     const candidates=[snapshot.failure,...snapshot.failures].filter(x=>x?.reason&&!/creation cancelled/i.test(x.reason)).sort((a,b)=>a.at.localeCompare(b.at));
     snapshot.failure=candidates.find(x=>x.source==='cloudformation'&&/^(CREATE|UPDATE|IMPORT)_FAILED$/.test(x.status))||candidates.find(x=>x.source==='cloudformation'&&/FAILED/.test(x.status))||snapshot.failures.find(x=>x.source==='worker'&&x.error)||snapshot.failures[0];
     const recovery=recoveryFor(op,e);
     if(!snapshot.recovery||recovery.category==='platform-intervention'||snapshot.recovery.category!=='platform-intervention')snapshot.recovery=recovery;
    }
    if(e.source==='orchestration'&&['FAILED','TIMED_OUT','ABORTED'].includes(e.status))snapshot.orchestrationFailure=e;
   }
   // Template policy caps resources at 100; bound even corrupted/unexpected AWS output.
   snapshot.resources=Object.fromEntries(Object.entries(snapshot.resources).slice(-300));
   const batchKey=DeploymentProgress.prefix(op.operationId)+ulid()+'.json';
   await new Promise<void>((resolve,reject)=>this.store.set(batchKey,{prev:head.key||null,first:head.seq+1,last:head.seq+entries.length,entries},{},e=>e?reject(e):resolve()));
   if(await this.cas(key,{...head,key:batchKey,seq:head.seq+entries.length,seen:[...seen].slice(-4096),snapshot},row?.etag||null))return;
  }throw new Error('Deployment progress contention');
 }
 private cursor(op:any,after:number){return Buffer.from(JSON.stringify({v:1,graphId:op.graphId,nodeId:op.nodeId,operationId:op.operationId,after})).toString('base64url');}
 async page(op:any,options:{cursor?:string;limit?:number;after?:number}={}){
  let after=options.after||0;
  if(options.cursor){try{const c=JSON.parse(Buffer.from(options.cursor,'base64url').toString());if(c.v!==1||c.graphId!==op.graphId||c.nodeId!==op.nodeId||c.operationId!==op.operationId||!Number.isSafeInteger(c.after)||c.after<0)throw new Error();after=c.after;}catch{throw Object.assign(new Error('Diagnostic cursor belongs to a different graph, node or operation.'),{code:'SCHEMA_INVALID',status:400});}}
  const head=await this.head(op.operationId);let key=head?.key;const batches:any[]=[];
  for(let count=0;key;count++){
   if(count>=10000)throw Object.assign(new Error('Diagnostic history exceeds the supported traversal window.'),{code:'CURSOR_EXPIRED',status:409});
   const batch=await this.get(key);if(!batch)throw new Error('Deployment diagnostic page missing');if(batch.last<=after)break;batches.push(batch);key=batch.prev;
  }
  const events:any[]=[];let bytes=0,scanned=after;
  outer:for(const b of batches.reverse())for(const e of b.entries){if(e.sequence<=after)continue;const size=Buffer.byteLength(JSON.stringify(e));if(events.length>=Math.max(1,Math.min(options.limit||50,100))||bytes+size>120000)break outer;events.push(e);bytes+=size;scanned=e.sequence;}
  return {operationId:op.operationId,events,nextCursor:this.cursor(op,scanned),hasMore:scanned<(head?.seq||0),receivedThrough:scanned};
 }
 async view(op:any){const head=await this.head(op.operationId),snapshot=head?.snapshot||{},all=Object.values<any>(snapshot.resources||{});
  let bytes=0;const resources=all.filter(e=>{bytes+=Buffer.byteLength(JSON.stringify(e));return bytes<=120000;});
  const phase=op.state==='planning'?snapshot.workerPhase||'planning':op.state==='applying'&&/ROLLBACK.*IN_PROGRESS/.test(snapshot.applicationStack?.status||'')?'rolling-back':phaseFor(op.state);
  return {version:1,sequence:head?.seq||0,...snapshot,phase,resources,resourceCount:all.length,resourcesTruncated:resources.length<all.length,collectedAt:head?.collectedAt||null,collectionPending:Object.values<any>(head?.collectionSources||{}).some(s=>s.queue?.length),
  history:{tool:'iac.events',arguments:{schemaVersion:1,graphId:op.graphId,nodeId:op.nodeId,operationId:op.operationId},cursor:this.cursor(op,0),latestCursor:this.cursor(op,head?.seq||0)},
  watch:{tool:'observations.watch',arguments:{schemaVersion:1,graphId:op.graphId,filter:{operationId:op.operationId}}}};}
 async flush(op:any){
  // Store first. Publication failure leaves the head outbox pending for the next worker/status request.
  try{for(let n=0;n<20;n++){
   const key=DeploymentProgress.prefix(op.operationId)+'HEAD.json',row=await this.get(key,true);if(!row||row.value.published>=row.value.seq)return;
   const page=await this.page(op,{after:row.value.published,limit:100});
   const published=await new ObservationJournal(this.store).append(op.graphId,page.events,{provenance:'server'});
   if(this.notify)for(const event of published||page.events)await this.notify(op.graphId,event);
   if(!await this.cas(key,{...row.value,published:page.receivedThrough},row.etag))continue;
  }}catch(e){console.warn('Deployment progress publication pending',op.operationId,String(e?.code||e?.name||'unavailable'));}
 }
}
