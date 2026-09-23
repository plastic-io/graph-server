const { ConsumerIndex } = require("../components/consumers");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

/**
 * Who uses a published component (plan PB-044).
 *
 * Publishing a version is only half of what a person needs to know; the other
 * half is who is running the one they are about to replace.  A pin says which
 * component and which version a node carries, so the set of pins in a graph is
 * what it consumes — and that has to be answerable without reading every graph
 * in the instance.
 */

const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
const pinned = (nodeId, publishedId, version, name) => ({
    id: nodeId, url: nodeId, properties: { name: name || nodeId, component: { publishedId, version, digest: "sha" } },
});
const graph = (id, nodes, over = {}) => ({ id, url: over.url || id, nodes, properties: { name: over.name || id } });

describe("the consumers index", () => {
    test("records which graphs carry a component, and at which version", async () => {
        const index = new ConsumerIndex(new FakeS3Service());
        await index.record(graph("g1", [pinned("a", "c1", 1, "Left"), pinned("b", "c1", 1, "Right"), pinned("c", "c2", 4)]));
        await index.record(graph("g2", [pinned("only", "c1", 2)], { name: "The other one" }));

        const consumers = await index.consumers("c1");
        expect(consumers.map((r) => r.graphId).sort()).toEqual(["g1", "g2"]);
        const one = consumers.find((r) => r.graphId === "g1");
        // both nodes of that graph, named as a person would recognise them
        expect(one.uses.map((u) => `${u.name}@${u.version}`).sort()).toEqual(["Left@1", "Right@1"]);
        expect((await index.consumers("c2")).map((r) => r.graphId)).toEqual(["g1"]);
        expect(await index.consumers("never-used")).toEqual([]);
    });

    test("a graph that stops using a component stops being one of its consumers", async () => {
        const index = new ConsumerIndex(new FakeS3Service());
        await index.record(graph("g1", [pinned("a", "c1", 1), pinned("b", "c2", 1)]));
        expect((await index.consumers("c2")).map((r) => r.graphId)).toEqual(["g1"]);

        const gone = await index.record(graph("g1", [pinned("a", "c1", 1)]));
        expect(gone.removed).toEqual(["c2"]);
        expect(await index.consumers("c2")).toEqual([]);
        // and the one it still uses is still there, updated rather than added
        expect(gone.updated).toEqual(["c1"]);
        expect((await index.consumers("c1")).map((r) => r.graphId)).toEqual(["g1"]);
    });

    test("says what publishing a version would mean: who is behind, level, and ahead", async () => {
        const index = new ConsumerIndex(new FakeS3Service());
        await index.record(graph("old", [pinned("n", "c1", 1)], { name: "Still on one" }));
        await index.record(graph("level", [pinned("n", "c1", 2)], { name: "On two" }));
        await index.record(graph("ahead", [pinned("n", "c1", 3)], { name: "Ahead somehow" }));

        const impact = await index.impact("c1", 2);
        expect(impact).toMatchObject({ publishedId: "c1", version: 2, consumers: 3 });
        expect(impact.behind.map((c) => c.graphName)).toEqual(["Still on one"]);
        expect(impact.current.map((c) => c.graphName)).toEqual(["On two"]);
        // ahead of the version being published is not nothing: it says a
        // rollback happened, or that somebody is running what was withdrawn
        expect(impact.ahead.map((c) => c.graphName)).toEqual(["Ahead somehow"]);
        expect(impact.behind[0].nodes).toEqual([{ nodeId: "n", name: "n" }]);
    });

    test("a caller hears only about the graphs it may read, in both answers", async () => {
        // the index is instance-wide; the answer is not.  Without this, asking
        // who uses a component is a way to learn the names of graphs you were
        // never given.
        const asked = [];
        const index = new ConsumerIndex(new FakeS3Service(), {
            readable: async (graphId, principal) => {
                asked.push([graphId, principal && principal.sub]);
                return graphId === "mine";
            },
        });
        await index.record(graph("mine", [pinned("a", "c1", 1)], { name: "Mine" }));
        await index.record(graph("theirs", [pinned("b", "c1", 3)], { name: "Somebody else's" }));

        expect((await index.consumers("c1", owner)).map((r) => r.graphId)).toEqual(["mine"]);
        expect(asked.map((a) => a[1])).toEqual(["auth0|u1", "auth0|u1"]);
        const impact = await index.impact("c1", 2, owner);
        // the graph it may not read is missing from the counts as well as the lists
        expect(impact.consumers).toBe(1);
        expect(impact.behind.map((r) => r.graphId)).toEqual(["mine"]);
        expect(impact.ahead).toEqual([]);
    });

    test("a graph with no pins is not a consumer of anything, and says so quietly", async () => {
        const index = new ConsumerIndex(new FakeS3Service());
        const answer = await index.record(graph("plain", [{ id: "a", url: "a", properties: { name: "a" } }]));
        expect(answer).toEqual({ added: [], updated: [], removed: [] });
        expect(await index.consumers("c1")).toEqual([]);
    });

    test("the route answers a list, or an impact when a version is named, and refuses without a principal", async () => {
        const index = new ConsumerIndex(new FakeS3Service());
        await index.record(graph("g1", [pinned("n", "c1", 1)]));
        const call = (event) => new Promise((resolve) => index.route(event, {}, (err, r) => resolve({ ...r, json: JSON.parse(r.body || "{}") })));

        const listed = await call({ pathParameters: { id: "c1" }, principal: owner });
        expect(listed.statusCode).toBe(200);
        expect(listed.json.consumers.map((c) => c.graphId)).toEqual(["g1"]);

        const impact = await call({ pathParameters: { id: "c1" }, queryStringParameters: { version: "2" }, principal: owner });
        expect(impact.json.behind.map((c) => c.graphId)).toEqual(["g1"]);

        const refused = await call({ pathParameters: { id: "c1" } });
        expect(refused.statusCode).toBe(403);
    });
});

