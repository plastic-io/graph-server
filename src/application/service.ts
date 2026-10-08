import {ulid} from 'ulid';
import {decide} from '../policy/decide';
import {ObservationJournal} from '../runtime/journal';
import {stackScope} from '../iac/isolation';
import {policyFromEnv} from '../iac/validator';
import {assertCredentialFree,redactCredentials} from '../security/credentials';
export {assertCredentialFree} from '../security/credentials';

export function publicCaller(principal:any){return principal?{sub:principal.sub,kind:principal.kind,tenant:principal.tenant}:null;}
export interface ApplicationRequest {graphId:string;nodeId:string;stackNodeId:string;logicalFunctionId:string;value:any;principal:any;executionId?:string;correlationId?:string;revisionId?:string;}
export class ApplicationService {
 constructor(private store:any,private deps:{invoke:(functionArn:string,event:any)=>Promise<any>;publish?:(graphId:string,event:any)=>Promise<void>;policy?:()=>any;journal?:boolean;rawResponse?:boolean}){}
 private get(key:string):Promise<any>{return new Promise((resolve,reject)=>this.store.get(key,(e,v)=>e?reject(e):resolve(v)));}
 async invoke(req:ApplicationRequest){
  if(!decide(req.principal,['graph:execute']).allow||!req.principal?.sub)throw Object.assign(new Error('Authenticated graph execution is required'),{code:'ADMISSION_DENIED',status:403});
  for(const id of [req.graphId,req.nodeId,req.stackNodeId,req.logicalFunctionId])if(!/^[A-Za-z0-9_.-]{1,64}$/.test(id))throw new Error('Invalid application address');
  assertCredentialFree(req.value);
  const binding=await this.get(`iac/deployed/${req.graphId}/${req.stackNodeId}.json`).catch(()=>null);
  if(!binding?.operationId)throw Object.assign(new Error('This stack has no completed approved deployment'),{code:'DEPLOYMENT_REQUIRED',status:409});
  const record=await this.get('iac/reviews/'+binding.operationId+'.json');
  const current=await this.get(`iac/review-index/${req.graphId}/${req.stackNodeId}.json`).catch(()=>null);
  if(current?.operationId && current.operationId!==binding.operationId){
   const active=await this.get('iac/reviews/'+current.operationId+'.json');
   if(['apply-requested','applying','destroyed'].includes(active.state)||active.manualRecoveryRequired||(active.state==='succeeded'&&!active.finalizedAt))throw Object.assign(new Error('Application deployment is changing or requires recovery; wait for deployment status'),{code:'DEPLOYMENT_UNAVAILABLE',status:409});
  }
  const scope=stackScope(req.graphId,req.stackNodeId,(this.deps.policy||policyFromEnv)());
  if(record.graphId!==req.graphId||record.nodeId!==req.stackNodeId||record.state!=='succeeded'||!record.approval||record.input?.isolation?.namespace!==scope.namespace)throw new Error('Deployment binding is not an approved isolated stack');
  const resource=(record.resources||[]).find(r=>r.logicalId===req.logicalFunctionId&&r.resourceType==='AWS::Lambda::Function');
  if(!resource||typeof resource.physicalId!=='string'||!resource.physicalId.startsWith(scope.namespace)||!/^[A-Za-z0-9-_]+$/.test(resource.physicalId))throw new Error('Function is not owned by this approved graph stack');
  const correlationId=req.correlationId||ulid();
  const context={schemaVersion:1,graphId:req.graphId,nodeId:req.nodeId,stackNodeId:req.stackNodeId,logicalFunctionId:req.logicalFunctionId,operationId:record.operationId,caller:publicCaller(req.principal),executionId:req.executionId,revisionId:req.revisionId,correlationId};
  try{
   const answer=await this.deps.invoke(`arn:aws:lambda:${scope.region}:${scope.account}:function:${resource.physicalId}`,{context,input:req.value});
   assertCredentialFree(answer);
   if(Buffer.byteLength(JSON.stringify(answer??null))>24000)throw new Error('Application response exceeds 24 KB');
   const updates=answer?.updates||[];
   if(!Array.isArray(updates)||updates.length>16)throw new Error('Application updates must be an array of at most 16 messages');
   for(const update of updates){
    if(typeof update.topic!=='string'||!update.topic.length||update.topic.length>128)throw new Error('Application update requires a topic');
    assertCredentialFree(update);
   }
   for(const update of updates)await this.deps.publish?.(req.graphId,{...context,eventType:'application.update',provenance:'server',messageId:ulid(),topic:update.topic,value:update.value,version:update.version});
   return this.deps.rawResponse||answer?.result===undefined?answer:answer.result;
  }catch(e){
   if(this.deps.journal!==false)await new ObservationJournal(this.store).append(req.graphId,[{kind:'exec.error',nodeId:req.nodeId,executionId:req.executionId,correlationId,operationId:record.operationId,revisionId:req.revisionId,payload:{message:redactCredentials(String(e.message)).slice(0,1000),code:'APPLICATION_INVOCATION_FAILED'}}],{provenance:'server'});
   throw e;
  }
 }
}
