import {createHash} from 'crypto';
import {ulid} from 'ulid';
import {redactCredentials} from '../security/credentials';
import {readJournalObject} from './journalStorage';

/** Arrival-ordered, conditional-write journal. Browser timestamps/IDs never determine its cursor. */
export class ObservationJournal {
 constructor(private store:any){}
 private get(key:string):Promise<any>{return new Promise((resolve,reject)=>this.store.get(key,(err,value)=>err&& !/NoSuchKey|NotFound|not found/i.test(String(err.code||err.message))?reject(err):resolve(err?null:value)));}
 private head(graphId:string):Promise<any>{return readJournalObject(this.store,`observations/watch/${graphId}/HEAD.json`,true);}
 private set(key:string,value:any):Promise<void>{return new Promise((resolve,reject)=>this.store.set(key,value,{},err=>err?reject(err):resolve()));}
 async append(graphId:string,observations:any[],context:any={}){
  if(!observations.length)return;
  if(!this.store.getVersioned||!this.store.compareAndSet)throw new Error('Observation watch requires conditional storage writes');
  const receivedAt=new Date().toISOString();
  for(let attempt=0;attempt<20;attempt++){
   const head=await this.head(graphId),seq=head?.value.seq||0;
   const entries=observations.map((o,i)=>redactCredentials({...o,...context,graphId,receivedAt,arrival:seq+i+1}));
   const key=`observations/watch/${graphId}/${ulid()}.json`;
   await this.set(key,{prev:head?.value.key||null,first:seq+1,last:seq+entries.length,entries});
   const success=await new Promise<boolean>((resolve,reject)=>this.store.compareAndSet(`observations/watch/${graphId}/HEAD.json`,{seq:seq+entries.length,key},head?.etag||null,err=>err&&(err.statusCode===412||err.code==='PreconditionFailed')?resolve(false):err?reject(err):resolve(true)));
   if(success)return entries;
  }throw new Error('Observation journal contention; retry ingestion');
 }
 async read(graphId:string,options:{cursor?:string;from?:'beginning'|'latest';limit?:number;filter?:any}={}){
  const filter=options.filter||{},binding=createHash('sha256').update(JSON.stringify([graphId,Object.keys(filter).sort().map(k=>[k,filter[k]])])).digest('hex').slice(0,24);
  let after=0;
  if(options.cursor){try{const c=JSON.parse(Buffer.from(options.cursor,'base64url').toString());if(c.version!==1||c.binding!==binding||!Number.isSafeInteger(c.after)||c.after<0)throw new Error();after=c.after;}catch{throw Object.assign(new Error('Cursor belongs to a different graph/filter or is invalid.'),{code:'SCHEMA_INVALID'});}}
  const head=await this.head(graphId);if(options.from==='latest'&&!options.cursor)after=head?.value.seq||0;
  let key=head?.value.key;const batches:any[]=[];
  for(let i=0;key;i++){
   if(i>=2000)throw Object.assign(new Error('Watch history exceeds the replay window. Use iac.events for deployment history or observations.query for archived executions, then start from latest.'),{code:'CURSOR_EXPIRED'});
   const batch=await this.get(key);if(!batch)throw new Error('Observation journal is incomplete');
   if(batch.last<=after)break;batches.push(batch);key=batch.prev;
  }
  const page:any[]=[];let scanned=after,more=false,bytes=0;const limit=options.limit||100;
  outer:for(const batch of batches.reverse())for(const o of batch.entries){
   if(o.arrival<=after)continue;
   const matches=Object.entries(filter).every(([k,v])=>k==='kind'?String(o.kind).startsWith(String(v)):o[k]===v);
   const size=matches?Buffer.byteLength(JSON.stringify(o)):0;
   if(matches&&(page.length>=limit||(page.length&&bytes+size>120000))){more=true;break outer;}
   scanned=o.arrival;if(matches){page.push(o);bytes+=size;}
  }
  return {observations:page,nextCursor:Buffer.from(JSON.stringify({version:1,binding,after:scanned})).toString('base64url'),hasMore:more,receivedThrough:scanned,source:'durable-arrival-journal',legacyHistory:'observations.query',pollAfterMs:more?0:2000};
 }
}
