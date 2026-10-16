/** Editor approval preferences never become agent delegations or graph policy. */
export function proposalAutomaticApproval(p:any,mode:'safe-actions'|'fully-automatic') {
 const deny=(reason:string)=>({allowed:false,reason});
 if(!p||!['validated','awaiting-review'].includes(p.state)||p.supersededBy||p.validation?.ok!==true||p.digestVersion!==2||!p.proposalDigest||!Number.isFinite(Date.parse(p.expiresAt))||Date.parse(p.expiresAt)<=Date.now())return deny('Only a current, validated, unexpired proposal can be approved automatically.');
 if(!Array.isArray(p.ops)||!p.ops.length)return deny('The proposal has no reviewed operations.');
 const allowed=['add-node','set-node-code','set-node-props','set-graph-props','connect','disconnect','set-component-pin','set-capabilities','set-placement','set-containment','set-iac-desired'];
 if(p.ops.some((o:any)=>!allowed.includes(o.op))||p.diffSummary?.nodesRemoved||p.diffSummary?.namespaces?.some((n:string)=>['policy','policy-autonomy','meta','observed','budgets'].includes(n)))return deny('Node removal, permission settings, budgets and platform-owned fields require manual review.');
 // Check complete operations, not a potentially truncated display summary.
 const graphKeys=['name','description','icon','width','height'];
 const nodeKeys=['name','description','icon','x','y','z','presentation','positionAbsolute'];
 if(p.ops.some((o:any)=>o.patch&&Object.keys(o.patch).some(k=>['autonomy','policy','acl','meta','budget','budgets'].includes(k))))return deny('AI Permissions cannot automatically approve changes to approval policy or security constraints.');
 if(mode==='safe-actions'&&p.ops.some((o:any)=>!['set-graph-props','set-node-props'].includes(o.op)||!o.patch||Object.keys(o.patch).some(k=>!(o.op==='set-graph-props'?graphKeys:nodeKeys).includes(k))))return deny('Safe Actions only approves names, descriptions and layout. Code, wiring, execution visibility and infrastructure definitions require manual review.');
 return {allowed:true,reason:'Requires a human editor session, the exact current proposal digest and normal admission checks. Graph acceptance does not approve infrastructure deployment.'};
}
export function proposalApprovalOptions(p:any){return {modes:{'safe-actions':proposalAutomaticApproval(p,'safe-actions'),'fully-automatic':proposalAutomaticApproval(p,'fully-automatic')}};}
