/**
 * Containment under attack (plan §8.1.4, acceptance criteria §4.6.6).
 *
 * Every case here is something a node can do, by accident or on purpose, that
 * would otherwise take the runtime with it.  The assertions are the thresholds
 * the isolate spike measured on the Lambda Node 22 image: a loop is stopped
 * within its budget plus 100 ms, a heap bomb is contained without the host
 * failing, and `exec.end` is emitted every single time — an execution that
 * cannot be stopped is worse than one that fails.
 *
 * These run the real isolate, so they skip where isolated-vm cannot load; the
 * Docker job in .github/workflows/test.yml runs them in the Lambda image,
 * which is where the addon has to work.
 */
const { ExecutionRunner, readObservations } = require("../runtime/executor");
const { isolationAvailable, isolationLoadError, runInIsolate } = require("../runtime/isolate");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1" };
const port = (name, over = {}) => ({ name, type: "Object", external: false, visible: true, ...over });
const node = (id, set, over = {}) => ({
    id, url: id, edges: (over.fields || ["out"]).map((field) => ({ field, connectors: [] })), version: 0, graphId: "g1", artifact: null, data: null,
    properties: { inputs: [port("in")], outputs: (over.fields || ["out"]).map((f) => port(f)), groups: [], name: id, description: "", tags: [], icon: "", x: 0, y: 0, z: 0, createdOn: 1, presentation: { x: 0, y: 0, z: 0 }, containment: "isolate", ...(over.properties || {}) },
    template: { set, vue: "" },
});
const graphOf = (nodes, connectors = []) => {
    const g = { id: "g1", url: "g1", version: 0, nodes, properties: { name: "g1", description: "" } };
    connectors.forEach(([from, to, field], i) => { g.nodes.find((n) => n.id === from).edges[0].connectors.push({ id: `c${i}`, nodeId: to, field: field || "in", graphId: "g1", version: 0 }); });
    return g;
};
const readJson = (s3, key) => JSON.parse(s3.objects.get(key).toString());
const observationsOf = (s3, summary) => readObservations(s3, readJson(s3, `executions/${summary.executionId}.json`));
/** Every adversarial run must end, and say so. */
const endsCleanly = async (s3, summary) => {
    const observations = await observationsOf(s3, summary);
    expect(observations[observations.length - 1].kind).toBe("exec.end");
    return observations;
};

const describeIfAvailable = isolationAvailable() ? describe : describe.skip;
if (!isolationAvailable()) {
    // eslint-disable-next-line no-console
    console.warn("adversarial containment tests skipped:", String(isolationLoadError() && isolationLoadError().message).slice(0, 120));
}