describe("rebuilding it from the graphs themselves", () => {
    /**
     * The index is written as changes are accepted, so every graph that
     * existed before it did is missing from it — and the answer it gives for
     * those, "nobody uses this", is the answer people publish on.  So it has
     * to be rebuildable, and rebuilding has to be safe to do at any time.
     */
    const withGraphs = (graphs) => {
        const store = new FakeS3Service();
        const index = new ConsumerIndex(store, {
            graphIds: async () => graphs.map((g) => g.id),
            project: async (graphId) => graphs.find((g) => g.id === graphId) || null,
        });
        return { store, index };
    };

    test("finds the consumers of graphs that were never edited since the index existed", async () => {
        const { index } = withGraphs([
            graph("g1", [pinned("a", "c1", 1)]),
            graph("g2", [pinned("b", "c1", 2), pinned("c", "c2", 1)]),
            graph("g3", []),
        ]);
        expect(await index.consumers("c1")).toEqual([]);

        const r = await index.rebuild();
        expect(r).toMatchObject({ graphs: 3, changed: 2, consumers: 3, failed: [] });
        expect((await index.consumers("c1")).map((x) => x.graphId).sort()).toEqual(["g1", "g2"]);
        expect((await index.consumers("c2")).map((x) => x.graphId)).toEqual(["g2"]);
    });

    test("running it twice changes nothing, and a graph that cannot be read does not stop the rest", async () => {
        const good = graph("g1", [pinned("a", "c1", 1)]);
        const working = new ConsumerIndex(new FakeS3Service(), {
            graphIds: async () => ["g1", "bad"],
            project: async (graphId) => { if (graphId === "bad") { throw new Error("no projection"); } return good; },
        });
        const first = await working.rebuild();
        expect(first.failed).toEqual([{ graphId: "bad", error: "no projection" }]);
        expect((await working.consumers("c1")).map((x) => x.graphId)).toEqual(["g1"]);
        const second = await working.rebuild();
        // the same graphs, so the records are rewritten rather than added
        expect(second).toMatchObject({ graphs: 2, consumers: 1 });
        expect((await working.consumers("c1")).map((x) => x.graphId)).toEqual(["g1"]);
    });

    test("an index that cannot enumerate the graphs says so rather than reporting an empty rebuild", async () => {
        const index = new ConsumerIndex(new FakeS3Service());
        expect(await index.rebuild()).toMatchObject({ code: "UNSUPPORTED" });
    });

    test("the route is for an administrator, and answers with what it did", async () => {
        const { index } = withGraphs([graph("g1", [pinned("a", "c1", 1)])]);
        const answer = await new Promise((resolve) => index.rebuildRoute({ principal: owner }, {}, (err, r) => resolve(r)));
        expect(answer.statusCode).toBe(200);
        expect(JSON.parse(answer.body)).toMatchObject({ graphs: 1, changed: 1 });
        const refused = await new Promise((resolve) => index.rebuildRoute({ principal: undefined }, {}, (err, r) => resolve(r)));
        expect(refused.statusCode).toBe(403);
    });
});

