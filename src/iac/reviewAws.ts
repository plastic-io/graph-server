import {CloudFormationClient, CreateChangeSetCommand, DescribeChangeSetCommand, DescribeStacksCommand,
    DeleteChangeSetCommand, ExecuteChangeSetCommand} from '@aws-sdk/client-cloudformation';
import {ReviewCloud} from './review';

/** This adapter is imported only by the isolated deployment worker. */
export function reviewCloud(region: string, roleArn: string): ReviewCloud {
    if (!roleArn) throw new Error('Missing CloudFormation execution role');
    const client=new CloudFormationClient({region});
    return {
        async stack(name) {
            try {
                const stack=(await client.send(new DescribeStacksCommand({StackName:name}))).Stacks?.[0];
                return stack ? {exists:true,stackId:stack.StackId,status:stack.StackStatus,reason:stack.StackStatusReason,
                    outputs:(stack.Outputs || []).map(o=>({key:o.OutputKey,value:o.OutputValue,description:o.Description}))} : {exists:false};
            } catch (e) {if (/does not exist/i.test(e.message)) return {exists:false};throw e;}
        },
        async create(op) {
            const answer=await client.send(new CreateChangeSetCommand({StackName:op.input.stack.name,
                ChangeSetName:op.changeSetName,ClientToken:op.operationId,ChangeSetType:op.stackExists ? 'UPDATE' : 'CREATE',
                TemplateBody:op.input.text,RoleARN:roleArn,Capabilities:op.input.capabilities,
                Parameters:Object.entries(op.input.parameters).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue:String(ParameterValue)})),
                Tags:[{Key:'GraphId',Value:op.graphId},{Key:'NodeId',Value:op.nodeId}],
                Description:'Reviewed graph infrastructure '+op.operationId}));
            return {changeSetId:answer.Id!,stackId:answer.StackId!};
        },
        async describe(op) {
            const changes:any[]=[];let next:string|undefined;let answer:any;
            do {
                answer=await client.send(new DescribeChangeSetCommand({StackName:op.input.stack.name,ChangeSetName:op.changeSetId || op.changeSetName,NextToken:next}));
                for (const change of answer.Changes || []) {
                    const r=change.ResourceChange || {};
                    changes.push({action:r.Action,logicalId:r.LogicalResourceId,resourceType:r.ResourceType,replacement:r.Replacement,scope:r.Scope || []});
                }
                next=answer.NextToken;
            } while(next);
            return {status:answer.Status,executionStatus:answer.ExecutionStatus,reason:answer.StatusReason,changes};
        },
        async execute(op) {
            await client.send(new ExecuteChangeSetCommand({StackName:op.input.stack.name,ChangeSetName:op.changeSetId,ClientRequestToken:op.operationId,DisableRollback:false}));
        },
        async remove(op) {
            try {await client.send(new DeleteChangeSetCommand({StackName:op.input.stack.name,ChangeSetName:op.changeSetId || op.changeSetName}));}
            catch (e) {if (!/does not exist|not found/i.test(e.message)) throw e;}
        },
    };
}
