/**
 * Containment (plan §4.6.3, D-4).  These run the real isolate, so they are
 * skipped where isolated-vm cannot load (it needs a matching Node ABI); CI and
 * the Lambda image both have it.
 */
const { ExecutionRunner } = require("../runtime/executor");
const { isolationAvailable, isolationLoadError, runInIsolate } = require("../runtime/isolate");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1" };
const port = (name, over = {}) => ({ name, type: "Object", external: false, visible: true, ...over });
const node = (id, set, over = {}) => ({ id, url: id, edges: [{ field: "out", connectors: [] }], version: 0, graphId: "g1", artifact: null, data: null, properties: { inputs: [port("in")], outputs: [port("out")], groups: [], name: id, description: "", tags: [], icon: "", x: 0, y: 0, z: 0, createdOn: 1, presentation: { x: 0, y: 0, z: 0 }, ...(over.properties || {}) }, template: { set, vue: "" } });
function graphOf(nodes, connectors = [], properties = {}) {
    const g = { id: "g1", url: "g1", version: 0, nodes, properties: { name: "g1", description: "", ...properties } };
    connectors.forEach(([from, to, field], i) => { g.nodes.find((n) => n.id === from).edges[0].connectors.push({ id: `c${i}`, nodeId: to, field: field || "in", graphId: "g1", version: 0 }); });
    return g;
}
const contained = (id, set, over = {}) => node(id, set, { ...over, properties: { ...(over.properties || {}), containment: "isolate" } });
const readJson = (s3, key) => JSON.parse(s3.objects.get(key).toString());
const observationsOf = async (s3, summary) => {
    const { readObservations } = require("../runtime/executor");
    return readObservations(s3, readJson(s3, `executions/${summary.executionId}.json`));
};

const describeIfAvailable = isolationAvailable() ? describe : describe.skip;
if (!isolationAvailable()) {
    // eslint-disable-next-line no-console
    console.warn("containment tests skipped:", String(isolationLoadError() && isolationLoadError().message).slice(0, 120));
}

