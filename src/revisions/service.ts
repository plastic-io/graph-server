import * as Y from "yjs";
import { createHash } from "crypto";
import { ulid } from "ulid";
import {
    toJSON, applyUpdate, encodeStateVector, toBase64, fromBase64, reconcile, schemaVersionOf,
    canonical, definitionView, layoutView, semanticDiff, describeDiff, UPDATE_EVENT,
} from "@plastic-io/graph-crdt";
import { Principal } from "../auth/principal";
import { decide, Authority } from "../policy/decide";
import { AdmissionService, AdmissionResult } from "../admission/admit";
import CrdtStore from "../crdtStore";

/**
 * Revisions (plan §4.7), grown out of the document's own history.
 *
 * A revision is a Yjs snapshot of the graph's document: the state vector plus
 * the delete set, a few hundred bytes that name one exact point in the
 * document's causal history.  Because the update log is append-only and merged
 * without garbage collection, any revision can be rebuilt later with
 * `Y.createDocFromSnapshot` and checked against the digests taken when it was
 * cut.  Cutting a revision also stamps `meta.revision` into the document as a
 * system principal, so every replica knows which version it carries.
 *
 * Layout: `revisions/<graphId>/<revisionId>.json` (manifest, immutable),
 * `revisions/<graphId>/<revisionId>.projection.json` (the frozen JSON),
 * `revisions/<graphId>/HEAD.json` (newest), `active/<graphId>.json` (what runs).
 */
export interface Revision {
    revisionId: string;
    graphId: string;
    seq: number;
    parent: string | null;
    label: string;
    snapshot: string;          // base64 Y.encodeSnapshotV2
    stateVector: string;       // base64
    headUpdateId: string;
    auditHead: string | null;  // newest audit record id when cut, so "changes since" is a cheap list
    digest: { definition: string; layout: string; full: string };
    schemaVersion: number;
    pins: { components: any[]; artifacts: string[]; runtime: { scheduler: string } };
    mutationIds: string[];
    createdBy: { sub: string; kind: string; tenant: string } | null;
    at: string;
    counts: { nodes: number; connectors: number };
    diffFromParent: string | null;
}

export interface ActivePointer {
    revisionId: string;
    seq: number;
    label: string;
    at: string;
    by: string | null;
    digest: string;
}

export const SYSTEM_PRINCIPAL: Principal = { sub: "system:revisions", kind: "system", tenant: "system", scopes: [] };

/** How long after an activation a failure is still counted against it. */
const WINDOW_MINUTES = 15;

export let SCHEDULER_VERSION = "unknown";
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    SCHEDULER_VERSION = require("@plastic-io/plastic-io/package.json").version || SCHEDULER_VERSION;
} catch (err) { /* not resolvable in every packaging */ }

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": true };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function digestsOf(projection: any) {
    return {
        definition: sha256(canonical(definitionView(projection))),
        layout: sha256(canonical(layoutView(projection))),
        full: sha256(canonical(projection)),
    };
}

interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
    list(prefix: string, cb: (err: any, data: any) => void): void;
}

export class RevisionService {
    readonly crdtStore: CrdtStore;
    readonly admission: AdmissionService;
    private store: Store;
    private notify: (graphId: string, event: any) => Promise<void>;
    private fanOut: (graphId: string, update: Uint8Array) => Promise<void>;
    /** What must hold before a version may be the one that runs (plan §8.1.8). */
    gate: ((graphId: string, revisionId: string, projection: any) => Promise<{ gate: string; says: string }[]>) | null = null;

    constructor(crdtStore: CrdtStore, admission: AdmissionService, hooks: {
        notify?: (graphId: string, event: any) => Promise<void>;
        fanOut?: (graphId: string, update: Uint8Array) => Promise<void>;
        gate?: (graphId: string, revisionId: string, projection: any) => Promise<{ gate: string; says: string }[]>;
    } = {}) {
        this.crdtStore = crdtStore;
        this.admission = admission;
        this.store = crdtStore.store as any;
        this.notify = hooks.notify || (async () => undefined);
        this.fanOut = hooks.fanOut || (async () => undefined);
        this.gate = hooks.gate || null;
    }

