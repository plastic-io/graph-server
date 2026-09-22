import * as Y from "yjs";
import { createHash } from "crypto";
import { toBase64, DiffSummary } from "@plastic-io/graph-crdt";
import { Principal } from "../auth/principal";
import { decide, requiredAuthorities, serverOwnedViolation, POLICY_VERSION } from "../policy/decide";
import { AuditChain } from "../audit/chain";
import { stage } from "./staging";
import { MAX_STRUCTS, RateLimiter } from "./limits";

/**
 * Admission (plan §4.4): the single place a mutation becomes trusted.  Every update,
 * from any transport, passes through admit():
 *
 *   1. idempotency   the same mutationId answers the same way and is stored once
 *   2. rate          a principal that keeps sending refused updates is slowed down
 *   3. structure     the bytes are a Yjs V2 update within the size and struct limits
 *   4. staging       the update is applied to a copy of the current document and
 *                    described as a semantic diff (namespaces, nodes, wiring, privilege)
 *   5. policy        what the diff needs against what the principal holds
 *   6. append        the exact bytes that were staged
 *   7. audit         a hash-chained record of the decision, accepted or not
 */
export interface AdmissionResult {
    mutationId: string;
    decision: "accepted" | "rejected";
    code?: "SCHEMA_INVALID" | "ADMISSION_DENIED" | "RATE_LIMITED" | "STALE_BASE" | "INTEGRITY_FAILURE" | "INTERNAL";
    /** Accepted, but something is worth the sender's attention (an embedded component copy that drifted). */
    warnings?: string[];
    reason?: string;
    updateId?: string;
    policyVersion: string;
    legacy?: boolean;
    replayed?: boolean;
    /** What the change touched, for the sender and the audit record (values omitted). */
    diffSummary?: DiffSummaryCompact;
    /** The server's state vector after the change, base64, so the sender can resync. */
    headStateVector?: string;
    retryAfterMs?: number;
}

export interface DiffSummaryCompact {
    empty: boolean;
    seed: boolean;
    namespaces: string[];
    nodesAdded: number;
    nodesRemoved: number;
    nodesChanged: number;
    connectorsAdded: number;
    connectorsRemoved: number;
    privilegeDelta: DiffSummary["privilegeDelta"];
    ops: DiffSummary["ops"];
    opsTruncated: boolean;
}

export interface AdmissionRequest {
    graphId: string;
    mutationId: string;
    legacy?: boolean;
    content: Uint8Array;      // the Yjs V2 update itself (sync message content)
    description: string;
    intent?: string;
    clientInfo?: { name: string; version: string };
    principal: Principal | undefined;
}

export { MAX_STRUCTS };
const MAX_OPS_IN_SUMMARY = 50;

/** Checks the graph after the change for embedded component copies that no longer match their manifests. */
export type IntegrityCheck = (after: any, diff: DiffSummary) => Promise<{ problems: { nodeId: string; publishedId: string; version: number; reason: string }[] }>;

/** Store surface needed here (S3Service / MemoryStore / FakeS3Service all provide it). */
interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
    list(prefix: string, cb: (err: any, data: any) => void): void;
}

export function compactDiff(diff: DiffSummary): DiffSummaryCompact {
    return {
        empty: diff.empty,
        seed: diff.seed,
        namespaces: diff.namespaces,
        nodesAdded: diff.nodesAdded.length,
        nodesRemoved: diff.nodesRemoved.length,
        nodesChanged: diff.nodesChanged.length,
        connectorsAdded: diff.connectorsAdded.length,
        connectorsRemoved: diff.connectorsRemoved.length,
        privilegeDelta: diff.privilegeDelta,
        ops: diff.ops.slice(0, MAX_OPS_IN_SUMMARY),
        opsTruncated: diff.ops.length > MAX_OPS_IN_SUMMARY,
    };
}

