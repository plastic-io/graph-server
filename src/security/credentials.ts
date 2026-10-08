/** Defense in depth for accidental credential copies. Identity always comes from verified transport context. */
const credentialKey=/^(authorization|password|access_token|refresh_token|id_token|client_secret|secretAccessKey|sessionToken)$/i;
const credentialText=/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bBearer\s+[A-Za-z0-9_.~+\/-]{8,}=*/g;
export function redactCredentials(value:any):any {
 if(typeof value==='string')return value.replace(credentialText,'[credential redacted]');
 if(Array.isArray(value))return value.map(redactCredentials);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,credentialKey.test(k)&&v?'[credential redacted]':redactCredentials(v)]));
 return value;
}
export function assertCredentialFree(value:any){
 if(JSON.stringify(value)!==JSON.stringify(redactCredentials(value)))throw Object.assign(new Error('Credentials must not enter graph properties, edge payloads or application messages'),{code:'CREDENTIAL_CONTENT',status:400});
}
