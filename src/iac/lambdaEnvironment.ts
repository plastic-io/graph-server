import type {StackScope} from './isolation';

export const LAMBDA_ENVIRONMENT_VERSION='lambda-default-environment-v1';
/** The AWS-reserved alias cannot be reassigned by an application. Encryption
 * context is authenticated with the ciphertext, not a caller identity claim.
 * Lambda's automatic KMS calls do NOT carry lambda:SourceFunctionArn. */
export function lambdaEnvironmentAccess(s:StackScope) {
 return {keyResource:`arn:aws:kms:${s.region}:${s.account}:key/*`,alias:'alias/aws/lambda',
  contextKey:'kms:EncryptionContext:aws:lambda:FunctionArn',functionArn:`arn:aws:lambda:${s.region}:${s.account}:function:${s.namespace}*`,account:s.account};
}
export function lambdaEnvironmentStatements(s:StackScope):any[] {
 const a=lambdaEnvironmentAccess(s);
 return [
  {Sid:'AllowOwnLambdaEnvironmentDecrypt',Effect:'Allow',Action:'kms:Decrypt',Resource:a.keyResource,Condition:{
   'ForAnyValue:StringEquals':{'kms:ResourceAliases':a.alias},StringEquals:{'kms:CallerAccount':a.account},ArnLike:{[a.contextKey]:a.functionArn}}},
  // Explicit negatives also constrain direct grants to a role session from a
  // key/resource policy. Omitting a condition must never bypass the boundary.
  {Sid:'DenyDecryptWithOtherKeys',Effect:'Deny',Action:'kms:Decrypt',Resource:a.keyResource,Condition:{'ForAllValues:StringNotEquals':{'kms:ResourceAliases':a.alias}}},
  {Sid:'DenyDecryptForOtherLambdaNamespaces',Effect:'Deny',Action:'kms:Decrypt',Resource:a.keyResource,Condition:{ArnNotLike:{[a.contextKey]:a.functionArn}}},
  {Sid:'DenyDecryptForOtherAccounts',Effect:'Deny',Action:'kms:Decrypt',Resource:a.keyResource,Condition:{StringNotEquals:{'kms:CallerAccount':a.account}}},
 ];
}
export function lambdaEnvironmentContract(s:StackScope,doc:any) {
 const access=lambdaEnvironmentAccess(s);
 const functions=Object.entries<any>(doc?.Resources||{}).filter(([,r])=>r?.Type==='AWS::Lambda::Function').map(([logicalId,r])=>({
  logicalId,functionName:r.Properties?.FunctionName,environmentDeclared:r.Properties?.Environment!==undefined,
  mode:r.Properties?.KMSKeyArn===undefined||r.Properties.KMSKeyArn===''?'aws-managed-default':'unsupported-customer-key',
  boundaryArn:s.boundaryArn,
 }));
 return {version:LAMBDA_ENVIRONMENT_VERSION,functions,access:{action:'kms:Decrypt',...access},
  evidence:'template-and-platform-definition',awsExecutionVerified:false,
  existingStacks:'Run iac.inspect. A platform release does not update installed boundaries; a differing boundary needs a separately human-approved, in-place guardrail recovery plan.',
  limitations:'The boundary permits only default Lambda environment decryption with the assigned function encryption context. It grants no KMS administration, encryption, grants, or access to customer keys or another namespace. Key policies, service behavior and other AWS policies still apply. CREATE_COMPLETE is not runtime readiness; run the declared authenticated readiness check.',
 };
}
