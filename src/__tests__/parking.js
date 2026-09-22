/**
 * Deliveries waiting for a browser (plan §4.8.2, PB-072/073).
 *
 * The question these answer is what happens to a hop that is handed to a
 * domain this process does not control: who may take it, what a reconnecting
 * browser is told it missed, and what is recorded when nobody ever takes it.
 */
const { ParkingService, DEFAULT_TTL_MS, RETENTION_MS } = require("../runtime/parking");
const { ExecutionRunner, readObservations } = require("../runtime/executor");
const { ExecutionIngest } = require("../runtime/ingest");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
const stranger = { sub: "auth0|u2", kind: "agent", tenant: "personal:auth0|u1", scopes: [] };
const EXECUTION = "01M32AAAAAAAAAAAAAAAAAAAAA";
const delivery = (over = {}) => ({
    schemaVersion: 1,
    executionId: EXECUTION,
    correlationId: EXECUTION,
    revisionId: "live",
    graphId: "g1",
    nodeId: "render",
    field: "in",
    value: { price: 42 },
    seq: 1,
    instancePath: [],
    target: "all-viewers",
    ...over,
});
const at = (iso) => () => new Date(iso);
const make = (iso = "2026-09-21T12:00:00.000Z") => {
    const s3 = new FakeS3Service();
    let now = new Date(iso);
    const parking = new ParkingService(s3, { now: () => now });
    return { s3, parking, travel: (ms) => { now = new Date(now.getTime() + ms); }, get now() { return now; } };
};

describe("parking a delivery", () => {
    test("holds it under the execution and the delivery key, once", async () => {
        const { s3, parking } = make();
        const first = await parking.park("g1", delivery());
        const second = await parking.park("g1", delivery({ value: { price: 999 } }));
        expect(first.state).toBe("pending");
        expect(first.expiresAt).toBe(new Date(new Date(first.parkedAt).getTime() + DEFAULT_TTL_MS).toISOString());
        // the same unit of work arriving twice is still one unit of work
        expect(second.delivery.value).toEqual({ price: 42 });
        expect([...s3.objects.keys()].filter((k) => k.startsWith("deliveries/pending/"))).toEqual([
            `deliveries/pending/g1/${EXECUTION}/render-1.json`,
        ]);
    });

    test("takes the graph's own time to wait when it states one", async () => {
        const { parking } = make();
        const record = await parking.park("g1", delivery(), 5000);
        expect(new Date(record.expiresAt).getTime() - new Date(record.parkedAt).getTime()).toBe(5000);
    });

    test("refuses a delivery that is not one", async () => {
        const { parking } = make();
        expect(await parking.park("g1", { nodeId: "render", seq: 1, executionId: "not-a-ulid" })).toBe(null);
        expect(await parking.park("g1", null)).toBe(null);
    });
});

describe("what a session is told is waiting for it", () => {
    test("a node every viewer draws is offered to every session; one addressed to a session is not", async () => {
        const { parking } = make();
        await parking.park("g1", delivery({ nodeId: "render", seq: 1, target: "all-viewers" }));
        await parking.park("g1", delivery({ nodeId: "charge", seq: 2, target: "initiator", initiator: "session-a" }));
        const a = await parking.pending("g1", owner, { session: "session-a" });
        const b = await parking.pending("g1", owner, { session: "session-b" });
        expect(a.deliveries.map((d) => d.nodeId).sort()).toEqual(["charge", "render"]);
        expect(b.deliveries.map((d) => d.nodeId)).toEqual(["render"]);
    });

    test("without a session it says everything that is waiting, and never what has been taken", async () => {
        const { parking } = make();
        await parking.park("g1", delivery());
        expect((await parking.pending("g1", owner)).parked).toBe(1);
        await parking.claim("g1", owner, { executionId: EXECUTION, key: "render-1", session: "session-a" });
        expect((await parking.pending("g1", owner)).parked).toBe(0);
    });

    test("a delivery past its time is not offered to anyone", async () => {
        const ctx = make();
        await ctx.parking.park("g1", delivery());
        ctx.travel(DEFAULT_TTL_MS + 1);
        expect((await ctx.parking.pending("g1", owner)).parked).toBe(0);
    });

    test("only for a graph the caller may read", async () => {
        const { parking } = make();
        const denied = await parking.pending("g1", undefined);
        expect(denied.code).toBe("ADMISSION_DENIED");
    });
});

