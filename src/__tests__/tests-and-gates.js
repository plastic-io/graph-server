/**
 * Component tests (plan §8.1.2) and the gates that use them (§8.1.8).
 * A test says what one part of a graph promised; a gate refuses to publish or
 * to run a version that no longer keeps those promises, and says which one.
 */
const { TestService } = require("../tests/runner");
const { JourneyService } = require("../journeys/service");
const { undeclaredEffects, touchesRisk, fromRuns } = require("../gates/gates");
const { ExecutionRunner } = require("../runtime/executor");
const { validatorFor_ } = require("../runtime/contracts");
const { RevisionService, SYSTEM_PRINCIPAL } = require("../revisions/service");
const { ComponentService } = require("../components/service");
const CrdtStore = require("../crdtStore").default;
const CrdtService = require("../crdtService").default;
const TocStore = require("../tocStore").default;
const { fromJSON, encodeState } = require("@plastic-io/graph-crdt");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
const undelegated = { sub: "agent|a1", kind: "agent", tenant: "personal:auth0|u1", scopes: [] };
const port = (name) => ({ name, type: "Object", external: false, visible: true });
const node = (id, set, over = {}) => ({
    id, url: id, edges: (over.fields || ["out"]).map((field) => ({ field, connectors: [] })), version: 0, graphId: "g1", artifact: null, data: null,
    properties: { inputs: [port("in")], outputs: (over.fields || ["out"]).map(port), groups: [], name: id, description: "", tags: [], icon: "", x: 0, y: 0, z: 0, createdOn: 1, presentation: { x: 0, y: 0, z: 0 }, ...(over.properties || {}) },
    template: { set, vue: "<template><div></div></template>" },
});
/** A rate limiter: five in a window, then refused, with a wait. */
const LIMITER = `
  const key = 'window/' + value.key;
  const seen = (await host.kv.get(key)) || { count: 0, since: host.now() };
  const windowMs = 60000;
  if (host.now() - seen.since > windowMs) { seen.count = 0; seen.since = host.now(); }
  if (seen.count < 5) {
    seen.count += 1;
    await host.kv.put(key, seen);
    edges.allowed = true;
    edges.retryAfterMs = 0;
  } else {
    edges.allowed = false;
    edges.retryAfterMs = windowMs - (host.now() - seen.since);
  }
`;
const graphOf = (nodes) => ({ id: "g1", url: "g1", version: 0, nodes, properties: { name: "Rate limiter", description: "" } });
const limiterGraph = (over = {}) => graphOf([
    node("limiter", LIMITER, { fields: ["allowed", "retryAfterMs"], properties: { name: "Rate limiter", capabilities: ["storage:kv:window/*"], provides: ["ratelimit.check"], ...(over.properties || {}) } }),
]);
const testBody = (over = {}) => ({
    id: "five-then-refused",
    description: "Six hits in one window: five allowed, the sixth refused with a wait",
    target: { nodeId: "limiter", field: "in" },
    fixtures: { clock: { start: "2026-09-20T18:00:00Z", frozen: true }, kv: { prefix: "tests/five-then-refused" } },
    inputs: [{ value: { key: "u1", cost: 1 }, repeat: 6 }],
    expect: {
        outputs: [
            { field: "allowed", sequence: [true, true, true, true, true, false] },
            { field: "retryAfterMs", schema: { type: "integer", minimum: 1 }, onlyWhen: { field: "allowed", equals: false } },
        ],
        effects: [{ kind: "storage:kv", scope: "window/u1", count: { min: 6, max: 12 } }],
        observations: [{ kind: "effect.denied", count: { min: 0, max: 0 } }],
        invariants: ["outputs.allowed === false implies outputs.retryAfterMs > 0"],
    },
    ...over,
});

