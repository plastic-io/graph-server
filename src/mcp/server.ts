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
import { readObservations } from "../runtime/executor";
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
    journeys?: { run(graphId: string, journeyId: string, by: "schedule" | "request", principal?: Principal): Promise<any> };
    tests?: { run(graphId: string, testId: string, principal: Principal | undefined, options?: any): Promise<any>; runAll(graphId: string, principal: Principal | undefined, options?: any): Promise<any> };
    /** Run a graph for an agent (the server wires this to the execution runner). */
    invoke?: (graphId: string, principal: Principal | undefined, request: { nodeUrl: string; field?: string; value?: any; budget?: any }) => Promise<any>;
    /** Ask a running execution to stop. */
    cancel?: (graphId: string, principal: Principal | undefined, executionId: string, reason: string) => Promise<any>;
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

    const storeList = (prefix: string): Promise<string[]> => new Promise((resolve, reject) => (deps.crdtStore.store as any).list(prefix, (err: any, items: any[]) => (err ? reject(err) : resolve((items || []).map((i: any) => i.Key)))));
    const storeGet = (key: string): Promise<any | null> => new Promise((resolve) => (deps.crdtStore.store as any).get(key, (err: any, data: any) => resolve(err ? null : data)));
    const inspectPayloads = (principal: Principal | undefined) => decide(principal, ["graph:inspect-payloads"]).allow;
    const redactFor = (o: any, allowed: boolean) => {
        if (allowed || !o.payload || typeof o.payload !== "object") return o;
        const p = o.payload;
        if (p.value !== undefined) return { ...o, payload: { meta: p.meta, redacted: "payload" } };
        return o;
    };

    /**
     * Everything observed for one execution: what the owning domain recorded,
     * plus each node another domain ran on its behalf (plan §4.8.2).
     */
    const observationsForExecution = async (record: any): Promise<any[]> => {
        const own = await readObservations(deps.crdtStore.store as any, record);
        const sideKeys = (await storeList(`executions/${record.executionId}/deliveries/`))
            .concat(await storeList(`executions/${record.executionId}/reports/`))
            // and a hop nobody took (plan §4.8.2, PB-072)
            .concat(await storeList(`deliveries/pending/${record.graphId}/${record.executionId}/`));
        const fromOtherDomains: any[] = [];
        for (const key of sideKeys) {
            const side = await storeGet(key);
            if (side && side.observationsKey) {
                fromOtherDomains.push(...await readObservations(deps.crdtStore.store as any, { observations: { key: side.observationsKey } } as any));
            }
        }
        return own.concat(fromOtherDomains);
    };

    /** Executions of a graph, newest first (executions/by-graph/<g>/<id>.json). */
    const listExecutions = async (graphId: string): Promise<any[]> => {
        const prefix = `executions/by-graph/${graphId}/`;
        const keys = (await storeList(prefix)).sort().reverse();
        const out: any[] = [];
        for (const key of keys.slice(0, 200)) {
            const r = await storeGet(key);
            if (r) out.push(r);
        }
        return out;
    };

    server.registerTool("observations.query", {
        title: "Query what happened to a graph",
        description: "Observations of a graph's executions (edge inputs, routes, effects, denials, errors, budget, contracts), newest first, plus the audit trail (mutations, revisions, publications, proposals) when asked for those kinds. Filter by execution, node or kind; continue with the cursor. Payloads need graph:inspect-payloads.",
        inputSchema: z.object({ schemaVersion: z.literal(1), graphId: ID, filter: z.object({ nodeId: ID.optional(), kind: z.string().max(64).optional(), executionId: z.string().max(64).optional(), since: z.string().max(64).optional() }).strict().optional(), limit: z.number().int().min(1).max(500).optional(), cursor: z.string().max(64).optional() }).strict(),
        annotations: { readOnlyHint: true },
    }, guarded("observations.query", "read", (a) => a.graphId, ["graph:observe"], async (args, principal) => {
        const filter = args.filter || {};
        const limit = args.limit || 50;
        const wantsAudit = !filter.kind || /^(mutation|revision|component|proposal|mcp)/.test(filter.kind);
        const wantsExecutions = !filter.kind || !/^(mutation|revision|component|proposal|mcp)/.test(filter.kind);
        const payloads = inspectPayloads(principal);
        let items: any[] = [];
        if (wantsExecutions) {
            const executions = filter.executionId ? [await storeGet(`executions/${filter.executionId}.json`)].filter(Boolean) : await listExecutions(args.graphId);
            for (const record of executions) {
                if (record.graphId !== args.graphId) continue;
                const observations = await observationsForExecution(record);
                observations.forEach((o: any) => {
                    if (filter.kind && !String(o.kind).startsWith(filter.kind)) return;
                    if (filter.nodeId && o.nodeId !== filter.nodeId) return;
                    items.push(redactFor(o, payloads));
                });
                if (items.length > limit * 4) break;
            }
        }
        if (wantsAudit && !filter.executionId) {
            const prefix = `${deps.admission.chain.prefix}/${args.graphId}/`;
            const ids = (await storeList(prefix)).filter((k) => !k.endsWith("HEAD.json")).map((k) => k.slice(prefix.length, -5)).sort().reverse().slice(0, limit * 2);
            for (const id of ids) {
                const record = await storeGet(`${prefix}${id}.json`);
                if (!record) continue;
                if (filter.kind && !String(record.kind).startsWith(filter.kind)) continue;
                if (filter.nodeId && record.nodeId !== filter.nodeId && !(record.diff && record.diff.ops && record.diff.ops.some((o: any) => o.nodeId === filter.nodeId))) continue;
                items.push(observationOf(record));
            }
        }
        items.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        if (filter.since) items = items.filter((o) => o.id > filter.since!);
        if (args.cursor) items = items.filter((o) => o.id < args.cursor!);
        const page = items.slice(0, limit);
        const more = items.length > limit;
        return ok(principal, { observations: page, nextCursor: more ? page[page.length - 1].id : undefined }, { graphId: args.graphId, truncated: more });
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

    /* ------------------------------------------------- acting on the graph */

    server.registerTool("proposal.decide", {
        title: "Approve or reject a proposal",
        description: "Record a decision on a proposal, bound to the digest that was reviewed. A proposal cannot be approved by whoever proposed it.",
        inputSchema: z.object({ schemaVersion: z.literal(1), graphId: ID, proposalId: ULID, decision: z.enum(["approve", "reject"]), proposalDigest: z.string().max(200).optional(), rationale: z.string().max(4000).optional() }).strict(),
        annotations: { readOnlyHint: false, idempotentHint: true },
    }, guarded("proposal.decide", "write", (a) => a.graphId, ["graph:approve"], async (args, principal) => {
        const r: any = await deps.proposals.decideProposal(args.graphId, args.proposalId, principal, args.decision, args.proposalDigest, args.rationale || "");
        if (r.error) return fail(r.code, r.error, retryFor(r.code), r.details);
        const p = r.proposal;
        return ok(principal, { proposalId: p.proposalId, state: p.state, requiredDecisions: p.requiredDecisions, decisions: p.decisions }, { graphId: args.graphId });
    }));

    server.registerTool("proposal.commit", {
        title: "Commit a proposal",
        description: "Admit the exact bytes that were validated, as the committing principal, and cut a revision for the result. Refused while the proposal still needs a decision, or if the graph moved since it was validated.",
        inputSchema: z.object({ schemaVersion: z.literal(1), graphId: ID, proposalId: ULID }).strict(),
        annotations: { readOnlyHint: false, idempotentHint: true },
    }, guarded("proposal.commit", "write", (a) => a.graphId, ["graph:commit"], async (args, principal) => {
        const r: any = await deps.proposals.commit(args.graphId, args.proposalId, principal);
        if (r.error) return fail(r.code, r.error, retryFor(r.code, r.rebaseTo), r.details);
        const p = r.proposal;
        return ok(principal, { proposalId: p.proposalId, state: p.state, resultRevision: p.resultRevision, mutationId: p.mutationId, warnings: p.warnings }, { graphId: args.graphId, resultRevision: p.resultRevision });
    }));

    server.registerTool("revision.cut", {
        title: "Name this state of the graph",
        description: "Cut a revision of the graph as it is now, so later work can name it. Returns the existing revision when nothing changed since the last one.",
        inputSchema: z.object({ schemaVersion: z.literal(1), graphId: ID, label: z.string().max(200).optional() }).strict(),
        annotations: { readOnlyHint: false, idempotentHint: true },
    }, guarded("revision.cut", "write", (a) => a.graphId, ["graph:commit"], async (args, principal) => {
        const r: any = await deps.revisions.cut(args.graphId, principal, args.label || "");
        if (r.error) return fail(r.code, r.error, retryFor(r.code));
        return ok(principal, { revision: revRef(r.revision.revisionId), seq: r.revision.seq, label: r.revision.label, created: r.created, digest: digestRef(r.revision.digest.full) }, { graphId: args.graphId, resultRevision: revRef(r.revision.revisionId) });
    }));

    server.registerTool("revision.activate", {
        title: "Run this revision",
        description: "Point execution at a revision. New work runs it; work already in flight finishes on the revision it started with. Refused when that version fails a test or a journey of this graph; `force` activates anyway and is recorded in the audit.",
        inputSchema: z.object({ schemaVersion: z.literal(1), graphId: ID, revisionId: REV, force: z.boolean().optional() }).strict(),
        annotations: { readOnlyHint: false, idempotentHint: true },
    }, guarded("revision.activate", "write", (a) => a.graphId, ["graph:activate"], async (args, principal) => {
        const r: any = await deps.revisions.activate(args.graphId, revId(args.revisionId), principal, !!args.force);
        if (r.error) return fail(r.code, r.error, retryFor(r.code));
        return ok(principal, { active: { revision: revRef(r.active.revisionId), seq: r.active.seq, label: r.active.label, at: r.active.at } }, { graphId: args.graphId, resultRevision: revRef(r.active.revisionId) });
    }));

    server.registerTool("revision.rollback", {
        title: "Bring the graph back to a revision",
        description: "Restore the graph's definition to an earlier revision as an ordinary admitted change, so history is never rewritten and the rollback can itself be undone.",
        inputSchema: z.object({ schemaVersion: z.literal(1), graphId: ID, revisionId: REV }).strict(),
        annotations: { readOnlyHint: false, idempotentHint: false },
    }, guarded("revision.rollback", "write", (a) => a.graphId, ["graph:rollback"], async (args, principal) => {
        const r: any = await deps.revisions.restore(args.graphId, revId(args.revisionId), principal);
        if (r.error) return fail(r.code, r.error, retryFor(r.code));
        return ok(principal, { decision: r.decision, mutationId: r.mutationId, reason: r.reason }, { graphId: args.graphId });
    }));

    server.registerTool("component.publish", {
        title: "Publish a component",
        description: "Publish the graph, or one node of it, as an immutable version other graphs can import. The version is the revision's sequence number; publishing an unchanged graph returns the version that already exists. Refused when a node reaches for an effect it never declared, or when a test of this graph fails; `force` publishes anyway and is recorded.",
        inputSchema: z.object({ schemaVersion: z.literal(1), graphId: ID, nodeId: ID.optional(), label: z.string().max(200).optional(), revisionId: REV.optional(), force: z.boolean().optional() }).strict(),
        annotations: { readOnlyHint: false, idempotentHint: true },
    }, guarded("component.publish", "write", (a) => a.graphId, ["component:publish"], async (args, principal) => {
        const r: any = await deps.components.publish(args.graphId, principal, { nodeId: args.nodeId, label: args.label, revisionId: args.revisionId ? revId(args.revisionId) : undefined, force: !!args.force });
        if (r.error) return fail(r.code, r.error, retryFor(r.code));
        return ok(principal, {
            publishedId: r.manifest.publishedId, version: r.manifest.version, created: r.created,
            digest: digestRef(r.manifest.digest), contract: r.manifest.contract, capabilities: r.manifest.capabilities,
            revision: revRef(r.revision.revisionId),
        }, { graphId: args.graphId, resultRevision: revRef(r.revision.revisionId) });
    }));

    server.registerTool("graph.invoke", {
        title: "Run a graph",
        description: "Run the graph from one of its nodes and answer with what the execution did: its id, state, hops, errors, effects allowed and refused, and where its observations are. Nodes placed in a browser are handed to whichever browsers are watching; the execution does not wait for them.",
        inputSchema: z.object({ schemaVersion: z.literal(1), graphId: ID, nodeUrl: z.string().min(1).max(256), field: z.string().max(128).optional(), value: z.any().optional(), budget: z.object({ wallMs: z.number().int().min(100).max(60000).optional(), hops: z.number().int().min(1).max(100000).optional() }).strict().optional() }).strict(),
        annotations: { readOnlyHint: false, idempotentHint: false },
    }, guarded("graph.invoke", "write", (a) => a.graphId, ["graph:execute"], async (args, principal) => {
        if (!deps.invoke) return fail("INTERNAL", "this server cannot run graphs");
        const r: any = await deps.invoke(args.graphId, principal, { nodeUrl: args.nodeUrl, field: args.field, value: args.value, budget: args.budget });
        if (r.error) return fail(r.code, r.error, retryFor(r.code));
        return ok(principal, r.summary, { graphId: args.graphId, resultRevision: r.summary && r.summary.revisionId && r.summary.revisionId !== "live" ? revRef(r.summary.revisionId) : undefined });
    }));

    server.registerTool("execution.cancel", {
        title: "Stop an execution",
        description: "Ask a running execution to stop. It notices at its next hop; work already in flight is not taken back.",
        inputSchema: z.object({ schemaVersion: z.literal(1), graphId: ID, executionId: ULID, reason: z.string().max(200).optional() }).strict(),
        annotations: { readOnlyHint: false, idempotentHint: true },
    }, guarded("execution.cancel", "write", (a) => a.graphId, ["graph:execute"], async (args, principal) => {
        if (!deps.cancel) return fail("INTERNAL", "this server cannot cancel executions");
        const r: any = await deps.cancel(args.graphId, principal, args.executionId, args.reason || "");
        if (r.error) return fail(r.code, r.error, retryFor(r.code));
        return ok(principal, r, { graphId: args.graphId });
    }));

    server.registerTool("tests.run", {
        title: "Check that a part still keeps its word",
        description: "Run one component test, or every test of a graph, and answer with what was expected and what happened. A test names its target by node or by capability, so it survives the graph being rebuilt.",
        inputSchema: z.object({ schemaVersion: z.literal(1), graphId: ID, testId: z.string().min(1).max(64).optional() }).strict(),
        annotations: { readOnlyHint: false, idempotentHint: false },
    }, guarded("tests.run", "write", (a) => a.graphId, ["graph:test"], async (args, principal) => {
        if (!deps.tests) return fail("INTERNAL", "this server has no tests");
        if (args.testId) {
            const r: any = await deps.tests.run(args.graphId, args.testId, principal, { by: "request" });
            if (r.error) return fail(r.code, r.error, retryFor(r.code));
            return ok(principal, { runs: [r], failed: r.state === "passed" ? 0 : 1 }, { graphId: args.graphId });
        }
        const r: any = await deps.tests.runAll(args.graphId, principal, { by: "request" });
        return ok(principal, { runs: r.runs, failed: r.failed.length }, { graphId: args.graphId });
    }));

    server.registerTool("journey.run", {
        title: "Prove the graph still does what it is for",
        description: "Run one intent journey now and answer with its verdict: passed, failed, unresolvable (nothing provides the capability any more), or probe-error.",
        inputSchema: z.object({ schemaVersion: z.literal(1), graphId: ID, journeyId: z.string().min(1).max(64) }).strict(),
        annotations: { readOnlyHint: false, idempotentHint: false },
    }, guarded("journey.run", "write", (a) => a.graphId, ["graph:test"], async (args, principal) => {
        if (!deps.journeys) return fail("INTERNAL", "this server has no journeys");
        const r: any = await deps.journeys.run(args.graphId, args.journeyId, "request", principal);
        if (r.error) return fail(r.code, r.error, retryFor(r.code));
        return ok(principal, { runId: r.runId, state: r.state, reason: r.reason, intent: r.intent, steps: r.steps, duration: r.duration }, { graphId: args.graphId });
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
    server.registerResource("executions", new ResourceTemplate("plastic://graph/{graphId}/executions", { list: undefined }), { title: "Executions of a graph", mimeType: "application/json" }, async (uri, vars: any) => {
        const graphId = v(vars, "graphId");
        await readable(graphId, ["graph:observe"]);
        const executions = (await listExecutions(graphId)).slice(0, 100).map((r: any) => ({ ...r, revisionId: r.revisionId && r.revisionId !== "live" ? revRef(r.revisionId) : r.revisionId }));
        return text(uri, { graphId, executions });
    });
    server.registerResource("execution", new ResourceTemplate("plastic://graph/{graphId}/execution/{executionId}", { list: undefined }), { title: "One execution and its observations", mimeType: "application/json" }, async (uri, vars: any) => {
        const graphId = v(vars, "graphId");
        await readable(graphId, ["graph:observe"]);
        const record = await storeGet(`executions/${v(vars, "executionId")}.json`);
        if (!record || record.graphId !== graphId) denied(`not found: ${uri.href}`);
        const { decision } = await forGraph(graphId, ["graph:inspect-payloads"]);
        const observations = (await observationsForExecution(record)).map((o: any) => redactFor(o, decision.allow));
        return text(uri, { execution: record, observations });
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
