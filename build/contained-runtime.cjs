// Fail the normal package lifecycle if a shared-runtime route loses containment.
// Run before assistant-stack moves the private bridge into the nested template.
const fs=require('node:fs'),path=require('node:path');
function verifyTemplate(template){
 const routes=Object.entries(template.Resources||{}).filter(([,r])=>r.Type==='AWS::Lambda::Function'&&r.Properties?.Handler?.startsWith('src/handler.'));
 if(!routes.length)throw new Error('No shared graph runtime functions were compiled');
 for(const [name,r]of routes){
  const p=r.Properties;
  if(p.Runtime!=='nodejs22.x'||(p.Architectures||['x86_64']).join(',')!=='x86_64')throw new Error(name+' must match the verified Linux x86_64 Node 22 native layer');
  if(!p.Layers?.some(l=>l?.Ref==='IsolatedVmLambdaLayer'))throw new Error(name+' is missing the isolated-vm runtime layer');
 }
 return routes.map(([name])=>name);
}
function verifyLayer(directory){
 const modules=path.join(directory,'nodejs/node_modules'),base=path.join(modules,'isolated-vm');
 const pkg=JSON.parse(fs.readFileSync(path.join(base,'package.json'),'utf8'));
 if(pkg.version!=='6.2.0')throw new Error('Unexpected isolated-vm version: '+pkg.version);
 for(const file of [path.join(base,'isolated-vm.js'),path.join(modules,'node-gyp-build','node-gyp-build.js')])if(!fs.statSync(file).isFile())throw new Error('Missing native layer loader: '+file);
 const binary=fs.readFileSync(path.join(base,'prebuilds/linux-x64/isolated-vm.abi127.glibc.node'));
 if(binary.subarray(0,4).toString('hex')!=='7f454c46'||binary[4]!==2||binary[5]!==1||binary.readUInt16LE(18)!==62)throw new Error('isolated-vm must contain a Linux x86_64 ELF binary for Node 22 ABI 127');
 return {module:pkg.name,version:pkg.version,platform:'linux',architecture:'x64',nodeAbi:'127'};
}
class ContainedRuntime {
 constructor(serverless){this.serverless=serverless;this.hooks={'after:aws:package:finalize:mergeCustomProviderResources':()=>{
  const functions=verifyTemplate(serverless.service.provider.compiledCloudFormationTemplate);
  const native=verifyLayer(path.join(serverless.serviceDir,'layers/isolated-vm'));
  serverless.cli.log('Verified native containment layer for '+functions.length+' shared-runtime functions ('+native.platform+'/'+native.architecture+', ABI '+native.nodeAbi+').');
 }};}
}
module.exports=ContainedRuntime;module.exports.verifyTemplate=verifyTemplate;module.exports.verifyLayer=verifyLayer;
