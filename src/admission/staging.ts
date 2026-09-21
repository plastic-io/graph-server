import * as Y from "yjs";
import {
    toJSON, applyUpdate, semanticDiff, schemaVersionOf, SCHEMA_VERSION, encodeStateVector, DiffSummary,
} from "@plastic-io/graph-crdt";

/**
 * Staged application (plan §4.4.2 step 3-4): apply the candidate update to a copy
 * of the current document and describe what it changed.  The bytes stored later
 * are exactly the bytes staged here, so replicas see what was validated.
 */
export type StagingResult =
    | {
        ok: true;
        diff: DiffSummary;
        before: any | null;
        after: any | null;
        headStateVector: Uint8Array;
        schemaVersion: number;
        cleared: boolean;
    }
    | { ok: false; code: "SCHEMA_INVALID" | "STALE_BASE"; reason: string };

/** The meta map as JSON; it is not part of the projection, so the diff cannot see it. */
function metaOf(doc: Y.Doc): Record<string, any> {
    const meta = doc.getMap("graph").get("meta");
    return meta instanceof Y.Map ? meta.toJSON() : {};
}

/** A fingerprint of what the document is still waiting for (structs it cannot integrate yet). */
function pendingSignature(doc: Y.Doc): string {
    const store: any = doc.store;
    const parts: string[] = [];
    if (store.pendingStructs && store.pendingStructs.missing) {
        store.pendingStructs.missing.forEach((clock: number, client: number) => parts.push(`${client}:${clock}`));
    }
    if (store.pendingDs) {
        parts.push(`ds:${store.pendingDs.byteLength}`);
    }
    return parts.sort().join(",");
}

export function stage(head: Uint8Array | null, content: Uint8Array): StagingResult {
    const doc = new Y.Doc();
    try {
        if (head) {
            applyUpdate(doc, head);
        }
        const before = toJSON(doc);
        const versionBefore = schemaVersionOf(doc);
        const metaBefore = metaOf(doc);
        const pendingBefore = pendingSignature(doc);
        try {
            applyUpdate(doc, content);
        } catch (err: any) {
            return { ok: false, code: "SCHEMA_INVALID", reason: `update does not apply to the current document: ${err && err.message}` };
        }
        if (pendingSignature(doc) !== pendingBefore) {
            // The update references changes this server has never seen.  Storing it
            // would leave a hole every reader trips over; the sender must wait for its
            // earlier changes to be acknowledged (or resynchronise) and send again.
            return { ok: false, code: "STALE_BASE", reason: "the update depends on changes the server has not received" };
        }
        const after = toJSON(doc);
        const versionAfter = schemaVersionOf(doc);
        if (versionAfter > SCHEMA_VERSION) {
            return { ok: false, code: "SCHEMA_INVALID", reason: `document schema version ${versionAfter} is newer than this server supports (${SCHEMA_VERSION})` };
        }
        const diff = semanticDiff(before, after);
        const metaAfter = metaOf(doc);
        const metaKeys = Array.from(new Set(Object.keys(metaBefore).concat(Object.keys(metaAfter))))
            .filter((k) => JSON.stringify(metaBefore[k]) !== JSON.stringify(metaAfter[k])).sort();
        if (before !== null && metaKeys.length) {
            // `meta` is not part of the projection, so the diff cannot see it.
            diff.namespaces = Array.from(new Set(diff.namespaces.concat("meta"))).sort();
            diff.ops.push({ op: "set-meta", namespace: "meta", keys: metaKeys });
            diff.empty = false;
        }
        return {
            ok: true, diff, before, after,
            headStateVector: encodeStateVector(doc),
            schemaVersion: versionAfter,
            cleared: before !== null && after === null,
        };
    } finally {
        doc.destroy();
    }
}
