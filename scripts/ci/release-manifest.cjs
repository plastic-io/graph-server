const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {readFileSync, readdirSync} = require('node:fs');
const {join} = require('node:path');
const env = process.env;
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function files(dir, base = '') {
  return readdirSync(dir, {withFileTypes:true}).flatMap(entry => entry.isDirectory()
    ? files(join(dir, entry.name), join(base, entry.name))
    : [{path:join(base, entry.name), sha256:sha256(join(dir, entry.name))}]);
}
// Deliberate allow-list: never serialize all of process.env into a public asset.
const configuration = Object.fromEntries([
  'AUTH_PROVIDER', 'AWS_ACCOUNT_ID', 'AWS_REGION', 'SERVICE_NAME', 'STAGE',
  'GRAPH_HTTP_SERVER', 'GRAPH_WSS_SERVER', 'EDITOR_URL', 'MCP_STREAM_URL',
  'COGNITO_ISSUER', 'COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'COGNITO_LOGIN_DOMAIN',
  'COGNITO_SCOPES', 'COGNITO_REQUIRED_SCOPES', 'COGNITO_SCOPE_MAP',
  'AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_AUDIENCE',
  'IAC_REVIEW_ENABLED', 'IAC_STACK_ISOLATION',
].filter(key => env[key]).map(key => [key, env[key]]));
console.log(JSON.stringify({serverRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  editorRevision:execFileSync('git',['-C','../graph-editor','rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  run:env.GITHUB_RUN_ID, configuration,
  artifacts:{server:files(env.SERVER_PACKAGE_DIR || '.serverless'), ...(env.DEPLOY_EDITOR === 'true' ? {editor:files('../graph-editor/dist')} : {})},
}, null, 2));