export class AdmissionService {
    private crdtStore: any;
    private store: Store;
    readonly chain: AuditChain;
    readonly rate: RateLimiter;
    /** Set by the component service once it exists; absent in stand-alone use. */
    integrity: IntegrityCheck | null;
    /**
     * What to do with a graph once a change to it has been **accepted**.
     * Derived data lives here — the consumers index (PB-044) — and it is
     * deliberately not a gate: an index that can refuse an edit is a worse
     * index than a stale one, and it can be rebuilt from the projections.
     */
    admitted: ((after: any, diff: DiffSummary) => Promise<void>) | null;
    /** Resolves an agent's delegated scopes for a graph before policy runs (policy/delegation.ts). */
    resolvePrincipal: ((principal: Principal | undefined, graphId: string) => Promise<Principal | undefined>) | null;
    constructor(crdtStore: any, store?: Store, options: { rate?: RateLimiter; integrity?: IntegrityCheck } = {}) {
        this.crdtStore = crdtStore;
        this.store = store || crdtStore.store;
        this.chain = new AuditChain(this.store);
        this.rate = options.rate || new RateLimiter();
        this.integrity = options.integrity || null;
        this.admitted = null;
        this.resolvePrincipal = null;
    }

    /**
     * Steps 3 and 4 alone: is this a Yjs update that applies to the graph, and
     * what does it change?  Proposals use it to validate what they would
     * commit; nothing is stored.
     */
    async stageOnly(graphId: string, content: Uint8Array): Promise<
        | { ok: true; diff: DiffSummary; after: any; before: any; headStateVector: string; structs: number }
        | { ok: false; code: "SCHEMA_INVALID" | "STALE_BASE"; reason: string }> {
        const check = AdmissionService.structuralCheck(content);
        if (check.ok === false) {
            return { ok: false, code: "SCHEMA_INVALID", reason: check.reason };
        }
        const { update: head } = await this.crdtStore.loadMerged(graphId);
        const staged = stage(head, content);
        if (staged.ok === false) {
            return { ok: false, code: staged.code, reason: staged.reason };
        }
        if (staged.cleared) {
            return { ok: false, code: "SCHEMA_INVALID", reason: "the update would empty the graph" };
        }
        return { ok: true, diff: staged.diff, after: staged.after, before: staged.before, headStateVector: toBase64(staged.headStateVector), structs: check.structs };
    }

    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }
    private putJson(key: string, value: any): Promise<void> {
        return new Promise((resolve, reject) => this.store.set(key, value, {}, (err: any) => (err ? reject(err) : resolve())));
    }
    static recordKey(graphId: string, mutationId: string) { return `mutations/${graphId}/${mutationId}.json`; }

    /** Structural guard: the bytes must be a Yjs V2 update that applies to a document. */
    static structuralCheck(content: Uint8Array): { ok: true; structs: number } | { ok: false; reason: string } {
        let meta;
        try {
            meta = Y.parseUpdateMetaV2(content);
        } catch (err: any) {
            return { ok: false, reason: `not a Yjs V2 update: ${err && err.message}` };
        }
        let structs = 0;
        meta.to.forEach((to: number, client: number) => { structs += to - (meta.from.get(client) || 0); });
        if (structs > MAX_STRUCTS) {
            return { ok: false, reason: `update carries ${structs} structs; the limit is ${MAX_STRUCTS}` };
        }
        // parseUpdateMeta only reads the header; applying to a throwaway document proves the body decodes.
        const probe = new Y.Doc();
        try {
            Y.applyUpdateV2(probe, content);
        } catch (err: any) {
            return { ok: false, reason: `update does not apply: ${err && err.message}` };
        } finally {
            probe.destroy();
        }
        return { ok: true, structs };
    }

    async admit(req: AdmissionRequest): Promise<AdmissionResult> {
        if (this.resolvePrincipal && req.principal && req.principal.kind === "agent") {
            req = { ...req, principal: await this.resolvePrincipal(req.principal, req.graphId) };
        }
        const at = new Date().toISOString();
        const sha256 = createHash("sha256").update(req.content).digest("hex");
        const base = { mutationId: req.mutationId, legacy: req.legacy };
        const rateKey = req.principal ? req.principal.sub : "anonymous";
        const principalSummary = req.principal ? { sub: req.principal.sub, kind: req.principal.kind, tenant: req.principal.tenant } : null;
        const audit = async (result: AdmissionResult, extra: any = {}) => {
            this.rate.record(rateKey, result.decision !== "accepted");
            try {
                await this.chain.append(req.graphId, {
                    kind: `mutation.${result.decision}`, at, graphId: req.graphId, mutationId: req.mutationId,
                    principal: principalSummary,
                    decision: result.decision, code: result.code, reason: result.reason, updateId: result.updateId,
                    description: req.description, intent: req.intent, clientInfo: req.clientInfo, bytes: req.content.byteLength, sha256,
                    policyVersion: result.policyVersion, diff: result.diffSummary, ...extra,
                });
            } catch (err) {
                console.error("Cannot write the audit record", err);
            }
        };
        const reject = async (code: AdmissionResult["code"], reason: string, extra: Partial<AdmissionResult> = {}, auditExtra: any = {}): Promise<AdmissionResult> => {
            const result: AdmissionResult = { ...base, decision: "rejected", code, reason, policyVersion: POLICY_VERSION, ...extra };
            await audit(result, auditExtra);
            return result;
        };

        // 1. idempotency: the same mutation id answers the same way, and is stored once
        const existing = await this.getJson(AdmissionService.recordKey(req.graphId, req.mutationId));
        if (existing && existing.result) {
            if (existing.sha256 !== sha256) {
                return reject("SCHEMA_INVALID", "mutationId was already used for different content", { policyVersion: existing.result.policyVersion }, { replay: true });
            }
            return { ...existing.result, replayed: true } as AdmissionResult;
        }

        // 2. rate: the cheapest check, so a flood of garbage costs nothing to refuse
        const rate = this.rate.check(rateKey);
        if (!rate.ok) {
            return reject("RATE_LIMITED", rate.reason || "too many mutations", { retryAfterMs: rate.retryAfterMs });
        }

        // 3. structural guard (never store bytes that do not decode)
        const check = AdmissionService.structuralCheck(req.content);
        if (check.ok === false) {
            return reject("SCHEMA_INVALID", check.reason);
        }

        // 4. staging: apply to a copy of the head and describe the change
        const { update: head } = await this.crdtStore.loadMerged(req.graphId);
        const staged = stage(head, req.content);
        if (staged.ok === false) {
            return reject(staged.code, staged.reason);
        }
        const diffSummary = compactDiff(staged.diff);
        const headStateVector = toBase64(staged.headStateVector);
        if (staged.cleared) {
            return reject("SCHEMA_INVALID", "the update would empty the graph; delete it through the delete route instead", { diffSummary, headStateVector });
        }

        // 5. policy on the diff
        const violation = serverOwnedViolation(staged.diff, req.principal);
        if (violation) {
            return reject("ADMISSION_DENIED", violation, { diffSummary, headStateVector });
        }
        const required = requiredAuthorities(staged.diff);
        const decision = decide(req.principal, required);
        if (!decision.allow) {
            return reject("ADMISSION_DENIED", decision.reason || "denied", { diffSummary, headStateVector, policyVersion: decision.policyVersion }, { required });
        }

        // 5b. embedded component copies must still match what was published
        let warnings: string[] | undefined;
        if (this.integrity && !staged.diff.empty) {
            const { problems } = await this.integrity(staged.after, staged.diff);
            if (problems.length) {
                const text = problems.map((p) => `${p.nodeId}: ${p.reason}`);
                if (process.env.COMPONENT_INTEGRITY === "reject") {
                    return reject("INTEGRITY_FAILURE", text.join("; "), { diffSummary, headStateVector }, { problems });
                }
                warnings = text;
            }
        }

        // 6. append the exact bytes that were staged
        const updateId = await this.crdtStore.appendUpdate(req.graphId, req.content, req.description, req.principal ? req.principal.sub : "Unknown");
        const result: AdmissionResult = { ...base, decision: "accepted", updateId, policyVersion: decision.policyVersion, diffSummary, headStateVector, ...(warnings ? { warnings } : {}) };

        // 6b. what follows from the change now that it is the graph's: nothing
        // here may fail the mutation, which has already happened.
        if (this.admitted) {
            try {
                await this.admitted(staged.after, staged.diff);
            } catch (err) {
                console.error("Cannot follow up an accepted change", err);
            }
        }

        // 7. record + audit
        try {
            await this.putJson(AdmissionService.recordKey(req.graphId, req.mutationId), { sha256, at, result });
        } catch (err) {
            console.error("Cannot write the mutation record", err);
        }
        await audit(result, { structs: check.structs, required, ...(warnings ? { warnings } : {}) });
        return result;
    }
}
