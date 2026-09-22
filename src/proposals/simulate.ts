import { Observation } from "@plastic-io/graph-crdt";
import { Principal } from "../auth/principal";
import { decide } from "../policy/decide";
import { ExecutionRunner, readObservations } from "../runtime/executor";
import { touchesRisk } from "../gates/gates";
import CrdtStore from "../crdtStore";

/**
 * What a proposal would do, before anyone lives with it (plan §4.7.5).
 *
 * Reviewing a change to a running application means asking two things: what
 * does it alter, and what would it have done to the work this application has
 * already handled.  The first is structural and always answerable.  The second
 * is shadow execution: the proposed graph is run against the inputs of recent
 * executions with **every effect refused**, and what it produced is compared
 * with what actually happened.
 *
 * The comparison is only as good as what was kept.  An execution whose inputs
 * were recorded as a shape rather than a value cannot be replayed, and that is
 * reported as coverage rather than passed over — a simulation that quietly
 * skips half the evidence is worse than one that says it found none.
 *
 * Nothing here performs an effect.  A node that reaches for the network, the
 * shared store or a secret is refused and listed, because "this would have
 * called something" is the most important thing a review can be told.
 */

export type SimulationMode = "structural" | "shadow" | "replay";

export interface Comparison {
    executionId: string;
    nodeId: string;
    field?: string;
    verdict: "equal" | "schema-equal" | "diff";
    note?: string;
}

export interface UnsimulatedEffect {
    kind: string;
    scope?: string;
    nodeId?: string;
    reason: string;
}

export interface SimulationResult {
    proposalId: string;
    graphId: string;
    mode: SimulationMode;
    /** Does what this change touches call for simulation at all (plan §4.7.5)? */
    required: boolean;
    namespaces: string[];
    comparisons: Comparison[];
    unsimulatedEffects: UnsimulatedEffect[];
    coverage: {
        executionsFound: number;
        executionsRun: number;
        compared: number;
        skipped: { executionId: string; reason: string }[];
    };
    verdict: "same" | "differs-in-value" | "differs" | "unproven";
    at: string;
}

export type SimulationError = { error: string; code: "ADMISSION_DENIED" | "NOT_FOUND" | "SCHEMA_INVALID" | "UNSUPPORTED" };

/** How far back to look for work to compare against, and how much of it. */
const DEFAULT_SINCE_MINUTES = 1440;
const MAX_SINCE_MINUTES = 1440;
const DEFAULT_SAMPLE = 10;
const MAX_SAMPLE = 50;

/** Effects with nothing honest to stand in for them (plan §4.7.5). */
const NO_SIMULATION_CLASS = (kind: string) => /^secret/.test(kind) || /^aws:/.test(kind);

interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    getRaw(key: string, cb: (err: any, data: any) => void): void;
    list(prefix: string, cb: (err: any, items: any[]) => void): void;
}

export class SimulationService {
    constructor(
        private store: Store,
        private crdtStore: CrdtStore,
        private deps: {
            proposals: { get(graphId: string, proposalId: string): Promise<any>; projection(graphId: string, proposalId: string): Promise<any> };
            runner: (live: (o: Observation) => void) => ExecutionRunner;
            now?: () => Date;
        },
    ) {}