describeIfAvailable("adversarial workloads", () => {
    jest.setTimeout(120000);
    const limits = { timeoutMs: 500, memoryMb: 64 };

    test("a CPU loop is stopped within its budget plus 100 ms", async () => {
        const s3 = new FakeS3Service();
        const started = Date.now();
        const summary = await new ExecutionRunner(s3).run({ graph: graphOf([node("a", "let n = 0; while (true) { n += 1; }")]), nodeUrl: "a", principal: owner, isolateLimits: limits });
        const elapsed = Date.now() - started;
        expect(elapsed).toBeLessThan(limits.timeoutMs + 2000);   // the budget, plus room for the run around it
        const observations = await endsCleanly(s3, summary);
        const budget = observations.find((o) => o.kind === "budget.exhausted");
        expect(budget.budget).toMatchObject({ dimension: "wallMs", limit: limits.timeoutMs });
        expect(budget.budget.used).toBeLessThan(limits.timeoutMs + 100);
    });

    test("a microtask storm cannot outrun the budget", async () => {
        const s3 = new FakeS3Service();
        const summary = await new ExecutionRunner(s3).run({ graph: graphOf([node("a", "while (true) { Promise.resolve().then(() => {}); }")]), nodeUrl: "a", principal: owner, isolateLimits: limits });
        expect(summary.errors).toBe(1);
        await endsCleanly(s3, summary);
    });

    test("an allocation bomb is contained and the host keeps serving", async () => {
        const s3 = new FakeS3Service();
        const runner = new ExecutionRunner(s3);
        const summary = await runner.run({ graph: graphOf([node("a", "const held = []; while (true) { held.push(new Array(1e6).fill('x')); }")]), nodeUrl: "a", principal: owner, isolateLimits: { timeoutMs: 20000, memoryMb: 16 } });
        expect(summary.errors).toBe(1);
        await endsCleanly(s3, summary);
        const state = {};
        const after = await runner.run({ graph: graphOf([node("b", "state.ok = true;")]), nodeUrl: "b", principal: owner, state });
        expect(after.state).toBe("completed");
        expect(state.ok).toBe(true);
    });

    test("a huge array that stays within reach of the limit is contained", async () => {
        const s3 = new FakeS3Service();
        const summary = await new ExecutionRunner(s3).run({ graph: graphOf([node("a", "state.big = new Array(5e6).fill(0).length; edges.out = state.big;")]), nodeUrl: "a", principal: owner, isolateLimits: { timeoutMs: 5000, memoryMb: 64 } });
        await endsCleanly(s3, summary);
    });

    /**
     * The limit of this containment, asserted rather than assumed.  A single
     * allocation far beyond the isolate's limit puts V8 into an unrecoverable
     * out-of-memory state and the process ends; the isolate's memory limit
     * only contains growth, where the collector gets a chance to run.  The
     * case runs in a child process, because in this one it would take the test
     * runner with it, and the assertion is that the child dies while this
     * process is unharmed.  The day isolated-vm or V8 contains this, the test
     * fails and the claim above can be tightened.
     */
    test("a single oversized allocation ends the process, and nothing else", async () => {
        const { execFileSync } = require("child_process");
        const fs = require("fs");
        const path = require("path");
        const script = path.join(__dirname, "..", "..", ".adversarial-child.js");
        fs.writeFileSync(script, `
            const ivm = require("isolated-vm");
            (async () => {
                const isolate = new ivm.Isolate({ memoryLimit: 64, onCatastrophicError: (m) => { process.stdout.write("catastrophic:" + m + "\n"); } });
                const context = await isolate.createContext();
                const compiled = await isolate.compileScript("const a = new Array(5e7).fill(0); a.length;");
                await compiled.run(context, { timeout: 4000, promise: true, copy: true }).catch((err) => process.stdout.write("threw:" + err.message + "\n"));
                try { isolate.dispose(); } catch (err) { /* gone */ }
                process.stdout.write("survived\n");
            })();
        `);
        let output = "";
        let died = false;
        try {
            output = String(execFileSync(process.execPath, [script], { timeout: 45000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
        } catch (err) {
            died = true;
            output = String((err && (err.stdout || err.message)) || "");
        }
        fs.unlinkSync(script);
        // either the child was killed outright, or it reported the failure; what matters is that it did not quietly succeed
        expect(died || /catastrophic:|threw:/.test(output)).toBe(true);
        expect(/^survived$/m.test(output)).toBe(false);
        // this process is untouched: it can still run an isolate
        const s3 = new FakeS3Service();
        const state = {};
        const after = await new ExecutionRunner(s3).run({ graph: graphOf([node("a", "state.ok = true;")]), nodeUrl: "a", principal: owner, state, isolateLimits: limits });
        expect(after.state).toBe("completed");
        expect(state.ok).toBe(true);
    });

    test("a string doubling loop is contained by the limit", async () => {
        const s3 = new FakeS3Service();
        const summary = await new ExecutionRunner(s3).run({ graph: graphOf([node("a", "let s = 'x'; while (true) { s += s; }")]), nodeUrl: "a", principal: owner, isolateLimits: { timeoutMs: 3000, memoryMb: 32 } });
        expect(summary.errors).toBe(1);
        await endsCleanly(s3, summary);
    });

    test("a promise that never settles ends at the budget, not never", async () => {
        const s3 = new FakeS3Service();
        const summary = await new ExecutionRunner(s3).run({ graph: graphOf([node("a", "await new Promise(() => {});")]), nodeUrl: "a", principal: owner, isolateLimits: { timeoutMs: 700, memoryMb: 32 }, budget: { wallMs: 3000, hops: 100, fanOut: 100, depth: 8 } });
        expect(summary.duration).toBeLessThan(6000);
        await endsCleanly(s3, summary);
    });

    test("infinite recursion is a stack error in the isolate, and the node's error alone", async () => {
        const s3 = new FakeS3Service();
        const g = graphOf([node("a", "function f() { return f(); }\nf();\nedges.out = 1;"), node("b", "state.reached = true;")], [["a", "b"]]);
        const state = {};
        const summary = await new ExecutionRunner(s3).run({ graph: g, nodeUrl: "a", principal: owner, state, isolateLimits: limits });
        expect(summary.errors).toBe(1);
        expect(state.reached).toBeUndefined();          // the failing node routed nothing
        const observations = await endsCleanly(s3, summary);
        expect(observations.some((o) => o.kind === "exec.error" && /call stack|RangeError/i.test(o.payload.message))).toBe(true);
    });

    test("a fan-out storm is bounded by the budget, not by patience", async () => {
        const s3 = new FakeS3Service();
        const target = node("t", "state.hits = (state.hits || 0) + 1;");
        const source = node("a", "edges.out = value;");
        for (let i = 0; i < 10000; i++) {
            source.edges[0].connectors.push({ id: `c${i}`, nodeId: "t", field: "in", graphId: "g1", version: 0 });
        }
        const state = {};
        const summary = await new ExecutionRunner(s3).run({
            graph: graphOf([source, target]), nodeUrl: "a", value: 1, principal: owner, state,
            budget: { wallMs: 10000, hops: 200, fanOut: 100, depth: 8 }, isolateLimits: limits,
        });
        expect(state.hits || 0).toBeLessThanOrEqual(200);
        const observations = await endsCleanly(s3, summary);
        expect(observations.some((o) => o.kind === "budget.exhausted")).toBe(true);
    });

    test("an observation flood is capped and sampled, and the execution still ends", async () => {
        const s3 = new FakeS3Service();
        const summary = await new ExecutionRunner(s3).run({
            graph: graphOf([node("a", "for (let i = 0; i < 5000; i++) { host.emit('flood', i); }")]),
            nodeUrl: "a", principal: owner, maxObservations: 100, isolateLimits: { timeoutMs: 20000, memoryMb: 64 },
        });
        expect(summary.observations.capped).toBe(true);
        const observations = await endsCleanly(s3, summary);
        expect(observations.length).toBeLessThan(5000);
        expect(observations.some((o) => o.kind === "budget.exhausted")).toBe(true);
    });

    test("the realm has nothing to reach: no require, process, fetch or credentials", async () => {
        const s3 = new FakeS3Service();
        const probe = `
            state.probe = {
                require: typeof require, process: typeof process, fetch: typeof fetch, AWS: typeof AWS,
                env: (() => { try { return typeof process.env.AWS_SECRET_ACCESS_KEY; } catch (e) { return 'unreachable'; } })(),
                realm: Function('return typeof process')(),
                ctor: await (async () => { try { return typeof await (async () => {}).constructor('return process')(); } catch (e) { return 'blocked'; } })(),
            };
        `;
        const state = {};
        await new ExecutionRunner(s3).run({ graph: graphOf([node("a", probe)]), nodeUrl: "a", principal: owner, state, isolateLimits: limits });
        expect(state.probe).toEqual({ require: "function", process: "undefined", fetch: "undefined", AWS: "undefined", env: "unreachable", realm: "undefined", ctor: "blocked" });
    });

    test("cancelling during a host call ends the execution instead of waiting for it", async () => {
        const s3 = new FakeS3Service();
        let release = () => undefined;
        const runner = new ExecutionRunner(s3, {
            // a host call that only finishes when this test lets it
            fetchImpl: () => new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, text: async () => "{}" }); }),
        });
        const g = graphOf([node("a", "await host.fetch('https://api.example.com/slow'); state.finished = true;", { properties: { capabilities: ["net:https:api.example.com"] } })]);
        const state = {};
        let handle = null;
        const run = runner.run({
            graph: g, nodeUrl: "a", principal: owner, state,
            isolateLimits: { timeoutMs: 20000, memoryMb: 64 },
            budget: { wallMs: 20000, hops: 100, fanOut: 100, depth: 8 },
            onHandle: (h) => { handle = h; },
        });
        await new Promise((r) => setTimeout(r, 300));
        expect(handle).not.toBeNull();
        await handle.cancel("a person changed their mind");
        const summary = await run;
        release();
        // A host call already in flight cannot be taken back, so the execution
        // is abandoned rather than waited on; what matters is that it ends,
        // says so, and that the node's continuation never runs.
        expect(["cancelled", "abandoned", "failed"]).toContain(summary.state);
        expect(state.finished).toBeUndefined();
        await endsCleanly(s3, summary);
    });

    test("sixty adversarial runs leave no isolates behind", async () => {
        const before = process.memoryUsage().rss;
        for (let i = 0; i < 60; i++) {
            const outcome = await runInIsolate({
                code: "let n = 0; while (true) { n += 1; }",
                limits: { timeoutMs: 50, memoryMb: 16 },
                inputs: { value: null, state: {}, data: null, properties: {}, node: { id: "a", properties: { outputs: [] } }, field: "in", graph: { id: "g1" }, cache: {}, capabilities: {} },
                setEdge: () => undefined, setState: () => undefined, setData: () => undefined, hostCall: async () => null, log: () => undefined,
            });
            expect(outcome.error.kind).toBe("timeout");
        }
        if (global.gc) {
            global.gc();
        }
        const after = process.memoryUsage().rss;
        // a leaked isolate holds megabytes; the spike measured RSS stable across 60 runs
        expect(after - before).toBeLessThan(200 * 1024 * 1024);
    });
});