    static manifestKey(graphId: string, revisionId: string) { return `revisions/${graphId}/${revisionId}.json`; }
    static projectionKey(graphId: string, revisionId: string) { return `revisions/${graphId}/${revisionId}.projection.json`; }
    static headKey(graphId: string) { return `revisions/${graphId}/HEAD.json`; }
    static windowKey(graphId: string, revisionId: string) { return `activations/${graphId}/${revisionId}.json`; }
    static activeKey(graphId: string) { return CrdtStore.activeKey(graphId); }
    static seqKey(graphId: string, seq: number) { return `revisions/${graphId}/seq/${seq}.json`; }

    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }
    private putJson(key: string, value: any): Promise<void> {
        return new Promise((resolve, reject) => this.store.set(key, value, {}, (err: any) => (err ? reject(err) : resolve())));
    }
    private listKeys(prefix: string): Promise<string[]> {
        return new Promise((resolve, reject) => this.store.list(prefix, (err: any, items: any[]) => (err ? reject(err) : resolve((items || []).map((i: any) => i.Key)))));
    }

    /* ------------------------------------------------------------ reading */

    async head(graphId: string): Promise<{ revisionId: string; seq: number } | null> {
        return this.getJson(RevisionService.headKey(graphId));
    }
    async active(graphId: string): Promise<ActivePointer | null> {
        return this.getJson(RevisionService.activeKey(graphId));
    }
    async get(graphId: string, revisionId: string): Promise<Revision | null> {
        return this.getJson(RevisionService.manifestKey(graphId, revisionId));
    }
    async projection(graphId: string, revisionId: string): Promise<any | null> {
        return this.getJson(RevisionService.projectionKey(graphId, revisionId));
    }
    /** The revision with this sequence number, via the index written at cut time. */
    async bySeq(graphId: string, seq: number): Promise<Revision | null> {
        const pointer = await this.getJson(RevisionService.seqKey(graphId, seq));
        return pointer && pointer.revisionId ? this.get(graphId, pointer.revisionId) : null;
    }
    /** Versions of this graph that were published as components, by seq. */
    async publishedVersions(graphId: string): Promise<Record<number, { at: string }>> {
        const keys = (await this.listKeys(`components/${graphId}/`)).filter((k) => k.endsWith("/manifest.json"));
        const out: Record<number, { at: string }> = {};
        for (const key of keys) {
            const m = await this.getJson(key);
            if (m && typeof m.version === "number") out[m.version] = { at: m.provenance && m.provenance.at };
        }
        return out;
    }
    /** Manifests oldest first, without the snapshot bytes. */
    async list(graphId: string): Promise<Omit<Revision, "snapshot" | "stateVector">[]> {
        const prefix = `revisions/${graphId}/`;
        const keys = (await this.listKeys(prefix)).filter((k) => k.endsWith(".json") && !k.endsWith(".projection.json") && !k.endsWith("HEAD.json") && !k.includes("/seq/"));
        const out: any[] = [];
        for (const key of keys) {
            const m = await this.getJson(key);
            if (m) {
                const { snapshot, stateVector, ...rest } = m;
                out.push(rest);
            }
        }
        return out.sort((a, b) => a.seq - b.seq);
    }

    /* ------------------------------------------------------------ cutting */

    /**
     * Name the document as it stands now.  Returns the existing head when
     * nothing changed since it was cut, so repeated saves never pile up
     * identical revisions.
     */
    async cut(graphId: string, principal: Principal | undefined, label = ""): Promise<{ revision: Revision; created: boolean } | { error: string; code: string }> {
        const allowed = decide(principal, ["graph:commit"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const merged = await this.crdtStore.loadMerged(graphId);
        if (!merged.update || !merged.headId) {
            return { error: "the graph has no document", code: "NOT_FOUND" };
        }
        const doc = new Y.Doc({ gc: false });
        try {
            applyUpdate(doc, merged.update);
            const projection = toJSON(doc);
            if (!projection) {
                return { error: "the document is empty", code: "NOT_FOUND" };
            }
            const digest = digestsOf(projection);
            const head = await this.head(graphId);
            const parent = head ? await this.get(graphId, head.revisionId) : null;
            if (parent && parent.digest.full === digest.full) {
                return { revision: parent, created: false };
            }
            const auditHead = await this.getJson(this.admission.chain.headKey(graphId));
            const revision: Revision = {
                revisionId: ulid(),
                graphId,
                seq: (head ? head.seq : 0) + 1,
                parent: parent ? parent.revisionId : null,
                label: String(label || "").slice(0, 200),
                snapshot: toBase64(Y.encodeSnapshotV2(Y.snapshot(doc))),
                stateVector: toBase64(encodeStateVector(doc)),
                headUpdateId: merged.headId,
                auditHead: auditHead ? auditHead.id : null,
                digest,
                schemaVersion: schemaVersionOf(doc),
                pins: {
                    components: projection.nodes.filter((n: any) => n.properties && n.properties.component).map((n: any) => ({ nodeId: n.id, ...n.properties.component })),
                    artifacts: Array.from(new Set(projection.nodes.map((n: any) => n.artifact).filter((a: any) => typeof a === "string" && a))),
                    runtime: { scheduler: SCHEDULER_VERSION },
                },
                mutationIds: await this.mutationsSince(graphId, parent ? parent.auditHead : null),
                createdBy: principal ? { sub: principal.sub, kind: principal.kind, tenant: principal.tenant } : null,
                at: new Date().toISOString(),
                counts: { nodes: projection.nodes.length, connectors: projection.nodes.reduce((n: number, node: any) => n + (node.edges || []).reduce((m: number, e: any) => m + ((e.connectors || []).length), 0), 0) },
                diffFromParent: null,
            };
            if (parent) {
                const before = await this.projection(graphId, parent.revisionId);
                revision.diffFromParent = describeDiff(semanticDiff(before, projection));
            }
            await this.putJson(RevisionService.manifestKey(graphId, revision.revisionId), revision);
            await this.putJson(RevisionService.projectionKey(graphId, revision.revisionId), projection);
            await this.putJson(RevisionService.headKey(graphId), { revisionId: revision.revisionId, seq: revision.seq });
            await this.putJson(RevisionService.seqKey(graphId, revision.seq), { revisionId: revision.revisionId });
            await this.admission.chain.append(graphId, {
                kind: "revision.cut", at: revision.at, graphId, revisionId: revision.revisionId, seq: revision.seq, label: revision.label,
                principal: revision.createdBy, digest, headUpdateId: revision.headUpdateId, mutations: revision.mutationIds.length,
            });
            await this.stamp(doc, graphId, revision);
            await this.notify(graphId, { eventType: "revision", action: "cut", revisionId: revision.revisionId, seq: revision.seq, label: revision.label, by: revision.createdBy && revision.createdBy.sub });
            return { revision, created: true };
        } finally {
            doc.destroy();
        }
    }

    /** Accepted mutations recorded after the given audit record id. */
    private async mutationsSince(graphId: string, afterAuditId: string | null): Promise<string[]> {
        const prefix = `${this.admission.chain.prefix}/${graphId}/`;
        const keys = (await this.listKeys(prefix)).filter((k) => !k.endsWith("HEAD.json")).sort();
        const recent = keys.filter((k) => !afterAuditId || k > `${prefix}${afterAuditId}.json`).slice(-500);
        const out: string[] = [];
        for (const key of recent) {
            const record = await this.getJson(key);
            // the server's own stamps (meta.revision) are bookkeeping, not changes anyone made
            if (record && record.kind === "mutation.accepted" && record.mutationId && !(record.principal && record.principal.kind === "system")) {
                out.push(record.mutationId);
            }
        }
        return out;
    }

    /**
     * Write `meta.revision` into the document as the system principal, through
     * the same admission gate as everything else, and fan it out.
     */
    private async stamp(doc: Y.Doc, graphId: string, revision: Revision): Promise<AdmissionResult | null> {
        let update: Uint8Array | null = null;
        const capture = (u: Uint8Array) => { update = u; };
        doc.on(UPDATE_EVENT as any, capture);
        doc.transact(() => {
            const root = doc.getMap("graph");
            let meta = root.get("meta") as Y.Map<any> | undefined;
            if (!(meta instanceof Y.Map)) {
                meta = new Y.Map<any>();
                root.set("meta", meta);
            }
            meta.set("revision", { id: revision.revisionId, seq: revision.seq, label: revision.label, at: revision.at });
        }, { source: "revisions" });
        doc.off(UPDATE_EVENT as any, capture);
        if (!update) {
            return null;
        }
        const result = await this.admission.admit({
            graphId, mutationId: ulid(), content: update, description: `Version ${revision.seq}`,
            intent: `stamp revision ${revision.revisionId}`, clientInfo: { name: "graph-server", version: "revisions" }, principal: SYSTEM_PRINCIPAL,
        });
        if (result.decision === "accepted") {
            await this.fanOut(graphId, update);
        } else {
            console.error("Cannot stamp the revision into the document", result);
        }
        return result;
    }

    /* ------------------------------------------------------------ rebuilding */

    /**
     * Rebuild the projection at a revision from the document's own history
     * and check it against the digest taken when the revision was cut.
     */
    async materialize(graphId: string, revisionId: string): Promise<{ projection: any; verified: boolean } | null> {
        const revision = await this.get(graphId, revisionId);
        if (!revision) {
            return null;
        }
        const merged = await this.crdtStore.loadMerged(graphId);
        if (!merged.update) {
            return null;
        }
        const base = new Y.Doc({ gc: false });
        let then: Y.Doc | null = null;
        try {
            applyUpdate(base, merged.update);
            then = Y.createDocFromSnapshot(base, Y.decodeSnapshotV2(fromBase64(revision.snapshot)));
            const projection = toJSON(then);
            const verified = !!projection && digestsOf(projection).full === revision.digest.full;
            return { projection, verified };
        } finally {
            base.destroy();
            if (then) then.destroy();
        }
    }

    /* ------------------------------------------------------------ activation */

    /** Make a revision the one execution loads (plan §4.7.4).  Idempotent. */
    async activate(graphId: string, revisionId: string, principal: Principal | undefined, force = false): Promise<{ active: ActivePointer } | { error: string; code: string }> {
        const allowed = decide(principal, ["graph:activate"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const revision = await this.get(graphId, revisionId);
        const projection = await this.projection(graphId, revisionId);
        if (!revision || !projection) {
            return { error: "no such revision", code: "NOT_FOUND" };
        }
        /**
         * The pre-activation gate (plan §8.1.8): activation is the moment a
         * change reaches the people using the application, so what is about to
         * run is checked first — against this revision, not against the live
         * graph.  `force` is for the person who has read the findings and
         * wants it anyway; it is recorded in the audit with their name on it.
         */
        if (!force && this.gate) {
            const findings = await this.gate(graphId, revisionId, projection);
            if (findings.length) {
                return {
                    error: `this version is not ready to run: ${findings.map((f) => f.says).join("; ")}`,
                    code: "GATE_FAILED",
                    details: { findings },
                } as any;
            }
        }
        const active: ActivePointer = { revisionId, seq: revision.seq, label: revision.label, at: new Date().toISOString(), by: principal ? principal.sub : null, digest: revision.digest.full };
        await this.crdtStore.writeExecutionProjection(projection, { revisionId, seq: revision.seq });
        await this.putJson(RevisionService.activeKey(graphId), active);
        await this.admission.chain.append(graphId, { kind: "revision.activated", at: active.at, graphId, revisionId, seq: revision.seq, principal: principal ? { sub: principal.sub, kind: principal.kind, tenant: principal.tenant } : null, digest: revision.digest.full, ...(force ? { forced: true } : {}) });
        // What runs was just changed; anything that fails in the next while is
        // worth connecting to this (plan §8.1.8, the post-activation window).
        await this.putJson(RevisionService.windowKey(graphId, revisionId), {
            graphId, revisionId, seq: revision.seq, at: active.at,
            until: new Date(Date.now() + WINDOW_MINUTES * 60000).toISOString(),
            by: active.by, forced: !!force, alerts: [],
        });
        await this.notify(graphId, { eventType: "revision", action: "activated", revisionId, seq: revision.seq, label: revision.label, by: active.by });
        return { active };
    }

    /* ------------------------------------------------------------ restore */

    /**
     * Bring the live document back to a revision as an ordinary admitted
     * change (history is never rewritten, plan §4.7.6), so it merges with
     * concurrent edits, is audited, and can itself be undone or re-versioned.
     */
    async restore(graphId: string, revisionId: string, principal: Principal | undefined): Promise<AdmissionResult | { error: string; code: string }> {
        const revision = await this.get(graphId, revisionId);
        const target = await this.projection(graphId, revisionId);
        if (!revision || !target) {
            return { error: "no such revision", code: "NOT_FOUND" };
        }
        const merged = await this.crdtStore.loadMerged(graphId);
        const doc = new Y.Doc();
        try {
            if (merged.update) {
                applyUpdate(doc, merged.update);
            }
            let update: Uint8Array | null = null;
            const capture = (u: Uint8Array) => { update = u; };
            doc.on(UPDATE_EVENT as any, capture);
            reconcile(doc, target, { source: "restore" });
            doc.off(UPDATE_EVENT as any, capture);
            if (!update) {
                return { mutationId: "", decision: "accepted", policyVersion: "none", reason: `already at version ${revision.seq}` } as AdmissionResult;
            }
            const result = await this.admission.admit({
                graphId, mutationId: ulid(), content: update, description: `Restore version ${revision.seq}`,
                intent: `restore revision ${revisionId}`, clientInfo: { name: "graph-server", version: "revisions" }, principal,
            });
            if (result.decision === "accepted") {
                await this.fanOut(graphId, update);
                await this.crdtStore.writeProjections(graphId);
                await this.notify(graphId, { eventType: "revision", action: "restored", revisionId, seq: revision.seq, by: principal ? principal.sub : null });
            }
            return result;
        } finally {
            doc.destroy();
        }
    }

    /* ------------------------------------------------------------ http */

    private reply(callback: (err: any, r: any) => void, statusCode: number, body: any) {
        callback(null, { statusCode, body: JSON.stringify(body), headers: corsHeaders });
    }
    private statusFor(code: string): number {
        if (code === "GATE_FAILED") return 409;
        return code === "ADMISSION_DENIED" ? 403 : code === "NOT_FOUND" ? 404 : code === "RATE_LIMITED" ? 429 : 400;
    }

    listRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const graphId = event.pathParameters.id;
        Promise.all([this.list(graphId), this.head(graphId), this.active(graphId), this.publishedVersions(graphId)])
            .then(([revisions, head, active, published]) => this.reply(callback, 200, { graphId, head, active, published, revisions }))
            .catch((err) => { console.error("Cannot list revisions.", err); callback(null, { statusCode: 500, headers: corsHeaders }); });
    }

    cutRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const graphId = event.pathParameters.id;
        let body: any = {};
        try { body = event.body ? JSON.parse(event.body) : {}; } catch (err) { body = {}; }
        this.cut(graphId, event.principal, body.label)
            .then((r: any) => r.error ? this.reply(callback, this.statusFor(r.code), r) : this.reply(callback, r.created ? 201 : 200, r))
            .catch((err) => { console.error("Cannot cut a revision.", err); callback(null, { statusCode: 500, headers: corsHeaders }); });
    }

    getRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const { id: graphId, revisionId } = event.pathParameters;
        const query = event.queryStringParameters || {};
        (async () => {
            const revision = await this.get(graphId, revisionId);
            if (!revision) {
                return this.reply(callback, 404, { error: "no such revision", code: "NOT_FOUND" });
            }
            if (query.materialize) {
                const built = await this.materialize(graphId, revisionId);
                return this.reply(callback, 200, { revision, projection: built && built.projection, verified: !!(built && built.verified), materialized: true });
            }
            return this.reply(callback, 200, { revision, projection: await this.projection(graphId, revisionId), materialized: false });
        })().catch((err) => { console.error("Cannot read a revision.", err); callback(null, { statusCode: 500, headers: corsHeaders }); });
    }

    activateRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const { id: graphId, revisionId } = event.pathParameters;
        // `?force=1` is for someone who has read what the gate found
        const force = /(^|&)force=1/.test(String(event.rawQueryString || "")) || !!(event.queryStringParameters && event.queryStringParameters.force);
        this.activate(graphId, revisionId, event.principal, force)
            .then((r: any) => r.error ? this.reply(callback, this.statusFor(r.code), r) : this.reply(callback, 200, r))
            .catch((err) => { console.error("Cannot activate a revision.", err); callback(null, { statusCode: 500, headers: corsHeaders }); });
    }

    restoreRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const { id: graphId, revisionId } = event.pathParameters;
        this.restore(graphId, revisionId, event.principal)
            .then((r: any) => {
                if (r.error) return this.reply(callback, this.statusFor(r.code), r);
                const status = r.decision === "accepted" ? 200 : this.statusFor(r.code || "");
                return this.reply(callback, status, { ok: r.decision === "accepted", ...r });
            })
            .catch((err) => { console.error("Cannot restore a revision.", err); callback(null, { statusCode: 500, headers: corsHeaders }); });
    }
}

export type { Authority };
