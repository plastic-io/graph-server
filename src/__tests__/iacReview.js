const {IacReviewService, prepareReview, APPLY_TYPES}=require('../iac/review');
const Store=require('../__testHelpers__/fakeS3');
const human={sub:'owner',kind:'human',tenant:'personal:owner',scopes:[]};
const policy={stackPrefix:'pio-dev-',accounts:['230639770018'],regions:['us-west-1'],substrateStacks:['graph-server'],allowedResourceTypes:APPLY_TYPES,maxResources:100};
const template=JSON.stringify({Resources:{Records:{Type:'AWS::S3::Bucket',Properties:{BucketName:'pio-dev-review-test',PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true}}}}});
function fixture() {
    let now=1000000;
    const graph={id:'g',nodes:[{id:'stack',properties:{iac:{stack:{name:'pio-dev-review',account:'230639770018',region:'us-west-1',environment:'dev'},template:{format:'json',text:template}}}}]};
    const cloud={stack:jest.fn(async()=>({exists:false})),create:jest.fn(async()=>({changeSetId:'changeset',stackId:'stackarn'})),
        describe:jest.fn(async()=>({status:'CREATE_COMPLETE',executionStatus:'AVAILABLE',changes:[{action:'Add',logicalId:'Records',resourceType:'AWS::S3::Bucket'}]})),
        execute:jest.fn(async()=>{}),remove:jest.fn(async()=>{})};
    const store=new Store(), start=jest.fn(async()=>{});
    const service=new IacReviewService(store,{projection:async()=>graph,policy:()=>policy,enabled:true,start,cloud,now:()=>now});
    const begin=()=>service.begin('g','stack',human);
    const planned=async()=>{const op=await begin();await service.step(op.operationId);await service.step(op.operationId);return service.current('g','stack',human);};
    const approve=op=>service.approve('g','stack',human,{operationId:op.operationId,reviewDigest:op.reviewDigest});
    return {service,cloud,graph,store,start,begin,planned,approve,advance:ms=>{now+=ms;}};
}
test('review is an explicit, durable checkpoint before any resource changes',async()=>{
    const f=fixture(),op=await f.planned();
    expect(op.state).toBe('awaiting-review');expect(op.plan.changes[0].logicalId).toBe('Records');
    expect(op.template.text).toBe(template);expect(op.reviewDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.cloud.execute).not.toHaveBeenCalled();expect(f.cloud.remove).not.toHaveBeenCalled();
    await f.approve(op);await f.service.step(op.operationId);
    expect(f.cloud.execute).toHaveBeenCalledTimes(1);
    f.cloud.stack.mockResolvedValue({exists:true,status:'CREATE_COMPLETE',outputs:[{key:'RecordsBucket',value:'pio-dev-review-test'}]});
    await f.service.step(op.operationId);
    expect(await f.service.current('g','stack',human)).toMatchObject({state:'succeeded',outputs:[{key:'RecordsBucket'}],approval:{sub:'owner'}});
    await f.approve(op);await f.service.step(op.operationId);expect(f.cloud.execute).toHaveBeenCalledTimes(1);
});
test('a forged digest, agent, or other graph cannot approve',async()=>{
    const f=fixture(),op=await f.planned();
    await expect(f.service.approve('g','stack',human,{operationId:op.operationId,reviewDigest:'forged'})).rejects.toMatchObject({code:'STALE_REVIEW'});
    await expect(f.service.approve('g','stack',{...human,kind:'agent',scopes:['iac:approve']},{operationId:op.operationId,reviewDigest:op.reviewDigest})).rejects.toMatchObject({code:'ADMISSION_DENIED'});
    await expect(f.service.approve('other','stack',human,{operationId:op.operationId,reviewDigest:op.reviewDigest})).rejects.toMatchObject({code:'NOT_FOUND'});
    expect(f.cloud.execute).not.toHaveBeenCalled();
});
test.each(['text','parameters','stack','policy'])('changing %s invalidates an earlier review',async(field)=>{
    const f=fixture(),op=await f.planned(),iac=f.graph.nodes[0].properties.iac;
    if(field==='text')iac.template.text+='\n';
    if(field==='parameters')iac.parameters={Changed:'value'};
    if(field==='stack')iac.stack.environment='staging';
    const previous=policy.maxResources;
    try {if(field==='policy')policy.maxResources++;
      await expect(f.approve(op)).rejects.toMatchObject({code:'STALE_REVIEW'});
    }finally{policy.maxResources=previous;}
    expect(f.cloud.execute).not.toHaveBeenCalled();
});
test('destructive review requires explicit confirmation',async()=>{
    const f=fixture();f.cloud.describe.mockResolvedValue({status:'CREATE_COMPLETE',executionStatus:'AVAILABLE',changes:[{action:'Remove',logicalId:'Records'}]});
    const op=await f.planned();expect(op.plan.destructive).toBe(true);
    await expect(f.approve(op)).rejects.toMatchObject({code:'APPROVAL_REQUIRED'});
    await f.service.approve('g','stack',human,{operationId:op.operationId,reviewDigest:op.reviewDigest,confirmDestructive:true});
    await f.service.step(op.operationId);expect(f.cloud.execute).toHaveBeenCalledTimes(1);
});
test('duplicate approvals race through a conditional write and execute once',async()=>{
    const f=fixture(),op=await f.planned();
    const outcomes=await Promise.allSettled([f.approve(op),f.approve(op)]);
    expect(outcomes.filter(o=>o.status==='fulfilled')).toHaveLength(1);
    await f.service.step(op.operationId);await f.service.step(op.operationId);
    expect(f.cloud.execute).toHaveBeenCalledTimes(1);
});
test('an execute retried after AWS accepted it observes rather than submitting a second apply',async()=>{
    const f=fixture(),op=await f.planned();await f.approve(op);
    f.cloud.describe.mockResolvedValue({status:'CREATE_COMPLETE',executionStatus:'EXECUTE_IN_PROGRESS'});
    await f.service.step(op.operationId);expect(f.cloud.execute).not.toHaveBeenCalled();
    expect((await f.service.current('g','stack',human)).state).toBe('applying');
});
test('only one operation per stack; reopening a pending review returns it',async()=>{
    const f=fixture(),op=await f.planned();expect((await f.begin()).operationId).toBe(op.operationId);
    const next=await f.service.begin('g','stack',human,true);expect(next.operationId).not.toBe(op.operationId);
    await f.service.step(op.operationId);expect(f.cloud.remove).toHaveBeenCalled();
    await expect(f.approve(op)).rejects.toMatchObject({code:'STALE_REVIEW'});
});
test.each(['cancel','expiry'])('%s removes the retained review without executing',async(mode)=>{
    const f=fixture(),op=await f.planned();
    if(mode==='cancel')await f.service.cancel('g','stack',human,{operationId:op.operationId});
    else {f.advance(3600001);await f.service.step(op.operationId);}
    await f.service.step(op.operationId);expect(f.cloud.remove).toHaveBeenCalled();expect(f.cloud.execute).not.toHaveBeenCalled();
    expect((await f.begin()).operationId).not.toBe(op.operationId);
});
test('rollback failures retain the lock and identify manual recovery',async()=>{
    const f=fixture(),op=await f.planned();await f.approve(op);await f.service.step(op.operationId);
    f.cloud.stack.mockResolvedValue({exists:true,status:'UPDATE_ROLLBACK_FAILED',reason:'Resource could not roll back.'});
    await f.service.step(op.operationId);
    expect(await f.service.current('g','stack',human)).toMatchObject({state:'rollback-failed',manualRecoveryRequired:true});
    await expect(f.begin()).rejects.toMatchObject({code:'RECOVERY_REQUIRED'});
});
test('a workflow failure after approval never releases a possibly-running AWS operation',async()=>{
    const f=fixture(),op=await f.planned();await f.approve(op);await f.service.fail(op.operationId,'Worker unavailable');
    await expect(f.begin()).rejects.toMatchObject({code:'RECOVERY_REQUIRED'});
    expect(await f.service.current('g','stack',human)).toMatchObject({state:'failed',manualRecoveryRequired:true});
});
test('no-change and failed previews show an explanation, without offering apply',async()=>{
    const f=fixture();f.cloud.describe.mockResolvedValue({status:'FAILED',reason:"The submitted information didn't contain changes."});
    const op=await f.planned();expect(op.state).toBe('no-changes');expect(op.reason).toMatch(/already matches/);
    await expect(f.approve(op)).rejects.toMatchObject({code:'STALE_REVIEW'});
});
test('template reading is authenticated and uses the current graph content',async()=>{
    const f=fixture();await expect(f.service.template('g','stack',undefined)).rejects.toMatchObject({code:'ADMISSION_DENIED'});
    expect((await f.service.template('g','stack',human)).validation.ok).toBe(true);
    f.graph.nodes[0].properties.iac.template.text+='\n';
    expect((await f.service.template('g','stack',human)).text).toBe(template+'\n');
});
test('a reviewed deployment cannot create public bucket access',async()=>{
    const f=fixture(),t=JSON.parse(template);t.Resources.Records.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy=false;
    f.graph.nodes[0].properties.iac.template.text=JSON.stringify(t);
    await expect(f.begin()).rejects.toThrow(/public-access blocks/);expect(f.start).not.toHaveBeenCalled();
});