async function setup(nodes) {
    const s3 = new FakeS3Service();
    const store = new CrdtStore(s3);
    const broadcast = { channel: [], postToClient: (d, c, p, cb) => cb(), _sendToChannel: (ch, v, cb) => { broadcast.channel.push([ch, v]); cb(); }, broadcast: (ch, v, cb) => cb() };
    const crdt = new CrdtService(store, broadcast);
    const tocStore = new TocStore(s3);
    const revisions = new RevisionService(store, crdt.admission, { fanOut: (g, u) => crdt.fanOutUpdate(g, u) });
    const components = new ComponentService(store, revisions, crdt.admission, { tocStore, broadcastService: broadcast });
    const tests = new TestService(s3, store, { runner: (live) => new ExecutionRunner(s3, { live }), validator: validatorFor_ });
    const journeys = new JourneyService(s3, store, { runner: (live) => new ExecutionRunner(s3, { live }) });
    const gate = async (graphId, revisionId, projection) => {
        const t = await tests.runAll(graphId, SYSTEM_PRINCIPAL, { revisionId, projection, by: "gate" });
        const j = await journeys.runAgainst(graphId, SYSTEM_PRINCIPAL, { revisionId, projection });
        return fromRuns("tests", t.failed).concat(fromRuns("journeys", j.failed));
    };
    components.gate = gate;
    revisions.gate = gate;
    if (nodes) {
        await store.appendUpdate("g1", encodeState(fromJSON(graphOf(nodes))), "seed", "system");
    }
    return { s3, store, crdt, revisions, components, tests, journeys, broadcast };
}

describe("a component test", () => {
    test("checks what a part promised: the sequence, the schema, the effects and the invariant", async () => {
        const ctx = await setup(limiterGraph().nodes);
        await ctx.tests.put("g1", owner, testBody());
        const run = await ctx.tests.run("g1", "five-then-refused", owner);
        expect(run).toMatchObject({ state: "passed", failures: [], testId: "five-then-refused" });
        expect(run.outputs.filter((o) => o.field === "allowed").map((o) => o.value)).toEqual([true, true, true, true, true, false]);
        expect(run.executionIds).toHaveLength(6);
        expect(run.effects.every((e) => e.kind === "storage:kv" && e.decision === "allowed")).toBe(true);
    });

    test("says which promise was broken when the part changes", async () => {
        const broken = limiterGraph().nodes;
        broken[0].template.set = LIMITER.replace("seen.count < 5", "seen.count < 50");
        const ctx = await setup(broken);
        await ctx.tests.put("g1", owner, testBody());
        const run = await ctx.tests.run("g1", "five-then-refused", owner);
        expect(run.state).toBe("failed");
        expect(run.failures[0]).toMatch(/allowed was .*true.*and the test expects/);
    });

    test("holds the clock still, so a window can be crossed without waiting for one", async () => {
        const ctx = await setup(limiterGraph().nodes);
        // the same six hits, but the clock steps a minute between each: every one is allowed
        await ctx.tests.put("g1", owner, testBody({
            id: "a-minute-apart",
            description: "Six hits a minute apart are all allowed",
            fixtures: { clock: { start: "2026-09-20T18:00:00Z", frozen: true, stepMs: 61000 }, kv: { prefix: "tests/a-minute-apart" } },
            expect: { outputs: [{ field: "allowed", sequence: [true, true, true, true, true, true] }] },
        }));
        const run = await ctx.tests.run("g1", "a-minute-apart", owner);
        expect(run).toMatchObject({ state: "passed", failures: [] });
    });

    test("keeps what it writes to itself", async () => {
        const ctx = await setup(limiterGraph().nodes);
        await ctx.tests.put("g1", owner, testBody());
        await ctx.tests.run("g1", "five-then-refused", owner);
        const keys = [...ctx.s3.objects.keys()].filter((k) => k.startsWith("kv/"));
        expect(keys).toEqual(["kv/tests/five-then-refused/g1/window/u1.json"]);
    });

    test("refuses what it cannot honestly check, and who may not ask", async () => {
        const ctx = await setup(limiterGraph().nodes);
        expect((await ctx.tests.put("g1", owner, testBody({ kind: "property" }))).error).toMatch(/only contract tests/);
        expect((await ctx.tests.put("g1", owner, testBody({ expect: { invariants: ["allowed implies the sun rises"] } }))).error).toMatch(/can only check invariants/);
        expect((await ctx.tests.put("g1", owner, testBody({ target: {} }))).error).toMatch(/names a node or a capability/);
        expect((await ctx.tests.put("g1", undelegated, testBody())).code).toBe("ADMISSION_DENIED");
        await ctx.tests.put("g1", owner, testBody({ id: "gone", target: { nodeId: "not-here" } }));
        const run = await ctx.tests.run("g1", "gone", owner);
        expect(run).toMatchObject({ state: "unresolvable", failures: ["no node not-here in this graph"] });
    });

    test("finds its target by capability, so the graph can be rebuilt underneath it", async () => {
        const ctx = await setup(limiterGraph().nodes);
        await ctx.tests.put("g1", owner, testBody({ id: "by-capability", target: { capability: "ratelimit.check" } }));
        const run = await ctx.tests.run("g1", "by-capability", owner);
        expect(run.state).toBe("passed");
    });
});

