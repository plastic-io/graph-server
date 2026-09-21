import * as Y from "yjs";
import { createHash } from "crypto";
import { ulid } from "ulid";
import { applyOps, toJSON, applyUpdate, reconcile, toBase64, fromBase64, UPDATE_EVENT, DiffSummary, PRIVILEGE_NAMESPACES } from "@plastic-io/graph-crdt";
import { Principal } from "../auth/principal";
import { decide, requiredAuthorities, serverOwnedViolation, Authority, POLICY_VERSION } from "../policy/decide";
import { AdmissionService, AdmissionResult, compactDiff, DiffSummaryCompact } from "../admission/admit";
import { RevisionService } from "../revisions/service";
import { SummaryService, revRef, revId, digestRef } from "../summary/service";
import CrdtStore from "../crdtStore";

/**
 * Proposals (plan §4.7.2, §5.3 proposal.create/validate): an agent's change,
 * materialised on the server from semantic operations, validated through the
 * same staging as every edit, and held for a human to commit through the same
 * admission gate.  Nothing an agent proposes touches the document until then.
 *
 * `proposals/<graphId>/<proposalId>.json` holds the record and the exact
 * update bytes (base64) that were validated; `.projection.json` the graph as
 * it would be, for the editor's preview; `by-key/<idempotencyKey>.json` maps
 * a retried create to its proposal.
 */
export type ProposalState = "validated" | "awaiting-review" | "committed" | "rejected" | "expired" | "stale";

export interface Proposal {
    proposalId: string;
    graphId: string;
    state: ProposalState;
    baseRevision: string;          // rev_<ulid>
    ops: any[];
    description: string;
    rationale: string;
    idempotencyKey: string;
    principal: { sub: string; kind: string; tenant: string; delegatedBy?: string } | null;
    update: string;                // base64 V2 update, exactly what was validated
    proposalDigest: string;        // sha256:<hex> of the update bytes
    diffSummary: DiffSummaryCompact;
    validation: { ok: boolean; errors: { code: string; message: string; nodeId?: string; field?: string }[] };
    impact: { consumers: any[]; downstream: string[]; privilegeDelta: any[]; testsToRun: string[]; oracleChanged: boolean };
    requiredDecisions: ("approve" | "iac-approve" | "privileged-connect")[];
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    decisions: { by: string; decision: "approve" | "reject" | "commit"; rationale?: string; at: string; proposalDigest: string }[];
    resultRevision?: string;
    mutationId?: string;
    warnings?: string[];
}

export type ProposalError = { error: string; code: "STALE_BASE" | "SCHEMA_INVALID" | "NOT_FOUND" | "CONFLICT" | "ADMISSION_DENIED" | "APPROVAL_REQUIRED"; rebaseTo?: string; details?: any };

interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
    list(prefix: string, cb: (err: any, data: any) => void): void;
}

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": true };
const TTL_MS = 7 * 24 * 3600 * 1000;
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export class ProposalService {
    private store: Store;
    constructor(
        readonly crdtStore: CrdtStore,
        readonly admission: AdmissionService,
        readonly revisions: RevisionService,
        readonly summaries: SummaryService,
        private hooks: { fanOut?: (graphId: string, update: Uint8Array) => Promise<void>; notify?: (graphId: string, event: any) => Promise<void> } = {},
    ) {
        this.store = crdtStore.store as any;
    }
    static key(graphId: string, proposalId: string) { return `proposals/${graphId}/${proposalId}.json`; }
    static projectionKey(graphId: string, proposalId: string) { return `proposals/${graphId}/${proposalId}.projection.json`; }
    static byKey(graphId: string, idempotencyKey: string) { return `proposals/${graphId}/by-key/${idempotencyKey}.json`; }

    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }
    private putJson(key: string, value: any): Promise<void> {
        return new Promise((resolve, reject) => this.store.set(key, value, {}, (err: any) => (err ? reject(err) : resolve())));
    }
    private listKeys(prefix: string): Promise<string[]> {
        return new Promise((resolve, reject) => this.store.list(prefix, (err: any, items: any[]) => (err ? reject(err) : resolve((items || []).map((i: any) => i.Key)))));
    }

    async get(graphId: string, proposalId: string): Promise<Proposal | null> {
        const p = await this.getJson(ProposalService.key(graphId, proposalId));
        if (p && (p.state === "validated" || p.state === "awaiting-review") && Date.parse(p.expiresAt) < Date.now()) {
            p.state = "expired";
        }
        return p;
    }
    async projection(graphId: string, proposalId: string): Promise<any | null> {
        return this.getJson(ProposalService.projectionKey(graphId, proposalId));
    }
    async list(graphId: string): Promise<Omit<Proposal, "update" | "ops">[]> {
        const keys = (await this.listKeys(`proposals/${graphId}/`)).filter((k) => k.endsWith(".json") && !k.endsWith(".projection.json") && !k.includes("/by-key/"));
        const out: any[] = [];
        for (const key of keys) {
            const p = await this.getJson(key);
            if (p) {
                const { update, ...rest } = p;
                if ((rest.state === "validated" || rest.state === "awaiting-review") && Date.parse(rest.expiresAt) < Date.now()) rest.state = "expired";
                out.push(rest);
            }
        }
        return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    /** Materialise ops on the graph as it is now and stage the result.  Shared by create and validate. */
    private async materialise(graphId: string, ops: any[], principal: Principal | undefined) {
        const live = await this.crdtStore.projectGraph(graphId);
        if (!live) {
            return { error: "no such graph", code: "NOT_FOUND" } as ProposalError;
        }
        const applied = applyOps(live, ops);
        if (!applied.ok) {
            const first = applied.errors[0];
            return { error: `operation ${first.index} (${ops[first.index] && ops[first.index].op}): ${first.message}`, code: first.code, details: { errors: applied.errors } } as ProposalError;
        }
        const { update: head } = await this.crdtStore.loadMerged(graphId);
        const doc = new Y.Doc();
        let update: Uint8Array | null = null;
        try {
            if (head) applyUpdate(doc, head);
            const capture = (u: Uint8Array) => { update = u; };
            doc.on(UPDATE_EVENT as any, capture);
            reconcile(doc, applied.projection, { source: "proposal" });
            doc.off(UPDATE_EVENT as any, capture);
        } finally {
            doc.destroy();
        }
        if (!update) {
            return { error: "the operations change nothing", code: "CONFLICT" } as ProposalError;
        }
        const staged = await this.admission.stageOnly(graphId, update);
        if (staged.ok === false) {
            return { error: staged.reason, code: staged.code } as ProposalError;
        }
        const violation = serverOwnedViolation(staged.diff, principal);
        if (violation) {
            return { error: violation, code: "ADMISSION_DENIED" } as ProposalError;
        }
        return { update: update as Uint8Array, diff: staged.diff, after: staged.after, touched: applied.touched, projection: applied.projection };
    }

    /** What a proposal still needs before it can be committed, given who proposed it. */
    private decisionsFor(diff: DiffSummary, principal: Principal | undefined): Proposal["requiredDecisions"] {
        const required = requiredAuthorities(diff);
        const held = (a: Authority) => decide(principal, [a]).allow;
        const out: Proposal["requiredDecisions"] = [];
        if (!principal || principal.kind === "agent") out.push("approve");   // agents do not commit in this release (plan M2)
        if (required.includes("graph:connect-privileged") && !held("graph:connect-privileged")) out.push("privileged-connect");
        if (required.includes("iac:approve") && !held("iac:approve")) out.push("iac-approve");
        return Array.from(new Set(out));
    }

    private impactOf(after: any, touched: string[], diff: DiffSummary) {
        const downstream = new Set<string>();
        (after && after.nodes ? after.nodes : []).forEach((n: any) => {
            if (!touched.includes(n.id)) return;
            (n.edges || []).forEach((e: any) => (e.connectors || []).forEach((c: any) => { if (!touched.includes(c.nodeId)) downstream.add(c.nodeId); }));
        });
        const privilegeDelta = [
            ...diff.privilegeDelta.placementToServer.map((nodeId) => ({ kind: "graph:invoke", scope: [`placement:server:${nodeId}`] })),
            ...diff.privilegeDelta.capabilitiesAdded.flatMap((c) => c.capabilities.map((cap) => ({ kind: cap.split(":").slice(0, 2).join(":"), scope: [`${c.nodeId}:${cap}`] }))),
        ];
        return { consumers: [], downstream: Array.from(downstream).sort(), privilegeDelta, testsToRun: [], oracleChanged: false };
    }

    async create(graphId: string, principal: Principal | undefined, input: { baseRevision: string; ops: any[]; description: string; rationale?: string; idempotencyKey: string }): Promise<{ proposal: Proposal; created: boolean } | ProposalError> {
        const allowed = decide(principal, ["graph:propose"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const existing = await this.getJson(ProposalService.byKey(graphId, input.idempotencyKey));
        if (existing && existing.proposalId) {
            const p = await this.get(graphId, existing.proposalId);
            if (p) return { proposal: p, created: false };
        }
        const head = await this.summaries.headOrCut(graphId);
        if (!head) {
            return { error: "no such graph", code: "NOT_FOUND" };
        }
        if (revId(input.baseRevision) !== head.revisionId) {
            return { error: `the graph is at ${revRef(head.revisionId)}, not ${input.baseRevision}`, code: "STALE_BASE", rebaseTo: revRef(head.revisionId) };
        }
        const m = await this.materialise(graphId, input.ops, principal);
        if ("error" in m) {
            return m;
        }
        const now = new Date();
        const requiredDecisions = this.decisionsFor(m.diff, principal);
        const proposal: Proposal = {
            proposalId: ulid(),
            graphId,
            state: requiredDecisions.length ? "awaiting-review" : "validated",
            baseRevision: revRef(head.revisionId),
            ops: input.ops,
            description: input.description.slice(0, 200),
            rationale: String(input.rationale || "").slice(0, 4000),
            idempotencyKey: input.idempotencyKey,
            principal: principal ? { sub: principal.sub, kind: principal.kind, tenant: principal.tenant, delegatedBy: principal.delegatedBy } : null,
            update: toBase64(m.update),
            proposalDigest: digestRef(sha256(m.update)),
            diffSummary: compactDiff(m.diff),
            validation: { ok: true, errors: [] },
            impact: this.impactOf(m.after, m.touched, m.diff),
            requiredDecisions,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
            decisions: [],
        };
        await this.putJson(ProposalService.key(graphId, proposal.proposalId), proposal);
        await this.putJson(ProposalService.projectionKey(graphId, proposal.proposalId), m.after);
        await this.putJson(ProposalService.byKey(graphId, input.idempotencyKey), { proposalId: proposal.proposalId });
        await this.admission.chain.append(graphId, { kind: "proposal.created", at: proposal.createdAt, graphId, proposalId: proposal.proposalId, principal: proposal.principal, description: proposal.description, baseRevision: proposal.baseRevision, proposalDigest: proposal.proposalDigest, diff: proposal.diffSummary, requiredDecisions });
        if (this.hooks.notify) await this.hooks.notify(graphId, { eventType: "proposal", action: "created", proposalId: proposal.proposalId, by: principal && principal.sub, state: proposal.state, description: proposal.description });
        return { proposal, created: true };
    }

    /** Re-validate against the graph as it is now; `rebase` re-applies the operations on the new head. */
    async validate(graphId: string, proposalId: string, principal: Principal | undefined, rebase = false): Promise<{ proposal: Proposal } | ProposalError> {
        const proposal = await this.get(graphId, proposalId);
        if (!proposal) {
            return { error: "no such proposal", code: "NOT_FOUND" };
        }
        if (proposal.state === "committed" || proposal.state === "rejected") {
            return { proposal };
        }
        const head = await this.summaries.headOrCut(graphId);
        if (!head) {
            return { error: "no such graph", code: "NOT_FOUND" };
        }
        if (revId(proposal.baseRevision) !== head.revisionId) {
            if (!rebase) {
                proposal.state = "stale";
                proposal.updatedAt = new Date().toISOString();
                await this.putJson(ProposalService.key(graphId, proposalId), proposal);
                return { error: `the graph moved to ${revRef(head.revisionId)}; validate with rebase to re-apply the operations there`, code: "STALE_BASE", rebaseTo: revRef(head.revisionId) };
            }
            // code edits on a node whose code changed underneath are a conflict, not a silent overwrite
            const base = await this.revisions.projection(graphId, revId(proposal.baseRevision));
            const live = await this.crdtStore.projectGraph(graphId);
            for (const op of proposal.ops) {
                if (op.op === "set-node-code" && base && live) {
                    const was = (base.nodes || []).find((n: any) => n.id === op.nodeId);
                    const is = (live.nodes || []).find((n: any) => n.id === op.nodeId);
                    if (was && is && JSON.stringify(was.template) !== JSON.stringify(is.template)) {
                        return { error: `node ${op.nodeId}'s code changed since ${proposal.baseRevision}`, code: "CONFLICT", rebaseTo: revRef(head.revisionId) };
                    }
                }
            }
        }
        const m = await this.materialise(graphId, proposal.ops, principal || (proposal.principal as any));
        if ("error" in m) {
            // Its operations no longer apply to the graph as it is, so it is
            // stale, not merely invalid: nothing here can be committed, and the
            // state says so rather than leaving it looking ready.
            proposal.validation = { ok: false, errors: [{ code: m.code, message: m.error }] };
            proposal.state = "stale";
            proposal.updatedAt = new Date().toISOString();
            await this.putJson(ProposalService.key(graphId, proposalId), proposal);
            return { proposal };
        }
        const proposer = proposal.principal as any;
        proposal.baseRevision = revRef(head.revisionId);
        proposal.update = toBase64(m.update);
        proposal.proposalDigest = digestRef(sha256(m.update));
        proposal.diffSummary = compactDiff(m.diff);
        proposal.validation = { ok: true, errors: [] };
        proposal.impact = this.impactOf(m.after, m.touched, m.diff);
        proposal.requiredDecisions = this.decisionsFor(m.diff, proposer);
        proposal.state = proposal.requiredDecisions.length ? "awaiting-review" : "validated";
        proposal.updatedAt = new Date().toISOString();
        await this.putJson(ProposalService.key(graphId, proposalId), proposal);
        await this.putJson(ProposalService.projectionKey(graphId, proposalId), m.after);
        return { proposal };
    }

    /** A human's decision: approve (recorded, bound to the digest) or reject. */
    async decideProposal(graphId: string, proposalId: string, principal: Principal | undefined, decision: "approve" | "reject", proposalDigest: string | undefined, rationale = ""): Promise<{ proposal: Proposal } | ProposalError> {
        const allowed = decide(principal, ["graph:approve"]);
        if (!allowed.allow) return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        const proposal = await this.get(graphId, proposalId);
        if (!proposal) return { error: "no such proposal", code: "NOT_FOUND" };
        if (proposal.state === "committed") return { error: "already committed", code: "CONFLICT" };
        if (proposalDigest && proposalDigest !== proposal.proposalDigest) return { error: "the proposal changed since you read it", code: "CONFLICT" };
        if (proposal.principal && principal && proposal.principal.sub === principal.sub && decision === "approve") return { error: "a proposal cannot be approved by its proposer", code: "ADMISSION_DENIED" };
        proposal.decisions.push({ by: principal ? principal.sub : "?", decision, rationale: rationale.slice(0, 2000), at: new Date().toISOString(), proposalDigest: proposal.proposalDigest });
        if (decision === "reject") {
            proposal.state = "rejected";
        } else {
            // an approval settles "approve", and the privileged decisions the approver is entitled to make
            const settles = new Set<string>(["approve"]);
            if (decide(principal, ["graph:connect-privileged"]).allow) settles.add("privileged-connect");
            if (decide(principal, ["iac:approve"]).allow) settles.add("iac-approve");
            proposal.requiredDecisions = proposal.requiredDecisions.filter((d) => !settles.has(d));
            if (!proposal.requiredDecisions.length) proposal.state = "validated";
        }
        proposal.updatedAt = new Date().toISOString();
        await this.putJson(ProposalService.key(graphId, proposalId), proposal);
        await this.admission.chain.append(graphId, { kind: "proposal.decided", at: proposal.updatedAt, graphId, proposalId, decision, principal: principal ? { sub: principal.sub, kind: principal.kind, tenant: principal.tenant } : null, proposalDigest: proposal.proposalDigest, rationale: rationale.slice(0, 2000) });
        if (this.hooks.notify) await this.hooks.notify(graphId, { eventType: "proposal", action: decision === "reject" ? "rejected" : "approved", proposalId, by: principal && principal.sub, state: proposal.state });
        return { proposal };
    }

    /**
     * Commit through the admission gate as the committing principal: the exact
     * bytes that were validated, audited like any edit, fanned out to every
     * replica, and a revision cut for the result.
     */
    async commit(graphId: string, proposalId: string, principal: Principal | undefined): Promise<{ proposal: Proposal; result: AdmissionResult } | ProposalError> {
        const proposal = await this.get(graphId, proposalId);
        if (!proposal) return { error: "no such proposal", code: "NOT_FOUND" };
        if (proposal.state === "committed") {
            return { proposal, result: { mutationId: proposal.mutationId || "", decision: "accepted", policyVersion: POLICY_VERSION, replayed: true } as AdmissionResult };
        }
        if (proposal.state === "rejected" || proposal.state === "expired") return { error: `the proposal is ${proposal.state}`, code: "CONFLICT" };
        const allowed = decide(principal, ["graph:commit"]);
        if (!allowed.allow) return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        const head = await this.summaries.headOrCut(graphId);
        if (head && revId(proposal.baseRevision) !== head.revisionId) {
            return { error: `the graph moved to ${revRef(head.revisionId)}; validate the proposal with rebase first`, code: "STALE_BASE", rebaseTo: revRef(head.revisionId) };
        }
        // decisions the committer cannot supply by committing
        const pending = proposal.requiredDecisions.filter((d) => {
            if (d === "approve") return !(principal && (!proposal.principal || principal.sub !== proposal.principal.sub));   // a different human's commit is the approval
            if (d === "privileged-connect") return !decide(principal, ["graph:connect-privileged"]).allow;
            if (d === "iac-approve") return !decide(principal, ["iac:approve"]).allow;
            return true;
        });
        if (pending.length) return { error: `still needs ${pending.join(", ")}`, code: "APPROVAL_REQUIRED", details: { requiredDecisions: pending } };
        const content = fromBase64(proposal.update);
        const result = await this.admission.admit({
            graphId, mutationId: ulid(), content, description: proposal.description, intent: `proposal ${proposalId}: ${proposal.rationale}`.slice(0, 4000),
            clientInfo: { name: "proposal", version: "1" }, principal,
        });
        if (result.decision !== "accepted") {
            proposal.validation = { ok: false, errors: [{ code: result.code || "REJECTED", message: result.reason || "" }] };
            proposal.updatedAt = new Date().toISOString();
            await this.putJson(ProposalService.key(graphId, proposalId), proposal);
            return { error: result.reason || "rejected", code: (result.code === "STALE_BASE" ? "STALE_BASE" : result.code === "ADMISSION_DENIED" ? "ADMISSION_DENIED" : "CONFLICT") as any };
        }
        if (this.hooks.fanOut) await this.hooks.fanOut(graphId, content);
        // execution and the TOC read plain projections; refresh them as an editor's edit would
        await this.crdtStore.writeProjections(graphId);
        const cut = await this.revisions.cut(graphId, principal, proposal.description);
        proposal.state = "committed";
        proposal.mutationId = result.mutationId;
        proposal.resultRevision = "error" in cut ? undefined : revRef(cut.revision.revisionId);
        proposal.warnings = result.warnings;
        proposal.decisions.push({ by: principal ? principal.sub : "?", decision: "commit", at: new Date().toISOString(), proposalDigest: proposal.proposalDigest });
        proposal.updatedAt = new Date().toISOString();
        await this.putJson(ProposalService.key(graphId, proposalId), proposal);
        await this.admission.chain.append(graphId, { kind: "proposal.committed", at: proposal.updatedAt, graphId, proposalId, mutationId: result.mutationId, resultRevision: proposal.resultRevision, principal: principal ? { sub: principal.sub, kind: principal.kind, tenant: principal.tenant } : null, proposer: proposal.principal });
        if (this.hooks.notify) await this.hooks.notify(graphId, { eventType: "proposal", action: "committed", proposalId, by: principal && principal.sub, mutationId: result.mutationId, resultRevision: proposal.resultRevision });
        return { proposal, result };
    }

    /* ------------------------------------------------------------ http (humans, editor) */

    private reply(callback: (err: any, r: any) => void, statusCode: number, body: any) {
        callback(null, { statusCode, body: JSON.stringify(body), headers: corsHeaders });
    }
    private statusFor(code: string): number {
        return code === "ADMISSION_DENIED" ? 403 : code === "NOT_FOUND" ? 404 : code === "STALE_BASE" || code === "CONFLICT" || code === "APPROVAL_REQUIRED" ? 409 : 400;
    }
    listRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        this.list(event.pathParameters.id)
            .then((proposals) => this.reply(callback, 200, { graphId: event.pathParameters.id, proposals }))
            .catch((err) => { console.error("Cannot list proposals.", err); callback(null, { statusCode: 500, headers: corsHeaders }); });
    }
    getRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const { id: graphId, proposalId } = event.pathParameters;
        Promise.all([this.get(graphId, proposalId), this.projection(graphId, proposalId)])
            .then(([proposal, projection]) => {
                if (!proposal) return this.reply(callback, 404, { error: "no such proposal", code: "NOT_FOUND" });
                const { update, ...rest } = proposal;
                return this.reply(callback, 200, { proposal: rest, projection });
            })
            .catch((err) => { console.error("Cannot read a proposal.", err); callback(null, { statusCode: 500, headers: corsHeaders }); });
    }
    createRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        let body: any = {};
        try { body = event.body ? JSON.parse(event.body) : {}; } catch (err) { body = {}; }
        this.create(event.pathParameters.id, event.principal, { baseRevision: body.baseRevision, ops: body.ops || [], description: body.description || "Proposal", rationale: body.rationale, idempotencyKey: body.idempotencyKey || ulid() })
            .then((r: any) => r.error ? this.reply(callback, this.statusFor(r.code), r) : this.reply(callback, r.created ? 201 : 200, { proposal: { ...r.proposal, update: undefined }, created: r.created }))
            .catch((err) => { console.error("Cannot create a proposal.", err); callback(null, { statusCode: 500, headers: corsHeaders }); });
    }
    decideRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const { id: graphId, proposalId } = event.pathParameters;
        let body: any = {};
        try { body = event.body ? JSON.parse(event.body) : {}; } catch (err) { body = {}; }
        this.decideProposal(graphId, proposalId, event.principal, body.decision === "reject" ? "reject" : "approve", body.proposalDigest, body.rationale || "")
            .then((r: any) => r.error ? this.reply(callback, this.statusFor(r.code), r) : this.reply(callback, 200, { proposal: { ...r.proposal, update: undefined } }))
            .catch((err) => { console.error("Cannot decide a proposal.", err); callback(null, { statusCode: 500, headers: corsHeaders }); });
    }
    commitRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const { id: graphId, proposalId } = event.pathParameters;
        this.commit(graphId, proposalId, event.principal)
            .then((r: any) => r.error ? this.reply(callback, this.statusFor(r.code), r) : this.reply(callback, 200, { proposal: { ...r.proposal, update: undefined }, result: r.result }))
            .catch((err) => { console.error("Cannot commit a proposal.", err); callback(null, { statusCode: 500, headers: corsHeaders }); });
    }
    validateRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const { id: graphId, proposalId } = event.pathParameters;
        const query = event.queryStringParameters || {};
        this.validate(graphId, proposalId, event.principal, query.rebase === "1" || query.rebase === "true")
            .then((r: any) => r.error ? this.reply(callback, this.statusFor(r.code), r) : this.reply(callback, 200, { proposal: { ...r.proposal, update: undefined } }))
            .catch((err) => { console.error("Cannot validate a proposal.", err); callback(null, { statusCode: 500, headers: corsHeaders }); });
    }
}