test('successful deployment publishes planning, approval and completion as separate durable milestones',async()=>{
 const f=fixture(),op=await f.planned();
 const before=await f.service.events('g','stack',human,{operationId:op.operationId});
 expect(before.events.some(e=>e.phase==='planning')).toBe(true);
 expect(before.events.some(e=>e.phase==='awaiting-approval'&&e.reviewDigest===op.reviewDigest)).toBe(true);
 expect(before.events.some(e=>e.phase==='deploying')).toBe(false);
 await f.approve(op);await f.service.step(op.operationId);
 f.cloud.stack.mockResolvedValue({exists:true,status:'CREATE_COMPLETE'});await f.service.step(op.operationId);
 const after=await f.service.events('g','stack',human,{operationId:op.operationId,cursor:before.nextCursor});
 expect(after.events.some(e=>e.state==='apply-requested'&&e.reviewDigest===op.reviewDigest)).toBe(true);
 expect(after.events.some(e=>e.state==='succeeded'&&e.phase==='terminal')).toBe(true);
 expect((await f.service.current('g','stack',human)).progress.phase).toBe('terminal');
 const later=await f.begin();expect(later.operationId).not.toBe(op.operationId);
 expect((await f.service.operations('g','stack',human)).operations.map(o=>o.operationId)).toEqual([later.operationId,op.operationId]);
});

test('failed cleanup preserves the original outcome, reports recovery and retains the operation lock',async()=>{
 const f=fixture(),op=await f.planned();await f.service.cancel('g','stack',human,{operationId:op.operationId});
 f.cloud.remove.mockRejectedValue(Object.assign(new Error('Cannot delete unexecuted change set: AccessDenied'),{code:'AccessDenied'}));
 await f.service.step(op.operationId);
 const current=await f.service.current('g','stack',human);
 expect(current.state).toBe('cancelled');expect(current.progress.cleanup.status).toBe('DELETE_FAILED');expect(current.manualRecoveryRequired).toBe(true);
 await expect(f.begin()).rejects.toMatchObject({code:'RECOVERY_REQUIRED'});
});
