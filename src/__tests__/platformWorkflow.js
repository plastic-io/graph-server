const {validateOperations,operationCatalogue}=require('../discovery/operations');
const {validateRuntime}=require('../discovery/validateRuntime');
const {includeInfrastructure}=require('../admission/infrastructureDiff');
const {semanticDiff}=require('@plastic-io/graph-crdt');
const {DEFAULT_POLICY}=require('../iac/types');
const {stackScope,validateIsolation,executionPolicy,runtimeBoundary}=require('../iac/isolation');
const {deploymentCapabilities,graphDeploymentCapabilities}=require('../iac/capabilities');
const {ApplicationService}=require('../application/service');
const {ObservationJournal}=require('../runtime/journal');
const {guardrailTemplate}=require('../iac/guardrails');
const Store=require('../__testHelpers__/fakeS3');
const policy={...DEFAULT_POLICY,accounts:['230639770018'],regions:['us-west-1']};
const scope=stackScope('graph-a','stack',policy);
function template(s=scope){return {Resources:{
 Records:{Type:'AWS::DynamoDB::Table',Properties:{TableName:s.namespace+'records',BillingMode:'PAY_PER_REQUEST',AttributeDefinitions:[{AttributeName:'id',AttributeType:'S'}],KeySchema:[{AttributeName:'id',KeyType:'HASH'}]}},
 Role:{Type:'AWS::IAM::Role',Properties:{RoleName:s.namespace+'backend',Path:'/graph-app/',PermissionsBoundary:s.boundaryArn,AssumeRolePolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'lambda.amazonaws.com'},Action:'sts:AssumeRole'}]},Policies:[{PolicyName:'records',PolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Action:['dynamodb:GetItem','dynamodb:PutItem'],Resource:{'Fn::GetAtt':['Records','Arn']}}]}}]}},
 Backend:{Type:'AWS::Lambda::Function',Properties:{FunctionName:s.namespace+'backend',Runtime:'nodejs22.x',Handler:'index.handler',Role:{'Fn::GetAtt':['Role','Arn']},Code:{ZipFile:'exports.handler=async event=>({result:event.context.caller.sub});'}}},
 Api:{Type:'AWS::ApiGateway::RestApi',Properties:{Name:s.namespace+'api',EndpointConfiguration:{Types:['REGIONAL']},Tags:[{Key:'GraphStack',Value:s.namespace}]}},
 Method:{Type:'AWS::ApiGateway::Method',Properties:{RestApiId:{Ref:'Api'},ResourceId:{'Fn::GetAtt':['Api','RootResourceId']},HttpMethod:'POST',AuthorizationType:'AWS_IAM',Integration:{Type:'AWS_PROXY',IntegrationHttpMethod:'POST',Uri:{'Fn::Sub':'arn:${AWS::Partition}:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${Backend.Arn}/invocations'}}}},
 }};}
const validate=t=>validateIsolation(JSON.stringify(t),'json',scope);
const put=(store,key,value)=>new Promise(resolve=>store.set(key,value,{},resolve));

