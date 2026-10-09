import {ulid} from 'ulid';
import {DelegationStore} from '../policy/delegation';
import {decide} from '../policy/decide';
import {DeploymentProgress} from './progress';
import {diagnosticError} from './diagnosticSafety';
import {policyFromEnv} from './validator';
import {canonical,digest,refused,scopeFor,recoveryPlan,validRecoveryDigest,inspectionFingerprint,operationKey,indexKey,lockKey,terminalStates,nextActions,platformDefinition} from './lifecycleModel';

export interface LifecycleDeps {
 invoke?:(graphId:string,principal:any,request:any)=>Promise<any>;
 inspect?:(op:any,options?:{ownRecovery?:boolean})=>Promise<any>;
 advance?:(op:any,action:any,index:number)=>Promise<any>;
 logs?:(op:any,options:any)=>Promise<any>;
 notify?:(graphId:string,event:any)=>Promise<void>;
 start?:(operationId:string)=>Promise<void>;
 policy?:()=>any;
 now?:()=>number;
 input?:(graphId:string,nodeId:string,principal:any)=>Promise<any>;
}
export function publicRecoveryPlan(plan:any) {
 if(!plan)return undefined;
 return {...plan,actions:plan.actions.map(a=>({...a,resources:a.resources?.map(r=>{const {definition,...visible}=r;return {...visible,...(definition?{definitionDigest:digest(definition)}:{})};})}))};
}
export function isPlatformAdmin(principal:any) {
 return principal?.kind==='human'&&decide(principal,['policy:admin']).allow&&(process.env.PLATFORM_ADMIN_SUBS||'').split(',').map(s=>s.trim()).filter(Boolean).includes(principal.sub);
}
export function maintenanceConfiguration() {
 const configured=!!(process.env.PLATFORM_ADMIN_SUBS||'').split(',').map(s=>s.trim()).filter(Boolean).length;
 return {configured,mode:'record-and-verify-only',executesAws:false,
  approvalEffect:'Records platform-admin approval for a separately reviewed platform release. It does not execute AWS changes, recovery or application deployment.',
  administratorRequirement:'A verified human subject configured in PLATFORM_ADMIN_SUBS with policy:admin authority.',
  ...(configured?{}:{blocker:{code:'PLATFORM_ADMIN_NOT_CONFIGURED',kind:'configuration',component:'platform-authorization',
   message:'No platform-maintenance administrator is configured. An authorized platform administrator must configure PLATFORM_ADMIN_SUBS through the platform release process. Ordinary graph recovery approval does not require this configuration.'}})};
}
/** Shares review records, per-stack fences and the durable bus outbox with normal deployment. */
export class IacLifecycleService {
 constructor(private store:any,private deps:LifecycleDeps){}
 private now(){return this.deps.now?.()??Date.now();}
 private policy(){return (this.deps.policy||policyFromEnv)();}
 private progress(){return new DeploymentProgress(this.store,this.deps.notify);}
 private read(key:string):Promise<any>{return new Promise((resolve,reject)=>this.store.getVersioned(key,(e,v)=>e&&!/NoSuchKey|NotFound|not found/i.test(String(e.code||e.message))?reject(e):resolve(e?null:v)));}
 private cas(key:string,value:any,etag:string|null):Promise<boolean>{return new Promise((resolve,reject)=>this.store.compareAndSet(key,value,etag,e=>e&&(e.statusCode===412||e.code==='PreconditionFailed')?resolve(false):e?reject(e):resolve(true)));}
 private async authority(g:string,n:string,p:any,write=false,approval=false) {
  if(![g,n].every(v=>/^[A-Za-z0-9_.-]{1,64}$/.test(v||'')))refused('SCHEMA_INVALID','Invalid graph or stack node ID.',400);
  p=await new DelegationStore(this.store).resolve(p,g);
  if(!decide(p,['graph:read',write?'iac:propose':'iac:read-status']).allow||approval&&(!decide(p,['iac:approve']).allow||p?.kind!=='human'))refused('ADMISSION_DENIED',approval?'An authenticated human with infrastructure approval authority must approve recovery.':'Graph-scoped infrastructure authority is required.',403);
  return p;
 }
 private async op(g:string,n:string,id?:string) {
  id=id||(await this.read(indexKey(g,n)))?.value.operationId;
  if(!id)return null;
  if(!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))refused('SCHEMA_INVALID','Invalid operation ID.',400);
  const row=await this.read(operationKey(id));
  if(!row||row.value.graphId!==g||row.value.nodeId!==n)refused('NOT_FOUND','Operation not found in this graph and node.',404);
  scopeFor(row.value,this.policy());return row;
 }
 private public(op:any){const {input,policyDigest,recoveryLease,...visible}=op;return {...visible,recoveryPlan:publicRecoveryPlan(op.recoveryPlan),stack:input.stack,nextActions:nextActions(op)};}
 private async historicalFailure(op:any) {
  const seen=new Set<string>();
  for(let depth=0;op&&depth<20&&!seen.has(op.operationId);depth++){
   seen.add(op.operationId);
   const failure=op.originalError||op.historicalFailure||op.reason||op.inspection?.historicalFailure;
   if(failure)return {historicalFailure:failure,historicalFailureOperationId:op.originalError?op.operationId:op.historicalFailureOperationId||op.inspection?.historicalFailureOperationId||op.operationId};
   const previous=op.sourceOperationId||op.previousOperationId;
   op=previous?(await this.op(op.graphId,op.nodeId,previous))?.value:null;
  }
  return {historicalFailure:null};
 }
 private async emit(op:any,kind:string,detail:any,status=op.state) {
  await this.progress().append(op,[{id:kind+':'+digest(detail),source:'lifecycle',kind,phase:kind.startsWith('runtime')?'runtime':kind.startsWith('maintenance')?'maintenance':op.action==='recover'?'recovering':'readiness',status,lifecycle:detail}]);
 }
 async inspect(g:string,n:string,p:any,options:any={}) {
  p=await this.authority(g,n,p);
  if(!this.deps.inspect)refused('CAPABILITY_UNAVAILABLE','Current AWS inspection is not configured. A platform administrator must deploy the graph lifecycle worker.');
  let row=await this.op(g,n,options.operationId);
  if(!row){
   const input=await this.deps.input?.(g,n,p);if(!input)refused('NOT_FOUND','Stack node not found.',404);
   const record={operationId:ulid(),graphId:g,nodeId:n,input,inputDigest:input.inputDigest,inspectionOnly:true,state:'inspected',action:'inspect',createdAt:this.now(),updatedAt:this.now(),history:[]};
   scopeFor(record,this.policy());await this.cas(operationKey(record.operationId),record,null);row=await this.read(operationKey(record.operationId));
  }
  const op=row.value,inspection=await this.deps.inspect(op);
  const lock=await this.read(lockKey(op.input.stack));
  const active=lock?.value.operationId&&await this.read(operationKey(lock.value.operationId));
  if(lock?.value.leaseUntil>this.now()){inspection.canReview=false;inspection.blockers.push({code:'WORKER_ACTIVE',kind:'busy',message:'A deployment worker still holds its execution lease.',operationId:lock.value.operationId,leaseUntil:lock.value.leaseUntil});}
  if(active&&!terminalStates.has(active.value.state)){
   inspection.activeOperation={operationId:active.value.operationId,state:active.value.state,action:active.value.action};
   inspection.canReview=false;
   if(active.value.operationId!==op.operationId)inspection.blockers.push({code:'OPERATION_ACTIVE',kind:'busy',message:'Another operation owns this stack.',operationId:active.value.operationId});
  }
  if(op.manualRecoveryRequired){inspection.canReview=false;inspection.blockers.push({code:'OPERATION_RECONCILIATION_REQUIRED',kind:'recovery',message:'The failed operation retains its safety lock. Prepare and approve recovery to reconcile its outcome before a fresh deployment review.'});}
  if(inspection.recoveryReadiness){
   const busy=inspection.blockers.filter(b=>b.kind==='busy');
   if(busy.length){inspection.recoveryReadiness.state='blocked';inspection.recoveryReadiness.prerequisites=[...inspection.recoveryReadiness.prerequisites.filter(b=>b.kind!=='busy'),...busy];}
   else if(op.manualRecoveryRequired&&inspection.recoveryReadiness.state==='not-required')inspection.recoveryReadiness.state='review-available';
  }
  try{inspection.templateValidation={kind:'static-template-validation',...(await this.deps.input?.(g,n,p))?.validation};}
  catch(e){inspection.templateValidation={kind:'static-template-validation',ok:false,error:diagnosticError(e,op)};}
  if(inspection.templateValidation.ok===false){inspection.canReview=false;inspection.blockers.push({code:'TEMPLATE_INVALID',kind:'template',message:'Current graph template validation failed. Correct it through a graph proposal before a new deployment review.'});}
  Object.assign(inspection,await this.historicalFailure(op));
  inspection.historyIsNotCurrentPermissionEvidence=true;
  inspection.maintenanceConfiguration=maintenanceConfiguration();
  const latest=await this.read(operationKey(op.operationId));
  await this.cas(operationKey(op.operationId),{...latest.value,inspection},latest.etag);
  await this.emit(op,'inspection',inspection);
  return {...inspection,operationId:op.operationId,nextActions:nextActions(op,inspection)};
 }
 async plan(g:string,n:string,p:any,options:any) {
  p=await this.authority(g,n,p,true);
  if(!this.deps.inspect||!this.deps.start)refused('CAPABILITY_UNAVAILABLE','Recovery requires the configured lifecycle worker and reviewed-operation workflow.');
  if(!/^[A-Za-z0-9_.-]{1,128}$/.test(options.idempotencyKey||''))refused('SCHEMA_INVALID','Supply a stable idempotencyKey for this recovery-plan request.',400);
  const source=(await this.op(g,n,options.operationId))?.value;if(!source)refused('NOT_FOUND','A prior operation is required for recovery.',404);
  const requestDigest=digest({g,n,source:source.operationId,key:options.idempotencyKey,allowDataLoss:options.allowDataLoss===true});
  const requestKey=`iac/recovery-requests/${g}/${n}/${digest(options.idempotencyKey)}.json`;
  const previous=await this.read(requestKey);
  if(previous){if(previous.value.requestDigest!==requestDigest)refused('IDEMPOTENCY_CONFLICT','This key was used for a different recovery request.');const found=await this.op(g,n,previous.value.operationId);if(found){await this.emit(found.value,'recovery.plan',{plan:publicRecoveryPlan(found.value.recoveryPlan),state:found.value.recoveryPlan.prerequisites.length?'recovery-blocked':'recovery-ready'});return this.public(found.value);}}
  const currentIndex=await this.read(indexKey(g,n));
  if(currentIndex?.value.operationId&&currentIndex.value.operationId!==source.operationId){
   const indexed=await this.read(operationKey(currentIndex.value.operationId));
   if(indexed?.value.requestDigest===requestDigest)return this.publishPlan(indexed.value,requestKey,requestDigest);
   if(indexed&&!terminalStates.has(indexed.value.state))refused('OPERATION_ACTIVE','Another deployment or recovery owns this stack.');
   refused('STALE_OPERATION','Prepare recovery from the current operation returned by iac.status. Its history preserves earlier failures.');
  }
  const inspection=await this.deps.inspect(source);
  const fence=await this.read(lockKey(source.input.stack)),owner=fence?.value.operationId&&await this.read(operationKey(fence.value.operationId));
  if(owner?.value.requestDigest===requestDigest)return this.publishPlan(owner.value,requestKey,requestDigest);
  if(fence?.value.leaseUntil>this.now()||owner?.value.recoveryLease?.until>this.now())refused('OPERATION_ACTIVE','A deployment or recovery worker still holds its execution lease. Wait for it to finish before preparing recovery.');
  if(owner&&!terminalStates.has(owner.value.state)) {
   const stranded=owner.value.operationId===source.operationId&&['FAILED','TIMED_OUT','ABORTED','SUCCEEDED','NOT_STARTED'].includes(inspection.workflow.status);
   const expired=owner.value.action==='recover'&&owner.value.state==='recovery-ready'&&owner.value.expiresAt<this.now();
   if(!stranded&&!expired)refused('OPERATION_ACTIVE','Another deployment or recovery owns this stack. Wait for it to finish.');
  }
  if(inspection.blockers.some(b=>b.kind==='busy'))refused('OPERATION_ACTIVE','A CloudFormation or workflow operation is still active.',409,inspection.blockers);
  const plan=recoveryPlan(source,inspection,options),id=ulid(),now=this.now(),historical=await this.historicalFailure(source);
  const op:any={operationId:id,graphId:g,nodeId:n,input:source.input,inputDigest:source.inputDigest,policyDigest:source.policyDigest,revisionId:source.revisionId,
   previousOperationId:source.operationId,sourceOperationId:source.operationId,requestDigest,action:'recover',state:plan.prerequisites.length?'recovery-blocked':'recovery-ready',
   recoveryPlan:plan,inspection,...historical,
   createdAt:now,updatedAt:now,expiresAt:now+900000,by:{sub:p.sub,kind:p.kind},history:[],recoveryIndex:0};
  await this.cas(operationKey(id),op,null);
  if(!await this.cas(lockKey(source.input.stack),{operationId:id},fence?.etag||null)) {
   const winner=await this.read(lockKey(source.input.stack)),record=winner?.value.operationId&&await this.read(operationKey(winner.value.operationId));
   if(record?.value.requestDigest===requestDigest)return this.publishPlan(record.value,requestKey,requestDigest);
   refused('OPERATION_ACTIVE','A concurrent review or recovery acquired the stack.');
  }
  return this.publishPlan(op,requestKey,requestDigest);
 }
 private async publishPlan(op:any,requestKey:string,requestDigest:string) {
  const key=indexKey(op.graphId,op.nodeId),index=await this.read(key);
  if(index?.value.operationId!==op.operationId){
   const fence=await this.read(lockKey(op.input.stack));
   if(fence?.value.operationId!==op.operationId||index?.value.operationId&&index.value.operationId!==op.sourceOperationId)refused('STALE_OPERATION','The current operation changed during recovery planning.');
   if(!await this.cas(key,{operationId:op.operationId},index?.etag||null)&&(await this.read(key))?.value.operationId!==op.operationId)refused('CONFLICT','The current operation changed during recovery planning.');
  }
  const src=await this.read(operationKey(op.sourceOperationId));
  if(src)await this.cas(operationKey(op.sourceOperationId),{...src.value,supersededBy:op.operationId,reviewInvalidatedAt:op.createdAt},src.etag);
  await this.cas(requestKey,{operationId:op.operationId,requestDigest},null);
  await this.emit(op,'recovery.plan',{plan:publicRecoveryPlan(op.recoveryPlan),state:op.recoveryPlan.prerequisites.length?'recovery-blocked':'recovery-ready'});
  if(op.state==='recovery-blocked')await this.release(op);
  return this.public(op);
 }
 async approve(g:string,n:string,p:any,body:any) {
  p=await this.authority(g,n,p,false,true);
  let row=await this.op(g,n,body.operationId),op=row?.value;
  if(!op||op.action!=='recover')refused('NOT_FOUND','Recovery plan not found.',404);
  if(body.recoveryDigest!==op.recoveryPlan?.digest||!validRecoveryDigest(op.recoveryPlan))refused('STALE_RECOVERY','Approve exactly the recovery digest displayed in the graph.');
  if(op.supersededBy||(await this.read(indexKey(g,n)))?.value.operationId!==op.operationId)refused('STALE_RECOVERY','A newer operation replaced this recovery review.');
  if(op.recoveryApproval&&['recovery-requested','recovering','recovered'].includes(op.state)){if(op.state==='recovery-requested'&&!op.recoveryDispatchedAt)await this.dispatchRecovery(op);return this.public((await this.op(g,n,op.operationId)).value);}
  if(op.state!=='recovery-ready'||this.now()>op.expiresAt||op.recoveryPlan.prerequisites.length)refused('STALE_RECOVERY','The plan is blocked, expired or no longer awaiting approval. Prepare a new recovery plan.');
  if(!op.recoveryPlan.preservesData&&body.confirmDataLoss!==true)refused('APPROVAL_REQUIRED','Explicitly approve the listed data loss before executing this recovery.');
  await this.assertFence(op);
  const inspection=await this.deps.inspect!(op);
  if(inspectionFingerprint(inspection)!==op.recoveryPlan.inspectionDigest||inspection.blockers.some(b=>b.kind!=='recovery'))refused('STALE_RECOVERY','AWS state, ownership, permissions or the platform definition changed. Prepare a new recovery plan.',409,inspection.blockers);
  row=await this.op(g,n,body.operationId);op=row.value;
  if(op.state!=='recovery-ready')return this.approve(g,n,p,body);
  if(op.supersededBy||this.now()>op.expiresAt)refused('STALE_RECOVERY','The recovery review changed or expired during verification.');
  await this.assertFence(op);
  const next={...op,state:'recovery-requested',updatedAt:this.now(),recoveryApproval:{sub:p.sub,at:this.now(),digest:body.recoveryDigest,confirmDataLoss:body.confirmDataLoss===true}};
  if(!await this.cas(operationKey(op.operationId),next,row.etag))refused('CONFLICT','Recovery changed while approving. Refresh its status.');
  await this.emit(next,'recovery.approval',{approval:next.recoveryApproval,planDigest:op.recoveryPlan.digest});
  await this.dispatchRecovery(next);
  return this.public((await this.op(g,n,op.operationId)).value);
 }
 private async dispatchRecovery(op:any){
  await this.assertFence(op);
  try{await this.deps.start!(op.operationId);}catch(e){if(!/ExecutionAlreadyExists/.test(String(e.code||e.name))){await this.fail(op,e);throw e;}}
  const row=await this.read(operationKey(op.operationId));
  await this.cas(operationKey(op.operationId),{...row.value,recoveryDispatchedAt:this.now()},row.etag);
 }
 private async assertFence(op:any) {
  const [index,lock]=await Promise.all([this.read(indexKey(op.graphId,op.nodeId)),this.read(lockKey(op.input.stack))]);
  if(index?.value.operationId!==op.operationId||lock?.value.operationId!==op.operationId)refused('STALE_RECOVERY','This recovery no longer owns the current operation and stack lock.');
 }
 private async release(op:any) {const key=lockKey(op.input.stack),lock=await this.read(key);if(lock?.value.operationId===op.operationId)await this.cas(key,{operationId:null},lock.etag);}
 private async fail(op:any,error:any) {
  const row=await this.read(operationKey(op.operationId));if(!row)return;
  // A transport failure can return while a private Lambda is still finishing.
  // Keep that worker's bounded lease; known local refusals ran no AWS mutation.
  const safe=diagnosticError(error,op),lease=error.status?null:row.value.recoveryLease;
  const next={...row.value,state:'failed',originalError:row.value.originalError||safe,reason:safe.message,manualRecoveryRequired:true,recoveryLease:lease,updatedAt:this.now()};
  await this.cas(operationKey(op.operationId),next,row.etag);await this.emit(next,'recovery.failure',{error:safe,sourceOperationId:op.sourceOperationId,...(lease?{workerLeaseUntil:lease.until,mayStillBeFinishing:true}:{})},'FAILED');
 }
 async step(id:string) {
  let row=await this.read(operationKey(id));if(!row)return {operationId:id,done:true};
  const op=row.value;scopeFor(op,this.policy());
  if(op.action!=='recover')refused('SCHEMA_INVALID','Not a recovery operation.',400);
  if(terminalStates.has(op.state))return {operationId:id,done:true};
  if(op.state==='recovery-ready')return {operationId:id,done:false,waitSeconds:30};
  const lease=ulid();if(op.recoveryLease?.until>this.now())return {operationId:id,done:false,waitSeconds:5};
  const stackKey=lockKey(op.input.stack),fence=await this.read(stackKey);
  if(fence?.value.operationId!==id)refused('STALE_RECOVERY','This recovery lost the stack fence.');
  if(fence.value.leaseUntil>this.now()||!await this.cas(stackKey,{operationId:id,lease,leaseUntil:this.now()+120000},fence.etag))return {operationId:id,done:false,waitSeconds:5};
  const releaseLease=async()=>{const lock=await this.read(stackKey);if(lock?.value.operationId===id&&lock.value.lease===lease)await this.cas(stackKey,{operationId:id},lock.etag);};
  if(!await this.cas(operationKey(id),{...op,recoveryLease:{id:lease,until:this.now()+120000}},row.etag)){await releaseLease();return {operationId:id,done:false,waitSeconds:5};}
  op.recoveryLease={id:lease,until:this.now()+120000};
  const save=async(patch:any)=>{const current=await this.read(operationKey(id));if(current?.value.recoveryLease?.id!==lease)refused('CONFLICT','Recovery worker lease changed.');const next={...current.value,...patch,updatedAt:this.now()};if(!await this.cas(operationKey(id),next,current.etag))refused('CONFLICT','Recovery state changed.');Object.assign(op,next);};
  try {
   await this.assertFence(op);
   if(!validRecoveryDigest(op.recoveryPlan)||op.recoveryApproval?.digest!==op.recoveryPlan.digest||op.recoveryPlan.prerequisites.length||op.recoveryPlan.approvedGuardrailDigest!==digest(platformDefinition(scopeFor(op,this.policy()))))refused('STALE_RECOVERY','Recovery approval or the approved platform definition is no longer valid.');
   if(this.now()-op.recoveryApproval.at>5*3600000)refused('RECOVERY_TIMEOUT','Recovery exceeded its monitoring window. Inspect its actions before preparing another plan.');
   if(op.state==='recovery-requested'){
    const inspection=await this.deps.inspect!(op,{ownRecovery:true});
    if(inspectionFingerprint(inspection)!==op.recoveryPlan.inspectionDigest||inspection.blockers.some(b=>b.kind!=='recovery'))refused('STALE_RECOVERY','The reviewed recovery is stale. No AWS mutation was performed.',409,inspection.blockers);
    await save({state:'recovering',startedAt:this.now()});
   }
   const index=op.recoveryIndex||0,action=op.recoveryPlan.actions[index];
   if(action) {
    const result=await this.deps.advance!(op,{...action,submitted:!!op.recoverySubmitted?.[index]},index);
    await save({recoveryIndex:result.done?index+1:index,recoverySubmitted:{...op.recoverySubmitted,...(result.submitted?{[index]:true}:{})},recoveryOutcomes:{...op.recoveryOutcomes,[index]:result}});
    await this.emit(op,'recovery.action',{index,action:publicRecoveryPlan({...op.recoveryPlan,actions:[action]}).actions[0],result},result.status||'COMPLETE');
    return {operationId:id,done:false,waitSeconds:5};
   }
   const inspection=await this.deps.inspect!(op,{ownRecovery:true});
   if(!inspection.canReview)refused('RECOVERY_PREREQUISITES_REMAIN','Recovery actions finished, but current inspection still blocks a new review.',409,inspection.blockers);
   if(op.recoveryPlan.actions.some(a=>a.target==='application'&&a.kind!=='release-operation')){
    const key=`iac/deployed/${op.graphId}/${op.nodeId}.json`,binding=await this.read(key);
    if(binding?.value.operationId&&!await this.cas(key,{operationId:null,recoveredBy:id},binding.etag))refused('CONFLICT','Deployment binding changed during recovery.');
   }
   await save({state:'recovered',inspection,manualRecoveryRequired:false,completedAt:this.now()});
   await this.emit(op,'recovery.complete',{inspection,recoveryDigest:op.recoveryPlan.digest,sourceOperationId:op.sourceOperationId,deploymentApproved:false});
   await this.release(op);return {operationId:id,done:true};
  } catch(e){await this.fail(op,e);return {operationId:id,done:true};}
  finally {const current=await this.read(operationKey(id));if(!(current?.value.state==='failed'&&current.value.recoveryLease?.id===lease)){if(current?.value.recoveryLease?.id===lease)await this.cas(operationKey(id),{...current.value,recoveryLease:null},current.etag);await releaseLease();}}
 }
 async maintenance(g:string,n:string,p:any,body:any,action='request') {
  p=await this.authority(g,n,p,action==='request');
  if(!this.deps.inspect)refused('CAPABILITY_UNAVAILABLE','Current AWS verification is not configured. A platform administrator must bootstrap lifecycle support through platform CI.');
  const row=await this.op(g,n,body.operationId),op=row?.value;if(!op)refused('NOT_FOUND','Operation not found.',404);
  if(action==='request') {
   const inspection=await this.deps.inspect!(op),requirements=inspection.blockers.filter(b=>['platform-permission','platform-maintenance','capability'].includes(b.kind));
   if(!requirements.length)refused('NO_MAINTENANCE_REQUIRED','Current inspection found no platform prerequisites.');
   const content={graphId:g,nodeId:n,operationId:op.operationId,requirements,approvedDefinitionDigest:inspection.approvedGuardrailDigest,
    execution:{mode:'record-and-verify-only',executesAws:false,approvalTriggersRelease:false,recoveryApproved:false,applicationDeploymentApproved:false},
    verification:['Review this request using a configured platform administrator identity.','Deploy only the separately reviewed platform change through platform CI.','Run iac.inspect and verify this request from the graph; approval alone does not establish readiness.']};
   const request={...content,digest:digest(content),state:'requested',createdAt:this.now(),requestedBy:p.sub};
   if(op.maintenance?.digest===request.digest)return {...op.maintenance,administration:maintenanceConfiguration()};
   if(!await this.cas(operationKey(op.operationId),{...op,maintenance:request,inspection},row.etag))refused('CONFLICT','Operation changed; refresh the maintenance request.');
   await this.emit(op,'maintenance.request',{...request,administration:maintenanceConfiguration()});return {...request,administration:maintenanceConfiguration()};
  }
  if(!isPlatformAdmin(p))refused('PLATFORM_ADMIN_REQUIRED','This review requires a human subject explicitly configured in PLATFORM_ADMIN_SUBS. Graph ownership and agent delegation cannot grant platform administration.',403);
  const request=op.maintenance;
  if(!request||body.maintenanceDigest!==request.digest)refused('STALE_MAINTENANCE','Approve or verify the exact current maintenance request.');
  let next:any;
  if(action==='approve')next={...request,state:'approved-awaiting-platform-release',approval:{sub:p.sub,at:this.now(),digest:request.digest}};
  else if(action==='verify'){
   if(!request.approval)refused('APPROVAL_REQUIRED','The separate platform-admin review has not been approved.');
   const inspection=await this.deps.inspect!(op),remaining=inspection.blockers.filter(b=>['platform-permission','platform-maintenance','capability'].includes(b.kind));
   next={...request,state:remaining.length?'verification-blocked':'verified',verifiedAt:this.now(),verificationEvidence:inspection.awsVerification,remaining};
  }else refused('SCHEMA_INVALID','Unknown maintenance review action.',400);
  if(!await this.cas(operationKey(op.operationId),{...op,maintenance:next},row.etag))refused('CONFLICT','Maintenance request changed.');
  await this.emit(op,'maintenance.'+action,next);return next;
 }
 async runtimeLogs(g:string,n:string,p:any,options:any) {
  p=await this.authority(g,n,p);
  if(!decide(p,['graph:observe','graph:inspect-payloads']).allow)refused('ADMISSION_DENIED','Runtime logs require graph observation and payload inspection authority.',403);
  if(!this.deps.logs)refused('CAPABILITY_UNAVAILABLE','Application log diagnostics are not configured.');
  const binding=await this.read(`iac/deployed/${g}/${n}.json`),row=await this.op(g,n,options.operationId||binding?.value.operationId),op=row?.value;
  if(!op||op.state!=='succeeded'||!op.approval)refused('DEPLOYMENT_REQUIRED','Runtime diagnostics require an approved successful application deployment.');
  const response=await this.deps.logs(op,options);
  const entries=(response.events||[]).map(e=>({...e,source:'application',kind:'runtime-log',phase:'runtime'}));
  await this.progress().append(op,entries);
  const events=await this.progress().matching(op,entries);
  await this.emit(op,'runtime.logs',{logicalId:options.logicalId,window:response.window,truncated:response.truncated,unavailable:response.unavailable,omitted:response.omitted,error:response.error,correlationId:options.correlationId},response.error?'UNAVAILABLE':'COMPLETE');
  return {...response,events,operationId:op.operationId,history:(await this.progress().view(op)).history};
 }
 async readiness(g:string,n:string,p:any,options:any,invoke=this.deps.invoke) {
  p=await this.authority(g,n,p);
  if(!decide(p,['graph:execute','graph:observe']).allow)refused('ADMISSION_DENIED','Readiness checks require graph execution and observation authority.',403);
  if(!invoke)refused('CAPABILITY_UNAVAILABLE','Graph invocation is not configured for readiness checks.');
  if(!/^[A-Za-z0-9_.-]{1,128}$/.test(options.idempotencyKey||''))refused('SCHEMA_INVALID','A readiness idempotencyKey is required.',400);
  const bound=await this.read(`iac/deployed/${g}/${n}.json`),row=await this.op(g,n,bound?.value.operationId),op=row?.value;
  if(!bound?.value.operationId||!op||op.state!=='succeeded'||!op.approval)refused('DEPLOYMENT_REQUIRED','Readiness requires a completed approved deployment.');
  const current=(await this.op(g,n))?.value;
  if(current&&['apply-requested','applying','recovery-requested','recovering','recovered'].includes(current.state)||current?.manualRecoveryRequired)refused('OPERATION_ACTIVE','Application deployment is changing, requires recovery, or needs a fresh approved deployment after recovery.');
  const declaration=(op.input.readiness||[]).find(c=>c.id===options.checkId);
  if(!declaration)refused('READINESS_UNDECLARED','This check was not declared in the approved deployment. Add iac.readiness through a graph proposal and fresh deployment review.');
  const input=await this.deps.input!(g,n,p);
  if(input.inputDigest!==op.inputDigest)refused('STALE_READINESS','The stack or its readiness declarations changed after deployment. Prepare and approve a fresh deployment review.');
  const key=`iac/readiness/${op.operationId}/${digest(options.idempotencyKey)}.json`,prior=await this.read(key);
  if(prior){if(prior.value.checkId!==options.checkId)refused('IDEMPOTENCY_CONFLICT','Readiness key was used for a different check.');return prior.value;}
  const run:any={runId:ulid(),operationId:op.operationId,checkId:options.checkId,state:'running',startedAt:this.now(),criterion:'Graph invocation completed with zero execution errors and zero denied effects. The declared check node must assert application-specific health.'};
  if(!await this.cas(key,run,null))return (await this.read(key)).value;
  await this.emit(op,'runtime.readiness',run,'IN_PROGRESS');
  try {
   const answer=await invoke(g,p,{nodeUrl:declaration.nodeUrl,field:declaration.field,value:declaration.value,budget:{wallMs:15000,hops:100,fanOut:100,depth:16}}),summary=answer.summary;
   Object.assign(run,{state:summary?.state==='completed'&&summary.errors===0&&summary.effects?.denied===0?'verified':'failed',executionId:summary?.executionId,revisionId:summary?.revisionId,errors:summary?.errors,reason:answer.error||summary?.reason,finishedAt:this.now()});
  }catch(e){Object.assign(run,{state:'failed',error:diagnosticError(e,op),finishedAt:this.now()});}
  const stored=await this.read(key);await this.cas(key,run,stored.etag);
  for(let i=0;i<8;i++){
   const latest=await this.read(operationKey(op.operationId)),checks={...latest.value.runtimeReadiness?.checks,[options.checkId]:run};
   const status=op.input.readiness.every(c=>checks[c.id]?.state==='verified')?'verified':Object.values<any>(checks).some(c=>c.state==='failed')?'failed':'pending';
   if(await this.cas(operationKey(op.operationId),{...latest.value,runtimeReadiness:{state:status,checks,updatedAt:this.now(),evidence:'Declared graph checks only; not live multiplayer verification.'}},latest.etag))break;
  }
  await this.emit(op,'runtime.readiness',run,run.state.toUpperCase());return run;
 }
}
