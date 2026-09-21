import * as Y from "yjs";
import { createHash } from "crypto";
import { ulid } from "ulid";
import { Principal } from "../auth/principal";
import { decide, Authority } from "../policy/decide";

/**
 * Admission (plan §4.4), stage A: the single place a mutation becomes trusted.  Every
 * update, from any transport, passes through admit(): structural guard, idempotency,
 * policy, append, audit.  The semantic diff and staging document (stage B) slot in
 * between the structural guard and the policy check.
 */
export interface AdmissionResult {
    mutationId: string;
    decision: "accepted" | "rejected";
    code?: "SCHEMA_INVALID" | "ADMISSION_DENIED" | "RATE_LIMITED" | "INTERNAL";
    reason?: string;
    updateId?: string;
    policyVersion: string;
    legacy?: boolean;
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

export const MAX_STRUCTS = Number(process.env.MAX_STRUCTS || 200000);

/** Store surface needed here (S3Service / MemoryStore / FakeS3Service all provide it). */
interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
}

export class AdmissionService {
    private crdtStore: any;
    private store: Store;
    constructor(crdtStore: any, store?: Store) {
        this.crdtStore = crdtStore;
        this.store = store || crdtStore.store;
    }

    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }
    private putJson(key: string, value: any): Promise<void> {
        return new Promise((resolve, reject) => this.store.set(key, value, {}, (err: any) => (err ? reject(err) : resolve())));
    }
    static recordKey(graphId: string, mutationId: string) { return `mutations/${graphId}/${mutationId}.json`; }
    static auditKey(graphId: string, id: string) { return `audit/${graphId}/${id}.json`; }

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
        const at = new Date().toISOString();
        const sha256 = createHash("sha256").update(req.content).digest("hex");
        const base = { mutationId: req.mutationId, legacy: req.legacy };
        const audit = async (result: AdmissionResult, extra: any = {}) => {
            try {
                await this.putJson(AdmissionService.auditKey(req.graphId, ulid()), {
                    kind: `mutation.${result.decision}`, at, graphId: req.graphId, mutationId: req.mutationId,
                    principal: req.principal ? { sub: req.principal.sub, kind: req.principal.kind, tenant: req.principal.tenant } : null,
                    decision: result.decision, code: result.code, reason: result.reason, updateId: result.updateId,
                    description: req.description, intent: req.intent, clientInfo: req.clientInfo, bytes: req.content.byteLength, sha256,
                    policyVersion: result.policyVersion, ...extra,
                });
            } catch (err) {
                console.error("Cannot write the audit record", err);
            }
        };

        // 1. idempotency: the same mutation id answers the same way, and is stored once
        const existing = await this.getJson(AdmissionService.recordKey(req.graphId, req.mutationId));
        if (existing && existing.result) {
            if (existing.sha256 !== sha256) {
                const result: AdmissionResult = { ...base, decision: "rejected", code: "SCHEMA_INVALID", reason: "mutationId was already used for different content", policyVersion: existing.result.policyVersion };
                await audit(result, { replay: true });
                return result;
            }
            return { ...existing.result, replayed: true } as AdmissionResult;
        }

        // 2. structural guard (never store bytes that do not decode)
        const check = AdmissionService.structuralCheck(req.content);
        if (check.ok === false) {
            const result: AdmissionResult = { ...base, decision: "rejected", code: "SCHEMA_INVALID", reason: check.reason, policyVersion: "m1-owner" };
            await audit(result);
            return result;
        }

        // 3. policy (stage A: the reference-instance owner policy; stage B decides on the semantic diff)
        const required: Authority[] = ["graph:commit"];
        const decision = decide(req.principal, required);
        if (!decision.allow) {
            const result: AdmissionResult = { ...base, decision: "rejected", code: "ADMISSION_DENIED", reason: decision.reason, policyVersion: decision.policyVersion };
            await audit(result);
            return result;
        }

        // 4. append the exact bytes that were validated
        const updateId = await this.crdtStore.appendUpdate(req.graphId, req.content, req.description, req.principal ? req.principal.sub : "Unknown");
        const result: AdmissionResult = { ...base, decision: "accepted", updateId, policyVersion: decision.policyVersion };

        // 5. record + audit
        try {
            await this.putJson(AdmissionService.recordKey(req.graphId, req.mutationId), { sha256, at, result });
        } catch (err) {
            console.error("Cannot write the mutation record", err);
        }
        await audit(result, { structs: check.structs });
        return result;
    }
}