describeIfAvailable("a contained node", () => {
    jest.setTimeout(30000);

    test("runs ordinary node code, routes its edges and writes state back", async () => {
        const s3 = new FakeS3Service();
        const runner = new ExecutionRunner(s3);
        const g = graphOf([
            contained("a", "state.seen = (state.seen || 0) + 1; state.nested = {deep: {n: value}}; if (edges.hasOwnProperty('out')) { edges.out = value * 2; }"),
            node("b", "state.received = value;"),
        ], [["a", "b"]]);
        const state = {};
        const summary = await runner.run({ graph: g, nodeUrl: "a", field: "in", value: 21, principal: owner, state });
        expect(summary).toMatchObject({ state: "completed", hops: 2, errors: 0 });
        expect(state).toEqual({ seen: 1, nested: { deep: { n: 21 } }, received: 42 });
    });

    test("has no ambient authority: no require, no process, no fetch, no AWS credentials", async () => {
        const s3 = new FakeS3Service();
        const runner = new ExecutionRunner(s3);
        const probe = `
            const seen = {};
            seen.require = typeof require;
            seen.process = typeof process;
            seen.fetch = typeof fetch;
            seen.AWS = typeof AWS;
            seen.globalKeys = Object.getOwnPropertyNames(globalThis).filter((k) => ["process", "require", "fetch", "AWS", "Buffer", "module", "__dirname"].includes(k));
            try { require('fs'); seen.requireCall = 'allowed'; } catch (e) { seen.requireCall = e.message; }
            // the classic escape: reach the realm's Function constructor and ask it for the host's globals
            try { seen.functionEscape = typeof Function('return process')(); } catch (e) { seen.functionEscape = 'blocked'; }
            seen.functionRealm = Function('return typeof process')();
            try { seen.thisEscape = typeof this.constructor.constructor('return process')(); } catch (e) { seen.thisEscape = 'blocked'; }
            state.probe = seen;
        `;
        const state = {};
        await runner.run({ graph: graphOf([contained("a", probe)]), nodeUrl: "a", value: 1, principal: owner, state });
        expect(state.probe).toMatchObject({ require: "function", process: "undefined", fetch: "undefined", AWS: "undefined", globalKeys: [] });
        expect(state.probe.requireCall).toMatch(/declare a capability and use host/);
        expect(state.probe.functionEscape).toBe("blocked");     // reaching for it throws: there is no such binding to return
        expect(state.probe.functionRealm).toBe("undefined");    // and the realm the Function constructor compiles into is the isolate's own
        expect(state.probe.thisEscape).toBe("blocked");         // and a contained node has no `this` to climb
    });

    test("a runaway loop is stopped inside its budget and reported as an exhausted budget", async () => {
        const s3 = new FakeS3Service();
        const runner = new ExecutionRunner(s3);
        const started = Date.now();
        const summary = await runner.run({ graph: graphOf([contained("a", "while (true) { Math.random(); }")]), nodeUrl: "a", value: 1, principal: owner, isolateLimits: { timeoutMs: 500, memoryMb: 32 } });
        const elapsed = Date.now() - started;
        expect(elapsed).toBeLessThan(3000);
        expect(summary.errors).toBe(1);
        const observations = await observationsOf(s3, summary);
        const budget = observations.find((o) => o.kind === "budget.exhausted");
        expect(budget).toMatchObject({ nodeId: "a", budget: { dimension: "wallMs", limit: 500 }, payload: { contained: true } });
        expect(observations.some((o) => o.kind === "exec.error" && /timed out/i.test(o.payload.message))).toBe(true);
    });

    test("a heap bomb is contained and the host survives to run the next node", async () => {
        const s3 = new FakeS3Service();
        const runner = new ExecutionRunner(s3);
        const g = graphOf([contained("a", "const held = []; while (true) { held.push(new Array(1e6).fill('x')); }")]);
        const summary = await runner.run({ graph: g, nodeUrl: "a", value: 1, principal: owner, isolateLimits: { timeoutMs: 20000, memoryMb: 16 } });
        expect(summary.errors).toBe(1);
        const observations = await observationsOf(s3, summary);
        expect(observations.some((o) => /memory limit|Array buffer allocation failed|timed out/i.test(JSON.stringify(o.payload || {})))).toBe(true);
        // the host is unharmed: another execution runs normally right after
        const state = {};
        const after = await runner.run({ graph: graphOf([contained("b", "state.ok = true;")]), nodeUrl: "b", value: 1, principal: owner, state });
        expect(after.state).toBe("completed");
        expect(state.ok).toBe(true);
    });

    test("effects still go through the capability host, and the same denials are observed", async () => {
        const s3 = new FakeS3Service();
        const fetched = [];
        const runner = new ExecutionRunner(s3, {
            fetchImpl: async (url) => { fetched.push(url); return { ok: true, status: 200, statusText: "OK", url, headers: new Map(), text: async () => JSON.stringify({ hello: "world" }) }; },
            secrets: async () => "sk-test",
        });
        const code = `
            const r = await host.fetch('https://api.example.com/v1');
            state.body = await r.json();
            state.status = r.status;
            try { await host.fetch('https://evil.example/'); } catch (e) { state.denied = e.message; }
            await host.kv.put('demo/x', {n: 1});
            state.kv = await host.kv.get('demo/x');
            try { await host.kv.get('other/x'); } catch (e) { state.kvDenied = 'refused'; }
            host.emit('contained', {ok: true});
            state.capabilities = host.capabilities.instance.map((c) => c.kind);
            state.contained = host.contained;
        `;
        const g = graphOf([contained("a", code, { properties: { capabilities: ["net:https:api.example.com", "storage:kv:demo/*"] } })]);
        const state = {};
        const summary = await runner.run({ graph: g, nodeUrl: "a", value: 1, principal: owner, state });
        expect(state.body).toEqual({ hello: "world" });
        expect(state.status).toBe(200);
        expect(state.denied).toMatch(/not granted \(instance\)/);
        expect(state.kv).toEqual({ n: 1 });
        expect(state.kvDenied).toBe("refused");
        expect(state.capabilities).toEqual(["net:https", "storage:kv"]);
        expect(state.contained).toBe(true);
        expect(fetched).toEqual(["https://api.example.com/v1"]);
        expect(summary.effects).toEqual({ allowed: 3, denied: 2 });   // fetch, kv.put, kv.get; two refusals
        const observations = await observationsOf(s3, summary);
        expect(observations.find((o) => o.kind === "custom").payload).toMatchObject({ kind: "contained" });
        expect(readJson(s3, "kv/g1/demo/x.json").value).toEqual({ n: 1 });
    });

    test("containment is per node: an uncontained node in the same graph still has the 2.0 realm", async () => {
        const s3 = new FakeS3Service();
        const runner = new ExecutionRunner(s3);
        const g = graphOf([
            contained("a", "state.contained = typeof process; edges.out = value;"),
            node("b", "state.ambient = typeof process;"),
        ], [["a", "b"]]);
        const state = {};
        await runner.run({ graph: g, nodeUrl: "a", value: 1, principal: owner, state });
        expect(state).toEqual({ contained: "undefined", ambient: "object" });
    });

    test("asking for containment where it cannot be provided is an error, not a quiet fall back", async () => {
        const s3 = new FakeS3Service();
        const runner = new ExecutionRunner(s3);
        const isolate = require("../runtime/isolate");
        const available = jest.spyOn(isolate, "isolationAvailable").mockReturnValue(false);
        try {
            const summary = await runner.run({ graph: graphOf([contained("a", "state.ran = true;")]), nodeUrl: "a", value: 1, principal: owner, state: {} });
            expect(summary.errors).toBe(1);
            const observations = await observationsOf(s3, summary);
            expect(observations.some((o) => o.payload && o.payload.code === "CONTAINMENT_UNAVAILABLE")).toBe(true);
        } finally {
            available.mockRestore();
        }
    });
});

