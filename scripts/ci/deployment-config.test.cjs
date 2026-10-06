const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtempSync, readFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {configuration, authEnvironment, serverEnvironment, appendEnvironment} = require('./deployment-config.cjs');
const stack = values => ({Stacks:[{Outputs:Object.entries(values).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}))}]});
const env = {AWS_ACCOUNT_ID:'230639770018',AWS_DEPLOY_ROLE_ARN:'arn:aws:iam::230639770018:role/graph-deploy',EDITOR_REF:'a'.repeat(40),
  AUTH0_DOMAIN:'tenant.auth0.com',AUTH0_AUDIENCE:'graphs'};
test('legacy deployments keep Auth0; Cognito requires managed editor configuration', () => {
  assert.equal(configuration(env).AUTH_PROVIDER, 'auth0');
  assert.equal(configuration(env).DEPLOY_EDITOR, 'false');
  assert.equal(configuration({...env,AUTH_PROVIDER:'cognito'}).DEPLOY_EDITOR, 'true');
  assert.throws(()=>configuration({...env,AUTH_PROVIDER:'other'}));
});
test('reject wrong AWS account, moving editor references, and incomplete Auth0 hosting', () => {
  assert.throws(()=>configuration({...env,AWS_ACCOUNT_ID:'123456789012'}), /wrong AWS account/);
  assert.throws(()=>configuration({...env,EDITOR_REF:'main'}), /full commit SHA/);
  assert.throws(()=>configuration({...env,DEPLOY_EDITOR:'true'}), /AUTH0_CLIENT_ID/);
});
test('one infrastructure output set configures both verifier and browser', () => {
  const config=authEnvironment(stack({EditorUrl:'https://editor.example/graph-editor/',EditorBucket:'bucket',DistributionId:'distribution',
    Issuer:'https://cognito-idp.us-west-1.amazonaws.com/us-west-1_Test',UserPoolId:'us-west-1_Test',ClientId:'browser',LoginDomain:'example.auth.us-west-1.amazoncognito.com'}), 'cognito');
  assert.equal(config.COGNITO_CLIENT_IDS, config.COGNITO_CLIENT_ID);
  assert.ok(config.COGNITO_SCOPES.split(' ').includes(config.COGNITO_REQUIRED_SCOPES));
  assert.equal(config.COGNITO_REDIRECT_SIGN_IN, 'https://editor.example/graph-editor/auth-callback');
  assert.equal(config.COGNITO_MACHINE_CLIENT_IDS, '');
  assert.equal(config.VIEW_ORIGINS, 'https://editor.example');
});
test('missing outputs and insecure endpoints fail the release', () => {
  assert.throws(()=>authEnvironment(stack({}), 'cognito'), /Missing stack output/);
  assert.throws(()=>serverEnvironment(stack({GraphHttpUrl:'http://example/',GraphWebSocketUrl:'wss://example/'})), /TLS/);
});
test('stack values cannot inject additional GitHub Actions environment variables', () => {
  const dir=mkdtempSync(join(tmpdir(),'deployment-config-'));const file=join(dir,'env');
  try {
    appendEnvironment(file,{COGNITO_SCOPE_MAP:'{"graphs/read":"graph:read"}'});
    assert.throws(()=>appendEnvironment(file,{EDITOR_URL:'https://example/\nAUTH_PROVIDER=other'}), /Multiline/);
    assert.equal(readFileSync(file,'utf8'), 'COGNITO_SCOPE_MAP={"graphs/read":"graph:read"}\n');
  } finally {rmSync(dir,{recursive:true});}
});