describe('Chess regression: discoverable application contract',()=>{
 test('rename, placement, ports and infrastructure are complete discoverable operations',()=>{
  expect(validateOperations(operationCatalogue.examples.rename)).toEqual([]);
  expect(validateOperations(operationCatalogue.examples.add)).toEqual([]);
  expect(validateOperations(operationCatalogue.examples.connect)).toEqual([]);
  expect(validateOperations(operationCatalogue.examples.presentation)).toEqual([]);
  const errors=validateOperations([{op:'rename-graph',name:'Chess'}]);
  expect(errors[0]).toMatchObject({path:'ops[0].op',schemaUri:operationCatalogue.uri});
  expect(validateOperations([{op:'set-placement',nodeId:'n',placement:'lambda'}])[0].path).toBe('ops[0].placement');
 });
 test('unavailable identity helper is refused, supported host identity and local bindings are accepted',()=>{
  const node=code=>({id:'n',properties:{placement:'server'},template:{set:code}});
  expect(validateRuntime({nodes:[node('edges.out=identity();')]},['n'])[0]).toMatchObject({code:'UNSUPPORTED_HELPER',nodeId:'n'});
  expect(validateRuntime({nodes:[node('const identity = () => "local"; edges.out=identity();')]},['n'])).toEqual([]);
  expect(validateRuntime({nodes:[node('edges.out=host.identity();')]},['n'])).toEqual([]);
  expect(validateRuntime({nodes:[node('await host.magic();')]},['n'])[0].message).toMatch(/host.magic/);
  const isolated=node('const url=new URL("https://example.test"); await new Promise(resolve=>setTimeout(resolve,1));');isolated.properties.containment='isolate';
  expect(validateRuntime({nodes:[isolated]},['n']).map(e=>e.message).join(' ')).toMatch(/URL.*setTimeout/);
 });
 test('new infrastructure nodes require infrastructure approval and enter the diff',()=>{
  const before={id:'g',nodes:[]},after={id:'g',nodes:[{id:'stack',properties:{iac:{template:{text:JSON.stringify(template()),format:'json'}}}}]};
  const diff=includeInfrastructure(semanticDiff(before,after),before,after);
  expect(diff.namespaces).toContain('iac');expect(diff.privilegeDelta.infrastructure).toBe(true);
  expect(require('../policy/decide').requiredAuthorities(diff)).toContain('iac:approve');
 });
 test('validation support is never confused with deployable support',()=>{
  const old=process.env.IAC_STACK_ISOLATION;delete process.env.IAC_STACK_ISOLATION;
  const result=deploymentCapabilities('graph-a','stack',{stack:{name:'pio-dev-chess',account:policy.accounts[0],region:policy.regions[0],environment:'dev'},template:{text:JSON.stringify(template()),format:'json'}},policy,true);
  expect(result.validationResourceTypes).toContain('AWS::Lambda::Function');
  expect(result.deployableResourceTypes).not.toContain('AWS::Lambda::Function');expect(result.deployable).toBe(false);
  if(old===undefined)delete process.env.IAC_STACK_ISOLATION;else process.env.IAC_STACK_ISOLATION=old;
 });
});

