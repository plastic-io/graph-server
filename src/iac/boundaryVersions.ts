/** IAM managed policies have five versions. Strict repair never removes one to
 * make room. Inventory is part of the recovery digest and rechecked before AWS
 * mutation; no account-wide enumeration or caller-selected policy is needed. */
export function boundaryVersions(result:any) {
 const versions=(result?.Versions||[]).map(v=>({id:v.VersionId,default:!!v.IsDefaultVersion})).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
 const complete=!!result&&!result.IsTruncated&&versions.length>0&&versions.length<=5&&versions.every(v=>/^v\d+$/.test(v.id))&&new Set(versions.map(v=>v.id)).size===versions.length&&versions.filter(v=>v.default).length===1;
 return {versions,complete,freeSlots:complete?5-versions.length:null};
}
export function boundaryVersionProblem(inventory:any,resource:string) {
 return !inventory?.complete||inventory.freeSlots<1?{
  code:'BOUNDARY_VERSION_CAPACITY',kind:'platform-maintenance',component:'RuntimeBoundary',resource,
  action:'iam:CreatePolicyVersion',message:'The approved boundary update requires a verified free IAM policy version slot. Strict recovery does not delete policy versions; a platform administrator must review version capacity separately.',
  verification:'Inspect the assigned boundary version inventory, separately review any policy-history maintenance, then prepare a fresh exact-digest recovery plan.',
 }:null;
}
