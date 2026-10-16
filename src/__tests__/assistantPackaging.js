const {split}=require('../../build/assistant-stack.cjs');
const crypto=require('crypto');
function fixture(){return {Conditions:{Configured:{'Fn::Equals':['true','true']}},Resources:{
 ServerlessDeploymentBucket:{Type:'AWS::S3::Bucket'},PlatformRole:{Type:'AWS::IAM::Role'},ConditionalRole:{Type:'AWS::IAM::Role',Condition:'Configured'},
 ChatLambdaFunction:{Type:'AWS::Lambda::Function'},AssistantQueue:{Type:'AWS::SQS::Queue',DeletionPolicy:'Retain'},
 AssistantWorkerLambdaFunction:{Type:'AWS::Lambda::Function',DependsOn:['PlatformRole'],Properties:{Code:{S3Bucket:{Ref:'ServerlessDeploymentBucket'},S3Key:'artifact/code.zip'},Role:{'Fn::GetAtt':['PlatformRole','Arn']},Environment:{Variables:{ROLE:{'Fn::If':['Configured',{'Fn::GetAtt':['ConditionalRole','Arn']},'']},QUEUE:{Ref:'AssistantQueue'}}}}},
 AssistantBridgeLambdaFunction:{Type:'AWS::Lambda::Function',Properties:{Role:{'Fn::GetAtt':['PlatformRole','Arn']}}},
 }};}
test('assistant moves into one retained stack, with scoped parameter bindings and no deleted resources',()=>{
 const root=fixture(),body=split(root,'artifact'),child=JSON.parse(body);
 expect(Object.keys(root.Resources).filter(k=>k.startsWith('Assistant'))).toEqual(['AssistantNestedStack']);
 expect(Object.keys(child.Resources)).toHaveLength(3);expect(child.Resources.AssistantWorkerLambdaFunction.Properties.Environment.Variables.QUEUE).toEqual({Ref:'AssistantQueue'});
 expect(root.Resources.AssistantNestedStack.DeletionPolicy).toBe('Retain');
 expect(root.Resources.AssistantNestedStack.Metadata.TemplateSha256).toBe(crypto.createHash('sha256').update(body).digest('hex'));
 expect(Object.values(root.Resources.AssistantNestedStack.Properties.Parameters)).toContainEqual({'Fn::If':['Configured',{'Fn::GetAtt':['ConditionalRole','Arn']},'']});
 expect(root.Resources.ChatLambdaFunction.DependsOn).toContain('AssistantNestedStack');
 expect(child.Resources.AssistantWorkerLambdaFunction.DependsOn).toBeUndefined();
});
test('remaining parent references and missing compiled workers fail closed',()=>{
 const root=fixture();root.Resources.Bad={Type:'AWS::IAM::Role',Properties:{Role:{Ref:'AssistantQueue'}}};expect(()=>split(root,'artifact')).toThrow('Parent still refers');
 const missing=fixture();delete missing.Resources.AssistantWorkerLambdaFunction;expect(()=>split(missing,'artifact')).toThrow('not compiled');
});
test('normal deploy uploads only the unchanged packaged assistant template',async()=>{
 const Plugin=require('../../build/assistant-stack.cjs'),fs=require('fs'),os=require('os'),path=require('path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-package-'));
 const request=jest.fn(),provider={getServerlessDeploymentBucketName:async()=> 'owned-bucket',request};
 const serverless={serviceDir:dir,getProvider:()=>provider,service:{provider:{compiledCloudFormationTemplate:fixture()},package:{artifactDirectoryName:'artifact'}}};
 try{const plugin=new Plugin(serverless,{package:dir});plugin.package();await plugin.upload();
  expect(request.mock.calls[0][0]).toBe('S3');expect(request.mock.calls[0][2]).toMatchObject({Bucket:'owned-bucket',Key:'artifact/assistant-template.json',ServerSideEncryption:'AES256'});
  fs.appendFileSync(path.join(dir,'assistant-template.json'),' ');await expect(plugin.upload()).rejects.toThrow('changed after packaging');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
