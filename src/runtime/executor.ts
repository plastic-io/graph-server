import Scheduler from "@plastic-io/plastic-io";
import { ulid } from "ulid";
import { ObservationRecorder, ExecutionRecord, Observation } from "./observe";
import { buildHostMembers, HostDeps } from "./host";
import { effectiveCapabilities, parseCapabilities } from "./capabilities";
import { makeContractHooks } from "./contracts";
import { AuditChain } from "../audit/chain";
import { runInIsolate, isolationAvailable, isolationLoadError } from "./isolate";
import { placementOf, runsHere, deliveryTarget, wireValue, EdgeDelivery } from "@plastic-io/graph-crdt";

/**
 * Runs one execution on the server (plan §4.6, §4.5): scheduler 2.1 with a
 * budget, the capability host, contract hooks and the observation recorder;
 * ends with the observations and the execution record written.
 */
export interface RunRequest {
    graph: any;
    nodeUrl: string;
    field?: string;
    value?: any;
    /** The `this` of set functions (kept for 2.0 graphs). */
    context?: any;
    state?: any;
    logger?: any;
    principal: { sub: string; kind: string; tenant: string } | null;
    executionId?: string;
    revisionId?: string;
    correlationId?: string;
    budget?: any;
    /** Forward a scheduler event to the legacy notify channel. */
    onEvent?: (name: string, event: any) => void;
    /** Extra members for the set function's `this` (the 2.0 setContext). */
    setContext?: (event: any) => any;
    /** Manifest capabilities per pinned component, when known. */
    manifestCapabilities?: (node: any) => any[] | null;
    /** Capabilities of the executing principal; null = unrestricted (owner). */
    principalCapabilities?: any[] | null;
    defaultCapture?: "none" | "meta" | "full";
    maxObservations?: number;
    /** Hand a browser-placed node to the browsers watching this graph (plan §4.8.2). */
    deliver?: (delivery: EdgeDelivery) => Promise<void> | void;
    /** See every value a node writes to an output edge, whether or not a connector carries it. */
    onEdgeWrite?: (field: string, value: any, node: any) => void;
    /**
     * A run that belongs to an execution someone else owns (a delivery from a
     * browser) keeps its observations but writes no execution record, because
     * the owner writes that.  Its observations go to their own file.
     */
    ownsExecutionRecord?: boolean;
    observationsSuffix?: string;
    /** The session that started this execution, for deliveries that must happen once. */
    initiator?: string;
    /** Where node code runs when the node does not say (`worker` keeps the 2.0 realm, `isolate` contains it). */
    defaultContainment?: "worker" | "isolate";
    /** Limits for one contained node invocation. */
    isolateLimits?: { timeoutMs: number; memoryMb: number };
}

export interface ExecutionSummary {
    executionId: string;
    revisionId: string;
    graphId: string;
    state: string;
    reason?: string;
    duration: number;
    hops: number;
    errors: number;
    observations: { count: number; key: string; sampled: boolean; capped: boolean };
    effects: { allowed: number; denied: number };
    budget?: any;
}

interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
    setRaw(key: string, body: Buffer, meta: any, cb: (err: any, data: any) => void): void;
    remove(key: string, cb: (err: any, data: any) => void): void;
}

/** How much of a contained node's HTTP response may cross the boundary. */
const MAX_CONTAINED_BODY = 1024 * 1024;

const LEGACY_EVENTS = ["begin", "end", "beginconnector", "endconnector", "set", "afterSet", "error", "warning", "load", "observation", "cancel"];

