const Y = require("yjs");
const { fromJSON, toJSON, reconcile, encodeState, applyUpdate, canonical, componentView } = require("@plastic-io/graph-crdt");
const CrdtStore = require("../crdtStore").default;
const CrdtService = require("../crdtService").default;
const TocStore = require("../tocStore").default;
const { RevisionService } = require("../revisions/service");
const { ComponentService, componentDigest, parseArtifactRef } = require("../components/service");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

const port = (name, external = false) => ({ name, type: "Object", external, visible: true });
const node = (id, over = {}) => ({ id, url: id, edges: [{ field: "out", connectors: [] }], version: 0, graphId: "g1", artifact: null, data: null, properties: { inputs: [port("in")], outputs: [port("out")], groups: [], name: id, description: "node " + id, tags: [], icon: "", x: 0, y: 0, z: 0, createdOn: 1, presentation: { x: 0, y: 0, z: 0 } }, template: { set: "edges.out = value;", vue: "" }, ...over });
const graphJson = () => ({ id: "g1", url: "g1", version: 0, nodes: [node("n1", { properties: { ...node("n1").properties, inputs: [port("in", true)] } }), node("n2", { properties: { ...node("n2").properties, outputs: [port("out", true)] } })], properties: { name: "Graph One", description: "a graph", exportable: true, icon: "mdi-graph", createdBy: "", createdOn: 0, lastUpdate: 0, height: 1, width: 1 } });
const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
const agent = { sub: "agent|a1", kind: "agent", tenant: "personal:auth0|u1", scopes: ["graph:commit"] };

async function edit(store, doc, description, mutate) {
    const snapshot = toJSON(doc); mutate(snapshot);
    let out; const h = (u) => (out = u); doc.on("updateV2", h); reconcile(doc, snapshot, { source: "test" }); doc.off("updateV2", h);
    if (out) await store.appendUpdate("g1", out, description, "auth0|u1");
    return out;
}
function fakeBroadcast() { const b = { channel: [] }; b.postToClient = (d, c, p, cb) => cb(); b._sendToChannel = (ch, v, cb) => { b.channel.push([ch, v]); cb(); }; b.broadcast = b._sendToChannel; return b; }
async function setup() {
    const s3 = new FakeS3Service(); const store = new CrdtStore(s3); const broadcast = fakeBroadcast();
    const crdt = new CrdtService(store, broadcast); const tocStore = new TocStore(s3);
    const notified = [];
    const revisions = new RevisionService(store, crdt.admission, { notify: async (g, e) => notified.push(e) });
    const components = new ComponentService(store, revisions, crdt.admission, { tocStore, broadcastService: broadcast, notify: async (g, e) => notified.push(e) });
    crdt.admission.integrity = (after, diff) => components.integrityCheck(after, diff);
    const doc = fromJSON(graphJson());
    await store.appendUpdate("g1", encodeState(doc), "seed", "system");
    return { s3, store, crdt, revisions, components, tocStore, doc, notified };
}
const readJson = (s3, key) => JSON.parse(s3.objects.get(key).toString());
const keysUnder = (s3, prefix) => [...s3.objects.keys()].filter((k) => k.startsWith(prefix)).sort();

