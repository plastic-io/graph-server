import EventSourceService from "../eventSourceService";
import TocStore from "../tocStore";
import FakeS3Service from "../__testHelpers__/fakeS3";
const AWS = require("aws-sdk");
describe("Event Source Service", () => {
    beforeEach(() => {
        AWS.mocks.S3.putObject.mockClear();
        AWS.mocks.S3.headObject.mockClear();
        AWS.mocks.S3.getObject.mockClear();
        AWS.mocks.S3.deleteObject.mockClear();
        AWS.mocks.S3.listObjects.mockClear();
        AWS.mocks.ApiGatewayManagementApi.postToConnection.mockClear();
    });
    it("Should call S3 getObject to fetch an object.", (done) => {
        const eventSourceService = new EventSourceService();
        const req = require("./__data__/event_http_request.json");
        req.event.pathParameters = {
            id: "1234",
        };
        eventSourceService.getEvents(req.event, req.context);
        expect(AWS.mocks.S3.listObjects).toHaveBeenCalled();
        done();
    });
    it("does not walk the store to answer for the list.", (done) => {
        // The list used to be rebuilt from every object under the projections
        // on each save, which is a request per graph.  It is a document now,
        // so reading it is a read of that document.
        const eventSourceService = new EventSourceService();
        eventSourceService.tocStore = new TocStore(new FakeS3Service());
        eventSourceService.getToc({}, {}, (err, response) => {
            expect(response.statusCode).toBe(200);
            expect(AWS.mocks.S3.headObject).not.toHaveBeenCalled();
            done();
        });
    });
    it("reports an empty list when nothing is stored yet.", (done) => {
        const eventSourceService = new EventSourceService();
        eventSourceService.tocStore = new TocStore(new FakeS3Service());
        eventSourceService.getToc({}, {}, (err, response) => {
            expect(JSON.parse(response.body)).toEqual({});
            done();
        });
    });
});

describe("a graph that changes is a graph on the list", () => {
    const Y = require("yjs");
    const { fromJSON, toJSON, reconcile, encodeState } = require("@plastic-io/graph-crdt");
    const CrdtStore = require("../crdtStore").default;
    const CrdtService = require("../crdtService").default;
    const TocStore = require("../tocStore").default;
    const { RevisionService } = require("../revisions/service");
    const { SummaryService } = require("../summary/service");
    const { ComponentService } = require("../components/service");
    const { ProposalService } = require("../proposals/service");
    const { ulid } = require("ulid");
    const fakeS3 = require("../__testHelpers__/fakeS3");
    const FakeS3 = fakeS3.FakeS3Service || fakeS3;

    /**
     * The list of graphs is its own document, and only the websocket path ever
     * wrote to it — so a graph an agent had changed sat at whatever an editor
     * last saved, and a graph no editor had ever opened was not on the list at
     * all: a document, revisions, projections, and nothing anybody could find.
     */
    const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
    const node = (id) => ({ id, url: id, edges: [], version: 0, graphId: "g1", artifact: null, data: null, properties: { inputs: [], outputs: [], groups: [], name: id, description: "", tags: [], icon: "", x: 0, y: 0, z: 0, createdOn: 1, presentation: {} }, template: { set: "", vue: "" } });
    const graphJson = (over = {}) => ({ id: "g1", url: "g1", version: 0, nodes: [node("a")], properties: { name: "Before", description: "", exportable: false, icon: "", createdBy: "", createdOn: 0, lastUpdate: 0, height: 1, width: 1, ...over } });

    async function setup(listed = true) {
        const s3 = new FakeS3();
        const store = new CrdtStore(s3);
        const broadcast = { channel: [], postToClient: (d, c, p, cb) => cb(), _sendToChannel: (ch, v, cb) => cb(), broadcast: (ch, v, cb) => cb() };
        const crdt = new CrdtService(store, broadcast);
        const tocStore = new TocStore(s3);
        crdt.tocStore = tocStore;
        const revisions = new RevisionService(store, crdt.admission, {});
        const components = new ComponentService(store, revisions, crdt.admission, { tocStore, broadcastService: broadcast });
        const summaries = new SummaryService(revisions, components);
        const failures = [];
        const proposals = new ProposalService(store, crdt.admission, revisions, summaries, {
            listed: listed
                ? (graph) => crdt.listGraph(graph)
                : async () => { failures.push("asked"); throw new Error("the list is unwritable"); },
        });
        const doc = fromJSON(graphJson());
        await store.appendUpdate("g1", encodeState(doc), "seed", "system");
        return { s3, store, crdt, revisions, summaries, proposals, tocStore, failures };
    }

    const propose = async (parts, ops, description) => {
        const head = await parts.summaries.headOrCut("g1");
        const created = await parts.proposals.create("g1", owner, {
            baseRevision: "rev_" + head.revisionId, ops, description, idempotencyKey: ulid(),
        });
        expect(created.error).toBeUndefined();
        return parts.proposals.commit("g1", created.proposal.proposalId, owner);
    };

    test("a graph no editor has ever opened is on the list once a proposal lands", async () => {
        const parts = await setup();
        expect(Object.keys(await parts.tocStore.project())).toEqual([]);

        const committed = await propose(parts, [{ op: "set-graph-props", patch: { name: "After" } }], "name it");
        expect(committed.error).toBeUndefined();

        const toc = await parts.tocStore.project();
        expect(toc.g1).toBeTruthy();
        expect(toc.g1.name).toBe("After");
    });

    test("the entry keeps up: a second change is on the list too", async () => {
        const parts = await setup();
        await propose(parts, [{ op: "set-graph-props", patch: { name: "First" } }], "first");
        await propose(parts, [{ op: "set-graph-props", patch: { name: "Second" } }], "second");
        expect((await parts.tocStore.project()).g1.name).toBe("Second");
    });

    test("a list that cannot be written does not fail the commit", async () => {
        const parts = await setup(false);
        const committed = await propose(parts, [{ op: "set-graph-props", patch: { name: "Regardless" } }], "regardless");
        expect(committed.error).toBeUndefined();
        expect(committed.proposal.state).toBe("committed");
        expect(parts.failures).toEqual(["asked"]);
    });
});
