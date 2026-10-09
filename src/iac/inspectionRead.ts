/** Retry read-only verification, never deployment/recovery mutations. */
export function transientInspectionError(error:any):boolean {
 const code=String(error?.code||error?.name||'').split('#').pop();
 return ['Throttling','ThrottlingException','RequestLimitExceeded','TooManyRequestsException','ServiceUnavailable','ServiceUnavailableException','InternalError','InternalFailure','RequestTimeout','RequestTimeoutException','TimeoutError','NetworkingError'].includes(code)||[429,500,502,503,504].includes(error?.statusCode);
}
const timing={now:()=>Date.now(),random:()=>Math.random(),sleep:(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))};
export async function inspectionRead(call:()=>Promise<any>,deadline:number,clock=timing) {
 for(let attempts=1;;attempts++) {
  try{return {value:await call(),attempts};}
  catch(error){
   const delay=Math.ceil(clock.random()*500*2**(attempts-1));
   // Leave room for the client's bounded five-second request timeout.
   if(!transientInspectionError(error)||attempts>=3||clock.now()+delay+5000>=deadline)
    throw Object.assign(error&&typeof error==='object'?error:new Error(String(error)),{inspectionAttempts:attempts});
   await clock.sleep(delay);
  }
 }
}
