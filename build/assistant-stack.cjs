// Package/upload through the normal Serverless lifecycle; no stack-preparation
// command. The existing platform is already close to CF's 500-resource limit.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const FILE='assistant-template.json';
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
function split(template, artifactDirectory) {
  const names=Object.keys(template.Resources).filter(k=>k.startsWith('Assistant'));
  if (!names.includes('AssistantWorkerLambdaFunction') || !names.includes('AssistantBridgeLambdaFunction')) throw new Error('Assistant Lambda resources were not compiled');
  const selected=new Set(names),parameters={},forward={},dependencies=new Set(),known=new Map();
  const child={AWSTemplateFormatVersion:'2010-09-09',Description:'Private Bedrock graph assistant; owned and released by the graph platform.',Parameters:parameters,Conditions:template.Conditions||{},Resources:{}};
  const lift=expression=>{
    const key=JSON.stringify(expression);let name=known.get(key);
    if(!name){name='PlatformValue'+known.size;known.set(key,name);parameters[name]={Type:'String',Default:''};
      const resource=expression.Ref||expression['Fn::GetAtt']?.[0];
      const condition=template.Resources[resource]?.Condition;
      forward[name]=condition?{'Fn::If':[condition,expression,'']}:expression;
    }
    return {Ref:name};
  };
  const visit=value=>{
    if(Array.isArray(value))return value.map(visit);
    if(!value||typeof value!=='object')return value;
    if(value.Ref&&!selected.has(value.Ref)&&!value.Ref.startsWith('AWS::'))return lift(value);
    if(value['Fn::GetAtt']){
      const pair=Array.isArray(value['Fn::GetAtt'])?value['Fn::GetAtt']:value['Fn::GetAtt'].split('.');
      if(!selected.has(pair[0]))return lift({'Fn::GetAtt':pair});
    }
    if(value['Fn::Sub']){
      const input=value['Fn::Sub'],text=Array.isArray(input)?input[0]:input,vars=Array.isArray(input)?input[1]:{};
      const rewritten=text.replace(/\$\{([A-Za-z0-9]+)(?:\.([A-Za-z0-9.]+))?\}/g,(whole,id,attr)=>{
        if(vars[id]||selected.has(id)||(!template.Resources[id]&&!template.Parameters?.[id]))return whole;
        return '${'+lift(attr?{'Fn::GetAtt':[id,attr]}:{Ref:id}).Ref+'}';
      });
      return {'Fn::Sub':Array.isArray(input)?[rewritten,visit(vars)]:rewritten};
    }
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,visit(v)]));
  };
  for(const name of names){
    const resource=JSON.parse(JSON.stringify(template.Resources[name]));
    if(resource.DependsOn){const deps=[].concat(resource.DependsOn);deps.filter(d=>!selected.has(d)).forEach(d=>dependencies.add(d));const local=deps.filter(d=>selected.has(d));if(local.length)resource.DependsOn=local;else delete resource.DependsOn;}
    child.Resources[name]=visit(resource);delete template.Resources[name];
  }
  // Refuse a new parent/child dependency cycle instead of hiding it.
  const remaining=JSON.stringify({Resources:template.Resources,Outputs:template.Outputs});
  for(const name of names)if(remaining.includes('"Ref":"'+name+'"')||remaining.includes('"Fn::GetAtt":["'+name+'"')||remaining.includes('${'+name))throw new Error('Parent still refers to assistant resource '+name);
  const body=JSON.stringify(child),key=artifactDirectory+'/'+FILE;
  const bucket=child.Resources.AssistantWorkerLambdaFunction.Properties.Code.S3Bucket;
  const parentBucket=bucket.Ref&&forward[bucket.Ref]?forward[bucket.Ref]:bucket;
  template.Resources.AssistantNestedStack={Type:'AWS::CloudFormation::Stack',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',
    Metadata:{TemplateSha256:hash(body),ArtifactKey:key},
    ...(dependencies.size?{DependsOn:[...dependencies]}:{}),Properties:{
      TemplateURL:{'Fn::Join':['',['https://s3.',{Ref:'AWS::Region'},'.',{Ref:'AWS::URLSuffix'},'/',parentBucket,'/',key]]},
      Parameters:forward,TimeoutInMinutes:20}};
  for(const name of ['ChatLambdaFunction','McpRouteLambdaFunction'])if(template.Resources[name]){
    template.Resources[name].DependsOn=[...new Set([].concat(template.Resources[name].DependsOn||[],'AssistantNestedStack'))];
  }
  if(Object.keys(template.Resources).length>500)throw new Error('Platform template still exceeds the 500-resource limit');
  return body;
}
class AssistantStack {
  constructor(serverless,options){this.serverless=serverless;this.options=options;this.provider=serverless.getProvider('aws');
    this.hooks={
      'after:aws:package:finalize:mergeCustomProviderResources':()=>this.package(),
      'after:aws:deploy:deploy:uploadArtifacts':()=>this.upload(),
    };
  }
  package(){
    const body=split(this.serverless.service.provider.compiledCloudFormationTemplate,this.serverless.service.package.artifactDirectoryName);
    const dir=this.options.package||this.serverless.service.package.path||path.join(this.serverless.serviceDir,'.serverless');
    fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,FILE),body);
  }
  async upload(){
    if(this.serverless.service.provider.shouldNotDeploy)return;
    const stack=this.serverless.service.provider.compiledCloudFormationTemplate.Resources.AssistantNestedStack;
    if(!stack)throw new Error('Packaged assistant nested stack is missing');
    const dir=this.options.package||this.serverless.service.package.path||path.join(this.serverless.serviceDir,'.serverless');
    const body=fs.readFileSync(path.join(dir,FILE));
    if(hash(body)!==stack.Metadata.TemplateSha256)throw new Error('Assistant template changed after packaging');
    const bucket=await this.provider.getServerlessDeploymentBucketName();
    await this.provider.request('S3','putObject',{Bucket:bucket,Key:stack.Metadata.ArtifactKey,Body:body,ContentType:'application/json',ServerSideEncryption:'AES256'});
  }
}
module.exports=AssistantStack;
module.exports.split=split;
