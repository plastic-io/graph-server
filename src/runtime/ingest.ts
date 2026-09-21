import { Observation, ExecutionRecord, ObservationRecorder, byteLength } from "./observe";
import { readObservations } from "./executor";
import { Principal } from "../auth/principal";
import { decide } from "../policy/decide";
import { ExecutionRunner } from "./executor";

/**
 * Browser executions report what they did (plan §4.5.3, PB-053/054).
 *
 * A graph runs in two places, and only one of them can write to the store, so
 * the browser hands its observations here when an execution ends.  The report
 * is evidence from a client and is treated as such: the identity, the graph
 * and the domain are stamped from the request rather than read from the body,
 * unknown fields and unknown kinds are dropped, volume is capped, and the
 * first report of an execution wins so a retry cannot rewrite history.
 */

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const KINDS = new Set(["edge.input", "edge.output", "route", "exec.begin", "exec.end", "exec.error", "effect", "effect.denied",
    "budget.exhausted", "contract.violation", "component.unresolved", "test.result", "custom", "gap"]);
const MAX_OBSERVATIONS = 5000;
const MAX_BYTES = 2 * 1024 * 1024;
const STATES = new Set(["completed", "cancelled", "error", "budget", "unknown"]);

export interface IngestResult {
    record: ExecutionRecord;
    observations: number;
    replayed: boolean;
}

export interface IngestError {
    error: string;
    code: "ADMISSION_DENIED" | "SCHEMA_INVALID" | "LIMIT_EXCEEDED";
    details?: any;
}

interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
    setRaw(key: string, body: Buffer, meta: any, cb: (err: any, data: any) => void): void;
}

const str = (v: any, max: number): string | undefined => (typeof v === "string" && v ? v.slice(0, max) : undefined);
const num = (v: any): number => (typeof v === "number" && isFinite(v) ? v : 0);

export class ExecutionIngest {
    constructor(private store: Store) {}

