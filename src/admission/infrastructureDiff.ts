import {DiffSummary} from '@plastic-io/graph-crdt';
/** The shared diff omitted IaC on added/removed nodes and only detected aws:cfn grants. */
export function includeInfrastructure(diff:DiffSummary,before:any,after:any):DiffSummary {
 const old=new Map((before?.nodes||[]).map((n:any)=>[n.id,n.properties?.iac]));
 const next=new Map((after?.nodes||[]).map((n:any)=>[n.id,n.properties?.iac]));
 const ids=[...new Set([...old.keys(),...next.keys()])];
 const wiringChanged=JSON.stringify((before?.nodes||[]).map((n:any)=>[n.id,n.edges]))!==JSON.stringify((after?.nodes||[]).map((n:any)=>[n.id,n.edges]));
 for(const id of ids){if(JSON.stringify(old.get(id))===JSON.stringify(next.get(id))&&!(wiringChanged&&(old.get(id)||next.get(id))))continue;
  diff.privilegeDelta.infrastructure=true;diff.empty=false;
  if(!diff.namespaces.includes('iac'))diff.namespaces.push('iac');
  if(!diff.ops.some(o=>o.namespace==='iac'&&o.nodeId===id))diff.ops.push({op:'set-iac-desired',namespace:'iac',nodeId:id as string});
 }diff.namespaces.sort();return diff;
}
