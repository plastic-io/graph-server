import EventSourceService from "../eventSourceService";
import FakeS3Service from "../__testHelpers__/fakeS3";

function sampleGraph(id, url) {
    return {
        id,
        version: 1,
        url,
        nodes: [],
        properties: { name: "Graph " + id, description: "", icon: "mdi-graph" },
    };
}

/** Put a graph in the store the way the projection writer would. */
function seed(store, graph) {
    const meta = {
        id: graph.id,
        name: graph.properties.name,
        version: String(graph.version),
        description: graph.properties.description,
        icon: graph.properties.icon,
        type: "graph",
        url: graph.url,
    };
    store.set(`graphs/projections/latest/${graph.id}.json`, graph, meta, () => undefined);
    store.set(`graphs/${graph.id}/projections/${graph.id}.1.json`, graph, meta, () => undefined);
    store.set(`graphs/projections/endpoints/${graph.url}.json`, graph, { ...meta, type: "endpoint" }, () => undefined);
    store.set(`graphs/${graph.id}/events/ev1.json`, { id: "ev1" }, { ...meta, type: "event" }, () => undefined);
}

function invoke(service, method, event) {
    return new Promise((resolve) => {
        service[method](event, {}, (err, response) => resolve({ err, response }));
    });
}

function readToc(service) {
    return new Promise((resolve) => {
        service.getToc({}, {}, (err, response) => resolve(JSON.parse(response.body)));
    });
}

