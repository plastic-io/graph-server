/** Absence is service evidence, never inferred from a denial, timeout or arbitrary prose. */
export function awsResourceAbsent(error:any,action:string):boolean {
 const code=String(error?.code||error?.name||'').split('#').pop();
 if(action.startsWith('iam:'))return code==='NoSuchEntity'||code==='NoSuchEntityException';
 if(action==='states:DescribeExecution')return code==='ExecutionDoesNotExist';
 if(action==='cloudformation:DescribeChangeSet'&&code==='ChangeSetNotFound')return true;
 if(code!=='ValidationError')return false;
 const message=String(error?.message||'');
 if(action==='cloudformation:DescribeStacks')return /^Stack (?:with id |\[)?.+does not exist\.?$/i.test(message);
 if(action==='cloudformation:DescribeChangeSet')return /^(?:Change ?set|Stack) (?:with id |\[)?.+does not exist\.?$/i.test(message);
 return false;
}
