import { createHash } from "crypto";
import { monotonicFactory } from "ulid";

/** Ids that sort in creation order even within one millisecond (per process). */
const nextId = monotonicFactory();

/**
 * Hash-chained audit log per graph (plan PB-023).
 *
 * Every record carries the hash of the one before it, so a record cannot be
 * altered or removed without every later hash failing to verify.  Records are
 * immutable objects under `audit/<graphId>/<ulid>.json`; `HEAD.json` points at
 * the newest.  Two admissions of the same graph that overlap in different Lambda
 * instances can both read the same head and fork the chain; `verify` reports
 * that as a break rather than hiding it, and a conditional write of HEAD (S3
 * If-Match) is the follow-on that removes the race.
 */
export interface AuditRecord {
    id: string;
    seq: number;
    prev: string | null;
    hash: string;
    [key: string]: any;
}

interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
    list(prefix: string, cb: (err: any, data: any) => void): void;
}

/** JSON with keys in a fixed order and no undefined values, so a hash is reproducible. */
export function canonical(value: any): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value === undefined ? null : value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonical).join(",")}]`;
    }
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

export function hashRecord(record: Record<string, any>): string {
    const { hash, ...rest } = record;
    return createHash("sha256").update(canonical(rest)).digest("hex");
}

export class AuditChain {
    private store: Store;
    readonly prefix: string;
    constructor(store: Store, prefix = "audit") {
        this.store = store;
        this.prefix = prefix;
    }
    headKey(graphId: string) { return `${this.prefix}/${graphId}/HEAD.json`; }
    recordKey(graphId: string, id: string) { return `${this.prefix}/${graphId}/${id}.json`; }

    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }
    private putJson(key: string, value: any): Promise<void> {
        return new Promise((resolve, reject) => this.store.set(key, value, {}, (err: any) => (err ? reject(err) : resolve())));
    }
    private list(prefix: string): Promise<string[]> {
        return new Promise((resolve, reject) => this.store.list(prefix, (err: any, items: any[]) => (err ? reject(err) : resolve((items || []).map((i: any) => i.Key)))));
    }

    async append(graphId: string, body: Record<string, any>): Promise<AuditRecord> {
        const head = await this.getJson(this.headKey(graphId));
        const record: AuditRecord = { ...body, id: nextId(), seq: head && head.seq ? head.seq + 1 : 1, prev: head && head.hash ? head.hash : null, hash: "" };
        record.hash = hashRecord(record);
        await this.putJson(this.recordKey(graphId, record.id), record);
        await this.putJson(this.headKey(graphId), { id: record.id, seq: record.seq, hash: record.hash });
        return record;
    }

    /** Walk the chain oldest first (by seq, then id) and report every break. */
    async verify(graphId: string): Promise<{ ok: boolean; length: number; breaks: string[] }> {
        const headKey = this.headKey(graphId);
        const keys = (await this.list(`${this.prefix}/${graphId}/`)).filter((k) => k !== headKey);
        const breaks: string[] = [];
        const records: AuditRecord[] = [];
        for (const key of keys) {
            const record = await this.getJson(key);
            if (!record) { breaks.push(`${key}: unreadable`); continue; }
            records.push(record);
        }
        records.sort((a, b) => (a.seq - b.seq) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        let prevHash: string | null = null;
        let last: AuditRecord | null = null;
        for (const record of records) {
            if (record.hash !== hashRecord(record)) breaks.push(`${record.id}: content does not match its hash`);
            if (record.prev !== prevHash) breaks.push(`${record.id}: prev ${record.prev} does not match the previous record`);
            if (last && record.seq !== last.seq + 1) breaks.push(`${record.id}: seq ${record.seq} after ${last.seq}`);
            prevHash = record.hash;
            last = record;
        }
        const head = await this.getJson(headKey);
        if (last && (!head || head.hash !== last.hash)) breaks.push("HEAD does not point at the newest record");
        return { ok: breaks.length === 0, length: keys.length, breaks };
    }
}
