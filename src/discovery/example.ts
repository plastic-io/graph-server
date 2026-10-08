import {StackScope} from '../iac/isolation';
/** An application fixture, not game-specific platform behavior. No credentials or user IDs. */
export function authenticatedApplicationExample(s:StackScope){
 const code=`const {DynamoDBClient,UpdateItemCommand,GetItemCommand}=require('@aws-sdk/client-dynamodb');
const db=new DynamoDBClient({});
exports.handler=async event=>{
 const caller=event.context?.caller;
 if(!caller?.sub)throw new Error('An authenticated caller is required');
 const input=event.input||{};
 if(!['register','refresh'].includes(input.action))throw new Error('Unsupported action');
 if(input.action==='register'&&caller.kind!=='human')throw new Error('Player registration requires a human session');
 const key={id:{S:'registered-players'}};
 const response=input.action==='register'
  ?await db.send(new UpdateItemCommand({TableName:process.env.TABLE,Key:key,UpdateExpression:'ADD playerIds :player, revision :one',ExpressionAttributeValues:{':player':{SS:[caller.sub]},':one':{N:'1'}},ReturnValues:'ALL_NEW'}))
  :await db.send(new GetItemCommand({TableName:process.env.TABLE,Key:key,ConsistentRead:true}));
 const record=response.Attributes||response.Item||{};
 const players=(record.playerIds?.SS||[]).sort(),version=Number(record.revision?.N||0);
 return {result:{registered:input.action==='register'?caller.sub:null,players,version},updates:[{topic:'players',value:{players},version}]};
};`;
 const template={AWSTemplateFormatVersion:'2010-09-09',Resources:{
  Records:{Type:'AWS::DynamoDB::Table',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{TableName:s.namespace+'records',BillingMode:'PAY_PER_REQUEST',AttributeDefinitions:[{AttributeName:'id',AttributeType:'S'}],KeySchema:[{AttributeName:'id',KeyType:'HASH'}]}},
  Logs:{Type:'AWS::Logs::LogGroup',Properties:{LogGroupName:'/aws/lambda/'+s.namespace+'backend',RetentionInDays:7}},
  Role:{Type:'AWS::IAM::Role',Properties:{RoleName:s.namespace+'backend',Path:'/graph-app/',PermissionsBoundary:s.boundaryArn,AssumeRolePolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'lambda.amazonaws.com'},Action:'sts:AssumeRole'}]},Policies:[{PolicyName:'own-records',PolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Action:['dynamodb:UpdateItem','dynamodb:GetItem'],Resource:{'Fn::GetAtt':['Records','Arn']}},{Effect:'Allow',Action:['logs:CreateLogStream','logs:PutLogEvents'],Resource:`arn:aws:logs:${s.region}:${s.account}:log-group:/aws/lambda/${s.namespace}backend:*`}]}}]}},
  Backend:{Type:'AWS::Lambda::Function',DependsOn:'Logs',Properties:{FunctionName:s.namespace+'backend',Runtime:'nodejs22.x',Handler:'index.handler',Timeout:15,Role:{'Fn::GetAtt':['Role','Arn']},Environment:{Variables:{TABLE:{Ref:'Records'}}},Code:{ZipFile:code}}},
 },Outputs:{Table:{Value:{Ref:'Records'}},Function:{Value:{Ref:'Backend'}}}};
 const vue=`<template><div><button @click="request('register')">Register signed-in player</button><button @click="request('refresh')">Refresh players</button><pre>{{ players }}</pre><p>{{ error }}</p></div></template>
<script>
export default {
 props: ['session','application','players'], data:()=>({error:''}),
 methods:{async request(action){try{if(!this.session.current().authenticated)throw new Error('Sign in first');await this.application.request('backend','request',{action});}catch(e){this.error=e.message;}}}
};
</script>`;
 const listener=`<script>
export default {props:['application'],data:()=>({version:-1}),mounted(){this.unsubscribe=this.application.subscribe(event=>{if(event.topic==='players'&&event.version>this.version){this.version=event.version;this.$emit('players',event.value.players);}});},beforeUnmount(){this.unsubscribe?.();}};
</script>`;
 return {version:1,evidence:'Example only: does not imply deployment or live two-user verification.',workflow:'Preflight these exact names, submit ops, accept graph proposal, prepare iac.review, approve deployment, then sign in as two different users and register in each browser. Both should receive the two-player list. Refresh sends a new authoritative query after reconnect; delivery is best effort.',configuration:{stack:{name:s.namespace+'stack',account:s.account,region:s.region,environment:'dev'},template:{text:JSON.stringify(template,null,2),format:'json'},capabilities:['CAPABILITY_NAMED_IAM']},ops:[
  {op:'set-graph-props',patch:{name:'Chess workflow regression'}},
  {op:'add-node',node:{id:s.nodeId,url:s.nodeId,name:'Application stack',layout:{x:120,y:400}}},
  {op:'add-node',node:{id:'backend',url:'backend',name:'Authenticated backend bridge',placement:'server',inputs:[{name:'request'}],outputs:[{name:'response'}],template:{set:`edges.response = await host.application.invoke(${JSON.stringify(s.nodeId)}, 'Backend', value);`},layout:{x:420,y:300}}},
  {op:'set-containment',nodeId:'backend',containment:'isolate'},
  {op:'set-capabilities',nodeId:'backend',granted:[{kind:'application:invoke',scope:[s.nodeId+'/Backend']}]},
  {op:'add-node',node:{id:'players',url:'players',name:'Players',placement:'browser',inputs:[{name:'players'}],template:{vue},layout:{x:100,y:100}}},
  {op:'set-node-props',nodeId:'players',patch:{appearsInPresentation:true,presentation:{x:0,y:0,z:1}}},
  {op:'add-node',node:{id:'listener',url:'listener',name:'Application bus listener',placement:'browser',outputs:[{name:'players'}],template:{set:'edges.players=value;',vue:listener},layout:{x:420,y:100}}},
  {op:'set-node-props',nodeId:'listener',patch:{appearsInPresentation:false,runInBackground:true}},
  {op:'connect',from:{nodeId:'listener',field:'players'},to:{nodeId:'players',field:'players'}},
  {op:'set-iac-desired',nodeId:s.nodeId,desired:{stack:{name:s.namespace+'stack',account:s.account,region:s.region,environment:'dev'},template:{text:JSON.stringify(template,null,2),format:'json'},capabilities:['CAPABILITY_NAMED_IAM']}},
 ],retention:'The records table is retained on deletion/replacement. A destroy review lists it; retained data requires a separately approved cleanup or import, never a silent delete.'};
}
