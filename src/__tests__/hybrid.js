/**
 * Hybrid execution (plan §4.8): one graph, two domains.  The server runs what
 * is placed here, hands over what is not, and runs a single node on behalf of a
 * browser that owns the execution.
 */
const { ExecutionRunner, readObservations } = require("../runtime/executor");
const { DeliveryService } = require("../runtime/deliveries");
const CrdtStore = require("../crdtStore").default;
const CrdtService = require("../crdtService").default;
const { fromJSON, encodeState } = require("@plastic-io/graph-crdt");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
const port = (name, over = {}) => ({ name, type: "Object", external: false, visible: true, ...over });
const node = (id, set, over = {}) => ({ id, url: id, edges: (over.fields || ["out"]).map((field) => ({ field, connectors: [] })), version: 0, graphId: "g1", artifact: null, data: null, properties: { inputs: [port("in")], outputs: [port("out")], groups: [], name: id, description: "", tags: [], icon: "", x: 0, y: 0, z: 0, createdOn: 1, presentation: { x: 0, y: 0, z: 0 }, ...(over.properties || {}) }, template: { set, vue: "" } });
function graphOf(nodes, connectors = [], properties = {}) {
    const g = { id: "g1", url: "g1", version: 0, nodes, properties: { name: "g1", description: "", ...properties } };
    connectors.forEach(([from, to, field], i) => { g.nodes.find((n) => n.id === from).edges[0].connectors.push({ id: `c${i + 1}`, nodeId: to, field: field || "in", graphId: "g1", version: 0 }); });
    return g;
}
const browserNode = (id, set, over = {}) => node(id, set, { ...over, properties: { ...(over.properties || {}), placement: "browser" } });
const serverNode = (id, set, over = {}) => node(id, set, { ...over, properties: { ...(over.properties || {}), placement: "server" } });
const readJson = (s3, key) => JSON.parse(s3.objects.get(key).toString());
const fakeBroadcast = () => { const b = { channel: [] }; b.postToClient = (d, c, p, cb) => cb(); b._sendToChannel = (ch, v, cb) => { b.channel.push([ch, v]); cb(); }; b.broadcast = b._sendToChannel; return b; };

describe("a server-owned execution reaching a browser node", () => {
    test("routes to it, observes the hop as deferred, and hands the value to the browsers", async () => {
        const s3 = new FakeS3Service();
        const runner = new ExecutionRunner(s3);
        const delivered = [];
        const g = graphOf([
            node("entry", "edges.out = {price: value * 2};"),
            browserNode("render", "state.rendered = value;", { properties: { capabilities: ["browser:dom"] } }),
            node("tail", "state.tail = value;"),
        ], [["entry", "render"], ["entry", "tail"]]);
        const state = {};
        const summary = await runner.run({ graph: g, nodeUrl: "entry", field: "in", value: 21, principal: owner, state, deliver: (d) => { delivered.push(d); } });
        expect(summary.state).toBe("completed");
        // the browser node did not run here, the server-placed one did
        expect(state).toEqual({ tail: { price: 42 } });
        expect(delivered).toHaveLength(1);
        expect(delivered[0]).toMatchObject({
            schemaVersion: 1, executionId: summary.executionId, graphId: "g1", nodeId: "render", field: "in",
            value: { price: 42 }, seq: 1, target: "all-viewers",
        });
        const observations = await readObservations(s3, readJson(s3, `executions/${summary.executionId}.json`));
        const deferred = observations.find((o) => o.payload && o.payload.deferred === "browser");
        expect(deferred).toMatchObject({ kind: "route", nodeId: "render", payload: { deferred: "browser", target: "all-viewers", seq: 1 } });
        expect(observations.some((o) => o.kind === "edge.input" && o.nodeId === "render")).toBe(true);
    });

    test("a node whose browser side does something must happen once, so it is addressed to the initiator", async () => {
        const s3 = new FakeS3Service();
        const runner = new ExecutionRunner(s3);
        const delivered = [];
        const g = graphOf([
            node("entry", "edges.out = value;"),
            browserNode("charge", "state.charged = value;", { properties: { capabilities: ["browser:dom", "net:https:api.example.com"] } }),
        ], [["entry", "charge"]]);
        await runner.run({ graph: g, nodeUrl: "entry", value: 1, principal: owner, initiator: "session-7", deliver: (d) => delivered.push(d) });
        expect(delivered[0]).toMatchObject({ target: "initiator", initiator: "session-7" });
    });

    test("a value that cannot cross the boundary fails the hop rather than arriving as null", async () => {
        const s3 = new FakeS3Service();
        const runner = new ExecutionRunner(s3);
        const g = graphOf([
            node("entry", "const big = {}; big.self = big; edges.out = big;"),
            browserNode("render", "state.rendered = value;"),
        ], [["entry", "render"]]);
        const summary = await runner.run({ graph: g, nodeUrl: "entry", value: 1, principal: owner, deliver: () => undefined });
        expect(summary.errors).toBe(1);
        const observations = await readObservations(s3, readJson(s3, `executions/${summary.executionId}.json`));
        expect(observations.some((o) => o.payload && o.payload.code === "UNSENDABLE_VALUE")).toBe(true);
    });
});