describe("taking a delivery", () => {
    test("records which session took it, and which sessions ran it", async () => {
        const ctx = make();
        await ctx.parking.park("g1", delivery());
        const first = await ctx.parking.claim("g1", owner, { executionId: EXECUTION, key: "render-1", session: "session-a" });
        ctx.travel(10);
        const second = await ctx.parking.claim("g1", owner, { executionId: EXECUTION, key: "render-1", session: "session-b" });
        expect(first).toMatchObject({ claimed: true, by: "session-a", runs: 1, alreadyClaimed: false });
        // every viewer draws this one, so the second session is a run, not a conflict
        expect(second).toMatchObject({ claimed: true, by: "session-a", runs: 2, alreadyClaimed: true });
        const record = JSON.parse(ctx.s3.objects.get(`deliveries/pending/g1/${EXECUTION}/render-1.json`).toString());
        expect(record.runs.map((r) => r.session)).toEqual(["session-a", "session-b"]);
    });

    test("says so when there is nothing under that key, and when it stopped waiting", async () => {
        const ctx = make();
        expect(await ctx.parking.claim("g1", owner, { executionId: EXECUTION, key: "render-1", session: "s" })).toMatchObject({ code: "NOT_FOUND" });
        await ctx.parking.park("g1", delivery());
        ctx.travel(DEFAULT_TTL_MS + 1);
        await ctx.parking.sweep();
        expect(await ctx.parking.claim("g1", owner, { executionId: EXECUTION, key: "render-1", session: "s" })).toMatchObject({ code: "EXPIRED" });
    });

    test("refuses a claim that does not name what it claims", async () => {
        const { parking } = make();
        expect(await parking.claim("g1", owner, { executionId: "nope", key: "render-1", session: "s" })).toMatchObject({ code: "SCHEMA_INVALID" });
        expect(await parking.claim("g1", owner, { executionId: EXECUTION, key: "render-1" })).toMatchObject({ code: "SCHEMA_INVALID" });
        expect(await parking.claim("g1", undefined, { executionId: EXECUTION, key: "render-1", session: "s" })).toMatchObject({ code: "ADMISSION_DENIED" });
    });
});

