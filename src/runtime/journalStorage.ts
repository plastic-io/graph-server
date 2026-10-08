/**
 * S3 returns AccessDenied for an absent object when unrestricted ListBucket is
 * unavailable. An exact-prefix list distinguishes absence without granting a
 * journal writer permission to enumerate the rest of the graph bucket.
 */
export function readJournalObject(store:any,key:string,versioned=false):Promise<any>{
 return new Promise((resolve,reject)=>store[versioned?'getVersioned':'get'](key,(error:any,value:any)=>{
  if(!error)return resolve(value);
  if(/NoSuchKey|NotFound|not found/i.test(String(error.code||error.message)))return resolve(null);
  if(error.code!=='AccessDenied'||!store.list||!/^((iac\/progress)|(observations\/watch))\/[^/]+\/HEAD\.json$/.test(key))return reject(error);
  store.list(key,(listError:any,objects:any[])=>{
   // A denied read of an existing object is never converted into an empty journal.
   if(listError||!Array.isArray(objects)||objects.some(o=>o.Key===key))return reject(error);
   resolve(null);
  });
 }));
}
