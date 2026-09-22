/**
 * What a proposal would do, before anyone lives with it (plan §4.7.5).
 *
 * The structural half is always answerable. The shadow half is only as good as
 * what was kept, which is why most of these are about saying so: what was
 * compared, what could not be, and what would have reached outside the graph.
 */
const { SimulationService } = require("../proposals/simulate");
const { ExecutionRunner } = require("../runtime/executor");
const CrdtStore = require("../crdtStore").default;
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
const reader = { sub: "agent|a1", kind: "agent", tenant: "personal:auth0|u1", scopes: ["graph:read"] };
const simulator = { sub: "agent|a2", kind: "agent", tenant: "personal:auth0|u1", scopes: ["graph:read", "graph:simulate"] };

const port = (name) => ({ name, type: "Object", external: false, visible: true });
const node = (id, set, properties = {}) => ({
    id, url: id, edges: [{ field: "out", connectors: [] }], version: 0, graphId: "g1", artifact: null, data: null,
    properties: {
        inputs: [port("in")], outputs: [port("out")], groups: [], name: id, description: "", tags: [], icon: "",
        x: 0, y: 0, z: 0, createdOn: 1, presentation: { x: 0, y: 0, z: 0 }, ...properties,
    },
    template: { set, vue: "" },
});
const graphOf = (nodes, connectors = []) => {
    const g = { id: "g1", url: "g1", version: 0, nodes, properties: { name: "g1", description: "" } };
    connectors.forEach(([from, to], i) => {
        g.nodes.find((n) => n.id === from).edges[0].connectors.push({ id: `c${i + 1}`, nodeId: to, field: "in", graphId: "g1", version: 0 });
    });
    return g;
};

/** A service whose proposal is whatever the test says it is. */
const make = (proposal, projection) => {
    const s3 = new FakeS3Service();
    const store = new CrdtStore(s3);
    const simulations = new SimulationService(s3, store, {
        proposals: {
            get: async () => proposal,
            projection: async () => projection,
        },
        runner: (live) => new ExecutionRunner(s3, { live }),
        now: () => new Date("2026-09-22T05:00:00.000Z"),
    });
    return { s3, simulations };
};

/** An execution of the graph as it is, with its inputs kept whole. */
async function recordExecution(s3, graph, value, at = "2026-09-22T04:59:00.000Z") {
    const runner = new ExecutionRunner(s3);
    const summary = await runner.run({
        graph, nodeUrl: "entry", field: "in", value, principal: owner,
        defaultCapture: "full", now: () => Date.parse(at),
    });
    const record = JSON.parse(s3.objects.get(`executions/${summary.executionId}.json`).toString());
    record.startedAt = at;
    s3.set(`executions/${summary.executionId}.json`, record, {}, () => undefined);
    s3.set(`executions/by-graph/g1/${summary.executionId}.json`, record, {}, () => undefined);
    return summary;
}

const live = graphOf([
    node("entry", "edges.out = {n: value.n};"),
    node("double", "edges.out = {n: value.n * 2};"),
], [["entry", "double"]]);

const proposalOf = (namespaces) => ({
    proposalId: "p1", graphId: "g1", state: "validated", diffSummary: { namespaces },
});

describe("what a change touches", () => {
    test("says whether simulation is called for at all", async () => {
        const codeChange = make(proposalOf(["code"]), live);
        const structural = await codeChange.simulations.run("g1", "p1", owner, { mode: "structural" });
        expect(structural).toMatchObject({ mode: "structural", required: true, namespaces: ["code"], verdict: "unproven" });
        expect(structural.comparisons).toEqual([]);

        const layoutChange = make(proposalOf(["layout"]), live);
        expect((await layoutChange.simulations.run("g1", "p1", owner, {})).required).toBe(false);
    });

    test("lists what nothing can stand in for", async () => {
        const proposed = graphOf([
            node("entry", "edges.out = value;", { capabilities: [{ kind: "secret", scope: ["stripe"] }] }),
            node("pay", "edges.out = value;", { capabilities: [{ kind: "aws:lambda", scope: ["invoke"] }, { kind: "net:https", scope: ["api.example.com"] }] }),
        ], [["entry", "pay"]]);
        const { simulations } = make(proposalOf(["capabilities"]), proposed);
        const answer = await simulations.run("g1", "p1", owner, { mode: "structural" });
        expect(answer.unsimulatedEffects.map((e) => `${e.nodeId}:${e.kind}`).sort()).toEqual(["entry:secret", "pay:aws:lambda"]);
        expect(answer.unsimulatedEffects[0].reason).toContain("never simulated");
    });

    test("only for somebody allowed to ask", async () => {
        const { simulations } = make(proposalOf(["code"]), live);
        expect(await simulations.run("g1", "p1", reader, {})).toMatchObject({ code: "ADMISSION_DENIED" });
        expect((await simulations.run("g1", "p1", simulator, {})).mode).toBe("structural");
    });

    test("a replay is refused rather than guessed at", async () => {
        const { simulations } = make(proposalOf(["code"]), live);
        const answer = await simulations.run("g1", "p1", owner, { mode: "replay" });
        expect(answer.code).toBe("UNSUPPORTED");
        expect(answer.error).toContain("does not record them yet");
    });

    test("a proposal that is not there, and one with nothing to run", async () => {
        expect(await make(null, live).simulations.run("g1", "p1", owner, {})).toMatchObject({ code: "NOT_FOUND" });
        expect(await make(proposalOf(["code"]), null).simulations.run("g1", "p1", owner, {})).toMatchObject({ code: "NOT_FOUND" });
    });
});