describe('isolated stack boundaries',()=>{
 test('namespaces are server assigned and graph/node/account bound',()=>{
  expect(stackScope('graph-a','stack',policy)).toEqual(scope);
  expect(stackScope('graph-b','stack',policy).namespace).not.toBe(scope.namespace);
  expect(stackScope('graph-a','other',policy).namespace).not.toBe(scope.namespace);
  expect(stackScope('graph-a','stack',{...policy,accounts:['123456789012']}).namespace).not.toBe(scope.namespace);
  const stage=process.env.STAGE;try{process.env.STAGE=(stage||'local')+'-other';expect(stackScope('graph-a','stack',policy).namespace).not.toBe(scope.namespace);}finally{if(stage===undefined)delete process.env.STAGE;else process.env.STAGE=stage;}
 });
 test('local Lambda, bounded IAM and authenticated REST API template passes',()=>expect(validate(template())).toEqual([]));
 test.each([
  ['cross-stack role',t=>t.Resources.Backend.Properties.Role='arn:aws:iam::230639770018:role/graph-app/foreign'],
  ['account-wide IAM permission',t=>t.Resources.Role.Properties.Policies[0].PolicyDocument.Statement[0]={Effect:'Allow',Action:'iam:*',Resource:'*'}],
  ['foreign data access',t=>t.Resources.Role.Properties.Policies[0].PolicyDocument.Statement[0].Resource='arn:aws:dynamodb:us-west-1:230639770018:table/other'],
  ['foreign principal trust',t=>t.Resources.Role.Properties.AssumeRolePolicyDocument.Statement[0].Principal={AWS:'arn:aws:iam::230639770018:root'}],
  ['guardrail replacement',t=>t.Resources.Role.Properties.PermissionsBoundary='arn:aws:iam::230639770018:policy/other'],
  ['policy attachment bypass',t=>t.Resources.Role.Properties.ManagedPolicyArns=['arn:aws:iam::aws:policy/AdministratorAccess']],
  ['existing API mutation',t=>t.Resources.Method.Properties.RestApiId='shared-server-api'],
  ['anonymous API',t=>t.Resources.Method.Properties.AuthorizationType='NONE'],
  ['foreign API namespace',t=>t.Resources.Api.Properties.Tags[0].Value='another-stack'],
  ['hidden imported API definition',t=>t.Resources.Api.Properties.Body={swagger:'2.0'}],
  ['inline API stage bypass',t=>t.Resources.Deployment={Type:'AWS::ApiGateway::Deployment',Properties:{RestApiId:{Ref:'Api'},StageName:'prod',StageDescription:{AccessLogSetting:{DestinationArn:'arn:aws:logs:us-west-1:230639770018:log-group:shared'}}}}],
  ['shared API logging role',t=>t.Resources.Stage={Type:'AWS::ApiGateway::Stage',Properties:{RestApiId:{Ref:'Api'},DeploymentId:{Ref:'Deployment'},MethodSettings:[{LoggingLevel:'INFO'}]}}],
  ['external code artifact',t=>t.Resources.Backend.Properties.Code={S3Bucket:'foreign',S3Key:'code.zip'}],
  ['unsupported snapshot retention',t=>t.Resources.Records.DeletionPolicy='Snapshot'],
  ['dynamic reference',t=>t.Resources.Backend.Properties.Environment={Variables:{SECRET:'{{resolve:secretsmanager:outside}}'}}],
 ])('%s is refused before review',(_name,mutate)=>{const t=template();mutate(t);expect(validate(t).length).toBeGreaterThan(0);});
 test('AWS policies allow own lifecycle, forbid guardrail edits and prevent boundary removal',()=>{
  const doc=executionPolicy(scope);const allow=doc.Statement.filter(s=>s.Effect==='Allow');
  expect(allow.find(s=>[].concat(s.Action).includes('iam:PassRole'))).toMatchObject({Resource:[expect.stringContaining('/graph-app/'+scope.namespace)],Condition:{StringEquals:{'iam:PassedToService':'lambda.amazonaws.com'}}});
  expect(doc.Statement.some(s=>s.Effect==='Deny'&&[].concat(s.Action).includes('iam:DeleteRolePermissionsBoundary'))).toBe(true);
  expect(JSON.stringify(runtimeBoundary(scope))).not.toContain('"Effect":"Allow","Action":["iam:');
  expect(allow.find(s=>[].concat(s.Action).includes('lambda:DeleteFunction')).Resource[0]).toContain(scope.namespace);
  expect(allow.find(s=>[].concat(s.Action).includes('apigateway:DELETE')).Condition.StringEquals['aws:ResourceTag/GraphStack']).toBe(scope.namespace);
  const guardrail=guardrailTemplate(scope,'arn:aws:iam::230639770018:role/platform-worker');
  const worker=guardrail.Resources.WorkerRole.Properties.Policies[0].PolicyDocument;
  expect(worker.Statement[0].Action).toContain('cloudformation:DeleteStack');expect(worker.Statement[0].Resource).toContain('/'+scope.namespace);
  expect(JSON.stringify(doc).length).toBeLessThan(10240);
 });
});