    private putJson(key: string, value: any): Promise<void> {
        return new Promise((resolve, reject) => this.store.set(key, value, {}, (err: any) => (err ? reject(err) : resolve())));
    }
    private putRaw(key: string, observations: Observation[], graphId: string, executionId: string): Promise<void> {
        return new Promise((resolve, reject) => this.store.setRaw(key, Buffer.from(observations.map((o) => JSON.stringify(o)).join("\n") + "\n"), {
            "graph-id": graphId, "execution-id": executionId, domain: "browser",
        }, (err: any) => (err ? reject(err) : resolve())));
    }
    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }

    /** Keep only the fields an observation is allowed to carry, stamped with the identity of this request. */
    private clean(raw: any, seq: number, stamp: { graphId: string; executionId: string; revisionId: string; owner: any; correlationId: string }): Observation | null {
        if (!raw || typeof raw !== "object" || !KINDS.has(raw.kind)) {
            return null;
        }
        const at = typeof raw.at === "string" && !isNaN(Date.parse(raw.at)) ? raw.at : new Date().toISOString();
        return {
            id: ULID.test(String(raw.id)) ? raw.id : `${stamp.executionId}-${seq}`,
            seq: typeof raw.seq === "number" ? raw.seq : seq,
            at,
            kind: raw.kind,
            graphId: stamp.graphId,
            revisionId: stamp.revisionId,
            executionId: stamp.executionId,
            correlationId: stamp.correlationId,
            domain: "browser",
            owner: stamp.owner,
            instancePath: Array.isArray(raw.instancePath) ? raw.instancePath.slice(0, 16).map((p: any) => String(p).slice(0, 64)) : [],
            nodeId: str(raw.nodeId, 128),
            edgeField: str(raw.edgeField, 128),
            connectorId: str(raw.connectorId, 128),
            spanId: str(raw.spanId, 64),
            parentSpanId: str(raw.parentSpanId, 64),
            payload: raw.payload === undefined ? undefined : raw.payload,
            capability: raw.capability && typeof raw.capability === "object" ? {
                kind: String(raw.capability.kind || "").slice(0, 64),
                scope: Array.isArray(raw.capability.scope) ? raw.capability.scope.slice(0, 8).map((s: any) => String(s).slice(0, 256)) : [],
                decision: raw.capability.decision === "allowed" ? "allowed" : "denied",
                ...(raw.capability.layer ? { layer: String(raw.capability.layer).slice(0, 32) } : {}),
            } : undefined,
            budget: raw.budget && typeof raw.budget === "object" ? { dimension: String(raw.budget.dimension || "").slice(0, 32), used: num(raw.budget.used), limit: num(raw.budget.limit) } : undefined,
            sampled: !!raw.sampled,
        };
    }

    /**
     * Store one browser execution and its observations.  Returns the stored
     * record, or the reason it was refused.
     */
    async ingest(graphId: string, principal: Principal | undefined, body: any): Promise<IngestResult | IngestError> {
        const allowed = decide(principal, ["graph:read"]);
        if (!allowed.allow || !principal) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const raw = body && typeof body === "object" ? body : {};
        const incoming = raw.record && typeof raw.record === "object" ? raw.record : {};
        const executionId = String(incoming.executionId || "");
        if (!ULID.test(executionId)) {
            return { error: "executionId must be a ULID", code: "SCHEMA_INVALID" };
        }
        const observations = Array.isArray(raw.observations) ? raw.observations : [];
        if (observations.length > MAX_OBSERVATIONS) {
            return { error: `at most ${MAX_OBSERVATIONS} observations per execution`, code: "LIMIT_EXCEEDED", details: { count: observations.length, limit: MAX_OBSERVATIONS } };
        }
        const existing = await this.getJson(ExecutionRunner.executionKey(executionId));
        const owner = { sub: principal.sub, kind: principal.kind, tenant: principal.tenant };
        const revisionId = ULID.test(String(incoming.revisionId)) ? String(incoming.revisionId) : "live";
        const correlationId = ULID.test(String(incoming.correlationId)) ? String(incoming.correlationId) : executionId;
        const stamp = { graphId, executionId, revisionId, owner, correlationId };
        const cleaned: Observation[] = [];
        let bytes = 0;
        for (let i = 0; i < observations.length; i++) {
            const o = this.clean(observations[i], i + 1, stamp);
            if (!o) continue;
            bytes += byteLength(JSON.stringify(o));
            if (bytes > MAX_BYTES) {
                return { error: `at most ${MAX_BYTES} bytes of observations per execution`, code: "LIMIT_EXCEEDED", details: { bytes, limit: MAX_BYTES } };
            }
            cleaned.push(o);
        }
        const startedAt = typeof incoming.startedAt === "string" && !isNaN(Date.parse(incoming.startedAt)) ? incoming.startedAt : new Date().toISOString();
        const key = ObservationRecorder.keyFor(graphId, executionId, Date.parse(startedAt));
        const record: ExecutionRecord = {
            executionId,
            graphId,
            revisionId,
            owner,
            domain: "browser",
            entry: { nodeUrl: str(incoming.entry && incoming.entry.nodeUrl, 256) || "", field: str(incoming.entry && incoming.entry.field, 128) },
            startedAt,
            endedAt: typeof incoming.endedAt === "string" && !isNaN(Date.parse(incoming.endedAt)) ? incoming.endedAt : new Date().toISOString(),
            state: STATES.has(incoming.state) ? incoming.state : "unknown",
            reason: str(incoming.reason, 512),
            duration: num(incoming.duration),
            hops: num(incoming.hops),
            errors: num(incoming.errors),
            observations: { count: cleaned.length, key, sampled: !!(incoming.observations && incoming.observations.sampled), capped: !!(incoming.observations && incoming.observations.capped) },
            effects: {
                allowed: cleaned.filter((o) => o.kind === "effect").length,
                denied: cleaned.filter((o) => o.kind === "effect.denied").length,
            },
            correlationId,
            receivedAt: new Date().toISOString(),
        };
        /**
         * An execution can span both domains (plan §4.8.2), and then the server
         * already wrote its record.  The browser's half is not a duplicate of
         * it and must not be dropped: it is stored beside the record as that
         * session's report, and anyone asking what the execution did is given
         * both halves.  One report per session, first one wins.
         */
        if (existing) {
            const session = String(raw.sessionId || "session").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "session";
            const reportKey = `executions/${executionId}/reports/browser-${session}.json`;
            const already = await this.getJson(reportKey);
            if (already || !cleaned.length) {
                return { record: existing, observations: already ? already.count : 0, replayed: true };
            }
            const observationsKey = key.replace(/\.ndjson$/, `-browser-${session}.ndjson`);
            await this.putRaw(observationsKey, cleaned, graphId, executionId);
            await this.putJson(reportKey, {
                at: new Date().toISOString(), by: principal.sub, graphId, domain: "browser",
                sessionId: session, count: cleaned.length, observationsKey,
                hops: record.hops, errors: record.errors, effects: record.effects, state: record.state,
            });
            return { record: existing, observations: cleaned.length, replayed: true };
        }
        if (cleaned.length) {
            await this.putRaw(key, cleaned, graphId, executionId);
        }
        await this.putJson(ExecutionRunner.executionKey(executionId), record);
        await this.putJson(ExecutionRunner.byGraphKey(graphId, executionId), record);
        return { record, observations: cleaned.length, replayed: false };
    }

    /**
     * What ran for this graph, newest first, and what one execution observed.
     * Both halves of an execution that spanned domains are joined, so the
     * editor shows one story rather than a server list and a browser list.
     */
    async list(graphId: string, principal: Principal | undefined, limit = 50): Promise<any> {
        const allowed = decide(principal, ["graph:observe"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const prefix = `executions/by-graph/${graphId}/`;
        const keys = (await this.list_(prefix)).sort().reverse().slice(0, Math.min(200, limit));
        const executions: any[] = [];
        for (const key of keys) {
            const record = await this.getJson(key);
            if (record) {
                executions.push(record);
            }
        }
        return { graphId, executions };
    }

    async observations(graphId: string, executionId: string, principal: Principal | undefined): Promise<any> {
        const allowed = decide(principal, ["graph:observe"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const record = await this.getJson(ExecutionRunner.executionKey(executionId));
        if (!record || record.graphId !== graphId) {
            return { error: "no such execution", code: "NOT_FOUND" };
        }
        const payloads = decide(principal, ["graph:inspect-payloads"]).allow;
        const observations = await this.allObservations(record);
        return {
            execution: record,
            observations: payloads ? observations : observations.map((o: any) => (o.payload && o.payload.value !== undefined ? { ...o, payload: { meta: o.payload.meta, redacted: "payload" } } : o)),
        };
    }

    /** The owner's observations plus every half another domain contributed. */
    private async allObservations(record: any): Promise<any[]> {
        const own = await readObservations(this.store as any, record);
        const sideKeys = (await this.list_(`executions/${record.executionId}/deliveries/`))
            .concat(await this.list_(`executions/${record.executionId}/reports/`));
        const rest: any[] = [];
        for (const key of sideKeys) {
            const side = await this.getJson(key);
            if (side && side.observationsKey) {
                rest.push(...await readObservations(this.store as any, { observations: { key: side.observationsKey } } as any));
            }
        }
        return own.concat(rest).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }

    private list_(prefix: string): Promise<string[]> {
        return new Promise((resolve) => (this.store as any).list(prefix, (err: any, items: any[]) => resolve(err ? [] : (items || []).map((i: any) => i.Key))));
    }

    /** `GET /crdt/{id}/executions` and `GET /crdt/{id}/executions/{executionId}` */
    listRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": true };
        const { id: graphId, executionId } = event.pathParameters || {};
        const limit = Number((event.queryStringParameters || {}).limit || 50);
        const answer = executionId
            ? this.observations(graphId, executionId, event.principal)
            : this.list(graphId, event.principal, limit);
        answer
            .then((r: any) => callback(null, { statusCode: r.error ? (r.code === "ADMISSION_DENIED" ? 403 : 404) : 200, body: JSON.stringify(r), headers }))
            .catch((err) => { console.error("Cannot list executions.", err); callback(null, { statusCode: 500, headers }); });
    }

    /** `POST /crdt/{id}/executions` */
    route(event: any, context: any, callback: (err: any, r: any) => void) {
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": true };
        let body: any = {};
        try { body = event.body ? JSON.parse(event.body) : {}; } catch (err) { body = {}; }
        this.ingest(event.pathParameters.id, event.principal, body)
            .then((r: any) => {
                const status = r.error ? (r.code === "ADMISSION_DENIED" ? 403 : r.code === "LIMIT_EXCEEDED" ? 413 : 400) : r.replayed ? 200 : 201;
                callback(null, { statusCode: status, body: JSON.stringify(r.error ? r : { execution: r.record, observations: r.observations, replayed: r.replayed }), headers });
            })
            .catch((err) => { console.error("Cannot store a browser execution.", err); callback(null, { statusCode: 500, headers }); });
    }
}
