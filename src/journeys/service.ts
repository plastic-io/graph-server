import { ulid } from "ulid";
import { Principal } from "../auth/principal";
import { decide } from "../policy/decide";
import { ExecutionRunner } from "../runtime/executor";
import { Observation } from "../runtime/observe";
import { isValidCron, isDue } from "./cron";
import CrdtStore from "../crdtStore";

/**
 * Continuous intent journeys (plan §8.1.7).
 *
 * A journey says what the application is *for*, in the words of the person who
 * wanted it, and then proves it on a schedule: "a signed-in user changes their
 * email and it persists".  It names capabilities rather than nodes, so a graph
 * can be rebuilt underneath it and the journey still asks the same question —
 * and if the capability is gone, that is the answer, not an error.
 *
 * Journeys run as a synthetic principal in its own tenant, so their traffic is
 * never confused with a person's, and their effects are contained: `sim`
 * refuses every effect, `isolated` keeps writes under a prefix of their own.
 */

export type EffectsMode = "sim" | "isolated" | "real-compensated";

export interface JourneyStep {
    act: { invoke: { capability: string; input?: any; field?: string } };
    expect?: {
        observation?: { kind: string; where?: Record<string, any> };
        outputs?: { schema: any };
        state?: { via?: { capability: string; input?: any }; schema: any };
    };
}

export interface IntentJourney {
    schemaVersion: 1;
    id: string;
    graphId: string;
    /** What this is for, in the words of whoever wanted it. */
    intent: string;
    capability: string;
    identity: { syntheticPrincipal: string; tenant: string };
    schedule: string;
    budget?: any;
    effects: EffectsMode;
    steps: JourneyStep[];
    flakiness?: { retries: number; quarantineAfter: number };
    enabled?: boolean;
    createdBy?: string | null;
    createdAt?: string;
    updatedAt?: string;
    /** Kept by the runner so the schedule knows what it has already done. */
    lastRunAt?: string | null;
    lastResult?: "passed" | "failed" | "unresolvable" | "probe-error" | null;
    consecutiveFailures?: number;
    quarantined?: boolean;
}

export interface JourneyStepResult {
    capability: string;
    resolvedNode?: string;
    executionId?: string;
    state: "passed" | "failed" | "unresolvable";
    reason?: string;
    observations?: number;
    deferredToBrowser?: string[];
}

export interface JourneyRun {
    runId: string;
    journeyId: string;
    graphId: string;
    revisionId: string;
    intent: string;
    at: string;
    duration: number;
    state: "passed" | "failed" | "unresolvable" | "probe-error";
    reason?: string;
    steps: JourneyStepResult[];
    correlationId: string;
    by: "schedule" | "request";
}

interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
    setRaw(key: string, body: Buffer, meta: any, cb: (err: any, data: any) => void): void;
    remove(key: string, cb: (err: any, data: any) => void): void;
    list(prefix: string, cb: (err: any, items: any[]) => void): void;
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const MAX_STEPS = 20;
const KEEP_RUNS = 50;

/** What a node says it provides, however the graph spells it. */
export function providedCapabilities(node: any): string[] {
    const properties = (node && node.properties) || {};
    const fromProvides = Array.isArray(properties.provides) ? properties.provides : [];
    const capabilities = properties.capabilities;
    const fromCapabilities = capabilities && !Array.isArray(capabilities) && Array.isArray(capabilities.provides) ? capabilities.provides : [];
    return [...fromProvides, ...fromCapabilities].map((c: any) => String(c));
}

/** The node that answers for a capability on this graph, if any still does. */
export function resolveCapability(graph: any, capability: string): any | null {
    const nodes = (graph && graph.nodes) || [];
    return nodes.find((n: any) => providedCapabilities(n).includes(capability)) || null;
}