describe('authenticated backend and existing bus integration (simulated users)',()=>{
 async function fixture(){
  const store=new Store();const publish=jest.fn(async()=>{}),records=new Map();
  await put(store,'iac/deployed/graph-a/stack.json',{operationId:'approved'});
  await put(store,'iac/reviews/approved.json',{operationId:'approved',graphId:'graph-a',nodeId:'stack',state:'succeeded',approval:{sub:'reviewer'},input:{isolation:scope},resources:[{logicalId:'Backend',resourceType:'AWS::Lambda::Function',physicalId:scope.namespace+'backend'}]});
  const invoke=jest.fn(async(_arn,event)=>{const sub=event.context.caller.sub;records.set(sub,{sub});return {result:{registered:sub},updates:[{topic:'registered',value:{players:[...records.keys()]},version:records.size}]};});
  return {store,publish,invoke,service:new ApplicationService(store,{publish,invoke,policy:()=>policy})};
 }
 const request=sub=>({graphId:'graph-a',nodeId:'backend',stackNodeId:'stack',logicalFunctionId:'Backend',principal:{sub,kind:'human',tenant:'test',token:'must-never-be-copied'},value:{action:'register',claimedSub:'forged'}});
 test('two callers register from verified context, broadcast through one graph bus, and never forward tokens',async()=>{
  const f=await fixture();await f.service.invoke(request('alice'));await f.service.invoke(request('bob'));
  expect(f.invoke.mock.calls[0][1].context.caller).toEqual({sub:'alice',kind:'human',tenant:'test'});
  expect(JSON.stringify(f.invoke.mock.calls)).not.toContain('must-never-be-copied');
  expect(f.publish.mock.calls[1][1]).toMatchObject({provenance:'server',value:{players:['alice','bob']},graphId:'graph-a'});
 });
 test('no credentials or unapproved/cross-stack function address is accepted',async()=>{
  const f=await fixture();await expect(f.service.invoke({...request('alice'),value:{access_token:'secret'}})).rejects.toThrow(/Credentials/);
  await expect(f.service.invoke({...request('alice'),logicalFunctionId:'Other'})).rejects.toThrow(/owned/);
  await expect(f.service.invoke({...request('alice'),graphId:'graph-b'})).rejects.toThrow(/completed approved/);
  expect(f.invoke).not.toHaveBeenCalled();
 });
});

describe('durable arrival cursor',()=>{
 test('concurrent writes and late browser IDs are all available exactly once per cursor traversal',async()=>{
  const store=new Store(),a=new ObservationJournal(store),b=new ObservationJournal(store);
  await Promise.all([a.append('g',[{id:'z',kind:'exec.error',nodeId:'server'}],{provenance:'server'}),b.append('g',[{id:'a',kind:'exec.error',nodeId:'browser'}],{provenance:'browser-report'})]);
  const page=await a.read('g',{limit:1});const next=await a.read('g',{cursor:page.nextCursor,limit:1});
  expect(new Set([...page.observations,...next.observations].map(o=>o.id))).toEqual(new Set(['a','z']));
  await b.append('g',[{id:'0',kind:'exec.error'}]);
  expect((await a.read('g',{cursor:next.nextCursor})).observations[0].id).toBe('0');
  await expect(a.read('other',{cursor:next.nextCursor})).rejects.toThrow(/different graph/);
 });
});

test('the published application example uses verified subjects and versioned updates for two simulated users',async()=>{
 const vm=require('vm'),example=require('../discovery/example').authenticatedApplicationExample(scope);
 const template=JSON.parse(example.configuration.template.text),members=new Set();let version=0;
 class Command{constructor(input){this.input=input;}}
 class Update extends Command{};class Get extends Command{};
 class DynamoDBClient{async send(command){if(command instanceof Update){members.add(command.input.ExpressionAttributeValues[':player'].SS[0]);version++;}const item={playerIds:{SS:[...members]},revision:{N:String(version)}};return command instanceof Update?{Attributes:item}:{Item:item};}}
 const sandbox={exports:{},process:{env:{TABLE:'application-owned'}},require:name=>{expect(name).toBe('@aws-sdk/client-dynamodb');return {DynamoDBClient,UpdateItemCommand:Update,GetItemCommand:Get};}};
 vm.runInNewContext(template.Resources.Backend.Properties.Code.ZipFile,sandbox);
 const call=sub=>sandbox.exports.handler({context:{caller:{sub,kind:'human'}},input:{action:'register',sub:'forged-other-user'}});
 const alice=await call('alice'),bob=await call('bob');await call('alice');
 expect(bob.result.players).toEqual(['alice','bob']);expect(members.size).toBe(2);
 expect(bob.updates[0].version).toBeGreaterThan(alice.updates[0].version);
 const script=example.ops.find(o=>o.node?.id==='listener').node.template.vue.match(/<script>([\s\S]*)<\/script>/)[1];
 const component={exports:{}};vm.runInNewContext(script.replace('export default','module.exports='),{module:component});
 const events=[];let receive;
 const self={...component.exports.data(),application:{subscribe:fn=>{receive=fn;return()=>{};}},$emit:(_name,value)=>events.push(value)};
 component.exports.mounted.call(self);receive(bob.updates[0]);receive(alice.updates[0]);
 expect(events).toEqual([['alice','bob']]);
});

