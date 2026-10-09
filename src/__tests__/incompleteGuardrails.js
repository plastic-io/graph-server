const {awsResourceAbsent}=require('../iac/awsErrors');
const {fixture,environment,human,read,save}=require('../__testHelpers__/lifecycleCloud');
const {operationKey}=require('../iac/lifecycleModel');
let env;
beforeEach(()=>{env={...process.env};environment();});
afterEach(()=>{process.env=env;});

test.each([
 ['iam:GetRole',{code:'NoSuchEntity',message:'The role with name assigned-worker cannot be found.'},true],
 ['iam:GetRolePolicy',{name:'NoSuchEntityException',message:'AWS changed this wording'},true],
 ['iam:GetPolicy',{code:'NoSuchEntity',message:'Policy was not found.'},true],
 ['states:DescribeExecution',{code:'ExecutionDoesNotExist',message:'Execution unavailable'},true],
 ['cloudformation:DescribeStacks',{code:'ValidationError',message:'Stack with id assigned-stack does not exist'},true],
 ['cloudformation:DescribeChangeSet',{name:'ChangeSetNotFound',message:'ChangeSet [assigned] does not exist'},true],
 ['iam:GetRole',{code:'AccessDenied',message:'The role cannot be found or access is denied.'},false],
 ['iam:GetRole',{code:'AccessDenied',message:'NoSuchEntity: role does not exist'},false],
 ['iam:GetRole',{code:'NetworkingError',message:'Role not found due to endpoint timeout'},false],
 ['iam:GetRole',{statusCode:404,message:'Resource not found'},false],
 ['cloudformation:DescribeStacks',{code:'AccessDenied',message:'Stack with id assigned-stack does not exist'},false],
 ['cloudformation:DescribeStacks',{code:'ValidationError',message:'An account parameter does not exist'},false],
 ['sts:AssumeRole',{code:'AccessDenied',message:'Role does not exist or cannot be assumed'},false],
])('classifies actual service evidence for %s (%j)',(action,error,expected)=>expect(awsResourceAbsent(error,action)).toBe(expected));

test('NoSuchEntity wording from the live regression gives a bounded human recovery review without platform-admin configuration',async()=>{
 delete process.env.PLATFORM_ADMIN_SUBS;
 const f=await fixture('disposable-missing-roles','stack');
 const inspect=await f.reviews.lifecycle.inspect(f.source.graphId,'stack',human);
 expect(inspect.roles.map(r=>r.exists)).toEqual([false,false]);
 expect(inspect.awsVerification.checks.filter(c=>c.action==='iam:GetRole'&&c.component==='guardrail').map(c=>c.result)).toEqual(['absent','absent']);
 expect(inspect.assumption.result).toBe('not-tested');expect(f.clients.assume).not.toHaveBeenCalled();
 expect(inspect.recoveryReadiness).toMatchObject({state:'review-available',prerequisites:[],requiresPlatformAdmin:false,missingRoles:['WorkerRole','ExecutionRole']});
 expect(inspect.maintenanceConfiguration).toMatchObject({configured:false,executesAws:false,blocker:{code:'PLATFORM_ADMIN_NOT_CONFIGURED'}});
 const op=await f.plan();expect(op.state).toBe('recovery-ready');
 expect(op.recoveryPlan.approvalRequirements).toMatchObject({platformAdministrator:false,applicationDeployment:false,exactDigest:true});
 expect(op.recoveryPlan.actions[0].resources.filter(r=>r.resourceType==='AWS::IAM::Role').map(r=>r.outcome)).toEqual(['Already absent','Already absent']);
 await f.approve(op);
 for(let i=0;i<20;i++)if((await f.reviews.lifecycle.step(op.operationId)).done)break;
 const result=await f.reviews.current(f.source.graphId,'stack',human,undefined,false);
 expect(result).toMatchObject({state:'recovered',canReviewMaintenance:false});
 expect(result.approval).toBeUndefined();expect(result.historicalFailure.message).toBe('Historical iam:GetRole failure');
 expect(f.policies.has(f.s.boundaryArn)).toBe(true);
 expect(f.clients.application).not.toHaveBeenCalled();
 expect(result.nextActions.actions.find(a=>a.tool==='iac.review').allowed).toBe(true);
});

