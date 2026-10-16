const {CloudFormationClient}=require('@aws-sdk/client-cloudformation');
const {Guardrails}=require('../iac/guardrails');
const {reviewCloud}=require('../iac/reviewAws');
const {IacReviewService,prepareReview}=require('../iac/review');
const {graphDeploymentCapabilities}=require('../iac/capabilities');
const {templateConsequences,TEMPLATE_CONTRACT_VERSION}=require('../iac/templateContract');
const {templateConsequencesSchema}=require('../discovery/lifecycle');
const {assemble}=require('../iac/assemble');
const {parseTemplate,validateTemplate}=require('../iac/validator');
const {stackScope,scopedPolicy,validateIsolation}=require('../iac/isolation');
const {DEFAULT_POLICY}=require('../iac/types');
const {environment,human,read,save}=require('../__testHelpers__/lifecycleCloud');
const Store=require('../__testHelpers__/fakeS3');
const policy={...DEFAULT_POLICY,accounts:['230639770018'],regions:['us-west-1']};
let env;
beforeEach(()=>{env={...process.env};environment();jest.spyOn(Guardrails.prototype,'ensure').mockResolvedValue(true);});
afterEach(()=>{process.env=env;jest.restoreAllMocks();});
const scope=()=>stackScope('template-contract-fixture','stack',policy);
function document(retention=30,policies=true,lifecycle){
 const s=scope();return {Resources:{WriterLogs:{Type:'AWS::Logs::LogGroup',...(policies?{DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain'}:{}),Properties:{LogGroupName:s.namespace+'writer',...(retention!==undefined?{RetentionInDays:retention}:{})}},
  Storage:{Type:'AWS::S3::Bucket',...(policies?{DeletionPolicy:'Delete',UpdateReplacePolicy:'Retain'}:{}),Properties:{BucketName:s.namespace+'storage',PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true},...(lifecycle?{LifecycleConfiguration:lifecycle}:{})}}}};
}
function fixture(text,format='json',before,changes){
 const s=scope(),store=new Store(),sent=[],calls=[];let submitted,revision='rev_fixture_1',awsTemplate,executionStatus='AVAILABLE';
 const graph={id:s.graphId,nodes:[{id:s.nodeId,properties:{iac:{stack:{name:s.namespace+'stack',account:s.account,region:s.region,environment:'dev'},template:{text,format}}}}]};
 const diff=changes||Object.entries(parseTemplate(text,format).doc.Resources).map(([logicalId,r])=>({Action:before?'Modify':'Add',LogicalResourceId:logicalId,ResourceType:r.Type,...(before?{Replacement:'False'}:{})}));
 const sdk=jest.spyOn(CloudFormationClient.prototype,'send').mockImplementation(async command=>{
  const name=command.constructor.name,args=command.input;calls.push({name,args});
  if(name==='DescribeStacksCommand')return {Stacks:[{StackId:'owned-stack-id',StackStatus:before?'UPDATE_COMPLETE':'REVIEW_IN_PROGRESS'}]};
  if(name==='CreateChangeSetCommand'){submitted=args.TemplateBody;return {Id:'owned-change-set',StackId:'owned-stack-id'};}
  if(name==='DescribeChangeSetCommand')return {Status:'CREATE_COMPLETE',ExecutionStatus:executionStatus,Changes:diff.map(ResourceChange=>({ResourceChange}))};
  if(name==='GetTemplateCommand')return {TemplateBody:args.ChangeSetName?(awsTemplate||submitted):JSON.stringify(before)};
  if(name==='ExecuteChangeSetCommand'){executionStatus='EXECUTE_IN_PROGRESS';return {};}
  throw new Error('Unexpected AWS call '+name);
 });
 const cloud=reviewCloud(s.region,'unused');
 const service=new IacReviewService(store,{projection:async()=>graph,revision:async()=>revision,policy:()=>policy,enabled:true,start:async()=>{},cloud,notify:async(g,e)=>sent.push(e)});
 const planned=async()=>{const op=await service.begin(s.graphId,s.nodeId,human,false,'apply',undefined,'strict');await service.step(op.operationId);await service.step(op.operationId);return service.current(s.graphId,s.nodeId,human,op.operationId,false);};
 const approve=(op,extra={})=>service.approve(s.graphId,s.nodeId,human,{operationId:op.operationId,reviewDigest:op.reviewDigest,confirmDestructive:true,...extra});
 return {s,store,sent,calls,sdk,graph,service,planned,approve,diff,setRevision:v=>revision=v,setAwsTemplate:v=>awsTemplate=v};
}

test.each(['explicit','omitted','lifecycle'])('%s settings survive preflight, review and AWS preparation unchanged, with strict compatibility',async mode=>{
 const rules={Rules:[{Id:'expire',Status:'Enabled',ExpirationInDays:30,NoncurrentVersionExpiration:{NoncurrentDays:7},AbortIncompleteMultipartUpload:{DaysAfterInitiation:2}}]};
 const doc=document(30,mode!=='omitted',mode==='lifecycle'?rules:undefined);
 if(mode==='omitted')delete doc.Resources.WriterLogs.Properties.RetentionInDays;
 const format=mode==='omitted'?'yaml':'json',text=format==='yaml'?'# authored whitespace and omission\n'+require('yaml').stringify(doc):JSON.stringify(doc,null,3)+'\n';
 const f=fixture(text,format);
 expect(graphDeploymentCapabilities(f.graph,'stack',policy,true).deployable).toBe(true);
 const op=await f.planned();expect(op.state).toBe('awaiting-review');
 expect(op.template).toMatchObject({text,format,sha256:require('crypto').createHash('sha256').update(text).digest('hex')});
 expect(templateConsequencesSchema.safeParse(op.plan.consequences).success).toBe(true);
 expect(f.calls.find(c=>c.name==='CreateChangeSetCommand').args).toMatchObject({TemplateBody:text,RoleARN:f.s.roleArn});
 expect(parseTemplate(op.template.text,format).doc).toEqual(doc);
 expect(f.calls.some(c=>c.name==='ExecuteChangeSetCommand')).toBe(false);
 await f.approve(op);await f.service.step(op.operationId);
 const executed=f.calls.find(c=>c.name==='ExecuteChangeSetCommand').args;
 expect(executed).toEqual({StackName:f.s.namespace+'stack',ChangeSetName:'owned-change-set',ClientRequestToken:op.operationId});
 expect(executed.DisableRollback).toBeUndefined();expect(executed.RetainExceptOnCreate).toBeUndefined();
 expect(f.sent.find(e=>e.state==='awaiting-review').lifecycle.plan.consequences).toEqual(op.plan.consequences);
 expect(f.calls.some(c=>/Delete|PutBucket|Purge/.test(c.name))).toBe(false);
});

test('Agreeable Dove regression: unchanged WriterLogs retention 30/Retain/Retain reaches review',async()=>{
 const doc=document(),text=JSON.stringify(doc),f=fixture(text,'json',doc);
 const op=await f.planned(),logs=op.plan.consequences.resources.find(r=>r.logicalId==='WriterLogs');
 expect(op.state).toBe('awaiting-review');expect(logs.requiresConfirmation).toBe(false);
 expect(logs.settings.find(s=>s.path==='Properties.RetentionInDays')).toMatchObject({before:{specified:true,value:30},after:{specified:true,value:30},changed:false});
 expect(op.plan.destructive).toBe(false);expect(f.calls.some(c=>c.name==='ExecuteChangeSetCommand')).toBe(false);
});

test('connected fragments cannot silently replace an explicit graph template',async()=>{
 const text=JSON.stringify(document()),f=fixture(text);
 f.graph.nodes.push({id:'fragment',properties:{iac:{resource:{logicalId:'Unselected',type:'AWS::Logs::LogGroup',properties:{LogGroupName:f.s.namespace+'other',RetentionInDays:1},deletionPolicy:'Delete'}}},edges:[{field:'out',connectors:[{nodeId:'stack',field:'in'}]}]});
 expect(graphDeploymentCapabilities(f.graph,'stack',policy,true).source).toBe('inline');
 const op=await f.planned();expect(op.template.text).toBe(text);expect(op.template.source).toBe('inline');
 expect(f.calls.find(c=>c.name==='CreateChangeSetCommand').args.TemplateBody).toBe(text);
 f.graph.nodes[0].properties.iac.template.text='';
 expect(prepareReview(f.graph,'stack',policy).validation.ok).toBe(false);
 delete f.graph.nodes[0].properties.iac.template;
 const selected=prepareReview(f.graph,'stack',policy);expect(selected.source).toBe('graph');
 expect(JSON.parse(selected.text).Resources.Unselected).toEqual({Type:'AWS::Logs::LogGroup',Properties:{LogGroupName:f.s.namespace+'other',RetentionInDays:1},DeletionPolicy:'Delete'});
});

test('removal, replacement and shorter retention reach human confirmation rather than preservation rejection',async()=>{
 const before=document(30),after=document(7);delete after.Resources.Storage;
 const f=fixture(JSON.stringify(after),'json',before,[{Action:'Remove',LogicalResourceId:'Storage',ResourceType:'AWS::S3::Bucket'},{Action:'Modify',Replacement:'True',LogicalResourceId:'WriterLogs',ResourceType:'AWS::Logs::LogGroup'}]);
 const op=await f.planned();expect(op.plan.destructive).toBe(true);
 await expect(f.approve(op,{confirmDestructive:false})).rejects.toMatchObject({code:'APPROVAL_REQUIRED'});
 expect(f.calls.some(c=>c.name==='ExecuteChangeSetCommand')).toBe(false);
 await f.approve(op);await f.service.step(op.operationId);
 expect(f.calls.filter(c=>c.name==='ExecuteChangeSetCommand')).toHaveLength(1);
 expect(op.plan.changes.find(c=>c.logicalId==='Storage').deletionPolicy).toBe('Delete');
});

test('omitted policies and Snapshot choices are not replaced by Retain',()=>{
 const d=document();d.Resources.Storage.UpdateReplacePolicy='Snapshot';delete d.Resources.WriterLogs.DeletionPolicy;
 expect(validateTemplate(JSON.stringify(d),'json',scopedPolicy(scope(),policy)).problems).toEqual([]);
 expect(validateIsolation(JSON.stringify(d),'json',scope())).toEqual([]);
 const projected={id:'g',nodes:[{id:'stack',properties:{iac:{stack:{name:'x'}}}},{id:'resource',properties:{iac:{resource:{logicalId:'Handle',type:'AWS::CloudFormation::WaitConditionHandle'}}},edges:[{field:'out',connectors:[{nodeId:'stack',field:'in'}]}]}]};
 expect(assemble(projected,'stack').template.Resources.Handle).toEqual({Type:'AWS::CloudFormation::WaitConditionHandle'});
 projected.nodes[1].properties.iac.resource={logicalId:'Log',type:'AWS::Logs::LogGroup',properties:{RetentionInDays:30},deletionPolicy:'Delete',updateReplacePolicy:'Snapshot'};
 expect(assemble(projected,'stack').template.Resources.Log).toEqual({Type:'AWS::Logs::LogGroup',Properties:{RetentionInDays:30},DeletionPolicy:'Delete',UpdateReplacePolicy:'Snapshot'});
});

test.each(['graph-content','revision','stored-template','old-contract','aws-template','aws-changes'])('%s changes invalidate approval before AWS execution',async mutation=>{
 const text=JSON.stringify(document()),f=fixture(text),op=await f.planned();
 if(mutation==='graph-content'){
  f.graph.nodes[0].properties.iac.template.text+='\n';await expect(f.approve(op)).rejects.toMatchObject({code:'STALE_REVIEW'});return;
 }
 await f.approve(op);
 if(mutation==='revision')f.setRevision('rev_fixture_2');
 if(mutation==='aws-template')f.setAwsTemplate(JSON.stringify(document(60)));
 if(mutation==='aws-changes')f.diff[0].Replacement='True';
 if(['stored-template','old-contract'].includes(mutation)){
  const key=IacReviewService.key(op.operationId),row=await read(f.store,key);
  if(mutation==='stored-template')row.input.text+='\n';else delete row.input.templateContractVersion;
  await save(f.store,key,row);
 }
 try{await f.service.step(op.operationId);}catch(e){expect(e.code).toBe('STALE_REVIEW');}
 expect(f.calls.some(c=>c.name==='ExecuteChangeSetCommand')).toBe(false);
});

test('authentication, graph ownership, account isolation and human approval remain enforced',async()=>{
 const f=fixture(JSON.stringify(document())),op=await f.planned();
 await expect(f.service.begin(f.s.graphId,'stack',undefined)).rejects.toMatchObject({code:'ADMISSION_DENIED'});
 await expect(f.service.approve('other-graph','stack',human,{operationId:op.operationId,reviewDigest:op.reviewDigest})).rejects.toMatchObject({code:'NOT_FOUND'});
 await expect(f.service.approve(f.s.graphId,'stack',{...human,kind:'agent',scopes:['iac:approve']},{operationId:op.operationId,reviewDigest:op.reviewDigest})).rejects.toMatchObject({code:'ADMISSION_DENIED'});
 await expect(f.approve(op,{reviewDigest:'forged'})).rejects.toMatchObject({code:'STALE_REVIEW'});
 for(const mutation of [d=>d.Resources.WriterLogs.Properties.LogGroupName='another-stack',d=>f.graph.nodes[0].properties.iac.stack.account='999999999999']){
  const doc=document();mutation(doc);f.graph.nodes[0].properties.iac.template.text=JSON.stringify(doc);
  expect(prepareReview(f.graph,'stack',policy).validation.ok).toBe(false);
 }
 expect(f.calls.some(c=>c.name==='ExecuteChangeSetCommand')).toBe(false);
});

test.each(['AccessDenied','ValidationError'])('AWS %s remains an AWS failure, not a retention/cost refusal',async code=>{
 const f=fixture(JSON.stringify(document())),op=await f.service.begin(f.s.graphId,'stack',human,false,'apply',undefined,'strict');
 const error=Object.assign(new Error(code+': service-specific detail'),{name:code,code});
 f.sdk.mockRejectedValueOnce(error);
 await expect(f.service.step(op.operationId)).rejects.toMatchObject({code,message:code+': service-specific detail'});
 // The real worker's exception/orchestration path records the original service error.
 await f.service.recordException(op.operationId,error,'worker-fixture');await f.service.fail(op.operationId,error);
 const status=await f.service.current(f.s.graphId,'stack',human,op.operationId,false);
 expect(status.originalError.code).toBe(code);expect(status.reason).toContain('service-specific detail');
 const events=await f.service.events(f.s.graphId,'stack',human,{operationId:op.operationId});
 expect(events.events.some(e=>e.error?.code===code)).toBe(true);
 expect(f.calls.some(c=>c.name==='ExecuteChangeSetCommand')).toBe(false);
});

test('resource sizing and concurrency are author choices, while missing AWS permissions are disclosed separately',()=>{
 const example=require('../discovery/example').authenticatedApplicationExample(scope()),doc=JSON.parse(example.configuration.template.text);
 doc.Resources.Backend.Properties.Timeout=120;doc.Resources.Backend.Properties.MemorySize=2048;
 doc.Resources.Backend.Properties.ReservedConcurrentExecutions=3;
 doc.Resources.Backend.Properties.LoggingConfig={LogGroup:scope().namespace+'writer',LogFormat:'JSON'};
 doc.Resources.Live={Type:'AWS::Lambda::Alias',Properties:{Name:'live',FunctionName:{Ref:'Backend'},FunctionVersion:'1',ProvisionedConcurrencyConfig:{ProvisionedConcurrentExecutions:2}}};
 const f=fixture(JSON.stringify(doc));f.graph.nodes[0].properties.iac.capabilities=example.configuration.capabilities;
 const preflight=graphDeploymentCapabilities(f.graph,'stack',policy,true);
 expect(preflight.validation.ok).toBe(true);expect(preflight.deployable).toBe(true);
 expect(preflight.effectivePermissions.permissionDependencies.map(p=>p.logicalId)).toEqual(['Backend','Live']);
 expect(preflight.evidence.awsPermissionsVerified).toBe(false);
 doc.Resources.Backend.Properties.LoggingConfig.LogGroup={Ref:'Logs'};
 expect(validateIsolation(JSON.stringify(doc),'json',scope())).toEqual([]);
 doc.Resources.Backend.Properties.LoggingConfig.LogGroup='unrelated-project';
 expect(validateIsolation(JSON.stringify(doc),'json',scope()).some(p=>p.path.endsWith('LoggingConfig.LogGroup'))).toBe(true);
});

test.each([{Properties:[]},{DeletionPolicy:'invented'},{UpdateReplacePolicy:'RetainExceptOnCreate'}])('structurally invalid resource attributes remain rejected: %j',patch=>{
 const d=document();Object.assign(d.Resources.WriterLogs,patch);
 expect(validateTemplate(JSON.stringify(d),'json',scopedPolicy(scope(),policy)).problems.some(p=>p.code==='RESOURCE_SHAPE')).toBe(true);
});

test('current inspection reports authored template validation separately from AWS and historical failure evidence',async()=>{
 const {fixture:platform}=require('../__testHelpers__/lifecycleCloud'),f=await platform('inspection-template-fixture','stack');
 f.installRoles();f.stacks.get(f.s.guardrailStack).StackStatus='CREATE_COMPLETE';
 await save(f.store,IacReviewService.key(f.source.operationId),{...f.source,manualRecoveryRequired:false});
 const doc=JSON.parse(f.graph.nodes[0].properties.iac.template.text);
 delete doc.Resources.Logs.Properties.RetentionInDays;delete doc.Resources.Records.DeletionPolicy;
 f.graph.nodes[0].properties.iac.template.text=JSON.stringify(doc);
 const result=await f.reviews.lifecycle.inspect(f.s.graphId,'stack',human,{preservation:'strict'});
 expect(result.templateValidation.ok).toBe(true);expect(result.canReview).toBe(true);
 expect(result.templateContract.version).toBe(TEMPLATE_CONTRACT_VERSION);
 expect(result.historicalFailure.code).toBe('AccessDenied');expect(result.awsVerification.deploymentTested).toBe(false);
});