describe("a delivery nobody takes", () => {
    test("is recorded against its execution as an error naming the reason", async () => {
        const ctx = make();
        ctx.s3.set(`executions/${EXECUTION}.json`, {
            executionId: EXECUTION, graphId: "g1", revisionId: "live", owner, domain: "server",
            entry: { nodeUrl: "entry", field: "in" }, state: "completed",
            observations: { count: 0, key: `observations/g1/2026092112/${EXECUTION}.ndjson` },
        }, {}, () => undefined);
        await ctx.parking.park("g1", delivery());
        ctx.travel(DEFAULT_TTL_MS + 1000);
        const swept = await ctx.parking.sweep();
        expect(swept.expired).toEqual([{ graphId: "g1", executionId: EXECUTION, key: "render-1", nodeId: "render" }]);
        const record = JSON.parse(ctx.s3.objects.get(`deliveries/pending/g1/${EXECUTION}/render-1.json`).toString());
        expect(record.state).toBe("expired");
        const observations = await readObservations(ctx.s3, { observations: { key: record.observationsKey } });
        expect(observations).toHaveLength(1);
        expect(observations[0]).toMatchObject({
            kind: "exec.error", nodeId: "render", executionId: EXECUTION, domain: "server",
            payload: { code: "NO_BROWSER", reason: "no-browser", target: "all-viewers", seq: 1 },
        });
        expect(observations[0].owner.sub).toBe(owner.sub);
    });

    test("is read back as part of that execution's story", async () => {
        const ctx = make();
        const runner = new ExecutionRunner(ctx.s3);
        const g = {
            id: "g1", url: "g1", version: 0, properties: { name: "g1", description: "" },
            nodes: [
                { id: "entry", url: "entry", edges: [{ field: "out", connectors: [{ id: "c1", nodeId: "render", field: "in", graphId: "g1", version: 0 }] }], version: 0, graphId: "g1", artifact: null, data: null, properties: { inputs: [{ name: "in", type: "Object", external: false, visible: true }], outputs: [{ name: "out", type: "Object", external: false, visible: true }], groups: [], name: "entry", description: "", tags: [], icon: "", x: 0, y: 0, z: 0, createdOn: 1, presentation: { x: 0, y: 0, z: 0 } }, template: { set: "edges.out = value;", vue: "" } },
                { id: "render", url: "render", edges: [{ field: "out", connectors: [] }], version: 0, graphId: "g1", artifact: null, data: null, properties: { placement: "browser", inputs: [{ name: "in", type: "Object", external: false, visible: true }], outputs: [{ name: "out", type: "Object", external: false, visible: true }], groups: [], name: "render", description: "", tags: [], icon: "", x: 0, y: 0, z: 0, createdOn: 1, presentation: { x: 0, y: 0, z: 0 } }, template: { set: "state.drawn = value;", vue: "" } },
            ],
        };
        const parked = [];
        const summary = await runner.run({
            graph: g, nodeUrl: "entry", field: "in", value: 21, principal: owner,
            deliver: async (d) => { parked.push(await ctx.parking.park("g1", d)); },
        });
        expect(parked).toHaveLength(1);
        ctx.travel(DEFAULT_TTL_MS + 1);
        await ctx.parking.sweep();
        const ingest = new ExecutionIngest(ctx.s3);
        const story = await ingest.observations("g1", summary.executionId, owner);
        const kinds = story.observations.map((o) => `${o.kind}:${o.nodeId || ""}`);
        expect(kinds).toContain("route:render");
        expect(kinds).toContain("exec.error:render");
        expect(story.observations.find((o) => o.kind === "exec.error").payload.reason).toBe("no-browser");
    });

    test("a delivery taken in time is never turned into an error", async () => {
        const ctx = make();
        await ctx.parking.park("g1", delivery());
        await ctx.parking.claim("g1", owner, { executionId: EXECUTION, key: "render-1", session: "session-a" });
        ctx.travel(DEFAULT_TTL_MS + 1);
        const swept = await ctx.parking.sweep();
        expect(swept.expired).toEqual([]);
        expect([...ctx.s3.objects.keys()].some((k) => k.endsWith("-no-browser.ndjson"))).toBe(false);
    });

    test("settled records are forgotten after a day, and pending ones are not", async () => {
        const ctx = make();
        await ctx.parking.park("g1", delivery());
        await ctx.parking.park("g1", delivery({ nodeId: "later", seq: 2 }));
        await ctx.parking.claim("g1", owner, { executionId: EXECUTION, key: "render-1", session: "session-a" });
        ctx.travel(RETENTION_MS + 1000);
        const swept = await ctx.parking.sweep();
        expect(swept.forgotten).toBe(1);
        expect(ctx.s3.objects.has(`deliveries/pending/g1/${EXECUTION}/render-1.json`)).toBe(false);
        // the one nobody took is now an error, and is kept until its own day is up
        expect(swept.expired.map((e) => e.nodeId)).toEqual(["later"]);
        expect(ctx.s3.objects.has(`deliveries/pending/g1/${EXECUTION}/later-2.json`)).toBe(true);
    });

    test("an agent may take one too: it is the graph it can read, not who it is", async () => {
        const ctx = make();
        await ctx.parking.park("g1", delivery());
        expect(await ctx.parking.claim("g1", { ...stranger, scopes: ["graph:read"] }, { executionId: EXECUTION, key: "render-1", session: "session-a" }))
            .toMatchObject({ claimed: true });
    });
});

