const {automaticApproval}=require('../iac/automaticApproval');
const {fixture,environment,human}=require('../__testHelpers__/lifecycleCloud');
let env;beforeEach(()=>{env={...process.env};environment();});afterEach(()=>process.env=env);
const apply=()=>({action:'apply',state:'awaiting-review',expiresAt:Date.now()+60000,reviewDigest:'exact',plan:{destructive:false,changes:[{action:'Add',resourceType:'AWS::SQS::Queue'}]}});
test.each([
 ['destroy',op=>op.action='destroy'],['removal',op=>op.plan.changes=[{action:'Remove'}]],['replacement',op=>op.plan.changes=[{action:'Modify',replacement:'True'}]],['uncertain replacement',op=>op.plan.changes=[{action:'Modify',replacement:'Conditional'}]],['nested stack',op=>op.plan.changes=[{action:'Add',resourceType:'AWS::CloudFormation::Stack'}]],['destructive',op=>op.plan.destructive=true],['stale',op=>op.supersededBy='new'],['expired',op=>op.expiresAt=0],['unplanned',op=>op.state='planning'],
])('auto-approval excludes %s',(_,mutate)=>{const op=apply();mutate(op);expect(automaticApproval(op).allowed).toBe(false);});
test('non-destructive deployment and bounded non-deleting recovery can be eligible',()=>{
 expect(automaticApproval(apply()).allowed).toBe(true);
 const op={action:'recover',state:'recovery-ready',expiresAt:Date.now()+60000,recoveryPlan:{digest:'exact',preservesData:true,prerequisites:[],actions:[{kind:'import-retained',dataLoss:[]},{kind:'reconcile-guardrails',dataLoss:[]}]}};
 expect(automaticApproval(op).allowed).toBe(true);
 for(const kind of ['delete-stack','rollback-stack','continue-update-rollback','unknown'])expect(automaticApproval({...op,recoveryPlan:{...op.recoveryPlan,actions:[{kind,dataLoss:[]}]}}).allowed).toBe(false);
 expect(automaticApproval({...op,recoveryPlan:{...op.recoveryPlan,preservesData:false}}).allowed).toBe(false);
});
test('human auto-approval cannot bypass recovery deletion refusal, even with an exact digest and data-loss confirmation',async()=>{
 const f=await fixture(),op=await f.plan();
 await expect(f.reviews.lifecycle.approve('g','stack',human,{operationId:op.operationId,recoveryDigest:op.recoveryPlan.digest,approvalMode:'automatic',confirmDataLoss:true})).rejects.toMatchObject({code:'AUTO_APPROVAL_FORBIDDEN'});
 expect(f.start).not.toHaveBeenCalled();expect(f.calls.some(c=>c.method==='deleteStack')).toBe(false);
});
test('automatic deployment still requires a human and exact current digest and records its mode',async()=>{
 const f=await fixture(),recovered=await f.recover(),op=await f.reviews.begin('g','stack',human,false,'apply',recovered.operationId);
 await f.reviews.step(op.operationId);await f.reviews.step(op.operationId);
 const review=await f.reviews.current('g','stack',human,undefined,false),body={operationId:op.operationId,reviewDigest:review.reviewDigest,approvalMode:'automatic'};
 expect(review.automaticApproval.allowed).toBe(true);
 await expect(f.reviews.approve('g','stack',{...human,kind:'agent'},body)).rejects.toMatchObject({code:'ADMISSION_DENIED'});
 await expect(f.reviews.approve('g','stack',human,{...body,reviewDigest:'wrong'})).rejects.toMatchObject({code:'STALE_REVIEW'});
 const approved=await f.reviews.approve('g','stack',human,body);expect(approved.approval.mode).toBe('automatic');expect(approved.approval.reviewDigest).toBe(body.reviewDigest);
 expect(f.deployCloud.execute).not.toHaveBeenCalled();
});
