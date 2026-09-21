import OpenAI from "openai";
import { EffectiveCapabilities, assertCapability, CapabilityDenied, PRIVILEGED_KINDS } from "./capabilities";
import { ObservationRecorder } from "./observe";

/**
 * The server `host` binding (plan §4.5.2, PB-051): the only way node code
 * reaches the outside world once isolates remove ambient authority.  Every
 * call is checked against the effective capabilities and observed; refused
 * calls are observed too and, for privileged kinds, audited.
 */
export interface HostDeps {
    fetchImpl?: typeof fetch;
    /** Resolve a secret reference (`openai`) to its value; only refs in scope reach it. */
    secrets?: (ref: string) => Promise<string>;
    kv?: { get(key: string): Promise<any>; put(key: string, value: any): Promise<void>; del(key: string): Promise<void> };
    audit?: (record: any) => Promise<void>;
}

export interface HostContext {
    graphId: string;
    node: any;
    spanId?: string;
    signal?: AbortSignal;
    effective: EffectiveCapabilities;
    recorder: ObservationRecorder;
    principal: { sub: string; kind: string; tenant: string } | null;
}

export function buildHostMembers(ctx: HostContext, deps: HostDeps): Record<string, any> {
    const nodeId = ctx.node && ctx.node.id;
    const guard = async (kind: string, scope: string, extra: any = {}) => {
        try {
            assertCapability(ctx.effective, kind, scope);
        } catch (err) {
            if (err instanceof CapabilityDenied) {
                ctx.recorder.effect("denied", kind, scope, nodeId, ctx.spanId, { reason: err.message }, err.layer);
                if (deps.audit && PRIVILEGED_KINDS.includes(kind)) {
                    await deps.audit({ kind: "effect.denied", at: new Date().toISOString(), graphId: ctx.graphId, nodeId, executionId: ctx.recorder.options.executionId, capability: { kind, scope: [scope] }, principal: ctx.principal, layer: err.layer });
                }
            }
            throw err;
        }
        ctx.recorder.effect("allowed", kind, scope, nodeId, ctx.spanId, extra);
        if (deps.audit && PRIVILEGED_KINDS.includes(kind)) {
            await deps.audit({ kind: "effect", at: new Date().toISOString(), graphId: ctx.graphId, nodeId, executionId: ctx.recorder.options.executionId, capability: { kind, scope: [scope] }, principal: ctx.principal });
        }
    };
    const fetchImpl = deps.fetchImpl || (typeof fetch === "function" ? fetch : undefined);
    return {
        /** HTTPS only, to hosts in the `net:https` scope. */
        async fetch(url: string, init: any = {}) {
            const parsed = new URL(String(url));
            if (parsed.protocol !== "https:") {
                throw new CapabilityDenied("net:https", parsed.hostname, "protocol");
            }
            await guard("net:https", parsed.hostname, { method: (init && init.method) || "GET" });
            if (!fetchImpl) throw new Error("fetch is not available in this runtime");
            return fetchImpl(parsed.href, { ...init, signal: init.signal || ctx.signal });
        },
        /** A small key-value store scoped by `storage:kv` prefixes, kept per graph. */
        kv: {
            async get(key: string) { await guard("storage:kv", String(key)); return deps.kv ? deps.kv.get(`${ctx.graphId}/${key}`) : undefined; },
            async put(key: string, value: any) { await guard("storage:kv", String(key), { bytes: Buffer.byteLength(JSON.stringify(value === undefined ? null : value)) }); if (deps.kv) await deps.kv.put(`${ctx.graphId}/${key}`, value); },
            async del(key: string) { await guard("storage:kv", String(key)); if (deps.kv) await deps.kv.del(`${ctx.graphId}/${key}`); },
        },
        /** A secret reference resolves to a client, never to the value. */
        secret(ref: string) {
            const name = String(ref);
            return {
                async openai(options: any = {}) {
                    await guard("secret", name, { client: "openai" });
                    if (!deps.secrets) throw new Error("secrets are not available in this runtime");
                    const apiKey = await deps.secrets(name);
                    return new OpenAI({ apiKey, ...options });
                },
                async header(headerName = "Authorization", prefix = "Bearer ") {
                    await guard("secret", name, { client: "header" });
                    if (!deps.secrets) throw new Error("secrets are not available in this runtime");
                    const value = await deps.secrets(name);
                    // a header object the node can spread into a host.fetch call; the value never enters node scope directly
                    return { [headerName]: prefix + value };
                },
            };
        },
        /** What this invocation may do, for nodes that adapt. */
        capabilities: {
            instance: ctx.effective.instance,
            manifest: ctx.effective.manifest,
        },
    };
}