test('malformed policies and cross-account targets produce preflight problems rather than succeeding',()=>{
 const old=process.env.IAC_STACK_ISOLATION;process.env.IAC_STACK_ISOLATION='true';
 try {
  const t=template();t.Resources.Role.Properties.Policies={bad:true};
  expect(validate(t)).toEqual(expect.arrayContaining([expect.objectContaining({path:'Resources.Role.Properties.Policies'})]));
  t.Resources.Role.Properties.AssumeRolePolicyDocument.Statement=[null];
  t.Resources.Api.Properties.Tags=[null];
  expect(validate(t)).toEqual(expect.arrayContaining([expect.objectContaining({path:'Resources.Role.Properties.AssumeRolePolicyDocument'}),expect.objectContaining({path:'Resources.Api.Properties.Tags'})]));
  const report=deploymentCapabilities('graph-a','stack',{stack:{name:scope.namespace+'stack',account:'111122223333',region:'us-east-1',environment:'dev'},template:{text:JSON.stringify(template()),format:'json'}},{...policy,accounts:[...policy.accounts,'111122223333'],regions:['us-west-1','us-east-1']},true);
  expect(report.problems.map(p=>p.code)).toEqual(expect.arrayContaining(['ACCOUNT_NOT_ALLOWED','REGION_NOT_ALLOWED']));
 }finally{if(old===undefined)delete process.env.IAC_STACK_ISOLATION;else process.env.IAC_STACK_ISOLATION=old;}
});

test('watch supports starting at latest and redacts accidental credentials from errors',async()=>{
 const store=new Store(),journal=new ObservationJournal(store);
 await journal.append('g',[{id:'older',kind:'exec.error'}]);
 const cursor=await journal.read('g',{from:'latest'});expect(cursor.observations).toHaveLength(0);
 await journal.append('g',[{id:'new',kind:'exec.error',payload:{message:'Bearer ABCDEFGHIJKL',access_token:'opaque-secret'}}]);
 const next=await journal.read('g',{cursor:cursor.nextCursor});
 expect(next.observations.map(o=>o.id)).toEqual(['new']);expect(JSON.stringify(next)).not.toMatch(/ABCDEFGHIJKL|opaque-secret/);
});

test('preflight assembles connected resource nodes and reports their deployment support',()=>{
 const env={...process.env};Object.assign(process.env,{IAC_STACK_ISOLATION:'true',IAC_GUARDRAIL_ROLE_ARN:'configured'});
 try{
  const graph={id:'graph-a',nodes:[{id:'stack',properties:{iac:{stack:{name:scope.namespace+'stack',account:scope.account,region:scope.region,environment:'dev'}}}},{id:'logs',properties:{iac:{resource:{logicalId:'Logs',type:'AWS::Logs::LogGroup',properties:{LogGroupName:scope.namespace+'log',RetentionInDays:7},updateReplacePolicy:'Retain'}}},edges:[{field:'out',connectors:[{nodeId:'stack',field:'in'}]}]}]};
  const good=graphDeploymentCapabilities(graph,'stack',policy,true);
  expect(good.source).toBe('graph');expect(good.problems).toEqual([]);expect(good.deployable).toBe(true);expect(good.validation.resourceTypes).toContain('AWS::Logs::LogGroup');
  expect(require('../iac/assemble').assemble(graph,'stack',policy).template.Resources.Logs.UpdateReplacePolicy).toBe('Retain');
  graph.nodes[1].properties.iac.resource.type='AWS::Lambda::Url';
  expect(graphDeploymentCapabilities(graph,'stack',policy,true).deployable).toBe(false);
 }finally{process.env=env;}
});
