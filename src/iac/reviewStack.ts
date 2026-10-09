import {StackScope} from './isolation';

/** Server-recorded CREATE change sets prove ownership before stack tags exist.
 * This is evidence for an empty review record, never deployment approval. */
export function reviewStackReference(op:any) {
 if(op.changeSetId&&op.stackId&&op.stackExists===false)return {
  graphId:op.graphId,nodeId:op.nodeId,operationId:op.operationId,
  stackId:op.stackId,changeSetId:op.changeSetId,
 };
 return op.reviewStackProof;
}

export function reviewStackCandidate(s:StackScope,stack:any,op:any) {
 const ref=reviewStackReference(op),name='review-'+s.namespace+ref?.operationId;
 if(stack?.StackStatus!=='REVIEW_IN_PROGRESS'||stack.RoleARN!==s.roleArn||
  ref?.graphId!==s.graphId||ref?.nodeId!==s.nodeId||!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(ref?.operationId||'')||
  ref.stackId!==stack.StackId||!stack.StackId?.startsWith(`arn:aws:cloudformation:${s.region}:${s.account}:stack/${s.namespace}stack/`)||
  !ref.changeSetId?.startsWith(`arn:aws:cloudformation:${s.region}:${s.account}:changeSet/${name}/`))return undefined;
 const tags=Object.fromEntries((stack.Tags||[]).map(t=>[t.Key,t.Value]));
 if(Object.entries({GraphId:s.graphId,NodeId:s.nodeId,GraphStack:s.namespace}).some(([k,v])=>tags[k]!==undefined&&tags[k]!==v))return undefined;
 return {...ref,changeSetName:name};
}

/** Both callers retain AWS read errors; a denied/partial inventory is not empty. */
export async function verifyReviewStack(s:StackScope,stack:any,op:any,read:(method:string,args:any)=>Promise<any>) {
 const ref=reviewStackCandidate(s,stack,op);if(!ref)return undefined;
 const changes=await read('describeChangeSet',{StackName:stack.StackId,ChangeSetName:ref.changeSetId});
 const tags=Object.fromEntries((changes?.Tags||[]).map(t=>[t.Key,t.Value]));
 if(changes?.ChangeSetId!==ref.changeSetId||changes.StackId!==stack.StackId||changes.ChangeSetName!==ref.changeSetName||
  changes.Description!=='Reviewed graph infrastructure '+ref.operationId||
  !['AVAILABLE','UNAVAILABLE','OBSOLETE'].includes(changes.ExecutionStatus)||
  tags.GraphId!==s.graphId||tags.NodeId!==s.nodeId||tags.GraphStack!==s.namespace)return undefined;
 const inventory=await read('listStackResources',{StackName:stack.StackId});
 if(!Array.isArray(inventory?.StackResourceSummaries)||inventory.StackResourceSummaries.length||inventory.NextToken)return undefined;
 return {graphId:ref.graphId,nodeId:ref.nodeId,operationId:ref.operationId,stackId:ref.stackId,changeSetId:ref.changeSetId};
}
