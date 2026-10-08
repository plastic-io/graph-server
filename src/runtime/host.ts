import OpenAI from "openai";
import { buildHostMembers as buildShared, HostContext, HostDeps as SharedHostDeps } from "@plastic-io/graph-crdt";

/**
 * The server's `host` binding (plan §4.5.2, PB-051).  The capability checks,
 * the observations and the audit calls are the shared implementation; what the
 * server adds is what only it can supply: an OpenAI client built from a secret
 * the node never sees.
 */
export type HostDeps = Omit<SharedHostDeps, "clients" | "domain"> & {application?:(request:any)=>Promise<any>};
export type { HostContext };

export function buildHostMembers(ctx: HostContext, deps: HostDeps): Record<string, any> {
    const members=buildShared(ctx, {
        ...deps,
        domain: "server",
        clients: { openai: (apiKey: string, options: any) => new OpenAI({ apiKey, ...options }) },
    });
    members.identity=()=>ctx.principal?{sub:ctx.principal.sub,kind:ctx.principal.kind,tenant:ctx.principal.tenant}:null;
    members.application={invoke:async(stackNodeId:string,logicalFunctionId:string,value:any)=>{
        const {assertCapability}=require('./capabilities');
        const address=stackNodeId+'/'+logicalFunctionId;
        try {assertCapability(ctx.effective,'application:invoke',address);}
        catch(error){ctx.recorder.effect('denied','application:invoke' as any,address,ctx.node.id,ctx.spanId,{reason:error.message},error.layer);throw error;}
        ctx.recorder.effect('allowed','application:invoke' as any,address,ctx.node.id,ctx.spanId);
        await deps.audit?.({kind:'effect',graphId:ctx.graphId,nodeId:ctx.node.id,executionId:ctx.recorder.options.executionId,capability:{kind:'application:invoke',scope:[address]},principal:members.identity()});
        if(!deps.application)throw new Error('Application invocation bridge is not configured');
        return deps.application({graphId:ctx.graphId,nodeId:ctx.node.id,stackNodeId,logicalFunctionId,value,principal:ctx.principal,executionId:ctx.recorder.options.executionId,correlationId:ctx.recorder.options.correlationId,revisionId:ctx.recorder.options.revisionId});
    }};
    return members;
}
