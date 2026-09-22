const { fromJSON, encodeState } = require("@plastic-io/graph-crdt");
const CrdtStore = require("../crdtStore").default;
const CrdtService = require("../crdtService").default;
const TocStore = require("../tocStore").default;
const { RevisionService } = require("../revisions/service");
const { ComponentService } = require("../components/service");
const { SummaryService } = require("../summary/service");
const { ProposalService } = require("../proposals/service");
const { DelegationStore } = require("../policy/delegation");
const { makeMcpStreamHandler } = require("../mcp/stream");
const { ChangeFeed, watchesFor, urisFor, graphOfUri } = require("../mcp/subscriptions");
const { Client } = require("@modelcontextprotocol/client");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { listGraph } = require("../tocService");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

/**
 * subscriptions/listen (plan PB-085, spike S-3).
 *
 * A client asks to hear about resources; the server says which of them changed
 * and nothing else.  These prove what that is worth: the events come from what
 * was written, not from what this process happened to see; a stream hears only
 * about graphs its caller may read; and a stream that ends because the Lambda
 * is nearly out of time ends the way the protocol says to, so the client knows
 * to listen again.
 */

const port = (name, external = false) => ({ name, type: "Object", external, visible: true });
const node = (id, over = {}) => ({ id, url: id, edges: [{ field: "out", connectors: [] }], version: 0, graphId: "g1", artifact: null, data: null, properties: { inputs: [port("in")], outputs: [port("out")], groups: [], name: id, description: "does " + id, tags: [], icon: "", x: 0, y: 0, z: 0, createdOn: 1, presentation: { x: 0, y: 0, z: 0 } }, template: { set: "edges.out = value;", vue: "" }, ...over });
const graphJson = (id = "g1") => ({ id, url: id, version: 0, nodes: [node("form", { graphId: id })], properties: { name: "Account settings", description: "a journey", exportable: true, icon: "mdi-graph", createdBy: "", createdOn: 0, lastUpdate: 0, height: 1, width: 1 } });

const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
const strangerAgent = { sub: "agent|a9", kind: "agent", tenant: "personal:auth0|u1", scopes: [] };
const fakeBroadcast = () => ({ postToClient: (d, c, p, cb) => cb(), _sendToChannel: (ch, v, cb) => cb(), broadcast: (ch, v, cb) => cb() });

async function setup(options = {}) {
    const s3 = new FakeS3Service();
    const store = new CrdtStore(s3);
    const broadcast = fakeBroadcast();
    const crdt = new CrdtService(store, broadcast);
    const tocStore = new TocStore(s3);
    const revisions = new RevisionService(store, crdt.admission, { fanOut: () => undefined });
    const components = new ComponentService(store, revisions, crdt.admission, { tocStore, broadcastService: broadcast });
    const summaries = new SummaryService(revisions, components);
    const delegations = new DelegationStore(s3);
    crdt.admission.resolvePrincipal = (p, g) => delegations.resolve(p, g);
    const proposals = new ProposalService(store, crdt.admission, revisions, summaries, { fanOut: () => undefined, notify: async () => undefined });
    const doc = fromJSON(graphJson());
    await store.appendUpdate("g1", encodeState(doc), "seed", "system");
    await listGraph(tocStore, broadcast, graphJson(), "system");
    const mcp = makeMcpStreamHandler(
        { crdtStore: store, tocStore, admission: crdt.admission, revisions, components, proposals, summaries, delegations },
        { store: s3, pollMs: 20, keepAliveMs: 40, ...options },
    );
    return { s3, store, crdt, revisions, proposals, delegations, tocStore, mcp };
}

/** A real MCP client whose fetch goes straight into the streaming handler. */
async function connect(mcp, principal) {
    const transport = new StreamableHTTPClientTransport(new URL("https://stream.test/mcp"), {
        fetch: (url, init) => mcp.serve(new Request(url, init), principal),
    });
    // The modern era: subscriptions/listen exists only there, and "auto" is how
    // a client finds out — a server/discover probe before the handshake.
    const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(transport);
    return client;
}