describe("deleting a graph", () => {
    let store;
    let service;

    beforeEach(() => {
        store = new FakeS3Service();
        service = new EventSourceService();
        service.store = store;
        service.crdtStore.store = store;
        service.broadcastService = {
            broadcast: (channelId, value, callback) => callback(null, null),
            postToClient: (d, c, m, callback) => callback(null, null),
            _sendToChannel: (channelId, value, callback) => callback(null, null),
        };
        seed(store, sampleGraph("keep-me", "KeepMe"));
        seed(store, sampleGraph("hide-me", "HideMe"));
    });

    /**
     * Writing the table of contents is deliberately deferred, so anything that
     * triggers it needs a moment before the result can be read back.
     */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

    it("keeps files that are not graphs out of the list", async () => {
        // The deleted index lives beside the projections.  It was being listed
        // as a graph with no name, which put an "undefined" entry in the list.
        await invoke(service, "deleteGraph", {
            pathParameters: { id: "hide-me" }, queryStringParameters: null, requestContext: {},
        });
        await settle();
        const toc = await readToc(service);
        expect(Object.keys(toc)).not.toContain("undefined");
        Object.keys(toc).forEach((key) => {
            expect(toc[key].id).toBeTruthy();
        });
    });

    it("lists both graphs before anything is deleted", async () => {
        service.updateToc(() => undefined);
        await settle();
        const toc = await readToc(service);
        expect(Object.keys(toc).sort()).toEqual(
            expect.arrayContaining(["keep-me", "hide-me", "endpoint/keep-me", "endpoint/hide-me"]),
        );
    });

    it("hides a graph without destroying anything", async () => {
        const { response } = await invoke(service, "deleteGraph", {
            pathParameters: { id: "hide-me" },
            queryStringParameters: null,
            requestContext: { identity: { userArn: "arn:tester" } },
        });
        await settle();
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ id: "hide-me", permanent: false });

        const toc = await readToc(service);
        expect(Object.keys(toc)).not.toContain("hide-me");
        expect(Object.keys(toc)).not.toContain("endpoint/hide-me");
        expect(Object.keys(toc)).toContain("keep-me");

        // Everything it was made of is still there.
        expect(store.objects.has("graphs/projections/latest/hide-me.json")).toBe(true);
        expect(store.objects.has("graphs/hide-me/events/ev1.json")).toBe(true);
        expect(store.objects.has("graphs/projections/endpoints/HideMe.json")).toBe(true);
    });

    it("still serves a hidden graph to anyone holding its address", async () => {
        await invoke(service, "deleteGraph", {
            pathParameters: { id: "hide-me" },
            queryStringParameters: null,
            requestContext: {},
        });
        await settle();
        const { response } = await invoke(service, "getGraph", {
            pathParameters: { id: "hide-me", version: "latest" },
        });
        expect(JSON.parse(response.body).id).toBe("hide-me");
    });

    it("puts a hidden graph back", async () => {
        await invoke(service, "deleteGraph", {
            pathParameters: { id: "hide-me" }, queryStringParameters: null, requestContext: {},
        });
        await settle();
        expect(Object.keys(await readToc(service))).not.toContain("hide-me");

        const { response } = await invoke(service, "undeleteGraph", {
            pathParameters: { id: "hide-me" },
        });
        await settle();
        expect(JSON.parse(response.body)).toEqual({ id: "hide-me", restored: true });
        expect(Object.keys(await readToc(service))).toContain("hide-me");
    });

    it("lists what is hidden", async () => {
        await invoke(service, "deleteGraph", {
            pathParameters: { id: "hide-me" }, queryStringParameters: null,
            requestContext: { identity: { userArn: "arn:tester" } },
        });
        await settle();
        const { response } = await invoke(service, "listDeletedGraphs", {});
        const listed = JSON.parse(response.body);
        expect(listed).toHaveLength(1);
        expect(listed[0].id).toBe("hide-me");
        expect(listed[0].deletedBy).toBe("arn:tester");
    });

    it("permanently removes everything when asked to", async () => {
        const { response } = await invoke(service, "deleteGraph", {
            pathParameters: { id: "hide-me" },
            queryStringParameters: { permanent: "true" },
            requestContext: {},
        });
        await settle();
        expect(JSON.parse(response.body)).toEqual({ id: "hide-me", permanent: true });

        expect(store.objects.has("graphs/projections/latest/hide-me.json")).toBe(false);
        expect(store.objects.has("graphs/hide-me/events/ev1.json")).toBe(false);
        expect(store.objects.has("graphs/projections/endpoints/HideMe.json")).toBe(false);
        // and the graph beside it is untouched
        expect(store.objects.has("graphs/projections/latest/keep-me.json")).toBe(true);
    });

    it("clears the hidden marker when a hidden graph is then destroyed", async () => {
        await invoke(service, "deleteGraph", {
            pathParameters: { id: "hide-me" }, queryStringParameters: null, requestContext: {},
        });
        await settle();
        await invoke(service, "deleteGraph", {
            pathParameters: { id: "hide-me" },
            queryStringParameters: { permanent: "true" },
            requestContext: {},
        });
        await settle();
        const { response } = await invoke(service, "listDeletedGraphs", {});
        expect(JSON.parse(response.body)).toEqual([]);
    });

    it("refuses a delete with no graph id", async () => {
        const { response } = await invoke(service, "deleteGraph", {
            pathParameters: null, queryStringParameters: null, requestContext: {},
        });
        expect(response.statusCode).toBe(400);
    });

    it("treats anything other than true as a hide", async () => {
        await invoke(service, "deleteGraph", {
            pathParameters: { id: "hide-me" },
            queryStringParameters: { permanent: "1" },
            requestContext: {},
        });
        await settle();
        expect(store.objects.has("graphs/projections/latest/hide-me.json")).toBe(true);
    });

    it("hides over the websocket route too, and only destroys when told", async () => {
        await invoke(service, "deleteGraphWs", {
            body: JSON.stringify({ id: "hide-me" }), requestContext: {},
        });
        await settle();
        expect(store.objects.has("graphs/projections/latest/hide-me.json")).toBe(true);
        expect(Object.keys(await readToc(service))).not.toContain("hide-me");

        await invoke(service, "deleteGraphWs", {
            body: JSON.stringify({ id: "hide-me", permanent: true }), requestContext: {},
        });
        await settle();
        expect(store.objects.has("graphs/projections/latest/hide-me.json")).toBe(false);
    });
});
