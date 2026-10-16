const fs=require('fs'),path=require('path'),YAML=require('yaml');
const {verifyTemplate,verifyLayer}=require('../../build/contained-runtime.cjs');
function compiled(){
 const source=YAML.parse(fs.readFileSync(path.join(__dirname,'../../serverless.yaml'),'utf8'),{customTags:[{tag:'!Ref',resolve:value=>({Ref:value})}],logLevel:'silent'});
 return {Resources:Object.fromEntries(Object.entries(source.functions).map(([name,fn])=>[name,{Type:'AWS::Lambda::Function',Properties:{Handler:fn.handler,Runtime:fn.runtime||source.provider.runtime,Architectures:[fn.architecture||source.provider.architecture||'x86_64'],Layers:fn.layers||source.provider.layers}}]))};
}
test('every shared handler, including editor readiness, inherits the native dependency',()=>{
 const template=compiled(),names=verifyTemplate(template);
 expect(names).toEqual(expect.arrayContaining(['iacReview','mcpRoute','mcpStream','taskWorker','edgeDeliver','assistantBridge','default','httpDefault','test','journey','journeyTick','revisionActivate','publish']));
 expect(template.Resources.iacReview.Properties.Layers).toContainEqual({Ref:'IsolatedVmLambdaLayer'});
});
test('the historical missing-layer route and incompatible native runtimes fail packaging',()=>{
 const template=compiled();template.Resources.iacReview.Properties.Layers=[];
 expect(()=>verifyTemplate(template)).toThrow('iacReview is missing');
 for(const change of [{Runtime:'nodejs20.x'},{Architectures:['arm64']}]){
  const wrong=compiled();Object.assign(wrong.Resources.mcpRoute.Properties,change);
  expect(()=>verifyTemplate(wrong)).toThrow('verified Linux x86_64 Node 22');
 }
});
test('a new shared-runtime route with an overriding layer list also fails closed',()=>{
 const template=compiled();template.Resources.newReadinessRoute={Type:'AWS::Lambda::Function',Properties:{Handler:'src/handler.newReadinessRoute',Runtime:'nodejs22.x',Layers:[{Ref:'ChromiumLambdaLayer'}]}};
 expect(()=>verifyTemplate(template)).toThrow('newReadinessRoute is missing');
 expect(()=>verifyTemplate({Resources:{}})).toThrow('No shared graph runtime');
});
test('layer layout validation rejects missing loaders and the wrong ELF architecture',()=>{
 const directory=fs.mkdtempSync(path.join(require('os').tmpdir(),'native-layout-')),modules=path.join(directory,'nodejs/node_modules'),base=path.join(modules,'isolated-vm');
 try{
  fs.mkdirSync(path.join(base,'prebuilds/linux-x64'),{recursive:true});fs.mkdirSync(path.join(modules,'node-gyp-build'));
  fs.writeFileSync(path.join(base,'package.json'),JSON.stringify({name:'isolated-vm',version:'6.2.0'}));
  fs.writeFileSync(path.join(base,'isolated-vm.js'),'loader');fs.writeFileSync(path.join(modules,'node-gyp-build/node-gyp-build.js'),'loader');
  const binary=Buffer.alloc(64);Buffer.from('7f454c460201','hex').copy(binary);binary.writeUInt16LE(62,18);
  const file=path.join(base,'prebuilds/linux-x64/isolated-vm.abi127.glibc.node');fs.writeFileSync(file,binary);
  expect(verifyLayer(directory)).toMatchObject({platform:'linux',architecture:'x64',nodeAbi:'127'});
  binary.writeUInt16LE(183,18);fs.writeFileSync(file,binary);expect(()=>verifyLayer(directory)).toThrow('Linux x86_64 ELF');
  fs.unlinkSync(path.join(modules,'node-gyp-build/node-gyp-build.js'));expect(()=>verifyLayer(directory)).toThrow();
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
