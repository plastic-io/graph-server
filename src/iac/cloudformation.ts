import {
    CloudFormationClient as Sdk, CreateChangeSetCommand, DeleteChangeSetCommand, DescribeChangeSetCommand, DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { ChangeSetSummary, CloudFormationClient } from "./service";

/**
 * The one place this server talks to CloudFormation (plan §4.9.6 policy 1).
 *
 * Three calls, all of them about a change set: make one, read it, delete it.
 * There is deliberately no `ExecuteChangeSet` here — not behind a flag, not
 * behind a condition — because the thing that stops this milestone changing a
 * resource should be that the code to do it does not exist.
 *
 * It is built only where an environment names the accounts it may reach, so an
 * instance with nothing configured has no client at all and says so.
 */
export function cloudFormationClient(region: string): CloudFormationClient {
    const sdk = new Sdk({ region });
    return {
        async stackExists(stackName: string) {
            try {
                const answer = await sdk.send(new DescribeStacksCommand({ StackName: stackName }));
                const stack = (answer.Stacks || [])[0];
                return !!stack && stack.StackStatus !== "REVIEW_IN_PROGRESS" && stack.StackStatus !== "DELETE_COMPLETE";
            } catch (err: any) {
                if (/does not exist/i.test((err && err.message) || "")) {
                    return false;
                }
                throw err;
            }
        },
        async createChangeSet(input) {
            const answer = await sdk.send(new CreateChangeSetCommand({
                StackName: input.stackName,
                TemplateBody: input.templateBody,
                Parameters: Object.keys(input.parameters).map((key) => ({ ParameterKey: key, ParameterValue: input.parameters[key] })),
                Capabilities: input.capabilities as any,
                ChangeSetName: input.changeSetName,
                ChangeSetType: input.changeSetType,
                ClientToken: input.clientRequestToken,
                Description: "plastic-io plan; nothing here executes it",
            }));
            return { changeSetId: String(answer.Id), stackId: answer.StackId };
        },
        async describeChangeSet(input) {
            const answer = await sdk.send(new DescribeChangeSetCommand({ ChangeSetName: input.changeSetId }));
            const changes: ChangeSetSummary[] = (answer.Changes || []).map((change: any) => {
                const r = (change && change.ResourceChange) || {};
                return {
                    action: String(r.Action || "Unknown"),
                    logicalId: String(r.LogicalResourceId || ""),
                    resourceType: String(r.ResourceType || ""),
                    physicalId: r.PhysicalResourceId,
                    replacement: r.Replacement,
                    scope: r.Scope,
                };
            });
            return { status: String(answer.Status || ""), statusReason: answer.StatusReason, executionStatus: answer.ExecutionStatus, changes };
        },
        async deleteChangeSet(input) {
            await sdk.send(new DeleteChangeSetCommand({ ChangeSetName: input.changeSetId }));
        },
    };
}
