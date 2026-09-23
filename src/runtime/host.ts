import OpenAI from "openai";
import { buildHostMembers as buildShared, HostContext, HostDeps as SharedHostDeps } from "@plastic-io/graph-crdt";

/**
 * The server's `host` binding (plan §4.5.2, PB-051).  The capability checks,
 * the observations and the audit calls are the shared implementation; what the
 * server adds is what only it can supply: an OpenAI client built from a secret
 * the node never sees.
 */
export type HostDeps = Omit<SharedHostDeps, "clients" | "domain"> & {
    /**
     * CloudFormation, for a node holding `aws:cfn` (D-41).  Declared here as
     * well as in the shared package because the server ships ahead of it: the
     * member appears in node scope when the published `@plastic-io/graph-crdt`
     * carries it, and until then this dep is simply unused.
     */
    deploy?: (request: any) => Promise<any>;
};
export type { HostContext };

export function buildHostMembers(ctx: HostContext, deps: HostDeps): Record<string, any> {
    return buildShared(ctx, {
        ...deps,
        domain: "server",
        clients: { openai: (apiKey: string, options: any) => new OpenAI({ apiKey, ...options }) },
    });
}