describe("the gates", () => {
    test("a node that reaches for an effect it never declared cannot be published", async () => {
        const sneaky = limiterGraph().nodes;
        sneaky[0].properties.capabilities = [];
        expect(undeclaredEffects(graphOf(sneaky))).toEqual([expect.objectContaining({ gate: "publication", nodeId: "limiter", says: expect.stringMatching(/calls host.kv without declaring storage:kv/) })]);
        const ctx = await setup(sneaky);
        const published = await ctx.components.publish("g1", owner, { label: "sneaky" });
        expect(published).toMatchObject({ code: "GATE_FAILED", error: expect.stringMatching(/without declaring storage:kv/) });
        expect(ctx.s3.objects.has("components/g1/1/manifest.json")).toBe(false);
    });

    test("a part that stopped keeping its word cannot be published either, and the gate says which", async () => {
        const broken = limiterGraph().nodes;
        broken[0].template.set = LIMITER.replace("seen.count < 5", "seen.count < 50");
        const ctx = await setup(broken);
        await ctx.tests.put("g1", owner, testBody());
        const published = await ctx.components.publish("g1", owner, { label: "broken" });
        expect(published).toMatchObject({ code: "GATE_FAILED" });
        expect(published.error).toMatch(/Six hits in one window.*failed/);
    });

    test("what passes its tests publishes, and a person who has read the findings may publish anyway", async () => {
        const ctx = await setup(limiterGraph().nodes);
        await ctx.tests.put("g1", owner, testBody());
        const published = await ctx.components.publish("g1", owner, { label: "sound" });
        expect(published.manifest).toMatchObject({ publishedId: "g1", version: expect.any(Number) });
        const sneaky = limiterGraph().nodes;
        sneaky[0].properties.capabilities = [];
        const ctx2 = await setup(sneaky);
        const forced = await ctx2.components.publish("g1", owner, { label: "anyway", force: true });
        expect(forced.manifest).toBeDefined();
    });

    test("a version that fails its tests does not become the one that runs", async () => {
        const ctx = await setup(limiterGraph().nodes);
        await ctx.tests.put("g1", owner, testBody());
        const good = await ctx.revisions.cut("g1", owner, "sound");
        expect(await ctx.revisions.activate("g1", good.revision.revisionId, owner)).toMatchObject({ active: { seq: good.revision.seq } });
        // the part changes and stops keeping its promise; the next version is refused
        const broken = limiterGraph().nodes;
        broken[0].template.set = LIMITER.replace("seen.count < 5", "seen.count < 50");
        const Y = require("yjs");
        const { applyUpdate, reconcile } = require("@plastic-io/graph-crdt");
        const doc = new Y.Doc();
        applyUpdate(doc, (await ctx.store.loadMerged("g1")).update);
        reconcile(doc, graphOf(broken));
        await ctx.store.appendUpdate("g1", encodeState(doc), "break it", "system");
        const bad = await ctx.revisions.cut("g1", owner, "broken");
        const refused = await ctx.revisions.activate("g1", bad.revision.revisionId, owner);
        expect(refused).toMatchObject({ code: "GATE_FAILED", error: expect.stringMatching(/not ready to run/) });
        expect((await ctx.revisions.active("g1")).seq).toBe(good.revision.seq);
        // a person who has read the findings can still say yes, and that is recorded
        const forced = await ctx.revisions.activate("g1", bad.revision.revisionId, owner, true);
        expect(forced.active.seq).toBe(bad.revision.seq);
        const audit = [...ctx.s3.objects.keys()].filter((k) => k.startsWith("audit/g1/") && !k.endsWith("HEAD.json")).map((k) => JSON.parse(ctx.s3.objects.get(k).toString()));
        expect(audit.some((a) => a.kind === "revision.activated" && a.forced)).toBe(true);
    });

    test("an activation opens a window, and a journey that fails inside it says so", async () => {
        const ctx = await setup(limiterGraph().nodes);
        await ctx.journeys.put("g1", owner, {
            id: "still-limits", intent: "The limiter still refuses the sixth hit in a window", capability: "ratelimit.check",
            schedule: "*/5 * * * *", effects: "isolated",
            steps: [{ act: { invoke: { capability: "ratelimit.check", input: { key: "j" } } }, expect: { observation: { kind: "exec.end", where: { state: "completed" } } } }],
        });
        const cut = await ctx.revisions.cut("g1", owner, "before");
        await ctx.revisions.activate("g1", cut.revision.revisionId, owner);
        const window = JSON.parse(ctx.s3.objects.get(RevisionService.windowKey("g1", cut.revision.revisionId)).toString());
        expect(window).toMatchObject({ seq: cut.revision.seq, alerts: [] });
        expect(Date.parse(window.until)).toBeGreaterThan(Date.now());
        // the graph breaks, the journey fails on its next tick, and the alert names the version
        const broken = limiterGraph().nodes;
        broken[0].template.set = "throw new Error('it stopped answering');";
        const Y = require("yjs");
        const { applyUpdate, reconcile } = require("@plastic-io/graph-crdt");
        const doc = new Y.Doc();
        applyUpdate(doc, (await ctx.store.loadMerged("g1")).update);
        reconcile(doc, graphOf(broken));
        await ctx.store.appendUpdate("g1", encodeState(doc), "break it", "system");
        // six minutes later: the journey is due again, and the window is still open
        ctx.journeys.deps = { ...ctx.journeys.deps, now: () => new Date(Date.now() + 6 * 60000) };
        const tick = await ctx.journeys.tick();
        expect(tick.ran.map((r) => r.state)).toEqual(["failed"]);
        expect(tick.alerts[0]).toMatch(/failed within 6 minute\(s\) of version 1 being activated/);
        const after = JSON.parse(ctx.s3.objects.get(RevisionService.windowKey("g1", cut.revision.revisionId)).toString());
        expect(after.alerts).toHaveLength(1);
    });

    test("the gates only ask the heavier questions of changes that could do harm", () => {
        expect(touchesRisk(["layout"])).toBe(false);
        expect(touchesRisk(["definition", "housekeeping"])).toBe(false);
        expect(touchesRisk(["code"])).toBe(true);
        expect(touchesRisk(["capabilities"])).toBe(true);
        expect(touchesRisk(["placement"])).toBe(true);
        expect(fromRuns("tests", [{ state: "failed", description: "a promise", failures: ["it was not kept"] }]))
            .toEqual([{ gate: "tests", says: "a promise failed: it was not kept" }]);
    });
});
