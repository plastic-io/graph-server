/** A request constraint, never a permission grant or a substitute for approval. */
export type Preservation = 'strict' | undefined;
export function preservationMode(value:any,inherited?:Preservation):Preservation {
 if(value!==undefined&&value!=='strict')throw Object.assign(new Error('preservation must be "strict" when supplied.'),{code:'SCHEMA_INVALID',status:400});
 return value||inherited;
}
const issue=(code:string,message:string,extra:any={})=>({code,kind:'preservation',message,...extra});
export function refusePreservation(problems:any[]){
 if(problems.length)throw Object.assign(new Error(problems.map(p=>p.message).join('\n')),{code:'PRESERVATION_BLOCKED',status:409,problems});
}
export const strict=(op:any)=>op?.preservation==='strict';
const healthy=new Set(['NOT_CREATED','DELETE_COMPLETE','CREATE_COMPLETE','UPDATE_COMPLETE','IMPORT_COMPLETE','UPDATE_ROLLBACK_COMPLETE']);

/** Failed-stack APIs can delete newly provisioned resources even with Retain.
 * No destructive command is offered as an executable preservation alternative. */
export function preservationStateProblems(inspection:any):any[]{
 const problems:any[]=[];
 for(const component of ['guardrail','application']){
  const stack=inspection?.[component];if(!stack)continue;
  const status=stack.status;
  if(healthy.has(status)||status==='REVIEW_IN_PROGRESS'&&!stack.resources?.length)continue;
  const failedCreate=['ROLLBACK_FAILED','ROLLBACK_COMPLETE','DELETE_FAILED'].includes(status);
  problems.push(issue(failedCreate?'PRESERVATION_IN_PLACE_UNSUPPORTED':'PRESERVATION_STATE_UNVERIFIED',
   failedCreate?`${component} stack is ${status}. CloudFormation does not support an ordinary in-place update in this state. Stack deletion is prohibited by this review; no deletion, rollback, import or replacement will run.`:
   `${component} stack is ${status}. The platform cannot prove that continuing or retrying this state preserves every resource. No rollback or destructive fallback will run.`,
   {component,resource:stack.stackId||stack.name,stackStatus:status,service:'cloudformation',
    limitation:failedCreate?'aws-stack-state':'platform-preservation-verification',
    documentation:'https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/view-stack-events.html',
    alternatives:failedCreate?[
     {action:'leave-in-place',supported:true,executesAutomatically:false,description:'Keep this stack and all surviving resources intact.'},
     {action:'separate-stack-node',supported:true,executesAutomatically:false,description:'A new graph stack node gets a separate namespace. Review and approve it independently; existing resources remain in place and are not automatically adopted or migrated.'},
     {action:'aws-support',supported:true,executesAutomatically:false,description:'A platform administrator can ask AWS Support whether a non-destructive service-side repair is possible. No repair capability is claimed or executed.'},
    ]:[{action:'inspect',supported:true,executesAutomatically:false,description:'Inspect current events and resource states. Failed-create/update retry or rollback requires a separately verified preservation capability; cancellation alone does not repair AWS state.'}]}));
 }
 return problems;
}

// Application resource properties, retention policies and change-set removals /
// replacements are author choices. Strict constrains separate recovery commands
// and platform guardrails, never the template submitted for deployment review.
export function preservationActionProblems(actions:any[]):any[]{
 return (actions||[]).filter(a=>!['reconcile-guardrails','release-operation'].includes(a.kind)||a.dataLoss?.length||a.resources?.some(r=>r.outcome==='Delete')).map(a=>issue('PRESERVATION_RECOVERY_ACTION',
  `Recovery action ${a.kind} is not verified to preserve every stack and resource. Strict recovery will not execute it.`,{action:a.kind,component:a.target,
   alternative:a.kind==='import-retained'?'Preserve the retained resource in place. A verified non-destructive import capability is required before adoption.':'Inspect the current state or use a separately approved stack node; no destructive fallback is authorized.'}));
}

/** Only IAM document updates and additions are known in-place guardrail edits. */
export function assertGuardrailPreservation(before:any,after:any){
 const problems:any[]=[];
 if(!before?.Resources||!after?.Resources)problems.push(issue('PRESERVATION_GUARDRAIL_UNVERIFIED','The complete current and approved guardrail templates are required.'));
 for(const [logicalId,r]of Object.entries<any>(before?.Resources||{})){
  const desired=after?.Resources?.[logicalId];
  if(!desired||r.Type!==desired.Type){problems.push(issue('PRESERVATION_GUARDRAIL_CHANGE',`Guardrail ${logicalId} would be removed or replaced.`,{logicalId}));continue;}
  if(r.Condition!==desired.Condition)problems.push(issue('PRESERVATION_GUARDRAIL_CHANGE',`Guardrail ${logicalId} has a changed resource condition.`,{logicalId}));
  // A managed-policy update can remove historical policy versions. Until that
  // lifecycle is verified without deletion, preserve the exact boundary document.
  const mutable=r.Type==='AWS::IAM::Role'?['Policies','AssumeRolePolicyDocument']:[];
  const fields=new Set([...Object.keys(r.Properties||{}),...Object.keys(desired.Properties||{})]);
  for(const field of fields)if(!mutable.includes(field)&&JSON.stringify(r.Properties?.[field])!==JSON.stringify(desired.Properties?.[field]))problems.push(issue('PRESERVATION_GUARDRAIL_CHANGE',`Guardrail ${logicalId}.${field} is not a verified in-place policy update.`,{logicalId,path:field}));
 }
 refusePreservation(problems);
}
