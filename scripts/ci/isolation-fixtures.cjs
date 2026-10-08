/** Offline fixtures only. No credentials, CloudFormation calls or deployment side effects. */
const fs=require('node:fs');
const path=require('node:path');
const {stackScope}=require('../../src/iac/isolation');
const {DEFAULT_POLICY}=require('../../src/iac/types');
const {guardrailTemplate}=require('../../src/iac/guardrails');
const {authenticatedApplicationExample}=require('../../src/discovery/example');
const directory=process.argv[2];
if(!directory)throw new Error('Supply the CI temporary fixture directory');
fs.mkdirSync(directory,{recursive:true});
const scope=stackScope('ci-graph','stack',{...DEFAULT_POLICY,accounts:['123456789012'],regions:['us-west-1']});
fs.writeFileSync(path.join(directory,'guardrails.json'),JSON.stringify(guardrailTemplate(scope,'arn:aws:iam::123456789012:role/platform-worker'),null,2));
fs.writeFileSync(path.join(directory,'application.json'),authenticatedApplicationExample(scope).configuration.template.text);