    private now(): Date {
        return this.deps.now ? this.deps.now() : new Date();
    }

    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }
    private listKeys(prefix: string): Promise<string[]> {
        return new Promise((resolve) => this.store.list(prefix, (err: any, items: any[]) => resolve(err ? [] : (items || []).map((i: any) => i.Key))));
    }

    async run(graphId: string, proposalId: string, principal: Principal | undefined, options: { mode?: SimulationMode; executionSample?: { sinceMinutes?: number; max?: number }; budget?: any } = {}): Promise<SimulationResult | SimulationError> {
        const allowed = decide(principal, ["graph:simulate"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const mode: SimulationMode = options.mode === "shadow" ? "shadow" : options.mode === "replay" ? "replay" : "structural";
        if (mode === "replay") {
            return {
                error: "a deterministic replay needs the responses the effects gave, and this server does not record them yet; ask for a shadow run instead",
                code: "UNSUPPORTED",
            };
        }
        const proposal = await this.deps.proposals.get(graphId, proposalId);
        if (!proposal || proposal.error) {
            return { error: `no proposal ${proposalId} on ${graphId}`, code: "NOT_FOUND" };
        }
        const proposed = await this.deps.proposals.projection(graphId, proposalId);
        if (!proposed || !Array.isArray(proposed.nodes)) {
            return { error: "this proposal has nothing to run: its projection is missing", code: "NOT_FOUND" };
        }
        const namespaces: string[] = (proposal.diffSummary && proposal.diffSummary.namespaces) || [];
        const result: SimulationResult = {
            proposalId, graphId, mode,
            required: touchesRisk(namespaces),
            namespaces,
            comparisons: [],
            unsimulatedEffects: [],
            coverage: { executionsFound: 0, executionsRun: 0, compared: 0, skipped: [] },
            verdict: "unproven",
            at: this.now().toISOString(),
        };
        // What this change asks for that nothing can stand in for.
        result.unsimulatedEffects.push(...this.effectsWithoutAClass(proposed));
        if (mode === "structural") {
            return result;
        }
        const sample = await this.sample(graphId, options.executionSample);
        result.coverage.executionsFound = sample.length;
        for (const record of sample) {
            const original = await this.observationsOf(record);
            const entry = this.entryInput(original);
            if (!entry) {
                result.coverage.skipped.push({ executionId: record.executionId, reason: "its inputs were kept as a shape, not a value, so there is nothing to run again" });
                continue;
            }
            const shadow = await this.shadowRun(proposed, entry, principal, options.budget, record.executionId);
            result.coverage.executionsRun += 1;
            const comparisons = this.compare(record.executionId, original, shadow);
            result.comparisons.push(...comparisons);
            result.coverage.compared += comparisons.length;
            result.unsimulatedEffects.push(...this.refusedEffects(shadow));
        }
        result.verdict = result.comparisons.some((c) => c.verdict === "diff")
            ? "differs"
            : result.comparisons.some((c) => c.verdict === "schema-equal")
                ? "differs-in-value"
                : result.comparisons.length ? "same" : "unproven";
        return result;
    }

    /** Executions to compare against: the most recent, within the window asked for. */
    private async sample(graphId: string, options: { sinceMinutes?: number; max?: number } = {}): Promise<any[]> {
        const sinceMinutes = Math.min(MAX_SINCE_MINUTES, Math.max(1, options.sinceMinutes || DEFAULT_SINCE_MINUTES));
        const max = Math.min(MAX_SAMPLE, Math.max(1, options.max || DEFAULT_SAMPLE));
        const cutoff = this.now().getTime() - sinceMinutes * 60000;
        const keys = (await this.listKeys(`executions/by-graph/${graphId}/`)).sort().reverse();
        const records: any[] = [];
        for (const key of keys) {
            if (records.length >= max) {
                break;
            }
            const record = await this.getJson(key);
            if (!record || !record.observations || !record.observations.key) {
                continue;
            }
            if (new Date(record.startedAt || record.endedAt || 0).getTime() < cutoff) {
                break;                                   // keys are in time order, so the rest are older still
            }
            records.push(record);
        }
        return records;
    }

    /** Everything that execution observed, including the halves another domain wrote. */
    private async observationsOf(record: any): Promise<any[]> {
        const own = await readObservations(this.store as any, record);
        const sideKeys = (await this.listKeys(`executions/${record.executionId}/deliveries/`))
            .concat(await this.listKeys(`executions/${record.executionId}/reports/`));
        const rest: any[] = [];
        for (const key of sideKeys) {
            const side = await this.getJson(key);
            if (side && side.observationsKey) {
                rest.push(...await readObservations(this.store as any, { observations: { key: side.observationsKey } } as any));
            }
        }
        return own.concat(rest).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }

    /** The value that started it, if it was kept whole. */
    private entryInput(observations: any[]): { nodeId: string; field: string; value: any } | null {
        const first = observations.find((o) => o.kind === "edge.input" && o.payload && o.payload.value !== undefined);
        if (!first) {
            return null;
        }
        return { nodeId: first.nodeId, field: first.edgeField || "in", value: first.payload.value };
    }

    /**
     * Run the proposed graph from the same entry, with nothing granted.  The
     * record is not written as an execution of this graph: it did not happen,
     * and an execution list that mixes what happened with what might have is
     * no longer evidence.
     */
    private async shadowRun(proposed: any, entry: { nodeId: string; field: string; value: any }, principal: Principal | undefined, budget: any, against: string): Promise<any[]> {
        const node = (proposed.nodes || []).find((n: any) => n.id === entry.nodeId);
        if (!node) {
            return [];
        }
        const observations: any[] = [];
        const runner = this.deps.runner((o) => observations.push(o));
        try {
            await runner.run({
                graph: proposed,
                nodeUrl: node.url,
                field: entry.field,
                value: entry.value,
                principal: principal ? { sub: principal.sub, kind: principal.kind, tenant: principal.tenant } : null,
                budget: { wallMs: 15000, hops: 1000, fanOut: 500, depth: 32, ...(budget || {}) },
                // simulation grants nothing: every effect is refused and observed
                principalCapabilities: [],
                // A comparison is only as sharp as what both sides kept, and
                // the point of this run is to be compared, so it keeps values.
                defaultCapture: "full",
                kvPrefix: `sim/${against}`,
                ownsExecutionRecord: false,
                observationsSuffix: `-shadow-${against}`,
                deliver: async () => undefined,          // a browser hop is not simulated here
            } as any);
        } catch (err: any) {
            observations.push({ kind: "exec.error", nodeId: node.id, payload: { message: String((err && err.message) || err) } });
        }
        return observations;
    }

    /**
     * What each node was given, then and now.  Values are compared when they
     * were kept; where only the shape was kept, the shape is what is compared,
     * and the answer says so rather than claiming more than it knows.
     */
    private compare(executionId: string, original: any[], shadow: any[]): Comparison[] {
        const inputsOf = (observations: any[]) => {
            const map = new Map<string, any>();
            observations.forEach((o) => {
                if (o.kind !== "edge.input" || !o.nodeId) {
                    return;
                }
                const key = `${o.nodeId}:${o.edgeField || ""}`;
                if (!map.has(key)) {
                    map.set(key, o.payload || {});
                }
            });
            return map;
        };
        const before = inputsOf(original);
        const after = inputsOf(shadow);
        const keys = Array.from(new Set([...before.keys(), ...after.keys()])).sort();
        return keys.map((key) => {
            const [nodeId, field] = key.split(":");
            const was = before.get(key);
            const now = after.get(key);
            if (!was) {
                return { executionId, nodeId, field, verdict: "diff" as const, note: "only the proposed graph reached this node" };
            }
            if (!now) {
                return { executionId, nodeId, field, verdict: "diff" as const, note: "the proposed graph never reached this node" };
            }
            return { executionId, nodeId, field, ...this.verdictFor(was, now) };
        });
    }

    private verdictFor(was: any, now: any): { verdict: Comparison["verdict"]; note?: string } {
        const bothValues = was.value !== undefined && now.value !== undefined;
        if (bothValues) {
            if (JSON.stringify(was.value) === JSON.stringify(now.value)) {
                return { verdict: "equal" };
            }
            const sameShape = shapeOf(was.value) === shapeOf(now.value);
            return sameShape
                ? { verdict: "schema-equal", note: "the same shape, a different value" }
                : { verdict: "diff", note: `${shapeOf(was.value)} became ${shapeOf(now.value)}` };
        }
        const wasMeta = was.meta || {};
        const nowMeta = now.meta || {};
        if (wasMeta.hash && nowMeta.hash && wasMeta.hash === nowMeta.hash) {
            return { verdict: "equal", note: "compared by shape: this graph does not keep the values that cross here" };
        }
        if (wasMeta.type && nowMeta.type && wasMeta.type === nowMeta.type) {
            return { verdict: "schema-equal", note: "compared by shape: this graph does not keep the values that cross here" };
        }
        return { verdict: "diff", note: `${wasMeta.type || "nothing"} became ${nowMeta.type || "nothing"}` };
    }

    /** Effects the shadow refused: in production these would have happened. */
    private refusedEffects(shadow: any[]): UnsimulatedEffect[] {
        return shadow
            .filter((o) => o.kind === "effect.denied" && o.capability)
            .map((o) => ({
                kind: String(o.capability.kind),
                scope: (o.capability.scope || [])[0],
                nodeId: o.nodeId,
                reason: "refused in simulation; this would reach outside the graph if it ran",
            }));
    }

    /** What the proposed graph asks for that nothing can honestly stand in for. */
    private effectsWithoutAClass(proposed: any): UnsimulatedEffect[] {
        const out: UnsimulatedEffect[] = [];
        (proposed.nodes || []).forEach((node: any) => {
            const capabilities = (node.properties && node.properties.capabilities) || [];
            (Array.isArray(capabilities) ? capabilities : []).forEach((capability: any) => {
                const kind = String((capability && capability.kind) || capability);
                if (NO_SIMULATION_CLASS(kind)) {
                    out.push({ kind, scope: capability && capability.scope, nodeId: node.id, reason: "nothing can stand in for this, so it is never simulated" });
                }
            });
        });
        return out;
    }
}

/** A shape a person would recognise: the type, and for an object its keys. */
function shapeOf(value: any): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    if (typeof value === "object") return `object{${Object.keys(value).sort().join(",")}}`;
    return typeof value;
}
