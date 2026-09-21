/**
 * Continuous intent journeys (plan §8.1.7): what the application is for,
 * proved on a schedule.  A journey names capabilities, not nodes, so these
 * tests rebuild the graph underneath one and expect it to keep passing — and
 * to say plainly when the capability is gone.
 */
const { JourneyService, resolveCapability, providedCapabilities } = require("../journeys/service");
const { cronMatches, isValidCron, isDue } = require("../journeys/cron");
const { ExecutionRunner } = require("../runtime/executor");
const CrdtStore = require("../crdtStore").default;
const { fromJSON, encodeState, applyUpdate, reconcile } = require("@plastic-io/graph-crdt");
const Y = require("yjs");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
const undelegatedAgent = { sub: "agent|a1", kind: "agent", tenant: "personal:auth0|u1", scopes: [] };
const journeyPrincipal = { sub: "synthetic:doubles-a-number", kind: "synthetic", tenant: "synthetic", scopes: ["graph:read", "graph:execute", "graph:observe"] };
const port = (name, over = {}) => ({ name, type: "Object", external: false, visible: true, ...over });
const node = (id, set, over = {}) => ({
    id, url: id, edges: [{ field: "out", connectors: [] }], version: 0, graphId: "g1", artifact: null, data: null,
    properties: { inputs: [port("in")], outputs: [port("out")], groups: [], name: id, description: "", tags: [], icon: "", x: 0, y: 0, z: 0, createdOn: 1, presentation: { x: 0, y: 0, z: 0 }, ...(over.properties || {}) },
    template: { set, vue: "" },
});
const graphOf = (nodes) => ({ id: "g1", url: "g1", version: 0, nodes, properties: { name: "Hybrid Check", description: "" } });
const journeyBody = (over = {}) => ({
    id: "doubles-a-number",
    intent: "A number sent to the entry point comes back doubled",
    capability: "demo.double",
    schedule: "*/5 * * * *",
    effects: "sim",
    steps: [{ act: { invoke: { capability: "demo.double", input: { n: 21 } } }, expect: { observation: { kind: "exec.end", where: { state: "completed" } } } }],
    ...over,
});

async function setup(nodes) {
    const s3 = new FakeS3Service();
    const store = new CrdtStore(s3);
    const notified = [];
    const journeys = new JourneyService(s3, store, {
        runner: (live) => new ExecutionRunner(s3, { live }),
        notify: async (graphId, e) => notified.push(e),
    });
    if (nodes) {
        await store.appendUpdate("g1", encodeState(fromJSON(graphOf(nodes))), "seed", "system");
    }
    return { s3, store, journeys, notified };
}

describe("the small part of cron a schedule needs", () => {
    test("matches the minutes it names, and refuses what it cannot run", () => {
        const at = (iso) => new Date(iso);
        expect(cronMatches("*/5 * * * *", at("2026-09-21T10:05:00Z"))).toBe(true);
        expect(cronMatches("*/5 * * * *", at("2026-09-21T10:07:00Z"))).toBe(false);
        expect(cronMatches("0 * * * *", at("2026-09-21T10:00:00Z"))).toBe(true);
        expect(cronMatches("30 2 * * *", at("2026-09-21T02:30:00Z"))).toBe(true);
        expect(cronMatches("30 2 * * *", at("2026-09-21T03:30:00Z"))).toBe(false);
        expect(cronMatches("0 0 * * 1", at("2026-09-21T00:00:00Z"))).toBe(true);    // a Monday
        expect(cronMatches("0 0 * * 2", at("2026-09-21T00:00:00Z"))).toBe(false);
        expect(cronMatches("0,30 * * * *", at("2026-09-21T10:30:00Z"))).toBe(true);
        expect(cronMatches("0-15 * * * *", at("2026-09-21T10:09:00Z"))).toBe(true);
        expect(isValidCron("*/5 * * * *")).toBe(true);
        expect(isValidCron("every 5 minutes")).toBe(false);
        expect(isValidCron("*/5 * * *")).toBe(false);
        expect(isValidCron("99 * * * *")).toBe(false);
    });

    test("a tick that covers several minutes still runs what it skipped, once", () => {
        const now = new Date("2026-09-21T10:07:00Z");
        expect(isDue("*/5 * * * *", now, null)).toBe(true);                              // never run
        expect(isDue("*/5 * * * *", now, "2026-09-21T10:05:30Z")).toBe(false);           // ran this cycle
        expect(isDue("*/5 * * * *", now, "2026-09-21T10:02:00Z")).toBe(true);            // 10:05 was skipped
        expect(isDue("*/5 * * * *", now, "2026-09-21T10:06:50Z")).toBe(false);           // ran within the minute
        expect(isDue("0 3 * * *", now, "2026-09-20T03:00:00Z")).toBe(false);             // not its hour
    });
});

