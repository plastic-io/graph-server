import * as z from 'zod/v4';

export const CONTRACT_VERSION = '1.0.0';
export const SCHEMA_URI = 'plastic://schema/1/operations';
const id=z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const json=z.record(z.string(),z.any());
const port=z.object({name:z.string().min(1).max(128),type:z.string().optional(),external:z.boolean().optional(),visible:z.boolean().optional(),schema:json.optional(),description:z.string().optional(),capture:z.enum(['none','meta','full']).optional(),redaction:z.enum(['none','hash','secret']).optional()}).strict();
const position=z.object({x:z.number().optional(),y:z.number().optional(),z:z.number().optional(),sort:z.number().optional()}).strict();
const capability=z.union([z.string(),z.object({kind:z.string(),scope:z.array(z.string()),optional:z.boolean().optional()}).strict()]);
export const nodeProperties=z.object({name:z.string().optional(),description:z.string().optional(),icon:z.string().optional(),tags:z.array(z.string()).optional(),inputs:z.array(port).optional(),outputs:z.array(port).optional(),x:z.number().optional(),y:z.number().optional(),z:z.number().optional(),presentation:position.optional(),appearsInPresentation:z.boolean().optional(),runInBackground:z.boolean().optional(),appearsInExport:z.boolean().optional(),positionAbsolute:z.boolean().optional()}).passthrough();
export const graphProperties=z.object({name:z.string().optional(),description:z.string().optional(),icon:z.string().optional(),width:z.number().optional(),height:z.number().optional(),contractMode:z.enum(['warn','reject']).optional()}).passthrough();
const budget=z.object({wallMs:z.number().positive().optional(),hops:z.number().int().positive().optional(),fanOut:z.number().int().positive().optional(),depth:z.number().int().positive().optional()}).strict();
export const iacConfiguration=z.object({
 schemaVersion:z.literal(1).optional(),
 stack:z.object({name:z.string(),account:z.string().regex(/^\d{12}$/),region:z.string(),environment:z.enum(['dev','staging','prod'])}).strict().optional(),
 template:z.object({text:z.string(),format:z.enum(['yaml','json'])}).strict().optional(),
 parameters:z.record(z.string(),z.string()).optional(),capabilities:z.array(z.enum(['CAPABILITY_IAM','CAPABILITY_NAMED_IAM'])).optional(),
 outputs:json.optional(),templateParameters:json.optional(),
 readiness:z.array(z.object({id,nodeUrl:z.string().min(1).max(200),field:z.string().optional(),value:z.any().optional(),description:z.string().max(1000).optional()}).strict()).max(8).optional(),
 resource:z.object({logicalId:z.string().regex(/^[A-Za-z0-9]{1,255}$/).optional(),type:z.string(),properties:json,dependsOn:z.array(z.string()).optional(),deletionPolicy:z.enum(['Delete','Retain','RetainExceptOnCreate','Snapshot']).optional(),updateReplacePolicy:z.enum(['Delete','Retain','Snapshot']).optional(),condition:z.string().optional(),metadata:json.optional()}).strict().optional(),
}).strict();
const shapes:any={
 'add-node':{node:z.object({id,url:z.string().min(1).max(256),name:z.string().optional(),inputs:z.array(port).optional(),outputs:z.array(port).optional(),placement:z.enum(['browser','server','portable']).optional(),template:z.object({set:z.string().optional(),vue:z.string().optional()}).strict().optional(),layout:position.optional()}).strict()},
 'remove-node':{nodeId:id},
 'set-node-code':{nodeId:id,template:z.enum(['set','vue']),text:z.string()},
 'set-node-props':{nodeId:id,patch:nodeProperties},
 'set-graph-props':{patch:graphProperties},
 'connect':{from:z.object({nodeId:id,field:z.string()}).strict(),to:z.object({nodeId:id,field:z.string(),graphId:id.optional()}).strict()},
 'disconnect':{connectorId:z.string()},
 'set-component-pin':{nodeId:id,pin:z.object({publishedId:id,version:z.number().int().nonnegative(),digest:z.string().optional()}).strict()},
 'set-capabilities':{nodeId:id,granted:z.array(capability)},
 'set-placement':{nodeId:id,placement:z.enum(['browser','server','portable'])},
 'set-containment':{nodeId:id,containment:z.enum(['worker','isolate'])},
 'set-budget':{nodeId:id.optional(),budget},
 'set-iac-desired':{nodeId:id,desired:iacConfiguration},
};
export const operationSchemas=Object.fromEntries(Object.entries(shapes).map(([op,shape])=>[op,z.object({op:z.literal(op),...(shape as any)}).strict()]));
export const operationSchema=z.discriminatedUnion('op',Object.values(operationSchemas) as any);
export const operationsSchema=z.array(operationSchema).min(1).max(500);
export function validateOperations(ops:any): any[] {
 if(!Array.isArray(ops)||!ops.length||ops.length>500)return [{path:'ops',message:'Supply 1–500 semantic operations.',schemaUri:SCHEMA_URI}];
 const errors:any[]=[];
 ops.forEach((op,index)=>{
  const schema=operationSchemas[op?.op];
  if(!schema){errors.push({index,path:`ops[${index}].op`,message:`Unknown operation ${String(op?.op)}.`,supported:Object.keys(shapes),schemaUri:SCHEMA_URI});return;}
  const result=schema.safeParse(op);
  if(!result.success)result.error.issues.forEach(e=>errors.push({index,path:`ops[${index}].${e.path.join('.')}`,message:e.message,schemaUri:SCHEMA_URI}));
  const protectedKeys=op.op==='set-node-props'?['component','capabilities','placement','containment','budget','budgets','iac','tests']:op.op==='set-graph-props'?['id','policy','meta']:[];
  Object.keys(op.patch||{}).filter(k=>protectedKeys.includes(k)).forEach(k=>errors.push({index,path:`ops[${index}].patch.${k}`,message:`${k} requires its dedicated operation or platform administration.`,schemaUri:SCHEMA_URI}));
 });return errors;
}
export const operationCatalogue={version:CONTRACT_VERSION,uri:SCHEMA_URI,schema:z.toJSONSchema(operationsSchema),properties:{node:z.toJSONSchema(nodeProperties),graph:z.toJSONSchema(graphProperties),infrastructure:z.toJSONSchema(iacConfiguration)},notes:['Property patches merge top-level keys; a nested value such as presentation replaces that whole value.','Custom application properties are permitted; protected placement, capabilities and iac fields use dedicated operations.','set-iac-desired.desired is the node properties.iac configuration, not a host.deploy request.','All operations in a proposal form one transaction.'],examples:{rename:[{op:'set-graph-props',patch:{name:'Chess'}}],add:[{op:'add-node',node:{id:'request',url:'request',name:'Request',placement:'browser',inputs:[{name:'in'}],outputs:[{name:'out'}],layout:{x:160,y:160}}}],connect:[{op:'connect',from:{nodeId:'request',field:'out'},to:{nodeId:'backend',field:'request'}}],presentation:[{op:'set-node-props',nodeId:'listener',patch:{appearsInPresentation:false,runInBackground:true}}],stack:[{op:'set-iac-desired',nodeId:'stack',desired:{stack:{name:'<preflight.namespace>stack',account:'<preflight.target.account>',region:'<preflight.target.region>',environment:'dev'},template:{format:'yaml',text:'<template using preflight namespace and permissions boundary>'},capabilities:['CAPABILITY_NAMED_IAM']}}]}};
