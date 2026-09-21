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
    /**
     * Resolve a linked graph or a published node the scheduler asks for
     * (`artifacts/graph/<id>.<version>`).  Without this the scheduler falls
     * back to fetching the path as a URL, which is how linked graphs came to
     * fail on the server (plan PB-046).
     */
    resolve?: (path: string) => Promise<any | null>;
    /** Extra members for the set function's `this` (the 2.0 setContext). */
    setContext?: (event: any) => any;
    /**
     * What the node believes the time is.  A test that says "five within a
     * window, then refused" cannot wait out a real window, so it runs against
     * a clock it holds still; everything else gets the real one.
     */
    now?: () => number;
    /** Manifest capabilities per pinned component, when known. */
    manifestCapabilities?: (node: any) => any[] | null;
    /** Capabilities of the executing principal; null = unrestricted (owner). */
    principalCapabilities?: any[] | null;
    defaultCapture?: "none" | "meta" | "full";
    maxObservations?: number;
    /**
     * Keep this run's key-value writes under a prefix of their own, so a
     * synthetic journey proves the graph works without touching what people
     * are using (plan §8.1.7, `effects: "isolated"`).
     */
    kvPrefix?: string;
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
    /** Receives the execution handle, so a caller can cancel what it started (plan §4.6.6). */
    onHandle?: (handle: any) => void;
    /** Look for a cancellation request between hops; off for short single-node runs. */
    watchForCancellation?: boolean;
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
    static cancelKey(executionId: string) { return `executions/${executionId}/cancel.json`; }
    static byGraphKey(graphId: string, executionId: string) { return `executions/by-graph/${graphId}/${executionId}.json`; }

    async run(req: RunRequest): Promise<ExecutionSummary> {
        const graph = req.graph;
        const executionId = req.executionId || ulid();
        const revisionId = req.revisionId || "live";
        const owner = req.principal || { sub: "anonymous", kind: "human", tenant: "none" };
        const startedAt = Date.now();
        const recorder = new ObservationRecorder({ graphId: graph.id, revisionId, executionId, correlationId: req.correlationId, owner, defaultCapture: req.defaultCapture, maxObservations: req.maxObservations, live: this.deps.live });
        recorder.learn(graph);
        const kvKey = (key: string) => `kv/${req.kvPrefix ? `${req.kvPrefix}/` : ""}${key}.json`;
        const hostDeps: HostDeps = {
            fetchImpl: this.deps.fetchImpl,
            secrets: this.deps.secrets,
            kv: {
                get: (key) => this.getJson(kvKey(key)).then((v) => (v && "value" in v ? v.value : undefined)),
                put: (key, value) => this.putJson(kvKey(key), { value, at: new Date().toISOString(), executionId }),
                del: (key) => new Promise((resolve) => this.store.remove(kvKey(key), () => resolve())),
            },
            audit: (record) => this.chain.append(graph.id, record).then(() => undefined),
            now: req.now,
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
                label: { graphId: graph.id, nodeId: node.id, executionId },
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
        /**
         * The scheduler's loader answers from a cache it fills synchronously
         * (a `load` listener has to set the value before the dispatch
         * returns), so anything that has to come from storage is fetched
         * before the run and seeded here.  What needs seeding: the graph
         * itself, because a node that embeds a linked graph runs with that
         * inner graph in scope and its connectors still name the outer one,
         * and every linked graph a node carries.
         */
        const prime = async () => {
            const seen = new Set<string>();
            const seed = async (id: any, version: any, value?: any): Promise<any | null> => {
                if (!id || version === undefined || version === null) {
                    return null;
                }
                const path = scheduler.getGraphPath(String(id), Number(version));
                if ((scheduler.graphLoader as any).cache[path]) {
                    return (scheduler.graphLoader as any).cache[path];
                }
                const resolved = value || (req.resolve ? await req.resolve(path) : null);
                if (resolved) {
                    (scheduler.graphLoader as any).cache[path] = resolved;
                }
                return resolved;
            };
            /**
             * A linked graph is part of the node that carries it, so where that
             * node runs is where its inner nodes run too (plan §4.8.1: an
             * instance may narrow placement, never widen it).  Inner nodes that
             * say nothing inherit; one that says `server` inside a node placed
             * in the browser keeps its own answer and is handed back.
             */
            const inherit = (inner: any, placement: string) => {
                (inner && inner.nodes ? inner.nodes : []).forEach((n: any) => {
                    n.properties = n.properties || {};
                    if (!n.properties.placement) {
                        n.properties.placement = placement;
                    }
                });
            };
            const walk = async (current: any, depth: number) => {
                if (!current || depth > 8 || seen.has(String(current.id))) {
                    return;
                }
                seen.add(String(current.id));
                await seed(current.id, current.version, current);
                for (const node of (current.nodes || [])) {
                    const linked = node && node.linkedGraph;
                    if (!linked || !linked.id) {
                        continue;
                    }
                    const inner = await seed(linked.id, linked.version === undefined ? node.version : linked.version, linked.graph);
                    const placement = node.properties && node.properties.placement;
                    if (inner && placement && placement !== "portable") {
                        inherit(inner, placement);
                        inherit(linked.graph, placement);
                    }
                    await walk(inner, depth + 1);
                    await walk(linked.graph, depth + 1);
                }
            };
            await walk(graph, 0);
        };
        await prime();
        scheduler.addEventListener("load", async (e: any) => {
            // the scheduler asks for a linked graph or a published node by path
            if (!req.resolve) {
                return;
            }
            const loaded = await req.resolve(e.url);
            if (loaded) {
                e.setValue(loaded);
                return;
            }
            recorder.record({ kind: "component.unresolved", payload: { path: e.url } });
        });
        if (req.onEvent) {
            LEGACY_EVENTS.forEach((name) => scheduler.addEventListener(name, (e: any) => req.onEvent!(name, e)));
        }
        if (req.setContext) {
            scheduler.addEventListener("set", (e: any) => { if (e.setContext) e.setContext(req.setContext!(e)); });
        }
        const handle = scheduler.invoke(req.nodeUrl, req.value, req.field, undefined, { executionId, revisionId });
        if (req.onHandle) {
            req.onHandle(handle);
        }
        /**
         * Someone asked this execution to stop (plan PB-065).  The request is
         * written where any invocation can leave it; this one notices at the
         * next hop, which is the earliest point it can stop without abandoning
         * work already in flight.
         */
        if (req.watchForCancellation !== false) {
            let lastLooked = 0;
            const lookForCancellation = async () => {
                const now = Date.now();
                if (now - lastLooked < 500) {
                    return;
                }
                lastLooked = now;
                const request = await this.getJson(ExecutionRunner.cancelKey(executionId));
                if (request) {
                    recorder.record({ kind: "exec.error", payload: { message: `cancelled: ${request.reason || "no reason given"}`, code: "CANCELLED", by: request.by } });
                    await handle.cancel(request.reason || "cancelled");
                }
            };
            scheduler.addEventListener("beginconnector", () => { lookForCancellation().catch(() => undefined); });
            scheduler.addEventListener("beginedge", () => { lookForCancellation().catch(() => undefined); });
        }
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
