import { ulid } from "ulid";
import { Principal } from "../auth/principal";
import { decide } from "../policy/decide";
import { ExecutionRunner } from "../runtime/executor";
import { Observation } from "../runtime/observe";
import { scopeMatches } from "../runtime/capabilities";
import { resolveCapability } from "../journeys/service";
import CrdtStore from "../crdtStore";

/**
 * Component tests (plan §8.1.2, PB-101).
 *
 * A journey asks whether the application still does what it is for; a test
 * asks whether one component still behaves as its author said it would.  The
 * difference matters when something breaks: a journey says the outcome is
 * gone, a test says which part stopped keeping its word.
 *
 * A test states inputs, and what it expects of the outputs, the effects and
 * the observations that follow.  It runs against a graph with its effects
 * contained and, where it needs to, a clock it holds still, so "five within a
 * window, then refused" can be checked in milliseconds.
 */

export type TestKind = "contract" | "property";

export interface ComponentTest {
    schemaVersion: 1;
    id: string;
    graphId: string;
    kind: TestKind;
    description: string;
    /** What is being tested: a node, or whatever provides a capability. */
    target: { nodeId?: string; capability?: string; field?: string };
    fixtures?: {
        /** Keep what the test writes to itself. */
        kv?: { prefix?: string };
        /** Hold the clock still, so a window can be crossed without waiting. */
        clock?: { start?: string; frozen?: boolean; stepMs?: number };
    };
    inputs: { field?: string; value: any; repeat?: number }[];
    expect: {
        /** Values the node wrote to an output, in order, or against a schema. */
        outputs?: { field: string; sequence?: any[]; schema?: any; onlyWhen?: { field: string; equals: any } }[];
        /** Effects it was allowed to perform, by kind and scope. */
        effects?: { kind: string; scope?: string; count?: { min?: number; max?: number } }[];
        /** Observations that must (or must not) appear. */
        observations?: { kind: string; count?: { min?: number; max?: number } }[];
        /** Plain-language rules, in the one shape this can check honestly. */
        invariants?: string[];
    };
    budget?: any;
    createdBy?: string | null;
    createdAt?: string;
    updatedAt?: string;
    lastResult?: "passed" | "failed" | null;
    lastRunAt?: string | null;
}

export interface TestRun {
    runId: string;
    testId: string;
    graphId: string;
    revisionId: string;
    description: string;
    at: string;
    duration: number;
    state: "passed" | "failed" | "unresolvable";
    /** Every expectation that was not met, in the words of the test. */
    failures: string[];
    outputs: { field: string; value: any }[];
    effects: { kind: string; scope: string; decision: string }[];
    observations: number;
    executionIds: string[];
    by: "request" | "gate";
}

interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
    remove(key: string, cb: (err: any, data: any) => void): void;
    list(prefix: string, cb: (err: any, items: any[]) => void): void;
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const MAX_INPUTS = 200;
const KEEP_RUNS = 20;
/** `outputs.a === x implies outputs.b > y`, and nothing more clever than that. */
const INVARIANT = /^outputs\.([a-zA-Z0-9_]+)\s*(===|!==|>|<|>=|<=)\s*(.+?)\s+implies\s+outputs\.([a-zA-Z0-9_]+)\s*(===|!==|>|<|>=|<=)\s*(.+)$/;

