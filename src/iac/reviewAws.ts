import {CloudFormationClient,CreateChangeSetCommand,DescribeChangeSetCommand,DescribeStacksCommand,DescribeStackResourcesCommand,GetTemplateCommand,DeleteStackCommand,DeleteChangeSetCommand,ExecuteChangeSetCommand} from '@aws-sdk/client-cloudformation';
import {ReviewCloud} from './review';
import {Guardrails} from './guardrails';
import {strict,refusePreservation,preservationChangeProblems,preservationTemplateProblems,preservationStateProblems} from './preservation';
import {parseTemplate} from './validator';
import {awsResourceAbsent} from './awsErrors';

/** Imported only by the isolated deployment worker. Each application stack uses its own AWS credentials. */
export function reviewCloud(region:string,legacyRoleArn:string):ReviewCloud {
 const guardrails=new Guardrails(region,process.env.IAC_GUARDRAIL_ROLE_ARN,process.env.IAC_WORKER_ROLE_ARN);
 const clients=new Map<string,CloudFormationClient>();
 async function client(op?:any){
  const scope=op?.input?.isolation;
  if(!scope)return new CloudFormationClient({region});
  if(!clients.has(scope.namespace))clients.set(scope.namespace,new CloudFormationClient({region:scope.region,credentials:()=>guardrails.credentials(scope)}));
  return clients.get(scope.namespace)!;
 }
 const cloud:ReviewCloud={
  async prepare(op){
   if(strict(op)&&!op.input.isolation)refusePreservation([{code:'PRESERVATION_ISOLATION_REQUIRED',kind:'preservation',message:'Strict deployment requires assigned stack isolation.'}]);
   if(strict(op))refusePreservation(preservationTemplateProblems(op.input));
   return op.input.isolation?guardrails.ensure(op.input.isolation,op.preservation):true;
  },
  async template(op){const answer=await(await client(op)).send(new GetTemplateCommand({StackName:op.input.stack.name,TemplateStage:'Original'}));return parseTemplate(answer.TemplateBody,'yaml').doc;},
  async stack(name,op){
   try{const s=(await(await client(op)).send(new DescribeStacksCommand({StackName:name}))).Stacks?.[0];
    return s?{exists:true,stackId:s.StackId,status:s.StackStatus,reason:s.StackStatusReason,outputs:(s.Outputs||[]).map(o=>({key:o.OutputKey,value:o.OutputValue,description:o.Description}))}:{exists:false};
   }catch(e){if(awsResourceAbsent(e,'cloudformation:DescribeStacks'))return {exists:false};throw e;}
  },
  async create(op){
   const roleArn=op.input.isolation?.roleArn||legacyRoleArn;if(!roleArn)throw new Error('Missing deployment role');
   const answer=await(await client(op)).send(new CreateChangeSetCommand({StackName:op.input.stack.name,ChangeSetName:op.changeSetName,ClientToken:op.operationId,ChangeSetType:op.stackExists?'UPDATE':'CREATE',TemplateBody:op.input.text,RoleARN:roleArn,Capabilities:op.input.capabilities,Parameters:Object.entries(op.input.parameters).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue:String(ParameterValue)})),Tags:[{Key:'GraphId',Value:op.graphId},{Key:'NodeId',Value:op.nodeId},...(op.input.isolation?[{Key:'GraphStack',Value:op.input.isolation.namespace}]:[])],Description:'Reviewed graph infrastructure '+op.operationId}));
   return {changeSetId:answer.Id!,stackId:answer.StackId!};
  },
  async describe(op){
   const changes:any[]=[];let next:string|undefined,answer:any;
   do{answer=await(await client(op)).send(new DescribeChangeSetCommand({StackName:op.input.stack.name,ChangeSetName:op.changeSetId||op.changeSetName,NextToken:next}));
    for(const change of answer.Changes||[]){const r=change.ResourceChange||{};changes.push({action:r.Action,logicalId:r.LogicalResourceId,physicalId:r.PhysicalResourceId,resourceType:r.ResourceType,replacement:r.Replacement,policyAction:r.PolicyAction,scope:r.Scope||[]});}next=answer.NextToken;
   }while(next);
   return {status:answer.Status,executionStatus:answer.ExecutionStatus,reason:answer.StatusReason,changes};
  },
  async execute(op){
   if(strict(op)){
    const stack=await cloud.stack(op.input.stack.name,op);
    refusePreservation(preservationStateProblems({application:{name:op.input.stack.name,stackId:stack.stackId,status:stack.status||'NOT_CREATED'}}));
    if(op.stackId&&stack.stackId&&op.stackId!==stack.stackId)refusePreservation([{code:'PRESERVATION_STACK_CHANGED',kind:'preservation',message:'The reviewed stack identity changed.'}]);
    refusePreservation(preservationChangeProblems((await cloud.describe(op)).changes));
    refusePreservation(preservationTemplateProblems(op.input,op.stackExists?await cloud.template!(op):undefined));
   }
   await(await client(op)).send(new ExecuteChangeSetCommand({StackName:op.input.stack.name,ChangeSetName:op.changeSetId,ClientRequestToken:op.operationId,DisableRollback:strict(op),...(strict(op)?{RetainExceptOnCreate:false}:{})}));
  },
  async resources(op){
   const answer=await(await client(op)).send(new DescribeStackResourcesCommand({StackName:op.stackId||op.input.stack.name}));
   return (answer.StackResources||[]).map(r=>({logicalId:r.LogicalResourceId,resourceType:r.ResourceType,physicalId:r.PhysicalResourceId,status:r.ResourceStatus})).sort((a,b)=>a.logicalId.localeCompare(b.logicalId));
  },
  async destroy(op){if(strict(op))refusePreservation([{code:'PRESERVATION_STACK_DELETION',kind:'preservation',message:'Strict preservation prohibits stack deletion.'}]);await(await client(op)).send(new DeleteStackCommand({StackName:op.stackId||op.input.stack.name,RoleARN:op.input.isolation.roleArn,ClientRequestToken:op.operationId}));},
  async remove(op){
   if(op.action==='destroy'||strict(op))return;
   try{await(await client(op)).send(new DeleteChangeSetCommand({StackName:op.input.stack.name,ChangeSetName:op.changeSetId||op.changeSetName}));}
   catch(e){if(!/does not exist|not found|cannot be assumed/i.test(e.message))throw e;}
  },
 };
 return cloud;
}
