const {createRegistrationHandler, permittedRedirect, registeredMcpClient} = require('../auth/cognitoRegistration');
const config = {issuer:'https://cognito-idp.us-west-1.amazonaws.com/us-west-1_Test', userPoolId:'us-west-1_Test',
  loginDomain:'graphs.auth.us-west-1.amazoncognito.com', baseUrl:'https://api.example/test', table:'clients',
  scopes:['graphs/access','graphs/read','graphs/propose']};
const uri = 'https://chatgpt.com/connector/oauth/test_callback';
function fixture() {
  const records = new Map();
  const store = {
    get:jest.fn(async key=>records.get(key)),
    reserve:jest.fn(async key=>{if(records.has(key))return false;records.set(key,{status:'pending'});return true;}),
    complete:jest.fn(async (key,client)=>{records.set(key,{status:'active',client});records.set('client#'+client.client_id,{status:'active',client});}),
  };
  const cognito = {createUserPoolClient:jest.fn(()=>({promise:async()=>({UserPoolClient:{ClientId:'generated123'}})}))};
  const handler=createRegistrationHandler(config,store,cognito);
  const register=async data=>handler({httpMethod:'POST',resource:'/oauth/register',body:JSON.stringify(data)});
  return {records,store,cognito,handler,register};
}
test('advertises actual Cognito PKCE, public token exchange, and automatic registration', async()=>{
  const f=fixture();
  for(const path of ['/.well-known/oauth-authorization-server','/.well-known/openid-configuration']){
    const r=await f.handler({httpMethod:'GET',resource:path});
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({issuer:config.baseUrl,code_challenge_methods_supported:['S256'],
      token_endpoint_auth_methods_supported:['none'],registration_endpoint:config.baseUrl+'/oauth/register',
      authorization_endpoint:'https://'+config.loginDomain+'/oauth2/authorize',
      token_endpoint:'https://'+config.loginDomain+'/oauth2/token',authorization_response_iss_parameter_supported:false});
  }
  expect(f.cognito.createUserPoolClient).not.toHaveBeenCalled();
});
test.each([
  uri,'https://chatgpt.com/connector_platform_oauth_redirect','http://127.0.0.1:1455/callback',
  'http://127.0.0.1:1455/callback/connection_123','http://localhost:8080/callback','http://[::1]:8123/callback',
])('allows exact supported callback %s', value=>expect(permittedRedirect(value)).toBe(true));
test.each([
  'https://chatgpt.com.evil.example/connector/oauth/test','https://evil.example/callback',
  'https://chatgpt.com@evil.example/connector/oauth/test','https://user@chatgpt.com/connector/oauth/test',
  'https://chatgpt.com/connector/oauth/test#fragment','https://chatgpt.com/connector/oauth/test?redirect=https://evil.example',
  'https://chatgpt.com/redirect','https://chatgpt.com/connector/oauth/*','http://chatgpt.com/connector/oauth/test',
  'http://169.254.169.254/callback','javascript:alert(1)','http://127.0.0.1.evil.example/callback',
])('rejects untrusted or ambiguous callback %s', value=>expect(permittedRedirect(value)).toBe(false));
test('registers and reuses a public code-only client without passwords, tokens, secrets, or user creation', async()=>{
  const f=fixture();
  const first=await f.register({redirect_uris:[uri],token_endpoint_auth_method:'none'});
  const second=await f.register({redirect_uris:[uri],client_name:'Different untrusted name'});
  expect(first.statusCode).toBe(201);expect(second.body).toBe(first.body);
  expect(JSON.parse(first.body)).toMatchObject({client_id:'generated123',redirect_uris:[uri],token_endpoint_auth_method:'none'});
  expect(first.body).not.toMatch(/client_secret|password|refresh_token"\s*:/);
  expect(f.cognito.createUserPoolClient).toHaveBeenCalledTimes(1);
  expect(f.cognito.createUserPoolClient).toHaveBeenCalledWith(expect.objectContaining({
    UserPoolId:config.userPoolId,GenerateSecret:false,AllowedOAuthFlows:['code'],
    ExplicitAuthFlows:['ALLOW_REFRESH_TOKEN_AUTH'],CallbackURLs:[uri],
    AllowedOAuthScopes:['graphs/access','graphs/propose','graphs/read'],
  }));
  expect(await registeredMcpClient('generated123',config,f.store)).toMatchObject({resource:config.baseUrl+'/mcp'});
  expect(await registeredMcpClient('unknown',config,f.store)).toBeUndefined();
});
test.each([
  {redirect_uris:['https://evil.example/callback']},{redirect_uris:[]},{redirect_uris:[uri],token_endpoint_auth_method:'client_secret_basic'},
  {redirect_uris:[uri],grant_types:['client_credentials']},{redirect_uris:[uri],response_types:['token']},
  {redirect_uris:[uri],scope:'aws.cognito.signin.user.admin'},{redirect_uris:[uri],scope:[]},
])('rejects invalid registration before any AWS mutation: %j', async input=>{
  const f=fixture();const r=await f.register(input);expect(r.statusCode).toBe(400);
  expect(f.store.reserve).not.toHaveBeenCalled();expect(f.cognito.createUserPoolClient).not.toHaveBeenCalled();
});
test('concurrent registration is bounded and retry resolves the same persisted client', async()=>{
  const f=fixture();const results=await Promise.all([f.register({redirect_uris:[uri]}),f.register({redirect_uris:[uri]})]);
  expect(results.map(r=>r.statusCode)).toContain(201);expect(f.cognito.createUserPoolClient).toHaveBeenCalledTimes(1);
  expect((await f.register({redirect_uris:[uri]})).statusCode).toBe(201);
  f.store.reserve.mockResolvedValue(false);
  expect((await f.register({redirect_uris:[uri+'2']})).statusCode).toBe(429);
});
test('disabled, foreign, incomplete, or revoked registry entries never become accepted clients', async()=>{
  const f=fixture();await f.register({redirect_uris:[uri]});
  const row=f.records.get('client#generated123');
  for(const change of [{status:'pending'},{client:{...row.client,issuer:'foreign'}},{client:{...row.client,resource:'https://another-api'}}]){
    f.records.set('client#generated123',{...row,...change});expect(await registeredMcpClient('generated123',config,f.store)).toBeUndefined();
  }
});
test('malformed requests and unexpected paths do not expose implementation details', async()=>{
  const f=fixture();
  expect((await f.handler({httpMethod:'POST',resource:'/oauth/register',body:'{'})).statusCode).toBe(400);
  expect((await f.handler({httpMethod:'POST',resource:'/oauth/register',body:'x'.repeat(8193)})).statusCode).toBe(413);
  expect((await f.handler({httpMethod:'GET',resource:'/graphs'})).statusCode).toBe(404);
  f.cognito.createUserPoolClient.mockImplementation(()=>{throw new Error('private AWS failure');});
  const r=await f.register({redirect_uris:[uri]});expect(r.statusCode).toBe(503);expect(r.body).not.toContain('AWS');
});