describe("the index keeps itself current as changes are accepted", () => {
    const { fromJSON, encodeState, toJSON, reconcile } = require("@plastic-io/graph-crdt");
    const CrdtStore = require("../crdtStore").default;
    const CrdtService = require("../crdtService").default;
    const Y = require("yjs");

    const port = (name) => ({ name, type: "Object", external: false, visible: true });
    const node = (id, over = {}) => ({
        id, url: id, edges: [{ field: "out", connectors: [] }], version: 0, graphId: "g1", artifact: null, data: null,
        properties: {
            inputs: [port("in")], outputs: [port("out")], groups: [], name: id, description: "", tags: [], icon: "",
            x: 0, y: 0, z: 0, createdOn: 1, presentation: { x: 0, y: 0, z: 0 }, ...(over.properties || {}),
        },
        template: { set: "", vue: "" },
    });
    const graphJson = (nodes) => ({
        id: "g1", url: "g1", version: 0, nodes,
        properties: { name: "A graph that imports", description: "", exportable: true, icon: "", createdBy: "", createdOn: 0, lastUpdate: 0, height: 1, width: 1 },
    });

    test("an accepted edit that adds a pin makes that graph a consumer", async () => {
        const s3 = new FakeS3Service();
        const store = new CrdtStore(s3);
        const broadcast = { postToClient: (d, c, p, cb) => cb(), _sendToChannel: (ch, v, cb) => cb(), broadcast: (ch, v, cb) => cb() };
        const crdt = new CrdtService(store, broadcast);
        const index = new ConsumerIndex(s3);
        crdt.admission.admitted = async (after) => { await index.record(after); };

        const doc = fromJSON(graphJson([node("plain")]));
        await store.appendUpdate("g1", encodeState(doc), "seed", "system");
        expect(await index.consumers("c1")).toEqual([]);

        // the edit a person makes when they drop a component onto the canvas
        const next = toJSON(doc);
        next.nodes.push(node("imported", { properties: { component: { publishedId: "c1", version: 1, digest: "sha" }, name: "Imported" } }));
        const before = Y.encodeStateVector(doc);
        reconcile(doc, next, "local");
        const update = Buffer.from(Y.encodeStateAsUpdateV2(doc, before));
        const result = await crdt.admission.admit({ graphId: "g1", mutationId: "01M34AAAAAAAAAAAAAAAAAAAAA", content: update, principal: owner, description: "Import a component" });
        expect(result.decision).toBe("accepted");

        const consumers = await index.consumers("c1");
        expect(consumers.map((c) => c.graphId)).toEqual(["g1"]);
        expect(consumers[0].uses).toEqual([{ nodeId: "imported", name: "Imported", version: 1, digest: "sha" }]);
    });

    test("an index that cannot be written does not stop the edit", async () => {
        const s3 = new FakeS3Service();
        const store = new CrdtStore(s3);
        const broadcast = { postToClient: (d, c, p, cb) => cb(), _sendToChannel: (ch, v, cb) => cb(), broadcast: (ch, v, cb) => cb() };
        const crdt = new CrdtService(store, broadcast);
        crdt.admission.admitted = async () => { throw new Error("the index is having a bad day"); };

        const doc = fromJSON(graphJson([node("plain")]));
        await store.appendUpdate("g1", encodeState(doc), "seed", "system");
        const next = toJSON(doc);
        next.nodes.push(node("another"));
        const before = Y.encodeStateVector(doc);
        reconcile(doc, next, "local");
        const update = Buffer.from(Y.encodeStateAsUpdateV2(doc, before));
        const result = await crdt.admission.admit({ graphId: "g1", mutationId: "01M34BBBBBBBBBBBBBBBBBBBBB", content: update, principal: owner, description: "Add a node" });
        expect(result.decision).toBe("accepted");
    });
});
