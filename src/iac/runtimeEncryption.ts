import type {StackScope} from './isolation';
import {lambdaEnvironmentAccess,lambdaEnvironmentStatements} from './lambdaEnvironment';

export const RUNTIME_ENCRYPTION_VERSION='aws-managed-runtime-decrypt-v1';
export function dynamoDbEncryptionAccess(s:StackScope){return {
 alias:'alias/aws/dynamodb',viaService:`dynamodb.${s.region}.amazonaws.com`,account:s.account,
 tableContext:'kms:EncryptionContext:aws:dynamodb:tableName',tableName:s.namespace+'*',subscriberContext:'kms:EncryptionContext:aws:dynamodb:subscriberId',
};}
/** Only AWS-reserved service keys, with cryptographically bound namespace context.
 * Negative statements also constrain direct resource-policy/session grants. */
export function runtimeEncryptionStatements(s:StackScope):any[]{
 const l=lambdaEnvironmentAccess(s),d=dynamoDbEncryptionAccess(s),Resource=l.keyResource,Action='kms:Decrypt';
 const alias={'ForAnyValue:StringEquals':{'kms:ResourceAliases':d.alias}};
 return [...lambdaEnvironmentStatements(s),
  {Sid:'AllowOwnDynamoDbDecrypt',Effect:'Allow',Action,Resource,Condition:{...alias,StringEquals:{'kms:CallerAccount':d.account,'kms:ViaService':d.viaService,[d.subscriberContext]:d.account},StringLike:{[d.tableContext]:d.tableName}}},
  {Sid:'DenyDecryptWithOtherKeys',Effect:'Deny',Action,Resource,Condition:{'ForAllValues:StringNotEquals':{'kms:ResourceAliases':[l.alias,d.alias]}}},
  {Sid:'DenyDecryptForOtherAccounts',Effect:'Deny',Action,Resource,Condition:{StringNotEquals:{'kms:CallerAccount':d.account}}},
  {Sid:'DenyDynamoDbDecryptOutsideService',Effect:'Deny',Action,Resource,Condition:{...alias,StringNotEquals:{'kms:ViaService':d.viaService}}},
  {Sid:'DenyDynamoDbDecryptOtherTables',Effect:'Deny',Action,Resource,Condition:{...alias,StringNotLike:{[d.tableContext]:d.tableName}}},
  {Sid:'DenyDynamoDbDecryptOtherSubscribers',Effect:'Deny',Action,Resource,Condition:{...alias,StringNotEquals:{[d.subscriberContext]:d.account}}},
 ];
}
export function dynamoDbEncryptionContract(s:StackScope,doc:any){return {
 version:RUNTIME_ENCRYPTION_VERSION,
 tables:Object.entries<any>(doc?.Resources||{}).filter(([,r])=>r?.Type==='AWS::DynamoDB::Table').map(([logicalId,r])=>({logicalId,tableName:r.Properties?.TableName,
  mode:r.Properties?.SSESpecification?.KMSMasterKeyId?'unsupported-customer-key':r.Properties?.SSESpecification?.SSEEnabled===true?'aws-managed-default':'aws-owned-default'})),
 access:{action:'kms:Decrypt',keyResource:lambdaEnvironmentAccess(s).keyResource,...dynamoDbEncryptionAccess(s)},
 evidence:'template-and-platform-definition',awsExecutionVerified:false,
 limitations:'AWS-owned encryption needs no caller KMS grant. AWS-managed DynamoDB table-key decryption is allowed only through DynamoDB in the assigned region, using alias/aws/dynamodb and the assigned account/table namespace encryption context. No direct KMS calls, customer keys, key administration, encryption, or grants are added. Installed boundaries require separately reviewed in-place migration. CREATE_COMPLETE is not runtime readiness.',
};}