test.each(['AccessDenied','NetworkingError','Throttling','UnknownEndpoint'])('%s never becomes absence or an approvable recovery',async code=>{
 const f=await fixture(),original=f.clients.iam.getMockImplementation();
 f.clients.iam.mockImplementation((m,a)=>m==='getRole'&&a.RoleName===f.approved.Resources.WorkerRole.Properties.RoleName?Promise.reject(Object.assign(new Error('The role cannot be found.'),{code})):original(m,a));
 const op=await f.plan();expect(op.state).toBe('recovery-blocked');
 expect(op.inspection.roles.find(r=>r.logicalId==='WorkerRole').exists).toBe('unknown');
 expect(op.recoveryPlan.prerequisites.some(p=>p.code==='AWS_CHECK_FAILED'&&p.error.code===code)).toBe(true);
 await expect(f.approve(op)).rejects.toMatchObject({code:'STALE_RECOVERY'});
 expect(f.calls.some(c=>['deleteStack','createStack','updateStack','executeChangeSet'].includes(c.method))).toBe(false);
});

test.each(['extra-resource','foreign-physical','foreign-path'])('guardrail ownership does not authorize %s inside the stack',async variant=>{
 const f=await fixture(),st=f.stacks.get(f.s.guardrailStack);
 if(variant==='extra-resource')st.template.Resources.SharedRole={Type:'AWS::IAM::Role',Properties:{RoleName:'platform-worker',Path:'/'}};
 if(variant==='foreign-physical')st.resources.find(r=>r.LogicalResourceId==='WorkerRole').PhysicalResourceId='gapp-another-stack-worker';
 if(variant==='foreign-path')st.template.Resources.WorkerRole.Properties.Path='/';
 const op=await f.plan();expect(op.state).toBe('recovery-blocked');
 expect(op.recoveryPlan.prerequisites.some(b=>b.code==='GUARDRAIL_RESOURCE_UNVERIFIED')).toBe(true);
 await expect(f.approve(op)).rejects.toMatchObject({code:'STALE_RECOVERY'});
 expect(f.calls.some(c=>c.method==='deleteStack')).toBe(false);
});

test('maintenance request explicitly records review only and explains absent administrator configuration',async()=>{
 delete process.env.PLATFORM_ADMIN_SUBS;
 const f=await fixture();f.permissions(false);const op=await f.plan();
 const request=await f.reviews.lifecycle.maintenance('g','stack',human,{operationId:op.operationId});
 expect(request.execution).toMatchObject({mode:'record-and-verify-only',executesAws:false,approvalTriggersRelease:false});
 expect(request.administration).toMatchObject({configured:false,blocker:{code:'PLATFORM_ADMIN_NOT_CONFIGURED'}});
 expect((await f.reviews.current('g','stack',human)).maintenanceConfiguration.configured).toBe(false);
 await expect(f.reviews.lifecycle.maintenance('g','stack',human,{operationId:op.operationId,maintenanceDigest:request.digest},'approve')).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});
 expect(f.calls.some(c=>['deleteStack','createStack','updateStack','executeChangeSet'].includes(c.method))).toBe(false);
});

test('an old recovery approval becomes stale across a platform contract change',async()=>{
 const f=await fixture(),op=await f.plan();
 const row=await read(f.store,operationKey(op.operationId));row.recoveryPlan.inspectionDigest='previous-platform-fingerprint';
 const {digest}=require('../iac/lifecycleModel');const {digest:unused,...content}=row.recoveryPlan;row.recoveryPlan.digest=digest(content);await save(f.store,operationKey(op.operationId),row);
 await expect(f.reviews.lifecycle.approve('g','stack',human,{operationId:op.operationId,recoveryDigest:row.recoveryPlan.digest})).rejects.toMatchObject({code:'STALE_RECOVERY'});
 expect(f.calls.some(c=>c.method==='deleteStack')).toBe(false);
});

test('DELETE_FAILED skips only verified-absent owned role records without root-path role deletion authority',async()=>{
 const f=await fixture();f.stacks.get(f.s.guardrailStack).StackStatus='DELETE_FAILED';
 const op=await f.plan();expect(op.state).toBe('recovery-ready');
 expect(op.recoveryPlan.actions[0].retainIds).toEqual(['ExecutionRole','WorkerRole']);
 await f.approve(op);for(let i=0;i<20;i++)if((await f.reviews.lifecycle.step(op.operationId)).done)break;
 expect((await f.reviews.current('g','stack',human,undefined,false)).state).toBe('recovered');
 expect(f.calls.find(c=>c.method==='deleteStack').args.RetainResources).toEqual(['ExecutionRole','WorkerRole']);
 expect(f.calls.find(c=>c.method==='createChangeSet').args.ResourcesToImport.map(r=>r.LogicalResourceId)).toEqual(['RuntimeBoundary']);
 expect(f.calls.some(c=>c.service==='iam'&&c.method==='deleteRole')).toBe(false);
});