describe("publishing grown out of revisions", () => {
    test("publishing a graph names a revision: the version is its seq, the manifest carries contract, digests and provenance, and the 2.0 layout is mirrored", async () => {
        const { s3, components, notified, tocStore } = await setup();
        const r = await components.publish("g1", owner, { label: "first release" });
        expect(r.created).toBe(true);
        const m = r.manifest;
        expect(m).toMatchObject({ schemaVersion: 1, publishedId: "g1", version: 1, kind: "graph", name: "Graph One", label: "first release", placement: "portable", counts: { nodes: 2, connectors: 0 } });
        expect(m.contract.inputs.map((p) => [p.name, p.nodeId])).toEqual([["in", "n1"]]);
        expect(m.contract.outputs.map((p) => [p.name, p.nodeId])).toEqual([["out", "n2"]]);
        expect(m.provenance).toMatchObject({ publishedBy: { sub: "auth0|u1" }, fromGraph: { graphId: "g1", revisionId: r.revision.revisionId, seq: 1 } });
        expect(m.digest).toMatch(/^[0-9a-f]{64}$/); expect(m.revisionDigest).toBe(r.revision.digest.full);
        const artifact = readJson(s3, "components/g1/1/artifact.json");
        expect(artifact.publishedBy).toBe("auth0|u1"); expect(componentDigest("graph", artifact)).toBe(m.digest);
        expect(readJson(s3, "components/g1/HEAD.json")).toMatchObject({ version: 1, revisionId: r.revision.revisionId });
        // the 2.0 layout still exists for old consumers and production execution
        expect(readJson(s3, "graphs/projections/published/artifacts/g1.1.json").id).toBe("g1");
        expect(readJson(s3, "graphs/projections/published/endpoints/g1.json").id).toBe("g1");
        expect(s3.meta.get("graphs/projections/published/artifacts/g1.1.json")).toMatchObject({ type: "publishedGraph", version: "1", "artifact-url": "artifacts/g1/1", "revision-id": r.revision.revisionId });
        const toc = await tocStore.project();
        expect(toc["artifacts/g1.1"]).toMatchObject({ id: "artifacts/g1", type: "publishedGraph", version: "1", "revision-id": r.revision.revisionId, digest: m.digest });
        expect(notified.map((e) => e.eventType + ":" + e.action)).toEqual(["revision:cut", "component:published"]);
        const audit = keysUnder(s3, "audit/g1/").filter((k) => !k.endsWith("HEAD.json")).map((k) => readJson(s3, k).kind);
        expect(audit).toEqual(["revision.cut", "mutation.accepted", "component.published"]);
    });

    test("republishing an unchanged graph returns the same version; an edit publishes the next revision; an older revision can be published by id", async () => {
        const { store, components, revisions, doc } = await setup();
        const first = await components.publish("g1", owner, { label: "v1" });
        const again = await components.publish("g1", owner, { label: "again" });
        expect(again.created).toBe(false); expect(again.manifest.version).toBe(1);
        await edit(store, doc, "Rename", (g) => { g.properties.name = "Graph Two"; });
        const second = await components.publish("g1", owner, {});
        expect(second.created).toBe(true); expect(second.manifest.version).toBe(2); expect(second.manifest.name).toBe("Graph Two");
        expect(second.manifest.digest).not.toBe(first.manifest.digest);
        expect((await components.list("g1")).map((m) => [m.version, m.name, "contract" in m])).toEqual([[2, "Graph Two", false], [1, "Graph One", false]]);
        expect((await components.head("g1")).version).toBe(2);
        expect((await components.artifact("g1", "latest")).properties.name).toBe("Graph Two");
        // publishing revision 1 again by id is the same immutable object
        const byId = await components.publish("g1", owner, { revisionId: first.revision.revisionId });
        expect(byId.created).toBe(false); expect(byId.manifest.version).toBe(1);
        expect((await revisions.listRoute && (await revisions.publishedVersions("g1")))).toMatchObject({ 1: {}, 2: {} });
    });

    test("publishing a node cuts the graph's revision and versions the node by it", async () => {
        const { s3, components, tocStore } = await setup();
        const r = await components.publish("g1", owner, { nodeId: "n2", label: "node release" });
        expect(r.created).toBe(true);
        expect(r.manifest).toMatchObject({ publishedId: "n2", version: 1, kind: "node", name: "n2", contract: { inputs: [{ name: "in" }], outputs: [{ name: "out" }] } });
        expect(readJson(s3, "components/n2/1/artifact.json").template.set).toBe("edges.out = value;");
        expect(readJson(s3, "graphs/projections/published/artifacts/n2.1.json").id).toBe("n2");
        expect(s3.objects.has("graphs/projections/published/endpoints/n2.json")).toBe(false);
        expect((await tocStore.project())["artifacts/n2.1"]).toMatchObject({ type: "publishedNode", "graph-id": "g1" });
        expect(await components.publish("g1", owner, { nodeId: "nope" })).toMatchObject({ code: "NOT_FOUND" });
        expect(await components.publish("g1", agent, {})).toMatchObject({ code: "ADMISSION_DENIED" });
    });

    test("the 2.0 artifact route serves the component, falling back to a pre-revision artifact", async () => {
        const { s3, components } = await setup();
        await components.publish("g1", owner, {});
        const call = (id, version) => new Promise((res) => components.artifactRoute({ pathParameters: { id, version } }, {}, (e, r) => res(r)));
        expect(JSON.parse((await call("g1", "1")).body).properties.name).toBe("Graph One");
        expect(JSON.parse((await call("g1", "latest")).body).id).toBe("g1");
        s3.objects.set("graphs/projections/published/artifacts/old.7.json", Buffer.from(JSON.stringify({ id: "old", legacy: true })));
        expect(JSON.parse((await call("old", "7")).body)).toEqual({ id: "old", legacy: true });
        expect((await call("nothing", "1")).statusCode).toBe(404);
        const get = (id, version) => new Promise((res) => components.getRoute({ pathParameters: { id, version } }, {}, (e, r) => res(JSON.parse(r.body))));
        const got = await get("g1", "1"); expect(got.manifest.version).toBe(1); expect(got.artifact.id).toBe("g1");
        const list = await new Promise((res) => components.listRoute({ pathParameters: { id: "g1" } }, {}, (e, r) => res(JSON.parse(r.body))));
        expect(list.head.version).toBe(1); expect(list.versions.length).toBe(1);
    });

    test("a consumer's embedded copy is checked against the manifest: faithful copies pass, drifted ones are warned about, or refused when configured", async () => {
        const { s3, store, crdt, components, doc } = await setup();
        const published = await components.publish("g1", owner, { nodeId: "n2" });
        const artifact = readJson(s3, "components/n2/1/artifact.json");
        // what the editor's addNodeItem does with the artifact
        const imported = JSON.parse(JSON.stringify(artifact)); delete imported.artifact; delete imported.url; imported.loaded = true; imported.edges.forEach((e) => { e.connectors = []; });
        const host = node("host", { linkedNode: imported, properties: { ...node("host").properties, component: { publishedId: "n2", version: 1, digest: published.manifest.digest } } });
        expect((await components.verifyEmbedded(host)).ok).toBe(true);
        // admitted as a graph change: no warning
        const content = await (async () => { const snapshot = JSON.parse(JSON.stringify(toJSON(doc))); snapshot.nodes.push(host); let out; const h = (u) => (out = u); doc.on("updateV2", h); reconcile(doc, snapshot, { source: "t" }); doc.off("updateV2", h); return out; })();
        const ok = await crdt.admission.admit({ graphId: "g1", mutationId: "01J8ZK5K0B1C2D3E4F5G6H7J8A", content, description: "Import", principal: owner });
        expect(ok.decision).toBe("accepted"); expect(ok.warnings).toBeUndefined();
        // the copy drifts: the code inside the embedded node is edited
        const drift = await (async () => { const snapshot = JSON.parse(JSON.stringify(toJSON(doc))); snapshot.nodes.find((n) => n.id === "host").linkedNode.template.set = "tampered"; let out; const h = (u) => (out = u); doc.on("updateV2", h); reconcile(doc, snapshot, { source: "t" }); doc.off("updateV2", h); return out; })();
        const warned = await crdt.admission.admit({ graphId: "g1", mutationId: "01J8ZK5K0B1C2D3E4F5G6H7J8B", content: drift, description: "Tamper", principal: owner });
        expect(warned.decision).toBe("accepted"); expect(warned.warnings).toEqual([expect.stringMatching(/host: the embedded copy of n2@1 differs/)]);
        // with enforcement on, the same change is refused and nothing is stored
        process.env.COMPONENT_INTEGRITY = "reject";
        const drift2 = await (async () => { const snapshot = JSON.parse(JSON.stringify(toJSON(doc))); snapshot.nodes.find((n) => n.id === "host").linkedNode.template.set = "tampered again"; let out; const h = (u) => (out = u); doc.on("updateV2", h); reconcile(doc, snapshot, { source: "t" }); doc.off("updateV2", h); return out; })();
        const objects = keysUnder(s3, "graphs/g1/crdt/v2/updates/").length;
        const refused = await crdt.admission.admit({ graphId: "g1", mutationId: "01J8ZK5K0B1C2D3E4F5G6H7J8C", content: drift2, description: "Tamper", principal: owner });
        delete process.env.COMPONENT_INTEGRITY;
        expect(refused).toMatchObject({ decision: "rejected", code: "INTEGRITY_FAILURE" });
        expect(keysUnder(s3, "graphs/g1/crdt/v2/updates/").length).toBe(objects);
        // a pin to something never published
        const ghost = node("ghost", { properties: { ...node("ghost").properties, component: { publishedId: "nope", version: 3 } } });
        expect((await components.verifyEmbedded(ghost)).reason).toMatch(/no published component nope@3/);
    });

    test("GET /graph/{id}/{version} resolves a version number to the revision's projection", async () => {
        const { store, components, doc } = await setup();
        const EventSourceService = require("../eventSourceService").default;
        await components.publish("g1", owner, {});
        await edit(store, doc, "Rename", (g) => { g.properties.name = "Later"; });
        const ess = new EventSourceService();
        ess.store = store.store; ess.crdtStore = store; ess.revisions = components.revisions;
        const r = await new Promise((res) => ess.getGraph({ pathParameters: { id: "g1", version: "1" } }, {}, (e, x) => res(x)));
        expect(JSON.parse(r.body).properties.name).toBe("Graph One");
    });

    test("artifact references parse in both spellings", () => {
        expect(parseArtifactRef("artifacts/abc-1.3")).toEqual({ publishedId: "abc-1", version: 3 });
        expect(parseArtifactRef("https://host/dev/artifacts/abc-1/3")).toEqual({ publishedId: "abc-1", version: 3 });
        expect(parseArtifactRef("artifacts/abc-1.3.json")).toEqual({ publishedId: "abc-1", version: 3 });
        expect(parseArtifactRef(null)).toBeNull();
    });
});