describe("a journey", () => {
    test("is saved with what it is for, and refuses what cannot be run", async () => {
        const { journeys } = await setup();
        const saved = await journeys.put("g1", owner, journeyBody());
        expect(saved.created).toBe(true);
        expect(saved.journey).toMatchObject({
            schemaVersion: 1, id: "doubles-a-number", graphId: "g1", capability: "demo.double",
            identity: { syntheticPrincipal: "synthetic:doubles-a-number", tenant: "synthetic" },
            effects: "sim", enabled: true, createdBy: "auth0|u1", quarantined: false,
        });
        expect((await journeys.put("g1", owner, journeyBody({ schedule: "every 5 minutes" }))).code).toBe("SCHEMA_INVALID");
        expect((await journeys.put("g1", owner, journeyBody({ intent: "no" }))).code).toBe("SCHEMA_INVALID");
        expect((await journeys.put("g1", owner, journeyBody({ steps: [] }))).code).toBe("SCHEMA_INVALID");
        expect((await journeys.put("g1", owner, journeyBody({ effects: "real-compensated" }))).error).toMatch(/compensator/);
        expect((await journeys.put("g1", undelegatedAgent, journeyBody())).code).toBe("ADMISSION_DENIED");
        // a journey's own principal can run and watch, and nothing else
        expect((await journeys.put("g1", journeyPrincipal, journeyBody())).code).toBe("ADMISSION_DENIED");
        expect((await journeys.list("g1", journeyPrincipal)).journeys).toHaveLength(1);
        const listed = await journeys.list("g1", owner);
        expect(listed.journeys.map((j) => j.id)).toEqual(["doubles-a-number"]);
    });

    test("passes when the graph still does what it is for, and says which node answered", async () => {
        const { journeys, notified, s3 } = await setup([
            node("entry", "edges.out = { doubled: value.n * 2 };", { properties: { provides: ["demo.double"] } }),
        ]);
        await journeys.put("g1", owner, journeyBody());
        const run = await journeys.run("g1", "doubles-a-number", "request", owner);
        expect(run).toMatchObject({ journeyId: "doubles-a-number", graphId: "g1", state: "passed", by: "request", intent: expect.stringContaining("doubled") });
        expect(run.steps).toEqual([expect.objectContaining({ capability: "demo.double", resolvedNode: "entry", state: "passed" })]);
        expect(run.steps[0].executionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        // the run is kept, the journey remembers, and anyone watching is told
        const stored = JSON.parse(s3.objects.get(`journeys/g1/doubles-a-number/runs/${run.runId}.json`).toString());
        expect(stored.state).toBe("passed");
        const journey = JSON.parse(s3.objects.get("journeys/g1/doubles-a-number.json").toString());
        expect(journey).toMatchObject({ lastResult: "passed", consecutiveFailures: 0, quarantined: false });
        expect(notified).toEqual([expect.objectContaining({ eventType: "journey", action: "result", state: "passed" })]);
        // it ran as the synthetic principal, in its own tenant
        const execution = JSON.parse(s3.objects.get(`executions/${run.steps[0].executionId}.json`).toString());
        expect(execution.owner).toEqual({ sub: "synthetic:doubles-a-number", kind: "synthetic", tenant: "synthetic" });
    });

    test("fails when the graph stops doing it, and says what it expected", async () => {
        const { journeys } = await setup([
            node("entry", "throw new Error('the doubler is broken');", { properties: { provides: ["demo.double"] } }),
        ]);
        await journeys.put("g1", owner, journeyBody());
        const run = await journeys.run("g1", "doubles-a-number", "request", owner);
        expect(run.state).toBe("failed");
        expect(run.reason).toMatch(/the doubler is broken/);
        expect(run.steps[0]).toMatchObject({ state: "failed", resolvedNode: "entry" });
    });

    test("names a capability, not a node, so the graph can be rebuilt underneath it", async () => {
        const { journeys, store } = await setup([
            node("entry", "edges.out = { doubled: value.n * 2 };", { properties: { provides: ["demo.double"] } }),
        ]);
        await journeys.put("g1", owner, journeyBody());
        expect((await journeys.run("g1", "doubles-a-number", "request", owner)).state).toBe("passed");
        // the node is replaced by a different one that provides the same thing,
        // the way an editor would: the document is changed, not appended to
        const rebuilt = graphOf([
            node("something-else-entirely", "edges.out = { doubled: value.n + value.n };", { properties: { provides: ["demo.double"] } }),
        ]);
        const doc = new Y.Doc();
        applyUpdate(doc, (await store.loadMerged("g1")).update);
        reconcile(doc, rebuilt);
        await store.appendUpdate("g1", encodeState(doc), "rebuild", "system");
        const after = await journeys.run("g1", "doubles-a-number", "request", owner);
        expect(after.state).toBe("passed");
        expect(after.steps[0].resolvedNode).toBe("something-else-entirely");
    });

    test("says the application lost a capability rather than calling it an error", async () => {
        const { journeys } = await setup([node("entry", "edges.out = value;")]);
        await journeys.put("g1", owner, journeyBody());
        const run = await journeys.run("g1", "doubles-a-number", "request", owner);
        expect(run.state).toBe("unresolvable");
        expect(run.reason).toMatch(/nothing in this graph provides demo.double/);
    });

    test("in sim, every effect is refused; in isolated, its writes are its own", async () => {
        const code = "try { await host.kv.put('counter', { n: 1 }); state.wrote = true; } catch (e) { state.refused = e.name; } edges.out = 1;";
        const { journeys, s3 } = await setup([node("entry", code, { properties: { provides: ["demo.double"], capabilities: ["storage:kv:counter"] } })]);
        await journeys.put("g1", owner, journeyBody());
        const sim = await journeys.run("g1", "doubles-a-number", "request", owner);
        expect(sim.state).toBe("passed");
        expect([...s3.objects.keys()].some((k) => k.startsWith("kv/"))).toBe(false);
        await journeys.put("g1", owner, journeyBody({ effects: "isolated" }));
        const isolated = await journeys.run("g1", "doubles-a-number", "request", owner);
        expect(isolated.state).toBe("passed");
        const written = [...s3.objects.keys()].filter((k) => k.startsWith("kv/"));
        expect(written).toEqual(["kv/synthetic/doubles-a-number/g1/counter.json"]);
    });

    test("a hop handed to a browser that is not here is said out loud", async () => {
        const nodes = [
            node("entry", "edges.out = { doubled: value.n * 2 };", { properties: { provides: ["demo.double"] } }),
            node("draw", "state.drew = value;", { properties: { placement: "browser" } }),
        ];
        nodes[0].edges[0].connectors.push({ id: "c1", nodeId: "draw", field: "in", graphId: "g1", version: 0 });
        const { journeys } = await setup(nodes);
        await journeys.put("g1", owner, journeyBody({
            steps: [{ act: { invoke: { capability: "demo.double", input: { n: 21 } } }, expect: { observation: { kind: "custom", where: { kind: "drawn" } } } }],
        }));
        const run = await journeys.run("g1", "doubles-a-number", "request", owner);
        expect(run.state).toBe("failed");
        expect(run.reason).toMatch(/handed to a browser that is not here/);
        expect(run.steps[0].deferredToBrowser).toEqual(["draw"]);
    });

    test("repeated failures quarantine it, so a broken journey stops crying wolf", async () => {
        const { journeys, s3 } = await setup([node("entry", "throw new Error('still broken');", { properties: { provides: ["demo.double"] } })]);
        await journeys.put("g1", owner, journeyBody({ flakiness: { retries: 0, quarantineAfter: 2 } }));
        await journeys.run("g1", "doubles-a-number", "request", owner);
        await journeys.run("g1", "doubles-a-number", "request", owner);
        const journey = JSON.parse(s3.objects.get("journeys/g1/doubles-a-number.json").toString());
        expect(journey).toMatchObject({ consecutiveFailures: 2, quarantined: true });
        // the schedule leaves a quarantined journey alone
        const tick = await journeys.tick();
        expect(tick.ran).toEqual([]);
    });

    test("the schedule runs what is due, and only that", async () => {
        const { journeys, s3 } = await setup([node("entry", "edges.out = { doubled: value.n * 2 };", { properties: { provides: ["demo.double"] } })]);
        await journeys.put("g1", owner, journeyBody({ id: "every-five", schedule: "*/5 * * * *" }));
        await journeys.put("g1", owner, journeyBody({ id: "nightly", schedule: "0 3 * * *" }));
        await journeys.put("g1", owner, journeyBody({ id: "switched-off", schedule: "*/5 * * * *", enabled: false }));
        journeys.deps = { ...journeys.deps, now: () => new Date("2026-09-21T10:05:00Z") };
        const tick = await journeys.tick();
        expect(tick.ran.map((r) => r.journeyId)).toEqual(["every-five"]);
        expect(tick.considered).toBe(3);
        expect(JSON.parse(s3.objects.get("journeys/g1/every-five.json").toString()).lastResult).toBe("passed");
    });

    test("what a capability means is read from the node, however the graph spells it", () => {
        expect(providedCapabilities({ properties: { provides: ["a.b"] } })).toEqual(["a.b"]);
        expect(providedCapabilities({ properties: { capabilities: { provides: ["c.d"] } } })).toEqual(["c.d"]);
        expect(providedCapabilities({ properties: { capabilities: ["net:https:x"] } })).toEqual([]);
        expect(providedCapabilities({})).toEqual([]);
        const graph = graphOf([node("a", "", { properties: { provides: ["x.y"] } })]);
        expect(resolveCapability(graph, "x.y").id).toBe("a");
        expect(resolveCapability(graph, "nope")).toBeNull();
    });
});
