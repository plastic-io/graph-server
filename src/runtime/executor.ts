import Scheduler from "@plastic-io/plastic-io";
import { ulid } from "ulid";
import { ObservationRecorder, ExecutionRecord, Observation } from "./observe";
import { buildHostMembers, HostDeps } from "./host";
import { effectiveCapabilities, parseCapabilities } from "./capabilities";
import { makeContractHooks } from "./contracts";
import { AuditChain } from "../audit/chain";

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
            onInput: hooks.onInput,
            onOutput: hooks.onOutput,
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
        const key = ObservationRecorder.keyFor(graph.id, executionId, startedAt);
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
            await this.putJson(ExecutionRunner.executionKey(executionId), record);
            await this.putJson(ExecutionRunner.byGraphKey(graph.id, executionId), record);
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