test('retained boundary replacement or new foreign attachments between deletion and import stop recovery',async()=>{
 for(const tamper of ['replace','attach']){
  const f=await fixture(),original=f.clients.iam.getMockImplementation();let changed=false;
  f.clients.iam.mockImplementation(async(m,a)=>{
   const result=await original(m,a);
   if(m==='getPolicy')result.Policy.PolicyId=changed&&tamper==='replace'?'replacement-policy':'reviewed-policy';
   if(changed&&tamper==='attach'&&m==='listEntitiesForPolicy')result.PolicyRoles=[{RoleName:'unrelated-role'}];
   return result;
  });
  const op=await f.plan();await f.approve(op);
  for(let i=0;i<4;i++){await f.reviews.lifecycle.step(op.operationId);const stored=await read(f.store,operationKey(op.operationId));if(stored.recoveryIndex===1)break;}
  changed=true;await f.reviews.lifecycle.step(op.operationId);
  const failed=await f.reviews.current('g','stack',human,undefined,false);expect(failed.state).toBe('failed');
  expect(['STALE_RECOVERY','OWNERSHIP_UNVERIFIED']).toContain(failed.originalError.code);
  expect(f.calls.some(c=>c.method==='createChangeSet')).toBe(false);expect(f.policies.has(f.s.boundaryArn)).toBe(true);
 }
});

test('unapproved data loss cannot execute any part of a recovery',async()=>{
 const f=await fixture(),table={...JSON.parse(f.input.text).Resources.Records,DeletionPolicy:'Delete'};
 f.stack(f.s.namespace+'stack','ROLLBACK_FAILED',{Resources:{Records:table}},[{LogicalResourceId:'Records',PhysicalResourceId:f.s.namespace+'records',ResourceType:table.Type,ResourceStatus:'CREATE_COMPLETE'}]);
 const op=await f.plan({allowDataLoss:true});expect(op.state).toBe('recovery-ready');expect(op.recoveryPlan.preservesData).toBe(false);
 await expect(f.approve(op)).rejects.toMatchObject({code:'APPROVAL_REQUIRED'});
 expect(f.calls.some(c=>['deleteStack','createStack','updateStack','executeChangeSet'].includes(c.method))).toBe(false);
});

test('stable stacks with out-of-band deleted role records expose an exact unsupported action',async()=>{
 const f=await fixture();f.stacks.get(f.s.guardrailStack).StackStatus='CREATE_COMPLETE';
 const op=await f.plan();expect(op.state).toBe('recovery-blocked');
 expect(op.recoveryPlan.prerequisites).toEqual(expect.arrayContaining([expect.objectContaining({code:'GUARDRAIL_ROLE_RECREATE_UNSUPPORTED',kind:'capability',logicalIds:['WorkerRole','ExecutionRole']})]));
 expect(f.calls.some(c=>c.method==='deleteStack')).toBe(false);
});

test('a fresh recovery preserves the historical error through legacy blocked operations',async()=>{
 const f=await fixture();f.permissions(false);const blocked=await f.plan();
 const legacy=await read(f.store,operationKey(blocked.operationId));delete legacy.historicalFailure;delete legacy.historicalFailureOperationId;
 await save(f.store,operationKey(blocked.operationId),legacy);f.permissions(true);
 const next=await f.reviews.lifecycle.plan('g','stack',human,{operationId:blocked.operationId,idempotencyKey:'after-platform-fix'});
 expect(next.state).toBe('recovery-ready');expect(next.historicalFailure).toEqual(f.source.originalError);expect(next.historicalFailureOperationId).toBe(f.source.operationId);
 const inspected=await f.reviews.lifecycle.inspect('g','stack',human);
 expect(inspected.historicalFailureOperationId).toBe(f.source.operationId);expect(inspected.policyAnalysis.checks.every(c=>c.result==='allowed-by-document')).toBe(true);
});