describe("a linked graph", () => {
    test("runs where the node that carries it runs, and an inner node keeps its own answer", async () => {
        const s3 = new FakeS3Service();
        const runner = new ExecutionRunner(s3);
        const delivered = [];
        // one way in to each inner node, so both are reachable from outside
        const inner = {
            id: "inner-1", url: "inner-1", version: 1, properties: { name: "inner" },
            nodes: [node("innerA", "state.innerRan = true;"), serverNode("innerB", "state.innerBRan = true; edges.out = value;"), serverNode("innerC", "state.innerCRan = true;")],
        };
        // a connector inside the subgraph, which used to send the scheduler off
        // to load that graph by name
        inner.nodes[1].edges[0].connectors.push({ id: "ic1", nodeId: "innerC", field: "in", graphId: "inner-1", version: 1 });
        const carrier = browserNode("carrier", "edges.out = value;", { fields: ["toA", "toB"] });
        carrier.linkedGraph = {
            id: "inner-1", version: 1, graph: inner, data: {}, properties: {},
            fields: { inputs: { toA: { id: "innerA", field: "in" }, toB: { id: "innerB", field: "in" } }, outputs: {} },
        };
        const g = graphOf([node("entry", "edges.out = value;", { fields: ["toA", "toB"] }), carrier],
            [["entry", "carrier", "toA"], ["entry", "carrier", "toB"]]);
        g.nodes[0].edges[1] = { field: "toB", connectors: [{ id: "c2", nodeId: "carrier", field: "toB", graphId: "g1", version: 0 }] };
        g.nodes[0].template.set = "edges.toA = value; edges.toB = value;";
        const state = {};
        const summary = await runner.run({ graph: g, nodeUrl: "entry", value: 1, principal: owner, state, deliver: (d) => delivered.push(d) });
        expect(summary.state).toBe("completed");
        // A node inside a linked graph is named by the host it came through, so
        // two uses of one subgraph are two sets of nodes (plan §4.2, PB-046).
        expect(delivered.map((d) => d.nodeId)).toEqual(["carrier/innerA"]);
        // the carrier is placed in the browser, so its inner node went there too
        expect(state.innerRan).toBeUndefined();
        // and an inner node that says "server" is still the server's to run,
        // as is what it routes to inside the same subgraph
        expect(state.innerBRan).toBe(true);
        expect(state.innerCRan).toBe(true);
        // the graph the caller passed in is not touched by any of this
        expect(inner.nodes[0].properties.placement).toBeUndefined();
        expect(inner.nodes[1].properties.placement).toBe("server");
    });
});

