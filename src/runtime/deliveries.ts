import { deliveryKey, placementOf, wireValue, EdgeDelivery, ObservationRecorder, Observation } from "@plastic-io/graph-crdt";
import { Principal } from "./../auth/principal";
import { decide } from "../policy/decide";
import { ExecutionRunner } from "./executor";
import CrdtStore from "../crdtStore";

/**
 * The other half of hybrid execution (plan §4.8.2, PB-071/072): a browser is
 * running a graph and reaches a node placed on the server.
 *
 * The browser cannot run that node — that is the whole point of placement — so
 * it asks here.  The server runs exactly that node, with the identity of the
 * caller rather than anything in the message, and answers with the values the
 * node wrote to its output edges so the browser can carry on routing them.
 *
 * A delivery is one unit of work with a name, `(connectorId|nodeId, seq)`
 * within an execution.  Asking twice returns the first answer instead of
 * running the node again, because a retry after a dropped connection must not
 * charge a credit card twice.
 */

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface DeliveryResult {
    executionId: string;
    nodeId: string;
    /** What the node wrote to its outputs, in the order it wrote them. */
    outputs: { field: string; value: any }[];
    observations: Observation[];
    state: "completed" | "error";
    error?: string;
    replayed: boolean;
    duration: number;
}

export interface DeliveryError {
    error: string;
    code: "ADMISSION_DENIED" | "SCHEMA_INVALID" | "NOT_FOUND" | "PLACEMENT" | "LIMIT_EXCEEDED";
}

interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
    setRaw(key: string, body: Buffer, meta: any, cb: (err: any, data: any) => void): void;
    remove(key: string, cb: (err: any, data: any) => void): void;
}

export class DeliveryService {
    constructor(private store: Store, private crdtStore: CrdtStore, private deps: { runner: (live: (o: Observation) => void) => ExecutionRunner }) {}

    static key(executionId: string, delivery: { connectorId?: string; nodeId: string; seq: number }): string {
        return `executions/${executionId}/deliveries/${deliveryKey({ ...delivery, executionId })}.json`;
    }

    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }
    private putJson(key: string, value: any): Promise<void> {
        return new Promise((resolve, reject) => this.store.set(key, value, {}, (err: any) => (err ? reject(err) : resolve())));
    }

    /** Run one node here on behalf of a browser-owned execution. */
    async deliver(graphId: string, principal: Principal | undefined, body: any): Promise<DeliveryResult | DeliveryError> {
        const allowed = decide(principal, ["graph:read"]);
        if (!allowed.allow || !principal) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const delivery = (body || {}) as EdgeDelivery;
        if (!ULID.test(String(delivery.executionId)) || !delivery.nodeId || typeof delivery.seq !== "number") {
            return { error: "a delivery needs executionId (ULID), nodeId and seq", code: "SCHEMA_INVALID" };
        }
        const wire: any = wireValue(delivery.value);
        if (!wire.ok) {
            return { error: wire.reason, code: "LIMIT_EXCEEDED" };
        }
        const key = DeliveryService.key(delivery.executionId, delivery);
        const existing = await this.getJson(key);
        if (existing) {
            return { ...existing.result, replayed: true };
        }
        const graph: any = await this.crdtStore.projectGraph(graphId).catch(() => null);
        if (!graph || !Array.isArray(graph.nodes)) {
            return { error: `no graph ${graphId}`, code: "NOT_FOUND" };
        }
        const node = graph.nodes.find((n: any) => n.id === delivery.nodeId);
        if (!node) {
            return { error: `no node ${delivery.nodeId} in ${graphId}`, code: "NOT_FOUND" };
        }
        if (placementOf(node) === "browser") {
            return { error: `node ${delivery.nodeId} is placed in the browser; the server will not run it`, code: "PLACEMENT" };
        }
        const startedAt = Date.now();
        // Only this node runs: its outgoing connectors are cut so the server
        // does not continue an execution the browser owns.  What it writes to
        // its edges goes back in the answer, and the browser routes it.
        const outputs: { field: string; value: any }[] = [];
        const observations: Observation[] = [];
        const isolatedNode = { ...node, edges: (node.edges || []).map((e: any) => ({ ...e, connectors: [] })) };
        const single = { ...graph, nodes: [isolatedNode] };
        const runner = this.deps.runner((o) => observations.push(o));
        const summary = await runner.run({
            graph: single,
            nodeUrl: isolatedNode.url,
            field: delivery.field,
            value: wire.value,
            principal: { sub: principal.sub, kind: principal.kind, tenant: principal.tenant },
            executionId: delivery.executionId,
            revisionId: ULID.test(String(delivery.revisionId)) ? delivery.revisionId : "live",
            correlationId: ULID.test(String(delivery.correlationId)) ? delivery.correlationId : delivery.executionId,
            budget: { wallMs: (delivery.budgetSlice && delivery.budgetSlice.wallMs) || 25000, hops: 1000, fanOut: 1000, depth: 8 },
            onEdgeWrite: (field: string, value: any) => {
                const sendable: any = wireValue(value);
                outputs.push({ field, value: sendable.ok ? sendable.value : null });
            },
            // the browser owns this execution and writes its record; these
            // observations belong to it and go in a file of their own
            ownsExecutionRecord: false,
            observationsSuffix: `-${deliveryKey({ ...delivery, executionId: delivery.executionId })}`,
        } as any);
        const result: DeliveryResult = {
            executionId: delivery.executionId,
            nodeId: delivery.nodeId,
            outputs,
            observations,
            state: summary.errors ? "error" : "completed",
            error: summary.errors ? (observations.find((o) => o.kind === "exec.error") || { payload: {} } as any).payload.message : undefined,
            replayed: false,
            duration: Date.now() - startedAt,
        };
        await this.putJson(key, {
            at: new Date().toISOString(), by: principal.sub, graphId,
            observationsKey: summary.observations.key,
            result: { ...result, observations: [] },
        });
        return result;
    }

    /** `POST /crdt/{id}/deliveries` */
    route(event: any, context: any, callback: (err: any, r: any) => void) {
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": true };
        let body: any = {};
        try { body = event.body ? JSON.parse(event.body) : {}; } catch (err) { body = {}; }
        this.deliver(event.pathParameters.id, event.principal, body)
            .then((r: any) => {
                const status = r.error && r.code ? (r.code === "ADMISSION_DENIED" ? 403 : r.code === "NOT_FOUND" ? 404 : r.code === "PLACEMENT" ? 409 : r.code === "LIMIT_EXCEEDED" ? 413 : 400) : 200;
                callback(null, { statusCode: status, body: JSON.stringify(r), headers });
            })
            .catch((err) => { console.error("Cannot run a delivery.", err); callback(null, { statusCode: 500, headers }); });
    }
}

export { ObservationRecorder };
