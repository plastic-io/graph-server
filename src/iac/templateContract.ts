import {createHash} from 'crypto';

/** Bump when review semantics change: old approvals must never acquire new meaning. */
export const TEMPLATE_CONTRACT_VERSION='author-template-v1';
export const templateSha256=(text:string)=>createHash('sha256').update(text).digest('hex');
export const templateContract={
 version:TEMPLATE_CONTRACT_VERSION,
 submission:'An explicit inline template is authoritative and its bytes are submitted unchanged, even with connected resource nodes. Only when no inline template is supplied does resource assembly provide the template. Fragments preserve authored properties and policy attributes; omissions remain omitted for CloudFormation defaults.',
 approval:'The graph revision, template SHA-256, parameters, capabilities, target, contract version and exact change set are bound to the human-approved review. Changed content or review semantics require a fresh approval.',
 choices:'Retention, lifecycle, billing, deletion and replacement settings are author choices, disclosed in review rather than rejected by platform cost or preservation policy.',
 legacyPreservation:'preservation=strict constrains separate stack deletion, recovery fallback and platform guardrail work only. It does not prohibit deletions, replacements or data expiry declared by the application template. Review its consequences before approval.',
 permissions:'Authentication, graph ownership, supported deployment capabilities, namespace/account isolation and platform IAM boundaries still apply. Static validation is not effective AWS permission verification.',
};

const fields:Record<string,string[]>={
 'AWS::Logs::LogGroup':['RetentionInDays'],
 'AWS::S3::Bucket':['LifecycleConfiguration','VersioningConfiguration'],
 'AWS::DynamoDB::Table':['TimeToLiveSpecification','PointInTimeRecoverySpecification','GlobalSecondaryIndexes','LocalSecondaryIndexes','BillingMode','ProvisionedThroughput'],
 'AWS::SQS::Queue':['MessageRetentionPeriod'],
 'AWS::Lambda::Alias':['ProvisionedConcurrencyConfig'],
 'AWS::Lambda::Version':['ProvisionedConcurrencyConfig'],
 'AWS::Lambda::Function':['Timeout','MemorySize','ReservedConcurrentExecutions','LoggingConfig'],
};
const stable=(v:any):string=>Array.isArray(v)?'['+v.map(stable).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v);
function setting(resource:any,field:string){
 const container=field.startsWith('Properties.')?resource?.Properties:resource,key=field.split('.').pop()!;
 if(container&&Object.prototype.hasOwnProperty.call(container,key))return {specified:true,value:container[key]};
 return {specified:false,default:'CloudFormation default (not injected)'};
}

/** Read-only disclosure, never normalization or validation of author choices.
 * Includes unchanged resources: ongoing expiry is relevant even without a CF change. */
export function templateConsequences(next:any,previous:any,changes:any[]=[],baseline='not-created'){
 const before=previous?.Resources||{},after=next?.Resources||{},byId=new Map(changes.map(c=>[c.logicalId,c]));
 const resources=[...new Set([...Object.keys(before),...Object.keys(after),...byId.keys()])].sort().map(logicalId=>{
  const old=before[logicalId],now=after[logicalId],r=now||old||{},change:any=byId.get(logicalId);
  const action=change?.action||(!old?'Add':!now?'Remove':stable(old)===stable(now)?'Unchanged':'Modify');
  const paths=['DeletionPolicy','UpdateReplacePolicy',...(fields[r.Type]||[]).map(f=>'Properties.'+f)];
  const settings=paths.map(path=>({path,before:old?setting(old,path):null,after:now?setting(now,path):null,
   changed:stable(old?setting(old,path):null)!==stable(now?setting(now,path):null)}));
  const consequences:string[]=[];
  const replacing=action==='Replace'||action==='Modify'&&change?.replacement!=='False'&&!!change;
  if(action==='Remove')consequences.push('Resource leaves the stack; AWS applies the current DeletionPolicy, including its default if omitted.');
  if(replacing)consequences.push('AWS reports replacement or cannot rule it out. UpdateReplacePolicy controls disposal of the old physical resource.');
  if(now?.DeletionPolicy==='RetainExceptOnCreate')consequences.push('RetainExceptOnCreate permits deletion when the operation that first creates this resource rolls back.');
  if(now?.UpdateReplacePolicy==='Snapshot')consequences.push('AWS falls back to Delete for UpdateReplacePolicy: Snapshot on resource types without snapshot support.');
  if(r.Type==='AWS::Logs::LogGroup')consequences.push(r.Properties?.RetentionInDays===undefined?'Log retention is omitted; CloudWatch keeps logs indefinitely by default.':'Configured log retention can expire events older than the specified age.');
  if(now?.Properties?.LifecycleConfiguration)consequences.push('S3 lifecycle rules may expire objects or versions, transition storage or abort incomplete uploads according to the authored configuration.');
  if(now?.Properties?.TimeToLiveSpecification?.Enabled!==undefined&&now.Properties.TimeToLiveSpecification.Enabled!==false)consequences.push('DynamoDB TTL can remove expired items.');
  // Consequential changes require confirmation, not a template rewrite or refusal.
  // Cost settings are disclosed but do not turn a review into a prohibition.
  const relevant=settings.filter(s=>s.changed&&!['Properties.BillingMode','Properties.ProvisionedThroughput','Properties.ProvisionedConcurrencyConfig','Properties.Timeout','Properties.MemorySize','Properties.ReservedConcurrentExecutions','Properties.LoggingConfig'].includes(s.path));
  const dataSettingsChanged=relevant.some(s=>s.path.startsWith('Properties.')&&(s.after?.specified||s.before?.specified));
  const policiesChanged=!!old&&!!now&&relevant.some(s=>!s.path.startsWith('Properties.'));
  const requiresConfirmation=action==='Remove'||replacing||dataSettingsChanged||policiesChanged;
  return {logicalId,resourceType:r.Type||change?.resourceType,action,replacement:change?.replacement,policyAction:change?.policyAction,settings,consequences,requiresConfirmation};
 });
 return {version:TEMPLATE_CONTRACT_VERSION,baseline,resources,requiresConfirmation:resources.some(r=>r.requiresConfirmation),
  note:'Advisory consequences are bound to this review. They do not change the submitted template. AWS validates resource-specific behavior and permissions.'};
}