describe("a browser-owned execution reaching a server node", () => {
    async function setup() {
        const s3 = new FakeS3Service();
        const store = new CrdtStore(s3);
        const crdt = new CrdtService(store, fakeBroadcast());
        const deliveries = new DeliveryService(s3, store, { runner: (live) => new ExecutionRunner(s3, { live }) });
        return { s3, store, crdt, deliveries };
    }
    const seed = async (store, g) => {
        const doc = fromJSON(g);
        await store.appendUpdate("g1", encodeState(doc), "seed", "system");
    };
    const delivery = (over = {}) => ({ schemaVersion: 1, executionId: "01M32BBBBBBBBBBBBBBBBBBBBB", correlationId: "01M32BBBBBBBBBBBBBBBBBBBBB", revisionId: "live", graphId: "g1", nodeId: "compute", field: "in", value: 21, connectorId: "c1", seq: 1, instancePath: [], ...over });

    test("runs exactly that node, with the caller's identity, and answers with what it wrote", async () => {
        const { s3, store, deliveries } = await setup();
        await seed(store, graphOf([
            serverNode("compute", "edges.out = {doubled: value * 2}; edges.log = 'computed';", { fields: ["out", "log"], properties: { outputs: [port("out"), port("log")] } }),
            node("downstream", "state.never = true;"),
        ], [["compute", "downstream"]]));
        const r = await deliveries.deliver("g1", owner, delivery());
        expect(r).toMatchObject({ executionId: "01M32BBBBBBBBBBBBBBBBBBBBB", nodeId: "compute", state: "completed", replayed: false });
        expect(r.outputs).toEqual([{ field: "out", value: { doubled: 42 } }, { field: "log", value: "computed" }]);
        // the server did not continue the execution the browser owns
        expect(r.observations.some((o) => o.nodeId === "downstream")).toBe(false);
        expect(r.observations.map((o) => o.kind)).toEqual(expect.arrayContaining(["exec.begin", "edge.input", "exec.end"]));
        // the browser owns the execution record, so the server wrote none
        expect(s3.objects.has("executions/01M32BBBBBBBBBBBBBBBBBBBBB.json")).toBe(false);
        const stored = readJson(s3, "executions/01M32BBBBBBBBBBBBBBBBBBBBB/deliveries/c1-1.json");
        expect(stored).toMatchObject({ by: "auth0|u1", graphId: "g1", observationsKey: expect.stringContaining("-c1-1.ndjson") });
        expect(s3.objects.has(stored.observationsKey)).toBe(true);
    });

    test("asking twice runs the node once", async () => {
        const { store, deliveries } = await setup();
        await seed(store, graphOf([serverNode("compute", "state.runs = (state.runs || 0) + 1; edges.out = value;")]));
        const first = await deliveries.deliver("g1", owner, delivery());
        const again = await deliveries.deliver("g1", owner, delivery({ value: 999 }));
        expect(first.replayed).toBe(false);
        expect(again.replayed).toBe(true);
        expect(again.outputs).toEqual([{ field: "out", value: 21 }]);
    });

    test("refuses what is not the server's to run, and what it cannot find", async () => {
        const { store, deliveries } = await setup();
        await seed(store, graphOf([browserNode("render", "state.x = value;"), serverNode("compute", "edges.out = value;")]));
        expect(await deliveries.deliver("g1", owner, delivery({ nodeId: "render" }))).toMatchObject({ code: "PLACEMENT" });
        expect(await deliveries.deliver("g1", owner, delivery({ nodeId: "ghost" }))).toMatchObject({ code: "NOT_FOUND" });
        expect(await deliveries.deliver("g1", undefined, delivery())).toMatchObject({ code: "ADMISSION_DENIED" });
        expect(await deliveries.deliver("g1", owner, delivery({ executionId: "nope" }))).toMatchObject({ code: "SCHEMA_INVALID" });
        expect(await deliveries.deliver("g1", owner, delivery({ value: "x".repeat(2 * 1024 * 1024) }))).toMatchObject({ code: "LIMIT_EXCEEDED" });
    });

    test("an error in the server node is the answer, not an exception the browser cannot see", async () => {
        const { store, deliveries } = await setup();
        await seed(store, graphOf([serverNode("compute", "throw new Error('the server node refused');")]));
        const r = await deliveries.deliver("g1", owner, delivery());
        expect(r).toMatchObject({ state: "error", error: expect.stringMatching(/the server node refused/) });
        expect(r.outputs).toEqual([]);
    });
});

/**
 * A graph that contains itself (plastic-io 2.3).  Flattening cannot make this
 * — there is no flat set of nodes for an unbounded recursion — so it is left
 * for the scheduler, which makes a call of it when a value arrives: one
 * instance per turn, each with its own state.
 */
describe("a graph that contains itself", () => {
    const recursive = () => {
        const g = graphOf([
            node("step", "state.trace = state.trace || []; state.trace.push({n: value.n, depth: instance ? instance.depth : 0}); if (value.n > 0) { edges.out = {n: value.n - 1}; }"),
            node("self", ""),
        ], [["step", "self"]]);
        g.nodes[1].linkedGraph = {
            id: "g1", version: 0, loaded: false, graph: g, data: {}, properties: {},
            fields: { inputs: { in: { id: "step", field: "in" } }, outputs: {} },
        };
        return g;
    };

    test("runs one level at a time, each knowing which turn it is", async () => {
        const s3 = new FakeS3Service();
        const runner = new ExecutionRunner(s3);
        const state = {};
        const summary = await runner.run({ graph: recursive(), nodeUrl: "step", field: "in", value: { n: 3 }, principal: owner, state });
        expect(summary.state).toBe("completed");
        expect(state.trace.map((t) => t.n)).toEqual([3, 2, 1, 0]);
        expect(state.trace.map((t) => t.depth)).toEqual([0, 1, 2, 3]);
    });

    test("a recursion that does not stop itself is stopped, and the execution says so", async () => {
        const s3 = new FakeS3Service();
        const runner = new ExecutionRunner(s3);
        const g = recursive();
        g.nodes[0].template.set = "edges.out = {n: value.n + 1};";       // no base case
        g.properties.linkedGraphDepth = 4;
        const summary = await runner.run({ graph: g, nodeUrl: "step", field: "in", value: { n: 0 }, principal: owner });
        const observations = await readObservations(s3, readJson(s3, `executions/${summary.executionId}.json`));
        const stopped = observations.find((o) => o.kind === "exec.error" && /Linked graphs went/.test((o.payload || {}).message || ""));
        expect(stopped).toBeTruthy();
        expect(stopped.payload.message).toContain("limit 4");
        expect(summary.errors).toBeGreaterThan(0);
    });
});