describeIfAvailable("the isolate itself", () => {
    test("stops a wedged isolate and disposes it without calling back in", async () => {
        const outcome = await runInIsolate({
            code: "let n = 0; while (true) { n += 1; }",
            limits: { timeoutMs: 300, memoryMb: 32 },
            inputs: { value: null, state: {}, data: null, properties: {}, node: { id: "a", properties: { outputs: [] } }, field: "in", graph: { id: "g1" }, cache: {}, capabilities: {} },
            setEdge: () => undefined, setState: () => undefined, setData: () => undefined,
            hostCall: async () => null, log: () => undefined,
        });
        expect(outcome.error).toMatchObject({ kind: "timeout" });
        expect(outcome.wallMs).toBeLessThan(2000);
        expect(outcome.cpuMs).toBeGreaterThanOrEqual(0);
        // a microtask storm allocates, so it ends on whichever ceiling it meets
        // first; either way it stops and the host is left healthy (spike S-1)
        const storm = await runInIsolate({
            code: "while (true) { Promise.resolve().then(() => {}); }",
            limits: { timeoutMs: 300, memoryMb: 32 },
            inputs: { value: null, state: {}, data: null, properties: {}, node: { id: "a", properties: { outputs: [] } }, field: "in", graph: { id: "g1" }, cache: {}, capabilities: {} },
            setEdge: () => undefined, setState: () => undefined, setData: () => undefined,
            hostCall: async () => null, log: () => undefined,
        });
        expect(["timeout", "memory"]).toContain(storm.error.kind);
        expect(storm.wallMs).toBeLessThan(3000);
    });
});