describe("running the proposal against work that already happened", () => {
    test("says the same when the change does not change what any node is given", async () => {
        const proposed = graphOf([
            node("entry", "edges.out = {n: value.n};   // tidied, same answer"),
            node("double", "edges.out = {n: value.n * 2};"),
        ], [["entry", "double"]]);
        const { s3, simulations } = make(proposalOf(["code"]), proposed);
        await recordExecution(s3, live, { n: 21 });
        const answer = await simulations.run("g1", "p1", owner, { mode: "shadow" });
        expect(answer.coverage).toMatchObject({ executionsFound: 1, executionsRun: 1 });
        expect(answer.verdict).toBe("same");
        expect(answer.comparisons.every((c) => c.verdict === "equal")).toBe(true);
        expect(answer.comparisons.map((c) => c.nodeId).sort()).toEqual(["double", "entry"]);
    });

    test("says which node is given something else, and what became of it", async () => {
        const proposed = graphOf([
            node("entry", "edges.out = {n: value.n + 1};"),
            node("double", "edges.out = {n: value.n * 2};"),
        ], [["entry", "double"]]);
        const { s3, simulations } = make(proposalOf(["code"]), proposed);
        await recordExecution(s3, live, { n: 21 });
        const answer = await simulations.run("g1", "p1", owner, { mode: "shadow" });
        expect(answer.verdict).toBe("differs-in-value");
        const changed = answer.comparisons.find((c) => c.nodeId === "double");
        expect(changed).toMatchObject({ verdict: "schema-equal", note: "the same shape, a different value" });
        expect(answer.comparisons.find((c) => c.nodeId === "entry").verdict).toBe("equal");
    });

    test("says when the proposal stops reaching a node at all", async () => {
        const proposed = graphOf([
            node("entry", "edges.out = {n: value.n};"),
            node("double", "edges.out = {n: value.n * 2};"),
        ]);                                            // the connector is gone
        const { s3, simulations } = make(proposalOf(["code"]), proposed);
        await recordExecution(s3, live, { n: 21 });
        const answer = await simulations.run("g1", "p1", owner, { mode: "shadow" });
        expect(answer.verdict).toBe("differs");
        expect(answer.comparisons.find((c) => c.nodeId === "double")).toMatchObject({ verdict: "diff", note: "the proposed graph never reached this node" });
    });

    test("an effect the proposal would perform is refused and listed, not performed", async () => {
        const proposed = graphOf([
            node("entry", "edges.out = {n: value.n};"),
            node("double", "await host.fetch('https://api.example.com/rate'); edges.out = {n: value.n * 2};", { capabilities: [{ kind: "net:https", scope: ["api.example.com"] }] }),
        ], [["entry", "double"]]);
        const { s3, simulations } = make(proposalOf(["code", "capabilities"]), proposed);
        await recordExecution(s3, live, { n: 21 });
        const answer = await simulations.run("g1", "p1", owner, { mode: "shadow" });
        const refused = answer.unsimulatedEffects.find((e) => e.kind === "net:https");
        expect(refused).toMatchObject({ nodeId: "double", scope: "api.example.com" });
        expect(refused.reason).toContain("would reach outside the graph");
    });

    test("an execution whose inputs were kept as a shape is counted, not skipped over quietly", async () => {
        const { s3, simulations } = make(proposalOf(["code"]), live);
        const runner = new ExecutionRunner(s3);
        const summary = await runner.run({ graph: live, nodeUrl: "entry", field: "in", value: { n: 7 }, principal: owner });  // default capture: meta
        const record = JSON.parse(s3.objects.get(`executions/${summary.executionId}.json`).toString());
        record.startedAt = "2026-09-22T04:59:30.000Z";
        s3.set(`executions/by-graph/g1/${summary.executionId}.json`, record, {}, () => undefined);
        const answer = await simulations.run("g1", "p1", owner, { mode: "shadow" });
        expect(answer.coverage.executionsFound).toBe(1);
        expect(answer.coverage.executionsRun).toBe(0);
        expect(answer.coverage.skipped[0].reason).toContain("kept as a shape");
        expect(answer.verdict).toBe("unproven");
    });

    test("looks no further back than it was asked to", async () => {
        const { s3, simulations } = make(proposalOf(["code"]), live);
        await recordExecution(s3, live, { n: 1 }, "2026-09-21T05:00:00.000Z");   // a day earlier
        const recent = await simulations.run("g1", "p1", owner, { mode: "shadow", executionSample: { sinceMinutes: 60 } });
        expect(recent.coverage.executionsFound).toBe(0);
        const wider = await simulations.run("g1", "p1", owner, { mode: "shadow", executionSample: { sinceMinutes: 1440 } });
        expect(wider.coverage.executionsFound).toBe(1);
    });

    test("the shadow leaves no trace in what this graph has run", async () => {
        const { s3, simulations } = make(proposalOf(["code"]), live);
        await recordExecution(s3, live, { n: 21 });
        const before = [...s3.objects.keys()].filter((k) => k.startsWith("executions/by-graph/")).length;
        await simulations.run("g1", "p1", owner, { mode: "shadow" });
        const after = [...s3.objects.keys()].filter((k) => k.startsWith("executions/by-graph/")).length;
        expect(after).toBe(before);
        expect([...s3.objects.keys()].some((k) => k.includes("-shadow-"))).toBe(true);
    });
});
