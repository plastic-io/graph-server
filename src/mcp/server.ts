import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { createHash } from "crypto";
import { ulid } from "ulid";
import { semanticDiff } from "@plastic-io/graph-crdt";
import { Principal } from "../auth/principal";
import { decide, Authority, POLICY_VERSION } from "../policy/decide";
import { DelegationStore } from "../policy/delegation";
import { RateLimiter } from "../admission/limits";
import { AdmissionService } from "../admission/admit";
import { RevisionService } from "../revisions/service";
import { ComponentService } from "../components/service";
import { ProposalService } from "../proposals/service";
import { SummaryService, revRef, revId, digestRef } from "../summary/service";
import CrdtStore from "../crdtStore";
import TocStore from "../tocStore";

/**
 * The MCP surface (plan §5): read tools and resources, and proposals.  Every
 * tool goes through the same services the editor uses; nothing here reaches
 * the store or the scheduler directly (§1.6 guarantee d).  One server
 * instance is built per request, bound to the caller's principal.
 */
export interface McpDeps {
    crdtStore: CrdtStore;
    tocStore: TocStore;
    admission: AdmissionService;
    revisions: RevisionService;
    components: ComponentService;
    proposals: ProposalService;
    summaries: SummaryService;
    delegations: DelegationStore;
    rate?: { reads: RateLimiter; writes: RateLimiter };
}

export const SERVER_INFO = { name: "plastic-io-graph-server", version: "2.1.0" };
const ID = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const ULID = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const REV = z.string().regex(/^rev_[0-9A-HJKMNP-TV-Z]{26}$/);
const rates = { reads: new RateLimiter({ maxMutations: 60, maxRejections: 1000 }), writes: new RateLimiter({ maxMutations: 10, maxRejections: 1000 }) };

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: any; isError?: boolean };

function principalRef(p: Principal | undefined) {
    return p ? { sub: p.sub, kind: p.kind, tenant: p.tenant, ...(p.delegatedBy ? { delegatedBy: p.delegatedBy } : {}) } : { sub: "anonymous", kind: "human", tenant: "none" };
}

export function envelope(p: Principal | undefined, extra: Record<string, any> = {}) {
    return {
        schemaVersion: "1",
        requestId: ulid(),
        principal: principalRef(p),
        correlationId: ulid(),
        policyVersion: POLICY_VERSION,
        serverTime: new Date().toISOString(),
        truncated: false,
        ...extra,
    };
}

export function ok(p: Principal | undefined, result: any, extra: Record<string, any> = {}): ToolResult {
    const structuredContent = { envelope: envelope(p, extra), result };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
}

export function fail(code: string, message: string, retry: { retryable: boolean; afterMs?: number; rebaseTo?: string } = { retryable: false }, details?: any): ToolResult {
    const structuredContent = { error: { code, message: String(message).slice(0, 2000), retry, ...(details ? { details } : {}) } };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent, isError: true };
}

const retryFor = (code: string, rebaseTo?: string) => code === "STALE_BASE" ? { retryable: true, rebaseTo } : code === "RATE_LIMITED" ? { retryable: true, afterMs: 5000 } : { retryable: false };

/** Serialise an audit record as an observation-like entry (M2: the audit chain is the observation index). */
function observationOf(record: any) {
    return {
        id: record.id,
        kind: record.kind,
        at: record.at,
        seq: record.seq,
        graphId: record.graphId,
        nodeId: record.nodeId,
        executionId: record.executionId,
        mutationId: record.mutationId,
        proposalId: record.proposalId,
        revisionId: record.revisionId ? revRef(record.revisionId) : undefined,
        principal: record.principal,
        description: record.description || record.label || record.reason,
        decision: record.decision,
        code: record.code,
        namespaces: record.diff && record.diff.namespaces,
    };
}