/**
 * What crossed one wire (plan §4.5.3, PB-114).  The editor asks this when
 * someone selects a connector: the values that went through it are evidence
 * the browser that is open now never saw.
 */
describe("asking what crossed a connector", () => {
    const executionWith = (s3, executionId, observations) => {
        const record = {
            executionId, graphId: "g1", revisionId: "live", owner, domain: "server",
            entry: { nodeUrl: "entry", field: "in" }, startedAt: "2026-09-21T12:00:00.000Z", endedAt: "2026-09-21T12:00:01.000Z",
            state: "completed", duration: 1000, hops: 2, errors: 0, correlationId: executionId,
            observations: { count: observations.length, key: `observations/g1/2026092112/${executionId}.ndjson`, sampled: false, capped: false },
            effects: { allowed: 0, denied: 0 },
        };
        s3.set(`executions/${executionId}.json`, record, {}, () => undefined);
        s3.set(`executions/by-graph/g1/${executionId}.json`, record, {}, () => undefined);
        s3.setRaw(record.observations.key, Buffer.from(observations.map((o) => JSON.stringify(o)).join("\n") + "\n"), {}, () => undefined);
        return record;
    };
    const observation = (id, over = {}) => ({
        id, seq: 1, at: "2026-09-21T12:00:00.500Z", kind: "route", graphId: "g1", revisionId: "live",
        instancePath: [], executionId: EXECUTION, correlationId: EXECUTION, domain: "server", owner,
        connectorId: "c1", nodeId: "render", edgeField: "in", payload: { value: { price: 42 }, meta: { type: "object", bytes: 14 } },
        ...over,
    });

    test("answers with what went through that connector, newest first, and says how far it looked", async () => {
        const { s3 } = make();
        executionWith(s3, EXECUTION, [
            observation("01AAA", { connectorId: "c1" }),
            observation("01AAB", { connectorId: "c2", nodeId: "other" }),
            observation("01AAC", { connectorId: "c1", payload: { value: { price: 84 }, meta: { type: "object", bytes: 14 } } }),
        ]);
        const ingest = new ExecutionIngest(s3);
        const answer = await ingest.query("g1", owner, { connectorId: "c1" });
        expect(answer.observations.map((o) => o.id)).toEqual(["01AAC", "01AAA"]);
        expect(answer.observations[0].payload.value).toEqual({ price: 84 });
        expect(answer.filesRead).toBe(1);
    });

    test("filters by node and by kind as well", async () => {
        const { s3 } = make();
        executionWith(s3, EXECUTION, [
            observation("01AAA", { kind: "route", nodeId: "render" }),
            observation("01AAB", { kind: "exec.error", nodeId: "render", connectorId: undefined }),
            observation("01AAC", { kind: "route", nodeId: "compute", connectorId: "c9" }),
        ]);
        const ingest = new ExecutionIngest(s3);
        expect((await ingest.query("g1", owner, { nodeId: "compute" })).observations.map((o) => o.id)).toEqual(["01AAC"]);
        expect((await ingest.query("g1", owner, { kind: "exec." })).observations.map((o) => o.id)).toEqual(["01AAB"]);
    });

    test("hides payloads from a caller who may not read them, and refuses one who may not observe", async () => {
        const { s3 } = make();
        executionWith(s3, EXECUTION, [observation("01AAA")]);
        const ingest = new ExecutionIngest(s3);
        const agent = { sub: "auth0|a1", kind: "agent", tenant: "personal:auth0|u1", scopes: ["graph:read", "graph:observe"] };
        const answer = await ingest.query("g1", agent, { connectorId: "c1" });
        expect(answer.observations[0].payload).toEqual({ meta: { type: "object", bytes: 14 }, redacted: "payload" });
        expect((await ingest.query("g1", { ...agent, scopes: ["graph:read"] }, {})).code).toBe("ADMISSION_DENIED");
    });
});