export class ExecutionRunner {
    private store: Store;
    private chain: AuditChain;
    constructor(store: Store, private deps: { fetchImpl?: typeof fetch; secrets?: (ref: string) => Promise<string>; live?: (observation: Observation) => void } = {}) {
        this.store = store;
        this.chain = new AuditChain(store as any);
    }
    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }
    private putJson(key: string, value: any): Promise<void> {
        return new Promise((resolve, reject) => this.store.set(key, value, {}, (err: any) => (err ? reject(err) : resolve())));
    }
    private putRaw(key: string, body: string, meta: any): Promise<void> {
        return new Promise((resolve, reject) => this.store.setRaw(key, Buffer.from(body), meta, (err: any) => (err ? reject(err) : resolve())));
    }

    static executionKey(executionId: string) { return `executions/${executionId}.json`; }
    static byGraphKey(graphId: string, executionId: string) { return `executions/by-graph/${graphId}/${executionId}.json`; }

    async run(req: RunRequest): Promise<ExecutionSummary> {
        const graph = req.graph;
        const executionId = req.executionId || ulid();
        const revisionId = req.revisionId || "live";
        const owner = req.principal || { sub: "anonymous", kind: "human", tenant: "none" };
        const startedAt = Date.now();
        const recorder = new ObservationRecorder({ graphId: graph.id, revisionId, executionId, correlationId: req.correlationId, owner, defaultCapture: req.defaultCapture, maxObservations: req.maxObservations, live: this.deps.live });
        recorder.learn(graph);
        const hostDeps: HostDeps = {
            fetchImpl: this.deps.fetchImpl,
            secrets: this.deps.secrets,
            kv: {
                get: (key) => this.getJson(`kv/${key}.json`).then((v) => (v && "value" in v ? v.value : undefined)),
                put: (key, value) => this.putJson(`kv/${key}.json`, { value, at: new Date().toISOString(), executionId }),
                del: (key) => new Promise((resolve) => this.store.remove(`kv/${key}.json`, () => resolve())),
            },
            audit: (record) => this.chain.append(graph.id, record).then(() => undefined),
        };
        const hooks = makeContractHooks();
        const onOutput = (info: any) => {
            if (req.onEdgeWrite) {
                req.onEdgeWrite(info.field, info.value, info.node);
            }
            return hooks.onOutput(info);
        };
        /**
         * A node placed in the browser does not run here (plan §4.8.2).  The
         * server still routes to it, still checks its contract and still
         * observes the hop; what it does instead of running the code is hand
         * the value to the browsers watching this graph.  The observation says
         * the hop was deferred, so a reader can see where the execution went
         * rather than seeing it stop.
         */
        let deliverySeq = 0;
        const deliverToBrowser = async (nodeInterface: any, execution: any) => {
            const node = nodeInterface.node;
            deliverySeq += 1;
            const wire: any = wireValue(nodeInterface.value);
            if (!wire.ok) {
                recorder.record({ kind: "exec.error", nodeId: node.id, edgeField: nodeInterface.field, payload: { message: wire.reason, code: "UNSENDABLE_VALUE" }, spanId: execution && execution.spanId });
                throw new Error(wire.reason);
            }
            const delivery: EdgeDelivery = {
                schemaVersion: 1,
                executionId,
                correlationId: req.correlationId || executionId,
                revisionId,
                graphId: graph.id,
                nodeId: node.id,
                field: nodeInterface.field,
                value: wire.value,
                seq: deliverySeq,
                instancePath: [],
                target: deliveryTarget(node),
                budgetSlice: { wallMs: (req.budget && req.budget.wallMs) || 30000 },
                initiator: req.initiator,
            };
            recorder.record({
                kind: "route",
                nodeId: node.id,
                edgeField: nodeInterface.field,
                payload: { deferred: "browser", target: delivery.target, seq: delivery.seq, bytes: wire.bytes },
            });
            if (req.deliver) {
                await req.deliver(delivery);
            }
        };
        /**
         * Where a node's code runs (plan §4.6.3).  A node says for itself, a
         * graph can say for all of its nodes, and the deployment says what
         * happens when neither does.  Asking for containment and not getting it
         * is an error, never a quiet fall back into the ambient realm.
         */
        const containmentOf = (node: any): "worker" | "isolate" => {
            const asked = (node && node.properties && node.properties.containment)
                || (graph.properties && graph.properties.containment)
                || req.defaultContainment
                || "worker";
            return asked === "isolate" ? "isolate" : "worker";
        };
        const limits = req.isolateLimits || { timeoutMs: 10000, memoryMb: 128 };
        const executeNode = async ({ code, nodeInterface, execution, runInProcess }: any) => {
            const node = nodeInterface.node;
            if (!runsHere(node, "server")) {
                return deliverToBrowser(nodeInterface, execution);
            }
            if (containmentOf(node) !== "isolate") {
                return runInProcess();
            }
            if (!isolationAvailable()) {
                const why = isolationLoadError();
                recorder.record({ kind: "exec.error", nodeId: node.id, payload: { message: `containment was asked for and is not available: ${why ? why.message : "isolated-vm is missing"}`, code: "CONTAINMENT_UNAVAILABLE" } });
                throw new Error(`node ${node.id} asks for containment, which this runtime cannot provide`);
            }
            const host = nodeInterface.host || {};
            const setPath = (target: any, path: string[], value: any) => {
                if (!target || !path.length) return;
                let cursor = target;
                for (let i = 0; i < path.length - 1; i++) {
                    if (cursor[path[i]] === null || typeof cursor[path[i]] !== "object") {
                        cursor[path[i]] = {};
                    }
                    cursor = cursor[path[i]];
                }
                cursor[path[path.length - 1]] = value;
            };
            const outcome = await runInIsolate({
                code,
                limits,
                inputs: {
                    value: nodeInterface.value,
                    state: nodeInterface.state,
                    data: nodeInterface.data,
                    properties: nodeInterface.properties,
                    node: { id: node.id, url: node.url, version: node.version, graphId: node.graphId, properties: node.properties },
                    field: nodeInterface.field,
                    graph: { id: graph.id, url: graph.url, version: graph.version, properties: graph.properties },
                    cache: {},
                    capabilities: host.capabilities,
                },
                setEdge: (field, value) => { nodeInterface.edges[field] = value; },
                setState: (path, value) => setPath(nodeInterface.state, path, value),
                setData: (path, value) => setPath(nodeInterface.data, path, value),
                hostCall: async (member, args) => {
                    if (member === "fetch") {
                        const response: any = await host.fetch(args[0], args[1] || {});
                        const body = await response.text();
                        const truncated = body.length > MAX_CONTAINED_BODY;
                        const headers: Record<string, string> = {};
                        if (response.headers && typeof response.headers.forEach === "function") {
                            response.headers.forEach((v: string, k: string) => { headers[k] = v; });
                        }
                        return { ok: response.ok, status: response.status, statusText: response.statusText, url: response.url, headers, truncated, body: truncated ? body.slice(0, MAX_CONTAINED_BODY) : body };
                    }
                    if (member === "kv.get") return host.kv.get(args[0]);
                    if (member === "kv.put") return host.kv.put(args[0], args[1]);
                    if (member === "kv.del") return host.kv.del(args[0]);
                    if (member === "secret.header") return host.secret(args[0]).header(args[1], args[2]);
                    if (member === "emit") { host.emit(args[0], args[1]); return null; }
                    throw new Error(`host.${member} is not available to a contained node`);
                },
                log: (level, args) => {
                    if (req.logger && typeof (req.logger as any)[level] === "function") {
                        (req.logger as any)[level](...args);
                    }
                },
            });
            if (outcome.error) {
                if (outcome.error.kind === "timeout" || outcome.error.kind === "memory") {
                    recorder.record({ kind: "budget.exhausted", nodeId: node.id, budget: { dimension: outcome.error.kind === "timeout" ? "wallMs" : "memoryMb", used: outcome.error.kind === "timeout" ? outcome.wallMs : limits.memoryMb, limit: outcome.error.kind === "timeout" ? limits.timeoutMs : limits.memoryMb }, payload: { message: outcome.error.message, contained: true } });
                }
                throw new Error(outcome.error.message);
            }
            return outcome.result;
        };
        const scheduler = new Scheduler(graph, req.context || {}, req.state || {}, req.logger, {
            budget: req.budget,
            host: ({ execution, nodeInterface }: any) => buildHostMembers({
                graphId: graph.id,
                node: nodeInterface.node,
                spanId: nodeInterface.executionId ? undefined : undefined,
                signal: execution ? execution.token.signal : undefined,
                effective: effectiveCapabilities(nodeInterface.node, req.manifestCapabilities ? req.manifestCapabilities(nodeInterface.node) : null, req.principalCapabilities === undefined ? null : req.principalCapabilities),
                recorder,
                principal: req.principal,
            }, hostDeps),
            executeNode,
            onInput: hooks.onInput,
            onOutput,
            contractMode: (graph.properties && graph.properties.contractMode === "reject") ? "reject" : "warn",
        } as any);
        recorder.attach(scheduler);
        if (req.onEvent) {
            LEGACY_EVENTS.forEach((name) => scheduler.addEventListener(name, (e: any) => req.onEvent!(name, e)));
        }
        if (req.setContext) {
            scheduler.addEventListener("set", (e: any) => { if (e.setContext) e.setContext(req.setContext!(e)); });
        }
        const handle = scheduler.invoke(req.nodeUrl, req.value, req.field, undefined, { executionId, revisionId });
        const result: any = await handle.done;
        const endedAt = Date.now();
        const key = ObservationRecorder.keyFor(graph.id, executionId, startedAt).replace(/\.ndjson$/, `${req.observationsSuffix || ""}.ndjson`);
        const summary = recorder.summary();
        const observations = { count: summary.count, key, sampled: summary.sampled, capped: summary.capped };
        const record: ExecutionRecord = {
            executionId, graphId: graph.id, revisionId, owner, domain: "server",
            entry: { nodeUrl: req.nodeUrl, field: req.field },
            startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(),
            state: result.state, reason: result.reason, duration: endedAt - startedAt, hops: result.hops || 0, errors: result.errors || 0,
            observations, effects: summary.effects, budget: result.budget, correlationId: req.correlationId || executionId,
        };
        try {
            await this.putRaw(key, recorder.ndjson(), { "graph-id": graph.id, "execution-id": executionId, "content-type": "application/x-ndjson" });
            if (req.ownsExecutionRecord !== false) {
                await this.putJson(ExecutionRunner.executionKey(executionId), record);
                await this.putJson(ExecutionRunner.byGraphKey(graph.id, executionId), record);
            }
        } catch (err) {
            console.error("Cannot write the execution's observations", err);
        }
        return { executionId, revisionId, graphId: graph.id, state: result.state, reason: result.reason, duration: record.duration, hops: record.hops, errors: record.errors, observations, effects: summary.effects, budget: result.budget };
    }
}

/** Read one execution's observations back, newest first when asked. */
export async function readObservations(store: Store, record: ExecutionRecord): Promise<Observation[]> {
    const text: string | null = await new Promise((resolve) => (store as any).getRaw(record.observations.key, (err: any, body: Buffer) => resolve(err ? null : body.toString("utf8"))));
    if (!text) return [];
    return text.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (err) { return null; } }).filter(Boolean);
}

export { parseCapabilities };