const literal = (text: string): any => {
    const trimmed = text.trim();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (trimmed === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return trimmed.replace(/^['"]|['"]$/g, "");
};
const compare = (left: any, operator: string, right: any): boolean => {
    switch (operator) {
        case "===": return left === right;
        case "!==": return left !== right;
        case ">": return left > right;
        case "<": return left < right;
        case ">=": return left >= right;
        case "<=": return left <= right;
        default: return false;
    }
};

export class TestService {
    constructor(
        private store: Store,
        private crdtStore: CrdtStore,
        private deps: { runner: (live: (o: Observation) => void) => ExecutionRunner; validator?: (schema: any) => (value: any) => { ok: boolean; message?: string } },
    ) {}

    static key(graphId: string, testId: string) { return `tests/${graphId}/${testId}.json`; }
    static runKey(graphId: string, testId: string, runId: string) { return `tests/${graphId}/${testId}/runs/${runId}.json`; }

    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }
    private putJson(key: string, value: any): Promise<void> {
        return new Promise((resolve, reject) => this.store.set(key, value, {}, (err: any) => (err ? reject(err) : resolve())));
    }
    private listKeys(prefix: string): Promise<string[]> {
        return new Promise((resolve) => this.store.list(prefix, (err: any, items: any[]) => resolve(err ? [] : (items || []).map((i: any) => i.Key))));
    }

    /* ----------------------------------------------------------- the store */

    async list(graphId: string, principal: Principal | undefined): Promise<any> {
        const allowed = decide(principal, ["graph:read"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const keys = (await this.listKeys(`tests/${graphId}/`)).filter((k) => k.endsWith(".json") && !k.includes("/runs/"));
        const tests: ComponentTest[] = [];
        for (const key of keys) {
            const test = await this.getJson(key);
            if (test) {
                tests.push(test);
            }
        }
        return { graphId, tests };
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
        const existing = await this.getJson(TestService.key(graphId, body.id));
        const test: ComponentTest = {
            schemaVersion: 1,
            id: String(body.id),
            graphId,
            kind: "contract",
            description: String(body.description).slice(0, 1000),
            target: { nodeId: body.target.nodeId, capability: body.target.capability, field: body.target.field },
            fixtures: body.fixtures && typeof body.fixtures === "object" ? body.fixtures : undefined,
            inputs: body.inputs.map((i: any) => ({ field: i.field, value: i.value, repeat: Math.min(100, Math.max(1, Number(i.repeat) || 1)) })),
            expect: body.expect || {},
            budget: body.budget && typeof body.budget === "object" ? body.budget : { wallMs: 10000, hops: 200, fanOut: 100, depth: 16 },
            createdBy: existing ? existing.createdBy : principal.sub,
            createdAt: existing ? existing.createdAt : new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastResult: existing ? existing.lastResult : null,
            lastRunAt: existing ? existing.lastRunAt : null,
        };
        await this.putJson(TestService.key(graphId, test.id), test);
        return { test, created: !existing };
    }

    async remove(graphId: string, testId: string, principal: Principal | undefined): Promise<any> {
        const allowed = decide(principal, ["graph:test"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        await new Promise<void>((resolve) => this.store.remove(TestService.key(graphId, testId), () => resolve()));
        return { removed: testId };
    }

    async runs(graphId: string, testId: string, principal: Principal | undefined, limit = 20): Promise<any> {
        const allowed = decide(principal, ["graph:observe"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const keys = (await this.listKeys(`tests/${graphId}/${testId}/runs/`)).sort().reverse().slice(0, limit);
        const runs: TestRun[] = [];
        for (const key of keys) {
            const run = await this.getJson(key);
            if (run) {
                runs.push(run);
            }
        }
        return { graphId, testId, runs };
    }

    private validate(body: any): string | null {
        if (!body || typeof body !== "object") return "a test is an object";
        if (!ID.test(String(body.id || ""))) return "id must be a short slug";
        if (!body.description || String(body.description).trim().length < 8) return "description says what this test is checking, in a sentence";
        if (body.kind && body.kind !== "contract") return `${body.kind} tests are not run by this release; only contract tests are`;
        if (!body.target || (!body.target.nodeId && !body.target.capability)) return "target names a node or a capability";
        if (!Array.isArray(body.inputs) || !body.inputs.length) return "a test needs at least one input";
        const total = body.inputs.reduce((n: number, i: any) => n + (Number(i.repeat) || 1), 0);
        if (total > MAX_INPUTS) return `at most ${MAX_INPUTS} inputs in one test`;
        for (const invariant of (body.expect && body.expect.invariants) || []) {
            if (!INVARIANT.test(String(invariant))) {
                return `this release can only check invariants of the form "outputs.a === x implies outputs.b > y"; it cannot check ${JSON.stringify(invariant)}`;
            }
        }
        return null;
    }

    /* ---------------------------------------------------------- the runner */

    /** Run one test against a graph, or against a particular revision of it. */
    async run(graphId: string, testId: string, principal: Principal | undefined, options: { revisionId?: string; projection?: any; by?: "request" | "gate" } = {}): Promise<TestRun | { error: string; code: string }> {
        if (principal) {
            const allowed = decide(principal, ["graph:test"]);
            if (!allowed.allow) {
                return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
            }
        }
        const test: ComponentTest | null = await this.getJson(TestService.key(graphId, testId));
        if (!test) {
            return { error: `no test ${testId}`, code: "NOT_FOUND" };
        }
        const startedAt = Date.now();
        const runId = ulid();
        const graph: any = options.projection || await this.crdtStore.projectGraph(graphId).catch(() => null);
        const run: TestRun = {
            runId, testId, graphId, revisionId: options.revisionId || "live", description: test.description,
            at: new Date(startedAt).toISOString(), duration: 0, state: "passed", failures: [],
            outputs: [], effects: [], observations: 0, executionIds: [], by: options.by || "request",
        };
        if (!graph || !Array.isArray(graph.nodes)) {
            return this.finish(test, { ...run, state: "unresolvable", failures: ["the graph could not be read"], duration: Date.now() - startedAt });
        }
        const node = test.target.nodeId
            ? graph.nodes.find((n: any) => n.id === test.target.nodeId || n.url === test.target.nodeId)
            : resolveCapability(graph, test.target.capability as string);
        if (!node) {
            return this.finish(test, {
                ...run, state: "unresolvable", duration: Date.now() - startedAt,
                failures: [test.target.nodeId ? `no node ${test.target.nodeId} in this graph` : `nothing in this graph provides ${test.target.capability}`],
            });
        }

        /* the clock the test holds, and the corner of storage it writes to */
        const clock = test.fixtures && test.fixtures.clock;
        let now = clock && clock.start ? Date.parse(clock.start) : Date.now();
        const stepMs = clock && clock.stepMs ? Number(clock.stepMs) : 0;
        const nowFn = clock ? () => (clock.frozen === false ? Date.now() : now) : undefined;
        const prefix = (test.fixtures && test.fixtures.kv && test.fixtures.kv.prefix) || `tests/${test.id}`;

        const observations: Observation[] = [];
        const outputs: { field: string; value: any }[] = [];
        const runner = this.deps.runner((o) => observations.push(o));
        const field = test.target.field || (node.properties && node.properties.inputs && node.properties.inputs[0] && node.properties.inputs[0].name) || "in";
        try {
            for (const input of test.inputs) {
                for (let i = 0; i < (input.repeat || 1); i++) {
                    const summary: any = await runner.run({
                        graph,
                        nodeUrl: node.url,
                        field: input.field || field,
                        value: input.value,
                        principal: principal ? { sub: principal.sub, kind: principal.kind, tenant: principal.tenant } : null,
                        revisionId: options.revisionId,
                        correlationId: runId,
                        budget: test.budget,
                        kvPrefix: prefix,
                        now: nowFn,
                        onEdgeWrite: (writtenField: string, value: any, from: any) => {
                            if (!from || from.id === node.id) {
                                outputs.push({ field: writtenField, value });
                            }
                        },
                        deliver: async () => undefined,
                    } as any);
                    run.executionIds.push(summary.executionId);
                    now += stepMs;
                }
            }
        } catch (err: any) {
            run.failures.push(`the test could not be run: ${String((err && err.message) || err)}`);
        }
        run.outputs = outputs;
        run.observations = observations.length;
        run.effects = observations
            .filter((o) => o.kind === "effect" || o.kind === "effect.denied")
            .map((o) => ({ kind: o.capability!.kind, scope: (o.capability!.scope || [])[0] || "", decision: o.capability!.decision }));
        run.failures.push(...this.check(test, outputs, observations));
        return this.finish(test, { ...run, state: run.failures.length ? "failed" : "passed", duration: Date.now() - startedAt });
    }

    /** Everything the test said to expect, checked against what happened. */
    private check(test: ComponentTest, outputs: { field: string; value: any }[], observations: Observation[]): string[] {
        const failures: string[] = [];
        const expect = test.expect || {};
        const valuesOf = (field: string) => outputs.filter((o) => o.field === field).map((o) => o.value);
        (expect.outputs || []).forEach((wanted) => {
            const values = valuesOf(wanted.field);
            if (wanted.sequence) {
                const got = values.slice(0, wanted.sequence.length);
                if (JSON.stringify(got) !== JSON.stringify(wanted.sequence)) {
                    failures.push(`${wanted.field} was ${JSON.stringify(values).slice(0, 120)}, and the test expects ${JSON.stringify(wanted.sequence).slice(0, 120)}`);
                }
            }
            if (wanted.schema && this.deps.validator) {
                const validate = this.deps.validator(wanted.schema);
                values.forEach((value, index) => {
                    if (wanted.onlyWhen) {
                        const gate = valuesOf(wanted.onlyWhen.field)[index];
                        if (gate !== wanted.onlyWhen.equals) {
                            return;
                        }
                    }
                    const verdict = validate(value);
                    if (!verdict.ok) {
                        failures.push(`${wanted.field}[${index}] does not match what the test expects of it: ${verdict.message}`);
                    }
                });
            }
        });
        (expect.effects || []).forEach((wanted) => {
            const matching = observations.filter((o) => (o.kind === "effect" || o.kind === "effect.denied")
                && o.capability!.kind === wanted.kind
                && (!wanted.scope || (o.capability!.scope || []).some((s) => scopeMatches(wanted.scope as string, s) || scopeMatches(s, wanted.scope as string))));
            const count = matching.length;
            const min = wanted.count && wanted.count.min !== undefined ? wanted.count.min : 0;
            const max = wanted.count && wanted.count.max !== undefined ? wanted.count.max : Infinity;
            if (count < min || count > max) {
                failures.push(`${wanted.kind}${wanted.scope ? ` on ${wanted.scope}` : ""} happened ${count} time(s), and the test expects ${min === max ? min : `${min} to ${max === Infinity ? "any number" : max}`}`);
            }
        });
        (expect.observations || []).forEach((wanted) => {
            const count = observations.filter((o) => o.kind === wanted.kind).length;
            const min = wanted.count && wanted.count.min !== undefined ? wanted.count.min : 1;
            const max = wanted.count && wanted.count.max !== undefined ? wanted.count.max : Infinity;
            if (count < min || count > max) {
                failures.push(`${wanted.kind} appeared ${count} time(s), and the test expects ${min === max ? min : `${min} to ${max === Infinity ? "any number" : max}`}`);
            }
        });
        (expect.invariants || []).forEach((invariant) => {
            const match = INVARIANT.exec(invariant);
            if (!match) {
                failures.push(`this release cannot check "${invariant}"`);
                return;
            }
            const [, leftField, leftOp, leftValue, rightField, rightOp, rightValue] = match;
            const lefts = valuesOf(leftField);
            const rights = valuesOf(rightField);
            lefts.forEach((value, index) => {
                if (!compare(value, leftOp, literal(leftValue))) {
                    return;                                   // the rule does not apply here
                }
                if (!compare(rights[index], rightOp, literal(rightValue))) {
                    failures.push(`"${invariant}" does not hold: ${leftField} was ${JSON.stringify(value)} and ${rightField} was ${JSON.stringify(rights[index])}`);
                }
            });
        });
        return failures;
    }

    private async finish(test: ComponentTest, run: TestRun): Promise<TestRun> {
        await this.putJson(TestService.key(test.graphId, test.id), { ...test, lastResult: run.state === "passed" ? "passed" : "failed", lastRunAt: run.at });
        await this.putJson(TestService.runKey(test.graphId, test.id, run.runId), run);
        const keys = (await this.listKeys(`tests/${test.graphId}/${test.id}/runs/`)).sort().reverse();
        for (const key of keys.slice(KEEP_RUNS)) {
            await new Promise<void>((resolve) => this.store.remove(key, () => resolve()));
        }
        return run;
    }

    /** Every test of a graph, for a gate that needs to know whether it is sound. */
    async runAll(graphId: string, principal: Principal | undefined, options: { revisionId?: string; projection?: any; by?: "request" | "gate" } = {}): Promise<{ runs: TestRun[]; failed: TestRun[] }> {
        const listed = await this.list(graphId, principal);
        const runs: TestRun[] = [];
        for (const test of (listed.tests || [])) {
            const r = await this.run(graphId, test.id, principal, options);
            if (!("error" in r)) {
                runs.push(r);
            }
        }
        return { runs, failed: runs.filter((r) => r.state !== "passed") };
    }

    /* ----------------------------------------------------------- the routes */

    private reply(callback: (err: any, r: any) => void, body: any) {
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": true };
        const status = body && body.error ? (body.code === "ADMISSION_DENIED" ? 403 : body.code === "NOT_FOUND" ? 404 : 400) : 200;
        callback(null, { statusCode: status, body: JSON.stringify(body), headers });
    }

    /** `GET /crdt/{id}/tests`, `POST /crdt/{id}/tests` */
    listRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const graphId = event.pathParameters.id;
        if (event.httpMethod === "POST") {
            let body: any = {};
            try { body = event.body ? JSON.parse(event.body) : {}; } catch (err) { body = {}; }
            this.put(graphId, event.principal, body).then((r) => this.reply(callback, r)).catch((err) => { console.error("Cannot save a test.", err); callback(null, { statusCode: 500 }); });
            return;
        }
        this.list(graphId, event.principal).then((r) => this.reply(callback, r)).catch((err) => { console.error("Cannot list tests.", err); callback(null, { statusCode: 500 }); });
    }

    /** `POST /crdt/{id}/tests/{testId}/run`, `GET .../runs`, `DELETE .../{testId}` */
    testRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const { id: graphId, testId } = event.pathParameters || {};
        if (event.httpMethod === "DELETE") {
            this.remove(graphId, testId, event.principal).then((r) => this.reply(callback, r)).catch((err) => { console.error("Cannot remove a test.", err); callback(null, { statusCode: 500 }); });
            return;
        }
        if (event.httpMethod === "POST") {
            this.run(graphId, testId, event.principal, { by: "request" })
                .then((r: any) => this.reply(callback, r.error ? r : { run: r }))
                .catch((err) => { console.error("Cannot run a test.", err); callback(null, { statusCode: 500 }); });
            return;
        }
        this.runs(graphId, testId, event.principal, Number((event.queryStringParameters || {}).limit || 20))
            .then((r) => this.reply(callback, r)).catch((err) => { console.error("Cannot read test runs.", err); callback(null, { statusCode: 500 }); });
    }
}
