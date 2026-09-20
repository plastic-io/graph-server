import * as Y from "yjs";
import {
    fromJSON,
    toJSON,
    reconcile,
    readSyncMessage,
    writeSyncStep1,
    writeUpdate,
    toBase64,
    fromBase64,
    channelIdFor,
    MESSAGE_SYNC_STEP1,
    MESSAGE_SYNC_STEP2,
    MESSAGE_UPDATE,
    UPDATE_EVENT,
    encodeState,
    applyUpdate,
    encodeStateVector,
    UPDATE_FORMAT,
} from "@plastic-io/graph-crdt";
import CrdtService from "../crdtService";
import CrdtStore from "../crdtStore";
import FakeS3Service from "../__testHelpers__/fakeS3";

function sampleGraph() {
    return {
        id: "g1",
        version: 1,
        url: "Sample",
        nodes: [],
        properties: { name: "Sample", description: "", icon: "mdi-graph", template: "<div/>" },
    };
}

/** Records what the service tried to send, instead of calling API Gateway. */
class FakeBroadcastService {
    constructor() {
        this.direct = [];
        this.channel = [];
    }
    postToClient(domainName, connectionId, message, callback) {
        this.direct.push({ domainName, connectionId, message });
        callback(null, null);
    }
    _sendToChannel(channelId, value, callback, excludeConnectionId) {
        this.channel.push({ channelId, value, excludeConnectionId });
        callback(null, null);
    }
}

function wsEvent(body, connectionId = "conn-1") {
    return {
        body: JSON.stringify(body),
        requestContext: {
            connectionId,
            domainName: "example.execute-api",
            identity: { userArn: "arn:aws:iam::1:user/tester" },
        },
    };
}

function httpEvent(pathParameters, body) {
    return {
        pathParameters,
        body: body ? JSON.stringify(body) : undefined,
        requestContext: { identity: { userArn: "arn:aws:iam::1:user/tester" } },
    };
}

function invoke(service, method, event) {
    return new Promise((resolve) => {
        service[method](event, {}, (err, response) => resolve({ err, response }));
    });
}

