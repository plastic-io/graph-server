import * as Y from "yjs";
import {
    fromJSON,
    toJSON,
    reconcile,
    UPDATE_EVENT,
    encodeState,
    applyUpdate,
    mergeUpdates,
} from "@plastic-io/graph-crdt";
import CrdtStore, { encodeLabel, decodeLabel, decodeUlidTime } from "../crdtStore";
import FakeS3Service from "../__testHelpers__/fakeS3";

function sampleGraph(over) {
    return Object.assign({
        id: "g1",
        version: 1,
        url: "Sample",
        nodes: [],
        properties: {
            name: "Sample",
            description: "",
            icon: "mdi-graph",
            template: "<div/>",
        },
    }, over || {});
}

function makeNode(id, createdOn) {
    return {
        id,
        edges: [{ field: "out", connectors: [] }],
        version: 1,
        graphId: "g1",
        artifact: null,
        url: id,
        data: null,
        properties: {
            inputs: [],
            outputs: [{ name: "out", type: "Object", external: false, visible: true }],
            groups: [],
            name: id,
            description: "",
            createdOn,
            tags: [],
            icon: "mdi-node-rectangle",
            positionAbsolute: false,
            appearsInPresentation: false,
            appearsInExport: false,
            x: 0, y: 0, z: 0,
            presentation: { x: 0, y: 0, z: 0 },
        },
        template: { set: "", vue: "<template><div/></template>" },
    };
}

/** One editor session: a document plus the updates it produced. */
function client(seedUpdate) {
    const doc = new Y.Doc();
    const produced = [];
    doc.on(UPDATE_EVENT, (update) => produced.push(update));
    if (seedUpdate) {
        applyUpdate(doc, seedUpdate);
        produced.length = 0;
    }
    return {
        doc,
        produced,
        edit(mutate) {
            const snapshot = toJSON(doc);
            mutate(snapshot);
            reconcile(doc, snapshot, "test");
        },
    };
}