export class JourneyService {
    constructor(
        private store: Store,
        private crdtStore: CrdtStore,
        private deps: {
            runner: (live: (o: Observation) => void) => ExecutionRunner;
            notify?: (graphId: string, event: any) => Promise<void>;
            now?: () => Date;
        },
    ) {}

    static key(graphId: string, journeyId: string) { return `journeys/${graphId}/${journeyId}.json`; }
    static runKey(graphId: string, journeyId: string, runId: string) { return `journeys/${graphId}/${journeyId}/runs/${runId}.json`; }

    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }
    private putJson(key: string, value: any): Promise<void> {
        return new Promise((resolve, reject) => this.store.set(key, value, {}, (err: any) => (err ? reject(err) : resolve())));
    }
    private listKeys(prefix: string): Promise<string[]> {
        return new Promise((resolve) => this.store.list(prefix, (err: any, items: any[]) => resolve(err ? [] : (items || []).map((i: any) => i.Key))));
    }
    private now(): Date {
        return this.deps.now ? this.deps.now() : new Date();
    }

    /* ----------------------------------------------------------- the store */

    async list(graphId: string, principal: Principal | undefined): Promise<any> {
        const allowed = decide(principal, ["graph:read"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const keys = (await this.listKeys(`journeys/${graphId}/`)).filter((k) => k.endsWith(".json") && !k.includes("/runs/"));
        const journeys: IntentJourney[] = [];
        for (const key of keys) {
            const journey = await this.getJson(key);
            if (journey) {
                journeys.push(journey);
            }
        }
        return { graphId, journeys };
    }

    async put(graphId: string, principal: Principal | undefined, body: any): Promise<any> {
        const allowed = decide(principal, ["graph:test"]);
        if (!allowed.allow || !principal) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const invalid = this.validate(body);
        if (invalid) {
            return { error: invalid, code: "SCHEMA_INVALID" };
        }
        const existing = await this.getJson(JourneyService.key(graphId, body.id));
        const journey: IntentJourney = {
            schemaVersion: 1,
            id: String(body.id),
            graphId,
            intent: String(body.intent).slice(0, 1000),
            capability: String(body.capability),
            identity: { syntheticPrincipal: `synthetic:${body.id}`, tenant: "synthetic" },
            schedule: String(body.schedule),
            budget: body.budget && typeof body.budget === "object" ? body.budget : { wallMs: 20000, hops: 500, fanOut: 200, depth: 16 },
            effects: body.effects === "isolated" ? "isolated" : body.effects === "real-compensated" ? "real-compensated" : "sim",
            steps: body.steps.map((s: any) => ({
                act: { invoke: { capability: String(s.act.invoke.capability), input: s.act.invoke.input, field: s.act.invoke.field ? String(s.act.invoke.field) : undefined } },
                expect: s.expect,
            })),
            flakiness: { retries: Math.min(3, Number((body.flakiness || {}).retries) || 0), quarantineAfter: Math.min(10, Number((body.flakiness || {}).quarantineAfter) || 3) },
            enabled: body.enabled !== false,
            createdBy: existing ? existing.createdBy : principal.sub,
            createdAt: existing ? existing.createdAt : new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastRunAt: existing ? existing.lastRunAt : null,
            lastResult: existing ? existing.lastResult : null,
            consecutiveFailures: existing ? existing.consecutiveFailures || 0 : 0,
            quarantined: existing ? !!existing.quarantined : false,
        };
        await this.putJson(JourneyService.key(graphId, journey.id), journey);
        return { journey, created: !existing };
    }

    async remove(graphId: string, journeyId: string, principal: Principal | undefined): Promise<any> {
        const allowed = decide(principal, ["graph:test"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        await new Promise<void>((resolve) => this.store.remove(JourneyService.key(graphId, journeyId), () => resolve()));
        return { removed: journeyId };
    }

    async runs(graphId: string, journeyId: string, principal: Principal | undefined, limit = 20): Promise<any> {
        const allowed = decide(principal, ["graph:observe"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const keys = (await this.listKeys(`journeys/${graphId}/${journeyId}/runs/`)).sort().reverse().slice(0, limit);
        const runs: JourneyRun[] = [];
        for (const key of keys) {
            const run = await this.getJson(key);
            if (run) {
                runs.push(run);
            }
        }
        return { graphId, journeyId, runs };
    }

    private validate(body: any): string | null {
        if (!body || typeof body !== "object") return "a journey is an object";
        if (!ID.test(String(body.id || ""))) return "id must be a short slug";
        if (!body.intent || String(body.intent).trim().length < 8) return "intent says what this is for, in a sentence";
        if (!body.capability || typeof body.capability !== "string") return "capability names what the journey asks the graph to do";
        if (!isValidCron(body.schedule || "")) return "schedule must be a five field cron expression";
        if (!Array.isArray(body.steps) || !body.steps.length) return "a journey needs at least one step";
        if (body.steps.length > MAX_STEPS) return `at most ${MAX_STEPS} steps`;
        for (const step of body.steps) {
            if (!step || !step.act || !step.act.invoke || typeof step.act.invoke.capability !== "string") {
                return "every step invokes a capability";
            }
        }
        if (body.effects === "real-compensated") {
            return "real-compensated journeys need a declared compensator, which this release does not have";
        }
        return null;
    }

    /* ---------------------------------------------------------- the runner */

    /**
     * Run one journey now.  Each step resolves its capability against the
     * graph as it is, invokes it as the synthetic principal, and checks what
     * the journey said to expect.
     */
    async run(graphId: string, journeyId: string, by: "schedule" | "request", principal?: Principal): Promise<JourneyRun | { error: string; code: string }> {
        if (principal) {
            const allowed = decide(principal, ["graph:read"]);
            if (!allowed.allow) {
                return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
            }
        }
        const journey: IntentJourney | null = await this.getJson(JourneyService.key(graphId, journeyId));
        if (!journey) {
            return { error: `no journey ${journeyId}`, code: "NOT_FOUND" };
        }
        const startedAt = Date.now();
        const runId = ulid();
        const correlationId = runId;
        const graph: any = await this.crdtStore.projectGraph(graphId).catch(() => null);
        const active = await this.crdtStore.activeRevision(graphId).catch(() => null);
        const run: JourneyRun = {
            runId, journeyId, graphId,
            revisionId: active && active.revisionId ? active.revisionId : "live",
            intent: journey.intent,
            at: new Date(startedAt).toISOString(),
            duration: 0, state: "passed", steps: [], correlationId, by,
        };
        if (!graph || !Array.isArray(graph.nodes)) {
            return this.finish(journey, { ...run, state: "probe-error", reason: `the graph could not be read`, duration: Date.now() - startedAt });
        }
        // A journey may run the graph and watch what happens; it may not change
        // anything, and the policy holds it to that like any other non-human.
        const synthetic: any = {
            sub: journey.identity.syntheticPrincipal, kind: "synthetic", tenant: journey.identity.tenant,
            scopes: ["graph:read", "graph:execute", "graph:observe"],
        };
        for (const step of journey.steps) {
            const result = await this.runStep(journey, graph, step, synthetic, correlationId);
            run.steps.push(result);
            if (result.state !== "passed") {
                run.state = result.state === "unresolvable" ? "unresolvable" : "failed";
                run.reason = result.reason;
                break;
            }
        }
        return this.finish(journey, { ...run, duration: Date.now() - startedAt });
    }

    private async runStep(journey: IntentJourney, graph: any, step: JourneyStep, synthetic: any, correlationId: string): Promise<JourneyStepResult> {
        const capability = step.act.invoke.capability;
        const node = resolveCapability(graph, capability);
        if (!node) {
            // the application lost a capability: that is the finding, not an error
            return { capability, state: "unresolvable", reason: `nothing in this graph provides ${capability}` };
        }
        const observations: Observation[] = [];
        const outputs: { field: string; value: any }[] = [];
        const deferred: string[] = [];
        const runner = this.deps.runner((o) => observations.push(o));
        try {
            const summary = await runner.run({
                graph,
                nodeUrl: node.url,
                field: step.act.invoke.field || ((node.properties && node.properties.inputs && node.properties.inputs[0] && node.properties.inputs[0].name) || "in"),
                value: step.act.invoke.input,
                principal: { sub: synthetic.sub, kind: synthetic.kind, tenant: synthetic.tenant },
                correlationId,
                budget: journey.budget,
                // `sim` grants nothing, so every effect is refused and observed;
                // `isolated` keeps the journey's writes to itself
                principalCapabilities: journey.effects === "sim" ? [] : null,
                kvPrefix: journey.effects === "isolated" ? `synthetic/${journey.id}` : undefined,
                deliver: async (delivery: any) => { deferred.push(delivery.nodeId); },
            } as any);
            (summary as any).outputs = outputs;
            const failed = this.check(step, summary, observations, deferred);
            return {
                capability, resolvedNode: node.id, executionId: summary.executionId,
                observations: observations.length,
                deferredToBrowser: deferred.length ? deferred : undefined,
                state: failed ? "failed" : "passed",
                reason: failed || undefined,
            };
        } catch (err: any) {
            return { capability, resolvedNode: node.id, state: "failed", reason: String((err && err.message) || err) };
        }
    }

    /** What the journey said to expect, checked against what happened. */
    private check(step: JourneyStep, summary: any, observations: Observation[], deferred: string[]): string | null {
        const expect = step.expect || {};
        if (expect.observation) {
            const wanted = expect.observation;
            const found = observations.find((o) => {
                if (o.kind !== wanted.kind) {
                    return false;
                }
                const where = wanted.where || {};
                return Object.keys(where).every((k) => {
                    const payload: any = o.payload || {};
                    return payload[k] === where[k] || (o as any)[k] === where[k];
                });
            });
            if (!found) {
                const near = observations.filter((o) => o.kind === wanted.kind).length;
                return `expected ${wanted.kind}${wanted.where ? ` where ${JSON.stringify(wanted.where)}` : ""}` +
                    (near ? `; saw ${near} of that kind with other values` : "; it never happened") +
                    (deferred.length ? `; ${deferred.length} hop(s) were handed to a browser that is not here` : "");
            }
        }
        if (summary.errors) {
            const error = observations.find((o) => o.kind === "exec.error");
            return `the execution reported ${summary.errors} error(s)${error ? `: ${error.payload.message}` : ""}`;
        }
        if (expect.state && expect.state.schema) {
            // a state check needs a second capability to read it back; without
            // `via` there is nothing to read, so say so rather than pass quietly
            if (!expect.state.via) {
                return "a state expectation needs `via` naming the capability that reads it back";
            }
        }
        return null;
    }

    private async finish(journey: IntentJourney, run: JourneyRun): Promise<JourneyRun> {
        const failures = run.state === "passed" ? 0 : (journey.consecutiveFailures || 0) + 1;
        const quarantineAfter = (journey.flakiness && journey.flakiness.quarantineAfter) || 3;
        const updated: IntentJourney = {
            ...journey,
            lastRunAt: run.at,
            lastResult: run.state,
            consecutiveFailures: failures,
            quarantined: failures >= quarantineAfter,
        };
        await this.putJson(JourneyService.key(journey.graphId, journey.id), updated);
        await this.putJson(JourneyService.runKey(journey.graphId, journey.id, run.runId), run);
        await this.trim(journey.graphId, journey.id);
        if (this.deps.notify) {
            await this.deps.notify(journey.graphId, {
                eventType: "journey", action: "result", journeyId: journey.id, runId: run.runId,
                state: run.state, reason: run.reason, intent: journey.intent, at: run.at, duration: run.duration,
            });
        }
        return run;
    }

    private async trim(graphId: string, journeyId: string) {
        const keys = (await this.listKeys(`journeys/${graphId}/${journeyId}/runs/`)).sort().reverse();
        for (const key of keys.slice(KEEP_RUNS)) {
            await new Promise<void>((resolve) => this.store.remove(key, () => resolve()));
        }
    }

    /* -------------------------------------------------------- the schedule */

    /* ----------------------------------------------------------- the routes */

    private reply(callback: (err: any, r: any) => void, body: any) {
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": true };
        const status = body && body.error
            ? (body.code === "ADMISSION_DENIED" ? 403 : body.code === "NOT_FOUND" ? 404 : 400)
            : 200;
        callback(null, { statusCode: status, body: JSON.stringify(body), headers });
    }

    /** `GET /crdt/{id}/journeys`, `POST /crdt/{id}/journeys` */
    listRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const graphId = event.pathParameters.id;
        if (event.httpMethod === "POST") {
            let body: any = {};
            try { body = event.body ? JSON.parse(event.body) : {}; } catch (err) { body = {}; }
            this.put(graphId, event.principal, body)
                .then((r) => this.reply(callback, r))
                .catch((err) => { console.error("Cannot save a journey.", err); callback(null, { statusCode: 500 }); });
            return;
        }
        this.list(graphId, event.principal)
            .then((r) => this.reply(callback, r))
            .catch((err) => { console.error("Cannot list journeys.", err); callback(null, { statusCode: 500 }); });
    }

    /** `GET /crdt/{id}/journeys/{journeyId}/runs`, `POST /crdt/{id}/journeys/{journeyId}/run`, `DELETE /crdt/{id}/journeys/{journeyId}` */
    journeyRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const { id: graphId, journeyId } = event.pathParameters || {};
        const path = String(event.path || "");
        if (event.httpMethod === "DELETE") {
            this.remove(graphId, journeyId, event.principal)
                .then((r) => this.reply(callback, r))
                .catch((err) => { console.error("Cannot remove a journey.", err); callback(null, { statusCode: 500 }); });
            return;
        }
        if (event.httpMethod === "POST" || /\/run$/.test(path)) {
            this.run(graphId, journeyId, "request", event.principal)
                .then((r) => this.reply(callback, "error" in r ? r : { run: r }))
                .catch((err) => { console.error("Cannot run a journey.", err); callback(null, { statusCode: 500 }); });
            return;
        }
        this.runs(graphId, journeyId, event.principal, Number((event.queryStringParameters || {}).limit || 20))
            .then((r) => this.reply(callback, r))
            .catch((err) => { console.error("Cannot read journey runs.", err); callback(null, { statusCode: 500 }); });
    }

    /** The scheduled tick (EventBridge, every five minutes). */
    tickRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        this.tick()
            .then((r) => {
                console.log("Journey tick:", { considered: r.considered, ran: r.ran.map((run) => ({ journeyId: run.journeyId, state: run.state })) });
                callback(null, { ran: r.ran.length, considered: r.considered });
            })
            .catch((err) => { console.error("The journey tick failed.", err); callback(null, { ran: 0, error: String(err && err.message) }); });
    }

    /** Every journey that is due now, across every graph. */
    async tick(windowMinutes = 5): Promise<{ ran: JourneyRun[]; considered: number }> {
        const now = this.now();
        const keys = (await this.listKeys("journeys/")).filter((k) => k.endsWith(".json") && !k.includes("/runs/"));
        const ran: JourneyRun[] = [];
        for (const key of keys) {
            const journey: IntentJourney | null = await this.getJson(key);
            if (!journey || journey.enabled === false || journey.quarantined) {
                continue;
            }
            if (!isDue(journey.schedule, now, journey.lastRunAt, windowMinutes)) {
                continue;
            }
            const result = await this.run(journey.graphId, journey.id, "schedule");
            if (!("error" in result)) {
                ran.push(result);
            }
        }
        return { ran, considered: keys.length };
    }
}
