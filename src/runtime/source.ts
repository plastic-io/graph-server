/** Attribute execution only to a revision whose content actually matches the loaded graph. */
export async function executionRevision(graph:any,revisions:any):Promise<string>{
 const head=await revisions.head(graph.id);
 if(!head)return 'live';
 const snapshot=await revisions.projection(graph.id,head.revisionId);
 const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
 return canonical(graph)===canonical(snapshot)?head.revisionId:'live';
}
