import { deliveryKey, shouldRunDelivery, EdgeDelivery, ObservationRecorder } from "@plastic-io/graph-crdt";
import { Principal } from "./../auth/principal";
import { decide } from "../policy/decide";

/**
 * Deliveries waiting for a browser (plan §4.8.2, PB-072/073).
 *
 * A server-owned execution that reaches a browser-placed node hands the value
 * to the browsers watching the graph and carries on; the hop happens in a
 * place this process does not control.  Handing it to nobody used to be
 * indistinguishable from handing it to someone: the message went out on a
 * channel with no listeners and the execution ended as if the node had run.
 *
 * So every delivery is parked here first.  A browser that takes one says so,
 * and a delivery nobody takes before its time runs out is recorded as what it
 * is — `exec.error {reason: "no-browser"}` against that execution — rather
 * than disappearing.  Parking is also what makes a reconnect worth anything:
 * a browser that was away can ask for what it missed, and the delivery key
 * keeps it from running twice what it already ran.
 */

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const KEY = /^[A-Za-z0-9_.:|-]{1,200}$/;
/** How long a delivery waits for a browser when the graph does not say. */
export const DEFAULT_TTL_MS = 120000;
/** How long a settled delivery is kept before the sweep forgets it. */
export const RETENTION_MS = 24 * 60 * 60 * 1000;

export type ParkedState = "pending" | "claimed" | "expired";

export interface ParkedDelivery {
    graphId: string;
    executionId: string;
    key: string;
    delivery: EdgeDelivery;
    parkedAt: string;
    expiresAt: string;
    state: ParkedState;
    target?: string;
    initiator?: string;
    claimedBy?: string;
    claimedAt?: string;
    /** Every session that ran it; a node every viewer draws runs in each of them. */
    runs?: { session: string; at: string; state?: string }[];
    /** Written when it expires, so the execution's story includes the hop that never happened. */
    observationsKey?: string;
    settledAt?: string;
}

interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
    setRaw(key: string, body: Buffer, meta: any, cb: (err: any, data: any) => void): void;
    remove(key: string, cb: (err: any, data: any) => void): void;
    list(prefix: string, cb: (err: any, items: any[]) => void): void;
}

export class ParkingService {
    constructor(private store: Store, private deps: { now?: () => Date } = {}) {}

    private now(): Date {
        return this.deps.now ? this.deps.now() : new Date();
    }

    static prefix(graphId?: string, executionId?: string): string {
        if (!graphId) {
            return "deliveries/pending/";
        }
        return executionId ? `deliveries/pending/${graphId}/${executionId}/` : `deliveries/pending/${graphId}/`;
    }