/** Wait for something a poll away, without pinning the test to one interval. */
async function eventually(predicate, timeoutMs = 3000) {
    const started = Date.now();
    for (;;) {
        const value = await predicate();
        if (value) {
            return value;
        }
        if (Date.now() - started > timeoutMs) {
            return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe("what a record changed", () => {
    test("a URI names the graph it belongs to, and a listen only watches what it asked about", () => {
        expect(graphOfUri("plastic://graph/g1/executions")).toBe("g1");
        expect(graphOfUri("plastic://component/c1/1.0.0")).toBeUndefined();
        expect(watchesFor(["plastic://graph/g1", "plastic://graph/g1/history", "plastic://component/c1"]))
            .toEqual([{ graphId: "g1", executions: false }]);
        expect(watchesFor(["plastic://graph/g1/executions", "plastic://graph/g2"]))
            .toEqual([{ graphId: "g1", executions: true }, { graphId: "g2", executions: false }]);
    });

    test("an accepted mutation changed the graph; a refused one changed only the history", () => {
        expect(urisFor("g1", { kind: "mutation.accepted" })).toEqual(["plastic://graph/g1", "plastic://graph/g1/history"]);
        expect(urisFor("g1", { kind: "mutation.rejected", code: "TOO_BIG" })).toEqual(["plastic://graph/g1/history"]);
        expect(urisFor("g1", { kind: "proposal.created", proposalId: "p1" })).toEqual(["plastic://graph/g1/proposal/p1", "plastic://graph/g1/history"]);
        expect(urisFor("g1", { kind: "proposal.committed", proposalId: "p1" })).toEqual(["plastic://graph/g1/proposal/p1", "plastic://graph/g1", "plastic://graph/g1/history"]);
        const revision = urisFor("g1", { kind: "revision.cut", revisionId: "01J8ZK5K0B1C2D3E4F5G6H7J8A" });
        expect(revision[0]).toBe("plastic://graph/g1/rev/rev_01J8ZK5K0B1C2D3E4F5G6H7J8A");
        expect(urisFor("g1", { kind: "component.published", publishedId: "c1", version: "1.0.0" }))
            .toEqual(["plastic://component/c1", "plastic://component/c1/1.0.0", "plastic://graph/g1/history"]);
    });
});

describe("a feed that reads the store", () => {
    test("says nothing about what happened before it opened, and names what happened after", async () => {
        const { s3, crdt } = await setup();
        await crdt.admission.chain.append("g1", { kind: "mutation.accepted", graphId: "g1" });
        const feed = new ChangeFeed(s3, watchesFor(["plastic://graph/g1", "plastic://graph/g1/history"]));
        await feed.prime();
        expect(await feed.poll()).toBe(0);                    // the store has not moved
        await crdt.admission.chain.append("g1", { kind: "mutation.accepted", graphId: "g1" });
        expect(await feed.poll()).toBe(2);
        expect(feed.published.map((e) => e.uri).sort()).toEqual(["plastic://graph/g1", "plastic://graph/g1/history"]);
        expect(await feed.poll()).toBe(0);                    // and it does not say it twice
    });

    test("several records in one pass are one event per resource, not one per record", async () => {
        const { s3, crdt } = await setup();
        const feed = new ChangeFeed(s3, watchesFor(["plastic://graph/g1/history"]));
        await feed.prime();
        for (let i = 0; i < 5; i += 1) {
            await crdt.admission.chain.append("g1", { kind: "mutation.accepted", graphId: "g1" });
        }
        await feed.poll();
        expect(feed.published.filter((e) => e.uri === "plastic://graph/g1/history")).toHaveLength(1);
    });

    test("an execution that finished is the execution index and that one execution", async () => {
        const { s3 } = await setup();
        const feed = new ChangeFeed(s3, watchesFor(["plastic://graph/g1/executions"]));
        await new Promise((resolve) => s3.set("executions/by-graph/g1/01J0000000000000000000000A", { executionId: "01J0000000000000000000000A" }, {}, resolve));
        await feed.prime();
        expect(await feed.poll()).toBe(0);
        await new Promise((resolve) => s3.set("executions/by-graph/g1/01J0000000000000000000000B", { executionId: "01J0000000000000000000000B" }, {}, resolve));
        await feed.poll();
        expect(feed.published.map((e) => e.uri)).toEqual([
            "plastic://graph/g1/executions",
            "plastic://graph/g1/execution/01J0000000000000000000000B",
        ]);
    });

    test("an execution whose id sorts below one already there is still new", async () => {
        // The dev stage's own arrangement: a browser-owned execution carries an
        // id made in the browser, which sorted above every server id that came
        // after it.  Ordering by id loses those; membership does not.
        const { s3 } = await setup();
        const put = (id) => new Promise((resolve) => s3.set(`executions/by-graph/g1/${id}`, { executionId: id }, {}, resolve));
        await put("01M35PKQJSYS2K8W2RD97TR6QZ");            // the browser's, and the highest
        const feed = new ChangeFeed(s3, watchesFor(["plastic://graph/g1/executions"]));
        await feed.prime();
        await put("01M33TGE01QCKF55XPCMMV12RE");            // the server's, later but lower
        await feed.poll();
        expect(feed.published.map((e) => e.uri)).toEqual([
            "plastic://graph/g1/executions",
            "plastic://graph/g1/execution/01M33TGE01QCKF55XPCMMV12RE",
        ]);
        expect(await feed.poll()).toBe(0);
    });

    test("a store that cannot be read is reported, not thrown, and the stream stays open", async () => {
        const broken = { get: (k, cb) => cb(new Error("no")), list: (p, cb) => cb(new Error("no")) };
        const errors = [];
        const feed = new ChangeFeed(broken, watchesFor(["plastic://graph/g1"]), { onerror: (e) => errors.push(e) });
        await feed.prime();
        expect(await feed.poll()).toBe(0);
    });
});

describe("a stream a client holds open", () => {
    test("acknowledges what it will honour, then names each resource as it changes", async () => {
        const { mcp, crdt } = await setup();
        const client = await connect(mcp, owner);
        const updated = [];
        client.setNotificationHandler("notifications/resources/updated", (n) => updated.push(n.params.uri));
        const subscription = await client.listen({ resourceSubscriptions: ["plastic://graph/g1", "plastic://graph/g1/history"] });
        expect(subscription.honoredFilter).toEqual({ resourceSubscriptions: ["plastic://graph/g1", "plastic://graph/g1/history"] });
        await crdt.admission.chain.append("g1", { kind: "mutation.accepted", graphId: "g1" });
        await eventually(() => updated.length >= 2);
        expect(updated.sort()).toEqual(["plastic://graph/g1", "plastic://graph/g1/history"]);
        await subscription.close();
        await client.close();
    });

    test("hears nothing about a resource it did not ask for", async () => {
        const { mcp, crdt } = await setup();
        const client = await connect(mcp, owner);
        const updated = [];
        client.setNotificationHandler("notifications/resources/updated", (n) => updated.push(n.params.uri));
        const subscription = await client.listen({ resourceSubscriptions: ["plastic://graph/g1/history"] });
        await crdt.admission.chain.append("g1", { kind: "mutation.accepted", graphId: "g1" });
        await eventually(() => updated.length >= 1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(updated).toEqual(["plastic://graph/g1/history"]);
        await subscription.close();
        await client.close();
    });

    test("a graph the caller may not read is refused the way reading it is refused", async () => {
        const { mcp } = await setup();
        const client = await connect(mcp, strangerAgent);
        await expect(client.listen({ resourceSubscriptions: ["plastic://graph/g1/history"] })).rejects.toThrow(/not found: plastic:\/\/graph\/g1\/history/);
        await client.close();
    });

    test("ends gracefully when the invocation is nearly over, so the client knows to listen again", async () => {
        const { mcp } = await setup({ maxStreamMs: 250 });
        const client = await connect(mcp, owner);
        const subscription = await client.listen({ resourceSubscriptions: ["plastic://graph/g1"] });
        await expect(subscription.closed).resolves.toBe("graceful");
        await client.close();
    });

    test("the request/response endpoint says where to listen, and does not claim it can itself", async () => {
        const { makeMcpHandler } = require("../mcp/handler");
        const { s3, store, crdt, revisions, proposals, delegations, tocStore } = await setup();
        process.env.MCP_STREAM_URL = "https://stream.example/";
        try {
            const rest = makeMcpHandler({ crdtStore: store, tocStore, admission: crdt.admission, revisions, proposals, delegations, components: {}, summaries: {} });
            const client = await connect(rest, owner);
            expect(client.getInstructions()).toContain("subscriptions/listen stream against https://stream.example/");
            expect(client.getServerCapabilities().resources).not.toMatchObject({ subscribe: true });
            await client.close();
        } finally {
            delete process.env.MCP_STREAM_URL;
        }
    });

    test("the same endpoint answers ordinary requests", async () => {
        const { mcp } = await setup();
        const client = await connect(mcp, owner);
        const tools = (await client.listTools()).tools.map((t) => t.name);
        expect(tools).toContain("graph.summary");
        // and it says it can hold a subscription open, which the REST route does not
        expect(client.getServerCapabilities().resources).toMatchObject({ subscribe: true, listChanged: true });
        await client.close();
    });
});

describe("a stream that has to survive the substrate", () => {
    /** The raw frames, as a client on the other end of a Function URL sees them. */
    async function frames(mcp, principal, body, ms) {
        const response = await mcp.serve(new Request("https://stream.test/mcp", {
            method: "POST",
            headers: {
                "content-type": "application/json", accept: "application/json, text/event-stream",
                "mcp-protocol-version": "2026-07-28", "mcp-method": "subscriptions/listen",
            },
            body: JSON.stringify(body),
        }), principal);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        const until = Date.now() + ms;
        while (Date.now() < until) {
            const next = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), until - Date.now()))]);
            if (next.timeout || next.done) {
                break;
            }
            text += decoder.decode(next.value);
        }
        reader.cancel().catch(() => undefined);
        return { headers: response.headers, text };
    }

    const listenRequest = (uris) => ({
        jsonrpc: "2.0", id: 1, method: "subscriptions/listen",
        params: {
            notifications: { resourceSubscriptions: uris },
            _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": { name: "raw-client", version: "1.0.0" },
                "io.modelcontextprotocol/clientCapabilities": {},
            },
        },
    });

    test("keeps itself alive with comment frames, so nothing between them closes it", async () => {
        const { mcp } = await setup({ keepAliveMs: 40 });
        const { headers, text } = await frames(mcp, owner, listenRequest(["plastic://graph/g1"]), 200);
        expect(headers.get("content-type")).toBe("text/event-stream");
        expect(headers.get("x-accel-buffering")).toBe("no");   // nothing in the path may buffer it
        expect(text).toContain("notifications/subscriptions/acknowledged");
        expect((text.match(/: keepalive/g) || []).length).toBeGreaterThan(1);
    });

    test("stops reading the store the moment the client goes away", async () => {
        // A Lambda container is reused.  A feed still polling after its stream
        // ended would read the store on the next request's time, for nobody.
        const { s3 } = await setup();
        let reads = 0;
        const counted = { get: (k, cb) => { reads += 1; return s3.get(k, cb); }, list: (p2, cb) => { reads += 1; return s3.list(p2, cb); } };
        const mcp = makeMcpStreamHandler(
            { crdtStore: { store: s3 }, tocStore: { project: async () => ({}) }, delegations: { resolve: async (p2) => p2 } },
            { store: counted, pollMs: 20, keepAliveMs: 40 },
        );
        const response = await mcp.serve(new Request("https://stream.test/mcp", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "subscriptions/listen" },
            body: JSON.stringify(listenRequest(["plastic://graph/g1/history"])),
        }), owner);
        const reader = response.body.getReader();
        await reader.read();                                   // the ack
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(reads).toBeGreaterThan(0);                      // it was watching
        await reader.cancel();
        const afterCancel = reads;
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(reads).toBe(afterCancel);                       // and it stopped
    });

    test("listening again after a stream ends hears what changes from then on", async () => {
        const { mcp, crdt } = await setup();
        const client = await connect(mcp, owner);
        const updated = [];
        client.setNotificationHandler("notifications/resources/updated", (n) => updated.push(n.params.uri));
        const first = await client.listen({ resourceSubscriptions: ["plastic://graph/g1/history"] });
        await first.close();
        // While nobody was listening.  The client re-reads what it cares about;
        // the stream's job is to say what changes from here.
        await crdt.admission.chain.append("g1", { kind: "mutation.accepted", graphId: "g1" });
        const second = await client.listen({ resourceSubscriptions: ["plastic://graph/g1/history"] });
        await crdt.admission.chain.append("g1", { kind: "mutation.accepted", graphId: "g1" });
        expect(await eventually(() => updated.length >= 1)).toBeTruthy();
        expect(updated).toEqual(["plastic://graph/g1/history"]);
        await second.close();
        await client.close();
    });
});
