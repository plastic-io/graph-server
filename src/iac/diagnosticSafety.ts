import {redactCredentials} from '../security/credentials';
import {parseTemplate} from './validator';
const literalCache=new WeakMap<object,string[]>();

/** Structured platform records only. Application payloads are never passed to this sanitizer. */
export function diagnosticValue(value:any,op:any,depth=0):any {
 if(depth>14)return '[depth limit]';
 if(typeof value==='string')return diagnosticText(value,op,2000);
 if(Array.isArray(value))return value.slice(0,1000).map(v=>diagnosticValue(v,op,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,100).map(([key,v])=>[key,/^(credentials|input|payload|environment|parameters|secret|password|authorization|accessToken|refreshToken|sessionToken)$/i.test(key)?'[redacted]':diagnosticValue(v,op,depth+1)]));
 return value;
}

/** Diagnostic text is untrusted AWS/application output. Never persist request bodies or raw log records. */
export function diagnosticText(value:any,op:any,limit=2000):string {
 let text=String(value??'');
 let literals=op&&literalCache.get(op);
 if(!literals){literals=[];
  for(const v of Object.values(op?.input?.parameters||{}))if(typeof v==='string'&&v.length)literals.push(v);
  try {const doc=parseTemplate(op.input.text,op.input.format).doc;
   for(const p of Object.values<any>(doc?.Parameters||{}))if(p.NoEcho&&typeof p.Default==='string'&&p.Default.length)literals.push(p.Default);
   for(const r of Object.values<any>(doc?.Resources||{}))for(const v of Object.values(r.Properties?.Environment?.Variables||{}))if(typeof v==='string'&&v.length)literals.push(v);
  }catch{/* A malformed template must not hide the original diagnostic. */}
  if(op&&typeof op==='object')literalCache.set(op,literals);
 }
 for(const literal of literals.sort((a,b)=>b.length-a.length)){
  const escaped=literal.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  text=literal.length>=4?text.split(literal).join('[application value redacted]'):text.replace(new RegExp('(?<![A-Za-z0-9_])'+escaped+'(?![A-Za-z0-9_])','g'),'[application value redacted]');
 }
 text=redactCredentials(text)
  .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[private key redacted]')
  .replace(/(["']?(?:password|secret(?:[_-]?access[_-]?key)?|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|authorization|api[_-]?key)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,'$1[redacted]')
  .replace(/([?&](?:X-Amz-[^=]+|token|signature|credential|key)=)[^&#\s"']+/gi,'$1[redacted]')
  .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,'$1[credential redacted]@')
  .replace(/\b(?:Basic)\s+[A-Za-z0-9+/=]{8,}/g,'[credential redacted]');
 return text.length>limit?text.slice(0,limit)+'… [truncated]':text;
}
export function diagnosticError(error:any,op:any){
 let cause=error?.Cause??error?.cause;
 if(typeof cause==='string'){try{cause=JSON.parse(cause);}catch{cause={errorMessage:cause};}}
 const value=cause&&typeof cause==='object'?cause:error;
 return {code:diagnosticText(value?.code||value?.errorType||value?.name||error?.Error||'DEPLOYMENT_ERROR',op,160),
  message:diagnosticText(value?.message||value?.errorMessage||error?.message||error?.Error||(typeof error==='string'?error:'Deployment failed without an error message.'),op),
  ...(value?.requestId||value?.$metadata?.requestId?{requestId:diagnosticText(value.requestId||value.$metadata.requestId,op,160)}:{}),
  trace:[].concat(value?.trace||value?.stack?.split?.('\n')||[]).slice(0,6).map(line=>diagnosticText(line,op,400))};
}
export function recoveryFor(op:any,event:any){
 const status=String(event.status||''),message=String(event.reason||event.error?.message||'');
 if(op.action==='recover')return {category:'recovery-review',retryable:false,message:'The approved recovery stopped. Inspect the action outcome and current ownership with iac.inspect, then prepare a fresh iac.recovery.plan after its prerequisites are resolved. Recovery-worker errors do not imply an application template defect. A new exact recovery digest is required; no deployment is approved.'};
 if(/Check the operation in AWS|without an error message/i.test(message))return {category:'platform-intervention',retryable:false,message:'The original legacy failure has not been recovered yet. Inspect the diagnostic collection warning and refresh status. A platform maintainer must restore diagnostics before a safe retry can be determined.'};
 if(/ROLLBACK_FAILED|DELETE_FAILED/.test(status))return {category:'platform-intervention',retryable:false,message:'Rollback or cleanup did not finish. Use iac.inspect and iac.recovery.plan for current ownership, prerequisites and a graph-side recovery review. Monitoring never authorizes cleanup or deployment.'};
 if(/AccessDenied|Unauthorized|not authorized|cannot be assumed|permission|guardrail/i.test(message+' '+event.error?.code))return {category:'platform-intervention',retryable:false,message:'A platform permission or guardrail failed. Use iac.inspect to distinguish historical errors from current prerequisites, then iac.maintenance.request or iac.recovery.plan. Existing deployment approval is not reused.'};
 if(/throttl|timeout|timed.out|unavailable|network|rate.exceed/i.test(message+' '+status))return {category:op.approval?'platform-intervention':'retry-review',retryable:!op.approval,message:op.approval?'Deployment outcome may be uncertain. Inspect resource and rollback events here; a maintainer must reconcile it before retrying.':'A transient failure prevented planning. After it clears, create a new review; deployment still needs exact-digest human approval.'};
 return {category:'template-correction',retryable:false,message:'Correct the reported resource or template problem, then create and approve a new review. Graph acceptance alone does not deploy infrastructure.'};
}