describe("CRDT store", () => {
    let store;
    let s3;
    beforeEach(() => {
        s3 = new FakeS3Service();
        store = new CrdtStore(s3);
    });

    it("labels round trip through the object key", () => {
        const label = encodeLabel("Move Nodes", "arn:user");
        expect(decodeLabel(label)).toEqual({ description: "Move Nodes", userId: "arn:user" });
    });

    it("reads a ULID's creation time back out", () => {
        const before = Date.now();
        return store.appendUpdate("g1", new Uint8Array([1]), "x", "u").then((id) => {
            const time = decodeUlidTime(id);
            expect(time).toBeGreaterThanOrEqual(before - 1000);
            expect(time).toBeLessThanOrEqual(Date.now() + 1000);
        });
    });

    it("reports whether a graph has collaborative state", async () => {
        expect(await store.exists("g1")).toBe(false);
        await store.seedFromJson("g1", sampleGraph(), "tester");
        expect(await store.exists("g1")).toBe(true);
    });

    it("projects a seeded graph back into plain JSON", async () => {
        await store.seedFromJson("g1", sampleGraph({ nodes: [makeNode("n1", 1)] }), "tester");
        const graph = await store.projectGraph("g1");
        expect(graph.id).toBe("g1");
        expect(graph.properties.name).toBe("Sample");
        expect(graph.nodes).toHaveLength(1);
        expect(graph.nodes[0].id).toBe("n1");
    });

    it("merges a sequence of updates into one state", async () => {
        const seeded = fromJSON(sampleGraph());
        const a = client(encodeState(seeded));
        a.edit((g) => { g.nodes.push(makeNode("n1", 1)); });
        a.edit((g) => { g.properties.name = "Renamed"; });

        await store.appendUpdate("g1", encodeState(seeded), "Start", "u");
        for (const update of a.produced) {
            await store.appendUpdate("g1", update, "Edit", "u");
        }

        const graph = await store.projectGraph("g1");
        expect(graph.properties.name).toBe("Renamed");
        expect(graph.nodes.map((n) => n.id)).toEqual(["n1"]);
    });

    it("gives the same result whichever order concurrent updates arrive in", async () => {
        const seeded = fromJSON(sampleGraph());
        const seedUpdate = encodeState(seeded);
        const a = client(seedUpdate);
        const b = client(seedUpdate);
        a.edit((g) => { g.nodes.push(makeNode("from-a", 1)); });
        b.edit((g) => { g.nodes.push(makeNode("from-b", 2)); });

        const forward = new CrdtStore(new FakeS3Service());
        await forward.appendUpdate("g1", seedUpdate, "Start", "u");
        await forward.appendUpdate("g1", a.produced[0], "A", "ua");
        await forward.appendUpdate("g1", b.produced[0], "B", "ub");

        const backward = new CrdtStore(new FakeS3Service());
        await backward.appendUpdate("g1", seedUpdate, "Start", "u");
        await backward.appendUpdate("g1", b.produced[0], "B", "ub");
        await backward.appendUpdate("g1", a.produced[0], "A", "ua");

        const one = await forward.projectGraph("g1");
        const two = await backward.projectGraph("g1");
        expect(one).toEqual(two);
        expect(one.nodes.map((n) => n.id).sort()).toEqual(["from-a", "from-b"]);
    });

    it("a snapshot plus later updates reads the same as the raw log", async () => {
        const seeded = fromJSON(sampleGraph());
        const a = client(encodeState(seeded));
        await store.appendUpdate("g1", encodeState(seeded), "Start", "u");
        a.edit((g) => { g.nodes.push(makeNode("n1", 1)); });
        await store.appendUpdate("g1", a.produced[0], "Add", "u");

        const before = await store.projectGraph("g1");
        const head = await store.writeSnapshot("g1");
        expect(head).toBeTruthy();

        a.edit((g) => { g.properties.name = "After snapshot"; });
        await store.appendUpdate("g1", a.produced[1], "Rename", "u");

        const after = await store.projectGraph("g1");
        expect(before.properties.name).toBe("Sample");
        expect(after.properties.name).toBe("After snapshot");
        expect(after.nodes).toHaveLength(1);
    });

    it("keeps the update log after a snapshot so rewind still works", async () => {
        await store.seedFromJson("g1", sampleGraph(), "tester");
        await store.writeSnapshot("g1");
        const history = await store.history("g1");
        expect(history).toHaveLength(1);
        expect(history[0].description).toBe("Start");
    });

    it("lists history oldest first with the labels the client supplied", async () => {
        await store.appendUpdate("g1", new Uint8Array([1]), "Start", "alice");
        await store.appendUpdate("g1", new Uint8Array([2]), "Move Nodes", "bob");
        const history = await store.history("g1");
        expect(history.map((h) => h.description)).toEqual(["Start", "Move Nodes"]);
        expect(history.map((h) => h.userId)).toEqual(["alice", "bob"]);
        expect(history.map((h) => h.seq)).toEqual([1, 2]);
    });

    it("rebuilds a past state from a prefix of the log", async () => {
        const seeded = fromJSON(sampleGraph());
        const a = client(encodeState(seeded));
        const first = await store.appendUpdate("g1", encodeState(seeded), "Start", "u");
        a.edit((g) => { g.nodes.push(makeNode("n1", 1)); });
        await store.appendUpdate("g1", a.produced[0], "Add", "u");

        const early = await store.updatesUpTo("g1", first);
        const doc = new Y.Doc();
        applyUpdate(doc, mergeUpdates(early));
        expect(toJSON(doc).nodes).toHaveLength(0);

        const all = await store.updatesUpTo("g1", "Z".repeat(26));
        const full = new Y.Doc();
        applyUpdate(full, mergeUpdates(all));
        expect(toJSON(full).nodes).toHaveLength(1);
    });

    it("writes the JSON projections other services read", async () => {
        await store.seedFromJson("g1", sampleGraph({ url: "MyEndpoint", version: 4 }), "tester");
        const graph = await store.writeProjections("g1");
        expect(graph.version).toBe(4);
        expect(s3.objects.has("graphs/projections/latest/g1.json")).toBe(true);
        expect(s3.objects.has("graphs/g1/projections/g1.4.json")).toBe(true);
        expect(s3.objects.has("graphs/projections/endpoints/MyEndpoint.json")).toBe(true);
    });

    it("removes every object belonging to a deleted graph", async () => {
        await store.seedFromJson("g1", sampleGraph(), "tester");
        await store.writeSnapshot("g1");
        await store.removeAll("g1");
        expect(await store.exists("g1")).toBe(false);
    });
});