export function buildServer(deps: McpDeps, rawPrincipal: Principal | undefined): McpServer {
    const server = new McpServer(SERVER_INFO, {
        capabilities: { tools: {}, resources: {} },
        instructions: "Plastic-IO graph server. Read graphs with graph.summary and graph.expand at a named revision, then propose changes with proposal.create against that revision; a human commits proposals in the editor.",
    });
    const rate = deps.rate || rates;
    const rateKey = rawPrincipal ? rawPrincipal.sub : "anonymous";

    /** The caller as policy sees it for one graph, and whether it holds an authority. */
    const forGraph = async (graphId: string | undefined, required: Authority[]) => {
        const principal = await deps.delegations.resolve(rawPrincipal, graphId);
        const decision = decide(principal, required);
        return { principal, decision };
    };
    const audit = async (graphId: string | undefined, tool: string, args: any, outcome: { decision: string; code?: string }, startedAt: number) => {
        if (!graphId) return;
        try {
            await deps.admission.chain.append(graphId, {
                kind: `mcp.tool.${tool}`, at: new Date().toISOString(), graphId, principal: principalRef(rawPrincipal),
                argsHash: createHash("sha256").update(JSON.stringify(args || {})).digest("hex"), decision: outcome.decision, code: outcome.code, durationMs: Date.now() - startedAt,
            });
        } catch (err) {
            console.error("Cannot audit an MCP call", err);
        }
    };
    const guarded = (tool: string, kind: "read" | "write", graphOf: (args: any) => string | undefined, required: Authority[], run: (args: any, principal: Principal | undefined) => Promise<ToolResult>) => {
        return async (args: any): Promise<ToolResult> => {
            const startedAt = Date.now();
            const graphId = graphOf(args);
            const limiter = kind === "read" ? rate.reads : rate.writes;
            const verdict = limiter.check(rateKey);
            if (!verdict.ok) {
                return fail("RATE_LIMITED", verdict.reason || "too many calls", { retryable: true, afterMs: verdict.retryAfterMs });
            }
            limiter.record(rateKey, false);
            const { principal, decision } = await forGraph(graphId, required);
            if (!decision.allow) {
                const result = fail(rawPrincipal ? "ADMISSION_DENIED" : "ADMISSION_DENIED", decision.reason || "denied");
                await audit(graphId, tool, args, { decision: "denied" }, startedAt);
                return result;
            }
            try {
                const result = await run(args, principal);
                await audit(graphId, tool, args, { decision: result.isError ? "error" : "ok", code: result.isError ? result.structuredContent.error.code : undefined }, startedAt);
                return result;
            } catch (err: any) {
                console.error(`MCP tool ${tool} failed`, err);
                await audit(graphId, tool, args, { decision: "error", code: "INTERNAL" }, startedAt);
                return fail("INTERNAL", err && err.message ? err.message : String(err));
            }
        };
    };

    /* ------------------------------------------------------------ tools */

    server.registerTool("graph.summary", {
        title: "Summarise a graph or a node",
        description: "A bounded summary of a graph, or of one node in it, at a revision (HEAD when none is given). Returns the revision it read, so a proposal can name it as its base.",
        inputSchema: z.object({ schemaVersion: z.literal(1), graphId: ID, revisionId: REV.optional(), nodeId: ID.optional(), include: z.array(z.enum(["contract", "capabilities", "health", "deps"])).max(4).optional() }).strict(),
        annotations: { readOnlyHint: true },
    }, guarded("graph.summary", "read", (a) => a.graphId, ["graph:read"], async (args, principal) => {
        const revision = await deps.summaries.resolveRevision(args.graphId, args.revisionId);
        if (!revision) return fail("NOT_FOUND", `no graph ${args.graphId}${args.revisionId ? " at " + args.revisionId : ""}`);
        const projection = await deps.revisions.projection(args.graphId, revision.revisionId);
        if (!projection) return fail("NOT_FOUND", "the revision has no projection");
        if (args.nodeId) {
            const node = (projection.nodes || []).find((n: any) => n.id === args.nodeId);
            if (!node) return fail("NOT_FOUND", `no node ${args.nodeId}`);
            return ok(principal, deps.summaries.nodeSummary(args.graphId, revision, projection, node, args.include || []), { graphId: args.graphId, resultRevision: revRef(revision.revisionId) });
        }
        return ok(principal, deps.summaries.graphSummary(args.graphId, revision, projection, args.include || []), { graphId: args.graphId, resultRevision: revRef(revision.revisionId) });
    }));

    server.registerTool("graph.expand", {
        title: "Expand a graph around a node",
        description: "Breadth-first traversal from a node at a revision, bounded by depth, node count and bytes; continue with the cursor. Code is included only when asked for.",
        inputSchema: z.object({
            schemaVersion: z.literal(1), graphId: ID, revisionId: REV, root: z.object({ nodeId: ID }).strict(), direction: z.enum(["in", "out", "both"]),
            depth: z.number().int().min(1).max(4), maxNodes: z.number().int().min(1).max(200), maxBytes: z.number().int().min(1024).max(262144), includeCode: z.boolean().optional(), cursor: z.string().max(4096).optional(),
        }).strict(),
        annotations: { readOnlyHint: true },
    }, guarded("graph.expand", "read", (a) => a.graphId, ["graph:read"], async (args, principal) => {
        if (args.includeCode && !decide(principal, ["graph:inspect-internals"]).allow) return fail("ADMISSION_DENIED", "code needs graph:inspect-internals");
        const revision = await deps.revisions.get(args.graphId, revId(args.revisionId));
        if (!revision) return fail("NOT_FOUND", `no revision ${args.revisionId}`);
        const projection = await deps.revisions.projection(args.graphId, revision.revisionId);
        const r: any = deps.summaries.expand(args.graphId, revision, projection, { root: args.root.nodeId, direction: args.direction, depth: args.depth, maxNodes: args.maxNodes, maxBytes: args.maxBytes, includeCode: args.includeCode, cursor: args.cursor });
        if (r.error) return fail(r.error.code, r.error.message, retryFor(r.error.code, r.error.rebaseTo));
        return ok(principal, r, { graphId: args.graphId, resultRevision: revRef(revision.revisionId), truncated: !!(r.truncated.byDepth || r.truncated.byCount || r.truncated.byBytes) });
    }));

    server.registerTool("component.search", {
        title: "Search published components",
        description: "Published graphs and nodes by name, description or tag, newest version first.",
        inputSchema: z.object({ schemaVersion: z.literal(1), query: z.string().max(200), tags: z.array(z.string().max(64)).max(16).optional(), capability: z.string().max(64).optional(), placement: z.enum(["browser", "server", "portable"]).optional(), limit: z.number().int().min(1).max(50).optional(), cursor: z.string().max(64).optional() }).strict(),
        annotations: { readOnlyHint: true },
    }, guarded("component.search", "read", () => undefined, ["registry:read"], async (args, principal) => {
        const toc = await deps.tocStore.project();
        const q = args.query.toLowerCase();
        const entries = Object.keys(toc).filter((k) => k.startsWith("artifacts/")).map((k) => toc[k]).filter((e: any) => e && /published/.test(String(e.type)));
        const matches = entries.filter((e: any) => !q || String(e.name || "").toLowerCase().includes(q) || String(e.description || "").toLowerCase().includes(q))
            .map((e: any) => ({ publishedId: String(e.id).replace(/^artifacts\//, ""), version: Number(e.version), kind: e.type === "publishedNode" ? "node" : "graph", name: e.name, description: e.description, digest: e.digest ? digestRef(e.digest) : undefined, revisionId: e["revision-id"] ? revRef(e["revision-id"]) : undefined }))
            .sort((a: any, b: any) => a.name.localeCompare(b.name) || b.version - a.version);
        const offset = args.cursor ? Number(args.cursor) || 0 : 0;
        const limit = args.limit || 20;
        const page = matches.slice(offset, offset + limit);
        return ok(principal, { components: page, nextCursor: offset + limit < matches.length ? String(offset + limit) : undefined }, { truncated: offset + limit < matches.length });
    }));

    server.registerTool("observations.query", {
        title: "Query what happened to a graph",
        description: "Audit-backed observations for a graph, newest first: admitted and refused mutations, revisions, publications, proposals. Filter by kind or node; continue with the cursor.",
        inputSchema: z.object({ schemaVersion: z.literal(1), graphId: ID, filter: z.object({ nodeId: ID.optional(), kind: z.string().max(64).optional(), executionId: z.string().max(64).optional(), since: z.string().max(64).optional() }).strict().optional(), limit: z.number().int().min(1).max(500).optional(), cursor: z.string().max(64).optional() }).strict(),
        annotations: { readOnlyHint: true },
    }, guarded("observations.query", "read", (a) => a.graphId, ["graph:observe"], async (args, principal) => {
        const prefix = `${deps.admission.chain.prefix}/${args.graphId}/`;
        const keys: string[] = await new Promise((resolve, reject) => (deps.crdtStore.store as any).list(prefix, (err: any, items: any[]) => (err ? reject(err) : resolve((items || []).map((i: any) => i.Key)))));
        let ids = keys.filter((k) => !k.endsWith("HEAD.json")).map((k) => k.slice(prefix.length, -5)).sort().reverse();
        const filter = args.filter || {};
        if (filter.since) ids = ids.filter((id) => id > filter.since!);
        if (args.cursor) ids = ids.filter((id) => id < args.cursor!);
        const limit = args.limit || 50;
        const out: any[] = [];
        for (const id of ids) {
            if (out.length >= limit) break;
            const record: any = await new Promise((resolve) => (deps.crdtStore.store as any).get(`${prefix}${id}.json`, (err: any, data: any) => resolve(err ? null : data)));
            if (!record) continue;
            if (filter.kind && !String(record.kind).startsWith(filter.kind)) continue;
            if (filter.executionId && record.executionId !== filter.executionId) continue;
            if (filter.nodeId && record.nodeId !== filter.nodeId && !(record.diff && record.diff.ops && record.diff.ops.some((o: any) => o.nodeId === filter.nodeId))) continue;
            out.push(observationOf(record));
        }
        const last = out.length ? out[out.length - 1].id : undefined;
        const more = last ? ids.indexOf(last) < ids.length - 1 : false;
        return ok(principal, { observations: out, nextCursor: more ? last : undefined }, { graphId: args.graphId, truncated: more });
    }));

    const OPS = z.array(z.object({ op: z.string() }).passthrough()).min(1).max(500);
    server.registerTool("proposal.create", {
        title: "Propose a change",
        description: "Propose semantic operations against a graph at its current revision (baseRevision must be the revision graph.summary returned). The server materialises, validates and stores the proposal; a human commits it in the editor.",
        inputSchema: z.object({ schemaVersion: z.literal(1), graphId: ID, baseRevision: REV, ops: OPS, description: z.string().min(1).max(200), rationale: z.string().max(4000).optional(), expected: z.object({ affects: z.array(ID).max(500).optional() }).strict().optional(), idempotencyKey: ULID }).strict(),
        annotations: { readOnlyHint: false, idempotentHint: true },
    }, guarded("proposal.create", "write", (a) => a.graphId, ["graph:propose"], async (args, principal) => {
        const r: any = await deps.proposals.create(args.graphId, principal, { baseRevision: args.baseRevision, ops: args.ops, description: args.description, rationale: args.rationale, idempotencyKey: args.idempotencyKey });
        if (r.error) return fail(r.code, r.error, retryFor(r.code, r.rebaseTo), r.details);
        const p = r.proposal;
        return ok(principal, { proposalId: p.proposalId, proposalDigest: p.proposalDigest, state: p.state, validation: p.validation, impact: p.impact, requiredDecisions: p.requiredDecisions, diffSummary: p.diffSummary, created: r.created }, { graphId: args.graphId, baseRevision: p.baseRevision });
    }));

    server.registerTool("proposal.validate", {
        title: "Re-validate a proposal",
        description: "Check a proposal against the graph as it is now; with rebase, re-apply its operations on the new head.",
        inputSchema: z.object({ schemaVersion: z.literal(1), graphId: ID, proposalId: ULID, rebase: z.boolean().optional() }).strict(),
        annotations: { readOnlyHint: false, idempotentHint: true },
    }, guarded("proposal.validate", "write", (a) => a.graphId, ["graph:propose"], async (args, principal) => {
        const r: any = await deps.proposals.validate(args.graphId, args.proposalId, principal, !!args.rebase);
        if (r.error) return fail(r.code, r.error, retryFor(r.code, r.rebaseTo), r.details);
        const p = r.proposal;
        return ok(principal, { proposalId: p.proposalId, proposalDigest: p.proposalDigest, state: p.state, validation: p.validation, impact: p.impact, requiredDecisions: p.requiredDecisions, diffSummary: p.diffSummary }, { graphId: args.graphId, baseRevision: p.baseRevision });
    }));

    /* ------------------------------------------------------------ resources */

    const text = (uri: URL, value: any) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }] });
    const denied = (message: string) => { const e: any = new Error(message); e.code = -32602; throw e; };
    /** A template variable as matched, without any query string the matcher swept up. */
    const v = (vars: any, name: string) => String(vars && vars[name] !== undefined ? vars[name] : "").split("?")[0];
    const readable = async (graphId: string, required: Authority[] = ["graph:read"]) => {
        const { decision } = await forGraph(graphId, required);
        if (!decision.allow) denied(`not found: ${graphId}`);
    };

    server.registerResource("graphs", "plastic://graphs", { title: "Graphs", description: "The graphs this principal may read", mimeType: "application/json" }, async (uri) => {
        const toc = await deps.tocStore.project();
        const graphs = Object.keys(toc).map((k) => toc[k]).filter((e: any) => e && e.type === "graph" && !e.deleted).map((e: any) => ({ graphId: e.id, name: e.name, description: e.description, url: e.url, version: e.version }));
        return text(uri, { graphs });
    });
    server.registerResource("graph", new ResourceTemplate("plastic://graph/{graphId}", { list: undefined }), { title: "Graph summary at HEAD", mimeType: "application/json" }, async (uri, vars: any) => {
        const graphId = v(vars, "graphId");
        await readable(graphId);
        const revision = await deps.summaries.headOrCut(graphId);
        if (!revision) denied(`not found: ${uri.href}`);
        const projection = await deps.revisions.projection(graphId, revision!.revisionId);
        return text(uri, deps.summaries.graphSummary(graphId, revision!, projection, []));
    });
    server.registerResource("revision", new ResourceTemplate("plastic://graph/{graphId}/rev/{revisionId}", { list: undefined }), { title: "Revision manifest", mimeType: "application/json" }, async (uri, vars: any) => {
        const graphId = v(vars, "graphId");
        await readable(graphId);
        const revision = await deps.revisions.get(graphId, revId(v(vars, "revisionId")));
        if (!revision) denied(`not found: ${uri.href}`);
        const { snapshot, stateVector, ...manifest } = revision as any;
        return text(uri, { ...manifest, revisionId: revRef(manifest.revisionId), parent: manifest.parent ? revRef(manifest.parent) : null });
    });
    const readNode = async (uri, vars: any) => {
        const graphId = v(vars, "graphId");
        await readable(graphId);
        const revision = await deps.revisions.get(graphId, revId(v(vars, "revisionId")));
        if (!revision) denied(`not found: ${uri.href}`);
        const projection = await deps.revisions.projection(graphId, revision!.revisionId);
        const node = (projection.nodes || []).find((n: any) => n.id === v(vars, "nodeId"));
        if (!node) denied(`not found: ${uri.href}`);
        const wantsCode = uri.searchParams.get("expand") === "code" || v(vars, "expand") === "code";
        if (wantsCode) await readable(graphId, ["graph:inspect-internals"]);
        const summary: any = deps.summaries.nodeSummary(graphId, revision!, projection, node, []);
        summary.edges = node.edges;
        summary.contract = { inputs: summary.inputs, outputs: summary.outputs };
        if (wantsCode) summary.code = node.template;
        return text(uri, summary);
    };
    server.registerResource("node", new ResourceTemplate("plastic://graph/{graphId}/rev/{revisionId}/node/{nodeId}", { list: undefined }), { title: "Node at a revision", mimeType: "application/json" }, readNode);
    server.registerResource("nodeWithCode", new ResourceTemplate("plastic://graph/{graphId}/rev/{revisionId}/node/{nodeId}{?expand}", { list: undefined }), { title: "Node at a revision, with code when expand=code", mimeType: "application/json" }, readNode);
    server.registerResource("component", new ResourceTemplate("plastic://component/{publishedId}", { list: undefined }), { title: "Published component versions", mimeType: "application/json" }, async (uri, vars: any) => {
        const publishedId = v(vars, "publishedId");
        const [versions, head] = await Promise.all([deps.components.list(publishedId), deps.components.head(publishedId)]);
        if (!versions.length) denied(`not found: ${uri.href}`);
        return text(uri, { publishedId, head, versions });
    });
    server.registerResource("componentVersion", new ResourceTemplate("plastic://component/{publishedId}/{version}", { list: undefined }), { title: "A published version", mimeType: "application/json" }, async (uri, vars: any) => {
        const manifest = await deps.components.manifest(v(vars, "publishedId"), Number(v(vars, "version")));
        if (!manifest) denied(`not found: ${uri.href}`);
        return text(uri, { manifest, artifactUri: `artifacts/${v(vars, "publishedId")}/${v(vars, "version")}` });
    });
    const readHistory = async (uri, vars: any) => {
        const graphId = v(vars, "graphId");
        await readable(graphId);
        const history = await deps.crdtStore.history(graphId);
        const limit = Number(uri.searchParams.get("limit") || v(vars, "limit") || 100);
        return text(uri, { graphId, entries: history.slice(-limit).reverse() });
    };
    server.registerResource("history", new ResourceTemplate("plastic://graph/{graphId}/history", { list: undefined }), { title: "Mutation history", mimeType: "application/json" }, readHistory);
    server.registerResource("historyPage", new ResourceTemplate("plastic://graph/{graphId}/history{?limit}", { list: undefined }), { title: "Mutation history, bounded", mimeType: "application/json" }, readHistory);
    server.registerResource("diff", new ResourceTemplate("plastic://graph/{graphId}/diff/{fromRev}/{toRev}", { list: undefined }), { title: "Semantic diff between revisions", mimeType: "application/json" }, async (uri, vars: any) => {
        const graphId = v(vars, "graphId");
        await readable(graphId);
        const [from, to] = await Promise.all([deps.revisions.projection(graphId, revId(v(vars, "fromRev"))), deps.revisions.projection(graphId, revId(v(vars, "toRev")))]);
        if (!from || !to) denied(`not found: ${uri.href}`);
        const diff = semanticDiff(from, to);
        return text(uri, { fromRevision: v(vars, "fromRev"), toRevision: v(vars, "toRev"), namespaces: diff.namespaces, changes: diff.ops, privilegeDelta: diff.privilegeDelta, layoutOnly: diff.namespaces.every((ns) => ns === "layout" || ns === "housekeeping"), nodesAdded: diff.nodesAdded, nodesRemoved: diff.nodesRemoved, nodesChanged: diff.nodesChanged });
    });
    server.registerResource("proposal", new ResourceTemplate("plastic://graph/{graphId}/proposal/{proposalId}", { list: undefined }), { title: "Proposal", mimeType: "application/json" }, async (uri, vars: any) => {
        const graphId = v(vars, "graphId");
        await readable(graphId);
        const proposal = await deps.proposals.get(graphId, v(vars, "proposalId"));
        if (!proposal) denied(`not found: ${uri.href}`);
        const { update, ...rest } = proposal as any;
        return text(uri, rest);
    });

    return server;
}
