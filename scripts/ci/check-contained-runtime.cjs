// Verify the actual release archive, not a developer's node_modules directory.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const {verifyTemplate,verifyLayer}=require('../../build/contained-runtime.cjs');
const directory=path.resolve(process.argv[2]||'.serverless');
const root=JSON.parse(fs.readFileSync(path.join(directory,'cloudformation-template-update-stack.json')));
const functions=verifyTemplate(root);
const child=JSON.parse(fs.readFileSync(path.join(directory,'assistant-template.json')));
const bindings=root.Resources.AssistantNestedStack.Properties.Parameters;
for(const resource of Object.values(child.Resources))if(resource.Type==='AWS::Lambda::Function'){
 resource.Properties.Layers=resource.Properties.Layers?.map(layer=>bindings[layer.Ref]||layer);
}
functions.push(...verifyTemplate(child));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'graph-native-layer-'));
try{
 cp.execFileSync('unzip',['-q',path.join(directory,'isolatedVm.zip'),'-d',temporary]);
 const native=verifyLayer(temporary);
 const probe=`const assert=require('node:assert/strict');
 assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.versions.modules,'127');
 const resolved=require.resolve('isolated-vm');assert.ok(resolved.startsWith('/opt/nodejs/node_modules/'));
 const ivm=require('isolated-vm'),isolate=new ivm.Isolate({memoryLimit:32});
 try {const context=isolate.createContextSync();assert.equal(context.evalSync('1+1'),2);
 assert.equal(context.evalSync('[typeof require,typeof process,typeof fetch].join(",")'),'undefined,undefined,undefined');
 console.log(JSON.stringify({node:process.version,abi:process.versions.modules,platform:process.platform,architecture:process.arch,modulePath:resolved,contained:true}));}finally{isolate.dispose();}`;
 cp.execFileSync('docker',['run','--rm','--platform','linux/amd64','--entrypoint','/var/lang/bin/node','-e','NODE_PATH=/opt/nodejs/node_modules','-v',temporary+':/opt:ro','public.ecr.aws/lambda/nodejs:22','-e',probe],{stdio:'inherit'});
 console.log(JSON.stringify({checkedFunctions:functions.length,native,archive:path.basename(directory)+'/isolatedVm.zip'}));
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
