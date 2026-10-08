import {CloudFormationClient,CreateStackCommand,DescribeStacksCommand,GetTemplateCommand} from '@aws-sdk/client-cloudformation';
import {STS} from 'aws-sdk';
import {StackScope,executionPolicy,runtimeBoundary} from './isolation';
import {canonical} from './lifecycleModel';
import {parseTemplate} from './validator';
/** Only the trusted platform builds this template. Graph content cannot supply any part of it. */
export function guardrailTemplate(s:StackScope,workerArn:string){
 const workload=`arn:aws:cloudformation:${s.region}:${s.account}:stack/${s.namespace}stack/*`;
 const owned=[workload,...['review','recovery'].map(prefix=>`arn:aws:cloudformation:${s.region}:${s.account}:changeSet/${prefix}-${s.namespace}*/*`)];
 return {AWSTemplateFormatVersion:'2010-09-09',Description:'Platform-managed graph stack isolation; never graph editable',Resources:{
  RuntimeBoundary:{Type:'AWS::IAM::ManagedPolicy',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{Path:'/graph-guardrails/',ManagedPolicyName:s.namespace+'runtime',PolicyDocument:runtimeBoundary(s)}},
  ExecutionRole:{Type:'AWS::IAM::Role',Properties:{Path:'/graph-deploy/',RoleName:s.namespace+'execution',AssumeRolePolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'cloudformation.amazonaws.com'},Action:'sts:AssumeRole'}]},Policies:[{PolicyName:'isolated-stack',PolicyDocument:executionPolicy(s)}]}},
  WorkerRole:{Type:'AWS::IAM::Role',Properties:{Path:'/graph-deploy/',RoleName:s.namespace+'worker',AssumeRolePolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{AWS:workerArn},Action:'sts:AssumeRole'}]},Policies:[{PolicyName:'one-stack',PolicyDocument:{Version:'2012-10-17',Statement:[
   {Effect:'Allow',Action:['cloudformation:CreateChangeSet','cloudformation:DescribeChangeSet','cloudformation:DeleteChangeSet','cloudformation:ExecuteChangeSet','cloudformation:DescribeStacks','cloudformation:DescribeStackResources','cloudformation:ListStackResources','cloudformation:GetTemplate','cloudformation:DeleteStack','cloudformation:ContinueUpdateRollback','cloudformation:RollbackStack','cloudformation:TagResource','cloudformation:UntagResource'],Resource:owned},
   {Effect:'Allow',Action:'iam:PassRole',Resource:s.roleArn,Condition:{StringEquals:{'iam:PassedToService':'cloudformation.amazonaws.com'}}},
   {Effect:'Deny',Action:'cloudformation:*',NotResource:owned},
   {Effect:'Deny',Action:'iam:PassRole',NotResource:s.roleArn},
  ]}}]}},
 }};
}
export class Guardrails {
 private client:CloudFormationClient;
 constructor(private region:string,private roleArn:string,private workerArn:string){this.client=new CloudFormationClient({region});}
 async ensure(s:StackScope):Promise<boolean>{
  if(!this.roleArn||!this.workerArn)throw new Error('Isolated deployment guardrails are not configured');
  let stack:any;
  try{stack=(await this.client.send(new DescribeStacksCommand({StackName:s.guardrailStack}))).Stacks?.[0];}
  catch(e){if(!/does not exist/.test(e.message))throw e;}
  if(!stack){
   try{await this.client.send(new CreateStackCommand({StackName:s.guardrailStack,RoleARN:this.roleArn,Capabilities:['CAPABILITY_NAMED_IAM'],TemplateBody:JSON.stringify(guardrailTemplate(s,this.workerArn)),Tags:[{Key:'GraphId',Value:s.graphId},{Key:'NodeId',Value:s.nodeId},{Key:'IsolationVersion',Value:s.version}]}));}
   catch(e){if(!/AlreadyExists/.test(e.name||e.message))throw e;}return false;
  }
  const tags=Object.fromEntries((stack.Tags||[]).map(t=>[t.Key,t.Value]));
  if(tags.GraphId!==s.graphId||tags.NodeId!==s.nodeId||tags.IsolationVersion!==s.version||stack.RoleARN!==this.roleArn)throw new Error('Guardrail ownership or version does not match this graph stack');
  if(/IN_PROGRESS$/.test(stack.StackStatus))return false;
  if(stack.StackStatus!=='CREATE_COMPLETE'&&stack.StackStatus!=='UPDATE_COMPLETE')throw new Error('Platform guardrail provisioning failed: '+stack.StackStatus);
  const template=await this.client.send(new GetTemplateCommand({StackName:stack.StackId,TemplateStage:'Original'}));
  if(canonical(parseTemplate(template.TemplateBody,'yaml').doc)!==canonical(guardrailTemplate(s,this.workerArn)))throw new Error('The platform guardrail definition changed. Prepare and approve graph-native guardrail reconciliation with iac.recovery.plan.');
  return true;
 }
 async credentials(s:StackScope){
  const credentials=(await new STS({region:this.region}).assumeRole({RoleArn:s.workerRoleArn,RoleSessionName:'graph-review',DurationSeconds:900}).promise()).Credentials!;
  return {accessKeyId:credentials.AccessKeyId,secretAccessKey:credentials.SecretAccessKey,sessionToken:credentials.SessionToken,expiration:credentials.Expiration};
 }
}
