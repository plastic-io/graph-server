// Public deployment configuration shared by the workflow and its offline tests.
const fs = require('node:fs');
const {createHash} = require('node:crypto');
const {validate} = require('../../build/auth-provider.cjs');

function configuration(env) {
  const required = name => {
    if (!env[name]) throw new Error(`Set the GitHub environment variable ${name}`);
    return env[name];
  };
  const account = required('AWS_ACCOUNT_ID');
  if (!/^\d{12}$/.test(account)) throw new Error('AWS_ACCOUNT_ID must have 12 digits');
  const role = required('AWS_DEPLOY_ROLE_ARN');
  if (!role.startsWith(`arn:aws:iam::${account}:role/`)) throw new Error('Deployment role is in the wrong AWS account');
  const editor = required('EDITOR_REF');
  if (!/^[a-f0-9]{40}$/.test(editor)) throw new Error('EDITOR_REF must be a full commit SHA');
  const provider = env.AUTH_PROVIDER || 'auth0';
  if (!['auth0', 'cognito'].includes(provider)) throw new Error('Unknown AUTH_PROVIDER');
  const service = env.SERVICE_NAME || 'plastic-io-graph-server';
  const stage = env.STAGE || 'dev';
  const prefix = env.API_PREFIX || 'plastic';
  if (!/^[a-z][a-z0-9-]{2,39}$/.test(service)) throw new Error('SERVICE_NAME must be 3–40 lowercase letters, digits or hyphens, starting with a letter');
  for (const value of [stage, prefix]) if (!/^[a-z][a-z0-9-]{0,19}$/.test(value)) throw new Error('Invalid stage or API prefix');
  const managed = provider === 'cognito' || env.DEPLOY_EDITOR === 'true';
  if (provider === 'auth0') {
    validate({...env, AUTH_PROVIDER: provider});
    if (managed && !env.AUTH0_CLIENT_ID) throw new Error('AUTH0_CLIENT_ID is required to deploy the editor');
  }
  return {AUTH_PROVIDER: provider, SERVICE_NAME: service, STAGE: stage, API_PREFIX: prefix,
    EDITOR_REF: editor, DEPLOY_EDITOR: String(managed), AUTH_STACK_NAME: `${service}-auth`,
    // Cognito reserves words such as "cognito" and "aws" in prefix domains.
    COGNITO_DOMAIN_PREFIX: `graphs-${account}-${createHash('sha256').update(service).digest('hex').slice(0,12)}`};
}

function outputs(document) {
  if (document.Stacks?.length !== 1) throw new Error('Expected one deployment stack');
  const values = Object.fromEntries((document.Stacks[0].Outputs || []).map(o => [o.OutputKey, o.OutputValue]));
  return name => {
    if (!values[name]) throw new Error(`Missing stack output ${name}`);
    return values[name];
  };
}

function authEnvironment(document, provider) {
  const get = outputs(document);
  const editor = new URL(get('EditorUrl'));
  if (editor.protocol !== 'https:' || editor.pathname !== '/graph-editor/') throw new Error('Invalid editor URL');
  const common = {EDITOR_URL: editor.href, EDITOR_BUCKET: get('EditorBucket'), DISTRIBUTION_ID: get('DistributionId'),
    VIEW_ORIGINS: editor.origin, MCP_ALLOWED_ORIGINS: editor.origin};
  if (provider === 'auth0') return {...common, AUTH0_REDIRECT_URI: `${editor.href}auth-callback`};
  const cognito = {COGNITO_ISSUER: get('Issuer'), COGNITO_USER_POOL_ID: get('UserPoolId'),
    COGNITO_CLIENT_ID: get('ClientId'), COGNITO_CLIENT_IDS: get('ClientId'), COGNITO_MACHINE_CLIENT_IDS: '',
    COGNITO_REQUIRED_SCOPES: 'graphs/access', COGNITO_SCOPES: 'openid email profile graphs/access graphs/read graphs/propose',
    COGNITO_SCOPE_MAP: JSON.stringify({'graphs/read':'graph:read','graphs/propose':'graph:propose'}),
    COGNITO_LOGIN_DOMAIN: get('LoginDomain'), COGNITO_RESOURCE_AUDIENCE: '',
    COGNITO_REDIRECT_SIGN_IN: `${editor.href}auth-callback`, COGNITO_REDIRECT_SIGN_OUT: editor.href};
  validate({AUTH_PROVIDER: provider, ...cognito});
  if (!cognito.COGNITO_ISSUER.endsWith(`/${cognito.COGNITO_USER_POOL_ID}`)) throw new Error('User pool does not match issuer');
  return {...common, ...cognito};
}

function serverEnvironment(document) {
  const get = outputs(document);
  const http = new URL(get('GraphHttpUrl'));
  const ws = new URL(get('GraphWebSocketUrl'));
  if (http.protocol !== 'https:' || ws.protocol !== 'wss:') throw new Error('Deployment endpoints require TLS');
  return {GRAPH_HTTP_SERVER: http.href, GRAPH_WSS_SERVER: ws.href, MCP_STREAM_URL: get('McpStreamUrl'),
    REST_API_ID: get('GraphRestApiId'), WS_API_ID: get('GraphWebSocketApiId')};
}

function appendEnvironment(file, values) {
  const lines = Object.entries(values).map(([key,value]) => {
    if (/[\r\n]/.test(String(value))) throw new Error(`Multiline deployment value ${key}`);
    return `${key}=${value}\n`;
  });
  fs.appendFileSync(file, lines.join(''));
}

if (require.main === module) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Deployment configuration is prepared only by GitHub Actions');
  const [mode, input] = process.argv.slice(2);
  const document = input && JSON.parse(fs.readFileSync(input, 'utf8'));
  const values = mode === 'configure' ? configuration(process.env)
    : mode === 'auth' ? authEnvironment(document, process.env.AUTH_PROVIDER)
    : mode === 'server' ? serverEnvironment(document) : null;
  if (!values) throw new Error('Unknown configuration mode');
  appendEnvironment(process.env.GITHUB_ENV, values);
  if (mode === 'configure') appendEnvironment(process.env.GITHUB_OUTPUT, {editor_ref:values.EDITOR_REF, deploy_editor:values.DEPLOY_EDITOR});
}
module.exports = {configuration, authEnvironment, serverEnvironment, appendEnvironment};