describe("CRDT sync service", () => {
    let s3;
    let store;
    let broadcast;
    let service;

    beforeEach(() => {
        s3 = new FakeS3Service();
        store = new CrdtStore(s3);
        broadcast = new FakeBroadcastService();
        service = new CrdtService(store, broadcast);
    });

    it("answers a sync step 1 with the state the client is missing", async () => {
        await store.seedFromJson("g1", sampleGraph(), "tester");
        const empty = new Y.Doc();
        await invoke(service, "sync", wsEvent({
            action: "yjs",
            kind: "sync",
            graphId: "g1",
            payload: toBase64(writeSyncStep1(encodeStateVector(empty))),
        }));

        expect(broadcast.direct).toHaveLength(2);
        const first = readSyncMessage(fromBase64(broadcast.direct[0].message.response.payload));
        expect(first.type).toBe(MESSAGE_SYNC_STEP2);
        const rebuilt = new Y.Doc();
        applyUpdate(rebuilt, first.content);
        expect(toJSON(rebuilt).properties.name).toBe("Sample");

        // and the server asks for anything it is missing, so offline work
        // made by the client can come back in
        const second = readSyncMessage(fromBase64(broadcast.direct[1].message.response.payload));
        expect(second.type).toBe(MESSAGE_SYNC_STEP1);
    });

    it("stores an update and fans it out to everyone except the sender", async () => {
        const doc = fromJSON(sampleGraph());
        const update = encodeState(doc);
        await invoke(service, "sync", wsEvent({
            action: "yjs",
            kind: "sync",
            graphId: "g1",
            description: "Create New Node",
            payload: toBase64(writeUpdate(update)),
        }, "conn-abc"));

        const history = await store.history("g1");
        expect(history).toHaveLength(1);
        expect(history[0].description).toBe("Create New Node");

        expect(broadcast.channel).toHaveLength(1);
        expect(broadcast.channel[0].channelId).toBe(channelIdFor("g1"));
        expect(broadcast.channel[0].excludeConnectionId).toBe("conn-abc");
        const fanned = readSyncMessage(fromBase64(broadcast.channel[0].value.payload));
        expect(fanned.type).toBe(MESSAGE_UPDATE);
    });

    it("passes presence along without ever storing it", async () => {
        await invoke(service, "sync", wsEvent({
            action: "yjs",
            kind: "awareness",
            graphId: "g1",
            payload: toBase64(new Uint8Array([1, 2, 3])),
        }, "conn-xyz"));

        expect(broadcast.channel).toHaveLength(1);
        expect(broadcast.channel[0].value.kind).toBe("awareness");
        expect(broadcast.channel[0].excludeConnectionId).toBe("conn-xyz");
        expect(await store.exists("g1")).toBe(false);
    });

    it("two clients editing at once both keep their work", async () => {
        const seeded = fromJSON(sampleGraph());
        const seedUpdate = encodeState(seeded);
        await invoke(service, "sync", wsEvent({
            kind: "sync", graphId: "g1", description: "Start",
            payload: toBase64(writeUpdate(seedUpdate)),
        }));

        const makeClient = () => {
            const doc = new Y.Doc();
            applyUpdate(doc, seedUpdate);
            const produced = [];
            doc.on(UPDATE_EVENT, (u) => produced.push(u));
            return { doc, produced };
        };
        const alice = makeClient();
        const bob = makeClient();

        const edit = (client, mutate) => {
            const snapshot = toJSON(client.doc);
            mutate(snapshot);
            reconcile(client.doc, snapshot, "test");
        };
        edit(alice, (g) => { g.properties.name = "Alice was here"; });
        edit(bob, (g) => { g.properties.description = "Bob was here"; });

        await invoke(service, "sync", wsEvent({
            kind: "sync", graphId: "g1", description: "Alice",
            payload: toBase64(writeUpdate(alice.produced[0])),
        }, "conn-alice"));
        await invoke(service, "sync", wsEvent({
            kind: "sync", graphId: "g1", description: "Bob",
            payload: toBase64(writeUpdate(bob.produced[0])),
        }, "conn-bob"));

        const graph = await store.projectGraph("g1");
        expect(graph.properties.name).toBe("Alice was here");
        expect(graph.properties.description).toBe("Bob was here");
    });

    it("serves the whole document over HTTP for the initial load", async () => {
        await store.seedFromJson("g1", sampleGraph(), "tester");
        const { response } = await invoke(service, "getState", httpEvent({ id: "g1" }));
        const body = JSON.parse(response.body);
        expect(body.exists).toBe(true);
        const doc = new Y.Doc();
        applyUpdate(doc, fromBase64(body.payload));
        expect(toJSON(doc).id).toBe("g1");
        // The server's own state vector comes back too, so a caller can work
        // out what to push without a second round trip.
        expect(body.stateVector).toBeTruthy();
    });

    it("sends only what a caller is missing when given its state vector", async () => {
        await store.seedFromJson("g1", sampleGraph({ nodes: [] }), "tester");

        // A browser that already has the graph: bring it up to date first.
        const client = new Y.Doc();
        const full = await invoke(service, "getState", httpEvent({ id: "g1" }));
        const fullBody = JSON.parse(full.response.body);
        applyUpdate(client, fromBase64(fullBody.payload));

        // Nothing has changed since, so there is nothing to send.
        const caughtUp = await invoke(service, "getState", {
            ...httpEvent({ id: "g1" }),
            queryStringParameters: { sv: toBase64(encodeStateVector(client)) },
        });
        const caughtUpBody = JSON.parse(caughtUp.response.body);
        const nothing = fromBase64(caughtUpBody.payload);
        expect(nothing.length).toBeLessThan(fromBase64(fullBody.payload).length);

        // Someone else edits, and now only that edit comes back.
        const other = new Y.Doc();
        applyUpdate(other, fromBase64(fullBody.payload));
        const snapshot = toJSON(other);
        snapshot.properties.name = "Changed elsewhere";
        reconcile(other, snapshot, "test");
        await invoke(service, "sync", wsEvent({
            kind: "sync", graphId: "g1", description: "Update Graph Properties",
            payload: toBase64(writeUpdate(encodeState(other))),
        }));

        const delta = await invoke(service, "getState", {
            ...httpEvent({ id: "g1" }),
            queryStringParameters: { sv: toBase64(encodeStateVector(client)) },
        });
        const deltaBody = JSON.parse(delta.response.body);
        applyUpdate(client, fromBase64(deltaBody.payload));
        expect(toJSON(client).properties.name).toBe("Changed elsewhere");
        // The difference is far smaller than the document it completes.
        expect(fromBase64(deltaBody.payload).length)
            .toBeLessThan(fromBase64(fullBody.payload).length);
    });

    it("falls back to the whole document when the state vector is unusable", async () => {
        await store.seedFromJson("g1", sampleGraph(), "tester");
        const { response } = await invoke(service, "getState", {
            ...httpEvent({ id: "g1" }),
            queryStringParameters: { sv: "not-a-state-vector" },
        });
        const body = JSON.parse(response.body);
        const doc = new Y.Doc();
        applyUpdate(doc, fromBase64(body.payload));
        expect(toJSON(doc).id).toBe("g1");
    });

    it("reports an empty document for a graph that does not exist yet", async () => {
        const { response } = await invoke(service, "getState", httpEvent({ id: "nope" }));
        const body = JSON.parse(response.body);
        expect(body.exists).toBe(false);
        expect(body.payload).toBeNull();
    });

    it("serves the action log over HTTP", async () => {
        await store.appendUpdate("g1", new Uint8Array([1]), "Start", "alice");
        await store.appendUpdate("g1", new Uint8Array([2]), "Move Nodes", "bob");
        const { response } = await invoke(service, "getHistory", httpEvent({ id: "g1" }));
        const history = JSON.parse(response.body);
        expect(history.map((h) => h.description)).toEqual(["Start", "Move Nodes"]);
    });

    it("rebuilds a past state over HTTP for rewind", async () => {
        const seeded = fromJSON(sampleGraph());
        const first = await store.appendUpdate("g1", encodeState(seeded), "Start", "u");
        const snapshot = toJSON(seeded);
        snapshot.properties.name = "Later";
        reconcile(seeded, snapshot, "test");
        await store.appendUpdate("g1", encodeState(seeded), "Rename", "u");

        const { response } = await invoke(service, "getStateAt", httpEvent({ id: "g1", updateId: first }));
        const body = JSON.parse(response.body);
        const doc = new Y.Doc();
        applyUpdate(doc, fromBase64(body.payload));
        expect(toJSON(doc).properties.name).toBe("Sample");
    });

    it("accepts an oversized update over HTTP", async () => {
        const doc = fromJSON(sampleGraph());
        const { response } = await invoke(service, "postUpdate", httpEvent({ id: "g1" }, {
            payload: toBase64(writeUpdate(encodeState(doc))),
            description: "Big paste",
        }));
        expect(response.statusCode).toBe(200);
        const history = await store.history("g1");
        expect(history[0].description).toBe("Big paste");
        expect(broadcast.channel).toHaveLength(1);
    });

    it("refuses a message written in another update format", async () => {
        const doc = fromJSON(sampleGraph());
        await invoke(service, "sync", wsEvent({
            kind: "sync",
            graphId: "g1",
            description: "From an older client",
            format: 1,
            payload: toBase64(writeUpdate(encodeState(doc))),
        }));
        // Storing those bytes would not fail, it would decode into a different
        // document, so nothing is written and nothing is passed on.
        expect(await store.exists("g1")).toBe(false);
        expect(broadcast.channel).toHaveLength(0);
    });

    it("rejects an oversized update posted in another format", async () => {
        const doc = fromJSON(sampleGraph());
        const { response } = await invoke(service, "postUpdate", httpEvent({ id: "g1" }, {
            payload: toBase64(writeUpdate(encodeState(doc))),
            description: "Big paste",
            format: 1,
        }));
        expect(response.statusCode).toBe(409);
        expect(await store.exists("g1")).toBe(false);
    });

    it("accepts a message that states the format it was written in", async () => {
        const doc = fromJSON(sampleGraph());
        await invoke(service, "sync", wsEvent({
            kind: "sync",
            graphId: "g1",
            description: "Create New Node",
            format: UPDATE_FORMAT,
            payload: toBase64(writeUpdate(encodeState(doc))),
        }));
        expect(await store.exists("g1")).toBe(true);
    });

    it("a checkpoint refreshes the files graph execution reads", async () => {
        await store.seedFromJson("g1", sampleGraph(), "tester");
        const { response } = await invoke(service, "checkpoint", httpEvent({ id: "g1" }));
        expect(JSON.parse(response.body)).toEqual({ ok: true, version: 1 });
        expect(s3.objects.has("graphs/projections/latest/g1.json")).toBe(true);
        expect(s3.objects.has("graphs/projections/endpoints/Sample.json")).toBe(true);
    });

    it("a checkpoint puts a new graph on the list", async () => {
        // Writing the projection is not enough on its own.  Without the entry
        // being written, a graph somebody just made never shows up for them.
        await store.seedFromJson("g1", sampleGraph(), "tester");
        await invoke(service, "checkpoint", httpEvent({ id: "g1" }));
        const listed = await service.tocStore.project();
        expect(Object.keys(listed)).toContain("g1");
        expect(listed["g1"].name).toBe("Sample");
    });

    it("listing a graph does not read every other graph", async () => {
        // The point of the design: saving one graph costs one write, whatever
        // else is stored.  The old version listed the projections and read the
        // metadata of every object on each save.
        await store.seedFromJson("g1", sampleGraph(), "tester");
        await invoke(service, "checkpoint", httpEvent({ id: "g1" }));
        s3.calls = { list: 0, head: 0 };
        await store.seedFromJson("g2", { ...sampleGraph(), id: "g2", url: "Second" }, "tester");
        await invoke(service, "checkpoint", httpEvent({ id: "g2" }));
        expect(s3.calls.head).toBe(0);
    });

    it("a checkpoint on an unknown graph reports that there was nothing to do", async () => {
        const { response } = await invoke(service, "checkpoint", httpEvent({ id: "missing" }));
        expect(JSON.parse(response.body).ok).toBe(false);
    });

    it("refreshes the projection once an edit has left it stale", async () => {
        process.env.CHECKPOINT_INTERVAL_MS = "0";
        const fresh = new CrdtService(store, broadcast);
        const doc = fromJSON(sampleGraph());
        await invoke(fresh, "sync", wsEvent({
            kind: "sync", graphId: "g1", description: "Start",
            payload: toBase64(writeUpdate(encodeState(doc))),
        }));
        expect(s3.objects.has("graphs/projections/latest/g1.json")).toBe(true);
        delete process.env.CHECKPOINT_INTERVAL_MS;
    });
});
