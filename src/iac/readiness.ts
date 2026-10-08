import {assertCredentialFree} from '../security/credentials';
export function readinessProblems(value:any) {
 if(value===undefined)return [];
 const problems:any[]=[];
 const bad=(message:string)=>problems.push({code:'READINESS_INVALID',path:'iac.readiness',message});
 if(!Array.isArray(value)||value.length>8){bad('Declare at most eight readiness checks.');return problems;}
 const ids=new Set();
 for(const c of value){
  if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['id','nodeUrl','field','value','description'].includes(k))||!/^[A-Za-z0-9_.-]{1,64}$/.test(c.id||'')||typeof c.nodeUrl!=='string'||!c.nodeUrl.length||c.nodeUrl.length>200||c.field!==undefined&&typeof c.field!=='string') {bad('Each check requires id and nodeUrl, with optional field, value and description.');continue;}
  if(ids.has(c.id))bad('Readiness check IDs must be unique.');ids.add(c.id);
  if(Buffer.byteLength(JSON.stringify(c))>4000)bad('Each readiness declaration is limited to 4 KB.');
  try{assertCredentialFree(c);}catch{bad('Readiness declarations must not contain credentials.');}
 }
 return problems;
}
