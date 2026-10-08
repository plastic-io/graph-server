/** Compile the real Lambda entry point with each adapter and inspect its module graph. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const webpack = require('webpack');
const slsw = require('serverless-webpack');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-auth-builds-'));
const fixtures = {
  auth0: {AUTH_PROVIDER:'auth0', AUTH0_DOMAIN:'tenant.auth0.com', AUTH0_AUDIENCE:'graphs'},
  cognito: {AUTH_PROVIDER:'cognito', COGNITO_ISSUER:'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_Test',
    COGNITO_CLIENT_IDS:'browser', COGNITO_REQUIRED_SCOPES:'graphs/access', COGNITO_SCOPE_MAP:'{"graphs/read":"graph:read"}'},
};
async function run(name) {
  slsw.lib.serverless = {service: {provider: {environment: fixtures[name]}}};
  delete require.cache[require.resolve('../webpack.config.js')];
  const base = require('../webpack.config.js');
  const config = {...base, context: root, mode:'production', devtool:false,
    optimization: {minimize:false}, entry: {handler:path.join(root,'src/handler.ts'), oauth:path.join(root,'src/oauthHandler.ts'), iacWorker:path.join(root,'src/iacWorker.ts'), applicationBridge:path.join(root,'src/applicationWorker.ts')},
    output:{...base.output,path:path.join(output,name)},
  };
  const stats = await new Promise((resolve,reject) => {
    const compiler=webpack(config);
    compiler.run((err,stats) => compiler.close((closeError) => err || closeError ? reject(err || closeError) : resolve(stats)));
  });
  if (stats.hasErrors()) throw new Error(stats.toString({all:false,errors:true}));
  const data=stats.toJson({all:false,modules:true,nestedModules:true});
  const modules=[];
  const visit=(m) => {if(m.name) modules.push(m.name);for(const c of m.modules || []) visit(c);};
  for(const m of data.modules || []) visit(m);
  const wanted=`/auth/providers/${name}.ts`;
  const other=`/auth/providers/${name==='auth0'?'cognito':'auth0'}.ts`;
  if(!modules.some(m=>m.includes(wanted)) || modules.some(m=>m.includes(other))) throw new Error(`Provider isolation failed for ${name}`);
  if(name==='auth0' && modules.some(m=>m.includes('/auth/cognitoRegistration.ts'))) throw new Error('Cognito registration leaked into Auth0 bundle');
  fs.writeFileSync(path.join(output,name,'modules.json'),JSON.stringify(modules,null,2));
  const manifest=JSON.parse(fs.readFileSync(path.join(output,name,'auth-provider.json'),'utf8'));
  if(manifest.provider!==name) throw new Error('Incorrect provider manifest');
  console.log(`${name}: Lambda bundle verified (${modules.length} modules)`);
}
(async()=>{for(const name of Object.keys(fixtures)) await run(name); console.log(`Artifacts: ${output}`);})().catch(err=>{console.error(err);process.exitCode=1;});