    static key(graphId: string, executionId: string, key: string): string {
        return `${ParkingService.prefix(graphId, executionId)}${key}.json`;
    }

    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }
    private putJson(key: string, value: any): Promise<void> {
        return new Promise((resolve, reject) => this.store.set(key, value, {}, (err: any) => (err ? reject(err) : resolve())));
    }
    private listKeys(prefix: string): Promise<string[]> {
        return new Promise((resolve) => this.store.list(prefix, (err: any, items: any[]) => resolve(err ? [] : (items || []).map((i: any) => i.Key))));
    }

    /**
     * Hold a delivery until a browser takes it.  The same delivery arriving
     * twice — a re-broadcast, a retry — is the same unit of work, so the
     * record that is already here wins.
     */
    async park(graphId: string, delivery: EdgeDelivery, ttlMs?: number): Promise<ParkedDelivery | null> {
        if (!delivery || !ULID.test(String(delivery.executionId)) || !delivery.nodeId || typeof delivery.seq !== "number") {
            return null;
        }
        const key = deliveryKey({ ...delivery, executionId: delivery.executionId });
        const objectKey = ParkingService.key(graphId, delivery.executionId, key);
        const existing = await this.getJson(objectKey);
        if (existing) {
            return existing;
        }
        const at = this.now();
        const ttl = typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
        const record: ParkedDelivery = {
            graphId,
            executionId: delivery.executionId,
            key,
            delivery,
            parkedAt: at.toISOString(),
            expiresAt: new Date(at.getTime() + ttl).toISOString(),
            state: "pending",
            target: delivery.target,
            initiator: delivery.initiator,
            runs: [],
        };
        await this.putJson(objectKey, record);
        return record;
    }

    /**
     * What is still waiting.  A session asking gets what it would run: a node
     * every viewer draws, or one addressed to it.
     */
    async pending(graphId: string, principal: Principal | undefined, options: { session?: string; executionId?: string; limit?: number } = {}): Promise<any> {
        const allowed = decide(principal, ["graph:read"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const now = this.now().getTime();
        const keys = await this.listKeys(ParkingService.prefix(graphId, options.executionId));
        const deliveries: ParkedDelivery[] = [];
        for (const objectKey of keys.slice(0, Math.min(500, options.limit || 200))) {
            const record: ParkedDelivery = await this.getJson(objectKey);
            if (!record || record.state === "expired") {
                continue;
            }
            if (new Date(record.expiresAt).getTime() <= now) {
                continue;                                   // the sweep will say so; it is not this session's to run
            }
            if (!options.session) {
                // Nobody in particular is asking: this is "what is still
                // waiting for a browser", so a hop somebody has taken is not.
                if (record.state !== "pending") {
                    continue;
                }
                deliveries.push(record);
                continue;
            }
            if (!shouldRunDelivery(record.delivery || {}, options.session)) {
                continue;
            }
            if ((record.runs || []).some((run) => run.session === options.session)) {
                continue;                                   // this session has already run it
            }
            /**
             * A node that only draws is drawn by every viewer, so one viewer
             * taking it does not take it from the others; a node that acts
             * happens once, so a claim ends it (plan §4.8.2).
             */
            if (record.delivery && record.delivery.target === "initiator" && record.state === "claimed") {
                continue;
            }
            deliveries.push(record);
        }
        deliveries.sort((a, b) => (a.parkedAt < b.parkedAt ? -1 : 1));
        return { graphId, deliveries: deliveries.map((d) => d.delivery), parked: deliveries.length };
    }

    /**
     * A browser takes a delivery.  Taking is what counts, not finishing: a tab
     * that dies mid-way leaves the hop undone, and running an effect a second
     * time is worse than not running it at all (plan §4.8.2).
     */
    async claim(graphId: string, principal: Principal | undefined, body: any): Promise<any> {
        const allowed = decide(principal, ["graph:read"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const executionId = String((body || {}).executionId || "");
        const key = String((body || {}).key || "");
        const session = String((body || {}).session || "");
        if (!ULID.test(executionId) || !KEY.test(key) || !session) {
            return { error: "a claim needs executionId (ULID), key and session", code: "SCHEMA_INVALID" };
        }
        const objectKey = ParkingService.key(graphId, executionId, key);
        const record: ParkedDelivery = await this.getJson(objectKey);
        if (!record) {
            return { error: "no delivery is parked under that key", code: "NOT_FOUND" };
        }
        if (record.state === "expired") {
            return { error: "that delivery waited for a browser and stopped waiting", code: "EXPIRED", parked: record };
        }
        const at = this.now().toISOString();
        const runs = (record.runs || []).filter((r) => r.session !== session)
            .concat([{ session, at, state: String((body || {}).state || "taken") }]);
        const next: ParkedDelivery = {
            ...record,
            state: "claimed",
            claimedBy: record.claimedBy || session,
            claimedAt: record.claimedAt || at,
            settledAt: at,
            runs,
        };
        await this.putJson(objectKey, next);
        return { graphId, executionId, key, claimed: true, by: next.claimedBy, runs: runs.length, alreadyClaimed: !!record.claimedBy && record.claimedBy !== session };
    }

    /**
     * The tick's half of it: a delivery whose time ran out is recorded against
     * its execution as an error with the reason, so a person reading what
     * happened sees the hop that never happened rather than an execution that
     * simply stops.  Settled records are forgotten after a day.
     */
    async sweep(options: { limit?: number } = {}): Promise<{ considered: number; expired: any[]; forgotten: number }> {
        const now = this.now().getTime();
        const keys = await this.listKeys(ParkingService.prefix());
        const expired: any[] = [];
        let forgotten = 0;
        let considered = 0;
        for (const objectKey of keys.slice(0, Math.min(2000, options.limit || 1000))) {
            const record: ParkedDelivery = await this.getJson(objectKey);
            if (!record || !record.delivery) {
                continue;
            }
            considered += 1;
            if (record.state !== "pending") {
                const settled = new Date(record.settledAt || record.expiresAt).getTime();
                if (now - settled > RETENTION_MS) {
                    await new Promise<void>((resolve) => this.store.remove(objectKey, () => resolve()));
                    forgotten += 1;
                }
                continue;
            }
            if (new Date(record.expiresAt).getTime() > now) {
                continue;
            }
            const observationsKey = await this.recordNoBrowser(record);
            await this.putJson(objectKey, { ...record, state: "expired", settledAt: new Date(now).toISOString(), observationsKey });
            expired.push({ graphId: record.graphId, executionId: record.executionId, key: record.key, nodeId: record.delivery.nodeId });
        }
        return { considered, expired, forgotten };
    }

    /** One observation, in the execution's own voice, saying nobody took the hop. */
    private async recordNoBrowser(record: ParkedDelivery): Promise<string | undefined> {
        const execution: any = await this.getJson(`executions/${record.executionId}.json`);
        const owner = (execution && execution.owner) || { sub: "system", kind: "system", tenant: "system" };
        const recorder = new ObservationRecorder({
            graphId: record.graphId,
            revisionId: (record.delivery && record.delivery.revisionId) || (execution && execution.revisionId) || "live",
            executionId: record.executionId,
            owner,
            domain: "server",
        });
        recorder.record({
            kind: "exec.error",
            nodeId: record.delivery.nodeId,
            edgeField: record.delivery.field,
            payload: {
                message: `no browser ran ${record.delivery.nodeId}: the delivery waited ${Math.round((new Date(record.expiresAt).getTime() - new Date(record.parkedAt).getTime()) / 1000)}s`,
                code: "NO_BROWSER",
                reason: "no-browser",
                target: record.target,
                initiator: record.initiator,
                seq: record.delivery.seq,
            },
        });
        const key = `observations/${record.graphId}/${stamp(record.parkedAt)}/${record.executionId}-${record.key}-no-browser.ndjson`;
        await new Promise<void>((resolve, reject) => this.store.setRaw(key, Buffer.from(recorder.ndjson()), {
            "graph-id": record.graphId, "execution-id": record.executionId, domain: "server",
        }, (err: any) => (err ? reject(err) : resolve())));
        return key;
    }

    /** `GET /crdt/{id}/deliveries/pending` */
    pendingRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": true };
        const query = event.queryStringParameters || {};
        this.pending(event.pathParameters.id, event.principal, {
            session: query.session, executionId: query.executionId, limit: Number(query.limit) || undefined,
        })
            .then((r: any) => callback(null, { statusCode: r.error ? (r.code === "ADMISSION_DENIED" ? 403 : 400) : 200, body: JSON.stringify(r), headers }))
            .catch((err) => { console.error("Cannot list parked deliveries.", err); callback(null, { statusCode: 500, headers }); });
    }

    /** `POST /crdt/{id}/deliveries/claim` */
    claimRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": true };
        let body: any = {};
        try { body = event.body ? JSON.parse(event.body) : {}; } catch (err) { body = {}; }
        this.claim(event.pathParameters.id, event.principal, body)
            .then((r: any) => {
                const status = r.error ? (r.code === "ADMISSION_DENIED" ? 403 : r.code === "NOT_FOUND" ? 404 : r.code === "EXPIRED" ? 409 : 400) : 200;
                callback(null, { statusCode: status, body: JSON.stringify(r), headers });
            })
            .catch((err) => { console.error("Cannot claim a delivery.", err); callback(null, { statusCode: 500, headers }); });
    }
}

/** The hour a delivery was parked in, which is how observations are filed. */
function stamp(at: string): string {
    const d = new Date(at);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}${String(d.getUTCHours()).padStart(2, "0")}`;
}
