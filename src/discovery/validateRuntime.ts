import {runtimeContract} from './runtime';
const acorn=require('acorn');
const scope=require('eslint-scope');
const globals=new Set('undefined NaN Infinity JSON Math Date Promise Array Object String Number Boolean BigInt Symbol Map Set WeakMap WeakSet RegExp Error TypeError RangeError SyntaxError Intl Uint8Array ArrayBuffer TextEncoder TextDecoder URL URLSearchParams parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI setTimeout clearTimeout console'.split(' '));
const unavailableInIsolate=new Set(['TextEncoder','TextDecoder','URL','URLSearchParams','setTimeout','clearTimeout']);
export function validateRuntime(graph:any,touched:string[]):any[] {
 const errors:any[]=[];
 for(const node of graph?.nodes||[]){
  if(!touched.includes(node.id)||!node.template?.set)continue;
  const domain=node.properties?.placement==='browser'?'browser':'server';
  const contained=domain==='server'&&(process.env.REQUIRE_CONTAINMENT==='true'||node.properties?.containment==='isolate');
  const source='async function __node('+runtimeContract.parameters.join(',')+'){\n'+node.template.set+'\n}';
  try{
   const ast=acorn.parse(source,{ecmaVersion:2022,ranges:true,locations:true});
   const analysis=scope.analyze(ast,{ecmaVersion:2022,sourceType:'script',optimistic:true,ignoreEval:true});
   for(const ref of analysis.globalScope.through){
    const name=ref.identifier.name;
    if(!globals.has(name)||(contained&&unavailableInIsolate.has(name)))errors.push({code:'UNSUPPORTED_HELPER',nodeId:node.id,field:'template.set',line:ref.identifier.loc.start.line-1,message:`${name} is not provided by this ${contained?'isolated ':''}runtime.`,schemaUri:runtimeContract.uri});
   }
   const visit=(n:any)=>{
    if(!n||typeof n!=='object')return;
    if(n.type==='CallExpression'){
     if(contained && n.callee.type==='Identifier' && ['require','eval','Function'].includes(n.callee.name))errors.push({code:'UNSUPPORTED_HELPER',nodeId:node.id,field:'template.set',line:n.loc.start.line-1,message:`${n.callee.name} is unavailable in server isolate execution.`,schemaUri:runtimeContract.uri});
     const parts:string[]=[];let c=n.callee;
     while(c?.type==='MemberExpression'&&!c.computed){parts.unshift(c.property.name);c=c.object;}
     if(c?.name==='host'){
      const name='host.'+parts.join('.');const helper=runtimeContract.helpers.find(h=>h.name===name);
      if(!helper||!helper[domain]||(contained&&!helper.contained))errors.push({code:'UNSUPPORTED_HELPER',nodeId:node.id,field:'template.set',line:n.loc.start.line-1,message:`${name} is unavailable in ${domain}${contained?' isolate':''} execution.`,schemaUri:runtimeContract.uri});
     }
     const factory=n.callee?.object;
     if(contained&&n.callee?.property?.name==='openai'&&factory?.type==='CallExpression'&&factory.callee?.object?.name==='host'&&factory.callee?.property?.name==='secret')errors.push({code:'UNSUPPORTED_HELPER',nodeId:node.id,field:'template.set',line:n.loc.start.line-1,message:'host.secret(...).openai() is unavailable in an isolate. Use scoped host.fetch and header().',schemaUri:runtimeContract.uri});
    }
    for(const k of Object.keys(n)){if(k==='loc'||k==='range')continue;const v=n[k];if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object')visit(v);}
   };visit(ast);
  }catch(e){errors.push({code:'INVALID_NODE_CODE',nodeId:node.id,field:'template.set',message:e.message,schemaUri:runtimeContract.uri});}
 }
 return errors.filter((e,i,a)=>a.findIndex(x=>x.nodeId===e.nodeId&&x.message===e.message)===i);
}
