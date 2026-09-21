const Y = require("yjs");
const { fromJSON, toJSON, reconcile, encodeState, applyUpdate, mergeUpdates } = require("@plastic-io/graph-crdt");
const CrdtStore = require("../crdtStore").default;
const CrdtService = require("../crdtService").default;
const { AdmissionService } = require("../admission/admit");
const { RevisionService, digestsOf, SYSTEM_PRINCIPAL } = require("../revisions/service");
const { AuditChain } = require("../audit/chain");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

const node = (id, x = 0) => ({ id, url: id, edges: [{ field: "out", connectors: [] }], version: 0, graphId: "g1", artifact: null, data: null, properties: { inputs: [], outputs: [{ name: "out", type: "Object", external: false, visible: true }], groups: [], name: id, description: "", tags: [], icon: "", x, y: 0, z: 0, createdOn: 1, presentation: { x, y: 0, z: 0 } }, template: { set: "", vue: "" } });
const graphJson = () => ({ id: "g1", url: "g1", version: 0, nodes: [node("n1"), node("n2", 10)], properties: { name: "g1", description: "", exportable: false, icon: "", createdBy: "", createdOn: 0, lastUpdate: 0, height: 1, width: 1 } });
const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
const agent = { sub: "agent|a1", kind: "agent", tenant: "personal:auth0|u1", scopes: ["graph:commit"] };

/** an editor-style edit: mutate the snapshot, reconcile, store the update */
async function edit(store, doc, description, mutate) {
    const snapshot = toJSON(doc); mutate(snapshot);
    let out; const h = (u) => (out = u); doc.on("updateV2", h); reconcile(doc, snapshot, { source: "test" }); doc.off("updateV2", h);
    if (out) await store.appendUpdate("g1", out, description, "auth0|u1");
    return out;
}
async function setup() {
    const s3 = new FakeS3Service(); const store = new CrdtStore(s3); const broadcast = fakeBroadcast();
    const crdt = new CrdtService(store, broadcast);
    const notified = []; const fanned = [];
    const revisions = new RevisionService(store, crdt.admission, { notify: async (g, e) => notified.push(e), fanOut: async (g, u) => fanned.push(u) });
    const doc = fromJSON(graphJson());
    await store.appendUpdate("g1", encodeState(doc), "seed", "system");
    return { s3, store, crdt, revisions, doc, notified, fanned };
}
function fakeBroadcast() {
    const b = { direct: [], channel: [] };
    b.postToClient = (d, c, payload, cb) => { b.direct.push(payload); cb(); };
    b._sendToChannel = (ch, val, cb) => { b.channel.push([ch, val]); cb(); };
    b.broadcast = b._sendToChannel;
    return b;
}
const keysUnder = (s3, prefix) => [...s3.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
const readJson = (s3, key) => JSON.parse(s3.objects.get(key).toString());

describe("revisions grown from the document's history", () => {
    test("cutting a revision writes an immutable manifest, the frozen projection, HEAD, an audit record, and stamps meta.revision into the document", async () => {
        const { s3, store, revisions, doc, notified, fanned } = await setup();
        const r = await revisions.cut("g1", owner, "first");
        expect(r.created).toBe(true);
        const rev = r.revision;
        expect(rev).toMatchObject({ graphId: "g1", seq: 1, parent: null, label: "first", schemaVersion: 2, createdBy: { sub: "auth0|u1" }, counts: { nodes: 2, connectors: 0 } });
        expect(rev.revisionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(rev.digest.full).toMatch(/^[0-9a-f]{64}$/);
        expect(typeof rev.snapshot).toBe("string");
        expect(readJson(s3, `revisions/g1/${rev.revisionId}.json`).revisionId).toBe(rev.revisionId);
        expect(readJson(s3, `revisions/g1/${rev.revisionId}.projection.json`).nodes.length).toBe(2);
        expect(readJson(s3, "revisions/g1/HEAD.json")).toEqual({ revisionId: rev.revisionId, seq: 1 });
        // the document now knows its own version: stamped by the system principal through admission, fanned out
        const projected = await store.loadMerged("g1"); const d = new Y.Doc(); applyUpdate(d, projected.update);
        expect(d.getMap("graph").get("meta").get("revision")).toMatchObject({ id: rev.revisionId, seq: 1, label: "first" });
        expect(fanned.length).toBe(1);
        const audit = keysUnder(s3, "audit/g1/").filter((k) => !k.endsWith("HEAD.json")).map((k) => readJson(s3, k));
        expect(audit.map((a) => a.kind)).toEqual(["revision.cut", "mutation.accepted"]);
        expect(audit[1]).toMatchObject({ principal: { sub: "system:revisions", kind: "system" }, description: "Version 1" });
        expect(audit[1].diff.namespaces).toEqual(["meta"]);
        expect(notified[0]).toMatchObject({ eventType: "revision", action: "cut", seq: 1 });
    });

    test("cutting again with nothing changed returns the same revision; after an edit it chains a new one with the mutations since", async () => {
        const { store, revisions, doc, crdt } = await setup();
        const first = (await revisions.cut("g1", owner, "first")).revision;
        const again = await revisions.cut("g1", owner, "again");
        expect(again.created).toBe(false); expect(again.revision.revisionId).toBe(first.revisionId);
        // an admitted edit (so it is in the audit chain), then a second cut
        const u = await edit(store, doc, "Rename", (g) => { g.properties.name = "renamed"; });
        const doc2 = new Y.Doc(); applyUpdate(doc2, (await store.loadMerged("g1")).update);
        let out; const h = (x) => (out = x); doc2.on("updateV2", h); reconcile(doc2, { ...toJSON(doc2), properties: { ...toJSON(doc2).properties, description: "d" } }, { source: "t" }); doc2.off("updateV2", h);
        const admitted = await crdt.admission.admit({ graphId: "g1", mutationId: "01J8ZK5K0B1C2D3E4F5G6H7J8A", content: out, description: "Describe", principal: owner });
        expect(admitted.decision).toBe("accepted");
        const second = (await revisions.cut("g1", owner, "second")).revision;
        expect(second.seq).toBe(2); expect(second.parent).toBe(first.revisionId);
        expect(second.mutationIds).toEqual(["01J8ZK5K0B1C2D3E4F5G6H7J8A"]);
        expect(second.diffFromParent).toMatch(/graph: properties.description, properties.name/);
        expect(second.digest.layout).toBe(first.digest.layout); expect(second.digest.definition).not.toBe(first.digest.definition);
        expect((await revisions.list("g1")).map((r) => [r.seq, r.label, "snapshot" in r])).toEqual([[1, "first", false], [2, "second", false]]);
    });

    test("a revision is rebuilt from the Yjs snapshot after later edits, a deletion and a log snapshot, and matches its digest", async () => {
        const { store, revisions, doc } = await setup();
        const rev = (await revisions.cut("g1", owner, "before")).revision;
        // later history: move, delete a node, add a node; then the store folds the log into a snapshot
        await edit(store, doc, "Move", (g) => { g.nodes[0].properties.x = 500; });
        await edit(store, doc, "Delete", (g) => { g.nodes = g.nodes.filter((n) => n.id !== "n2"); });
        await edit(store, doc, "Add", (g) => { g.nodes.push(node("n3", 7)); });
        expect(await store.writeSnapshot("g1")).toBeTruthy();
        const now = await store.projectGraph("g1");
        expect(now.nodes.map((n) => n.id).sort()).toEqual(["n1", "n3"]);
        const built = await revisions.materialize("g1", rev.revisionId);
        expect(built.verified).toBe(true);
        expect(built.projection.nodes.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
        expect(built.projection.nodes[0].properties.x).toBe(0);
        expect(digestsOf(built.projection).full).toBe(rev.digest.full);
    });

    test("restore brings the live document back to a revision as an ordinary admitted change", async () => {
        const { s3, store, revisions, doc, fanned } = await setup();
        const rev = (await revisions.cut("g1", owner, "keep")).revision;
        await edit(store, doc, "Delete", (g) => { g.nodes = g.nodes.filter((n) => n.id !== "n2"); });
        await edit(store, doc, "Rename", (g) => { g.properties.name = "changed"; });
        const r = await revisions.restore("g1", rev.revisionId, owner);
        expect(r.decision).toBe("accepted"); expect(r.diffSummary.nodesAdded).toBe(1);
        const after = await store.projectGraph("g1");
        expect(after.nodes.map((n) => n.id).sort()).toEqual(["n1", "n2"]); expect(after.properties.name).toBe("g1");
        expect(fanned.length).toBe(2);   // the stamp and the restore
        const record = keysUnder(s3, "audit/g1/").filter((k) => !k.endsWith("HEAD.json")).map((k) => readJson(s3, k)).pop();
        expect(record).toMatchObject({ kind: "mutation.accepted", description: "Restore version 1", principal: { sub: "auth0|u1" } });
        // restoring what is already current is a no-op, not a new update
        const noop = await revisions.restore("g1", rev.revisionId, owner);
        expect(noop.decision).toBe("accepted"); expect(noop.reason).toMatch(/already at version 1/);
        expect(fanned.length).toBe(2);
    });

    test("activation freezes what execution loads; later edits and checkpoints do not move it", async () => {
        const { s3, store, revisions, doc, crdt, notified } = await setup();
        const rev = (await revisions.cut("g1", owner, "v1")).revision;
        const a = await revisions.activate("g1", rev.revisionId, owner);
        expect(a.active).toMatchObject({ revisionId: rev.revisionId, seq: 1, by: "auth0|u1" });
        expect(readJson(s3, "active/g1.json").revisionId).toBe(rev.revisionId);
        expect(readJson(s3, "graphs/projections/endpoints/g1.json").properties.name).toBe("g1");
        expect(s3.meta.get("graphs/projections/endpoints/g1.json")["revision-id"]).toBe(rev.revisionId);
        expect(notified.pop()).toMatchObject({ eventType: "revision", action: "activated" });
        await edit(store, doc, "Rename", (g) => { g.properties.name = "live edit"; });
        await crdt.ensureProjection("g1");
        expect(readJson(s3, "graphs/projections/latest/g1.json").properties.name).toBe("live edit");
        expect(readJson(s3, "graphs/projections/endpoints/g1.json").properties.name).toBe("g1");   // execution still on v1
        // and it is audited
        const kinds = keysUnder(s3, "audit/g1/").filter((k) => !k.endsWith("HEAD.json")).map((k) => readJson(s3, k).kind);
        expect(kinds).toContain("revision.activated");
        expect(await new AuditChain(s3).verify("g1")).toMatchObject({ ok: true });
    });

    test("policy: cutting needs graph:commit, activation needs graph:activate; a client cannot forge meta.revision", async () => {
        const { store, revisions, doc, crdt } = await setup();
        const rev = (await revisions.cut("g1", owner, "v1")).revision;
        expect(await revisions.activate("g1", rev.revisionId, agent)).toMatchObject({ code: "ADMISSION_DENIED" });
        expect(await revisions.cut("g1", undefined, "x")).toMatchObject({ code: "ADMISSION_DENIED" });
        expect((await revisions.cut("g1", agent, "by agent")).created).toBe(false);   // allowed, nothing changed
        const doc2 = new Y.Doc(); applyUpdate(doc2, (await store.loadMerged("g1")).update);
        let out; const h = (x) => (out = x); doc2.on("updateV2", h);
        doc2.transact(() => doc2.getMap("graph").get("meta").set("revision", { id: "forged", seq: 99 }), { source: "raw" }); doc2.off("updateV2", h);
        const r = await crdt.admission.admit({ graphId: "g1", mutationId: "01J8ZK5K0B1C2D3E4F5G6H7J8B", content: out, description: "forge", principal: owner });
        expect(r).toMatchObject({ decision: "rejected", code: "ADMISSION_DENIED" }); expect(r.reason).toMatch(/meta namespace/);
        expect(r.diffSummary.ops).toEqual([{ op: "set-meta", namespace: "meta", keys: ["revision"] }]);
    });

    test("HTTP: list, cut, get (stored and materialized), activate, restore", async () => {
        const { revisions } = await setup();
        const call = (fn, extra) => new Promise((res) => fn.call(revisions, { pathParameters: { id: "g1" }, requestContext: {}, principal: owner, ...extra }, {}, (e, r) => res({ status: r.statusCode, body: r.body ? JSON.parse(r.body) : null })));
        const cut = await call(revisions.cutRoute, { body: JSON.stringify({ label: "over http" }) });
        expect(cut.status).toBe(201); expect(cut.body.revision.label).toBe("over http");
        const id = cut.body.revision.revisionId;
        expect((await call(revisions.cutRoute, { body: "{}" })).status).toBe(200);
        const list = await call(revisions.listRoute, {});
        expect(list.status).toBe(200); expect(list.body.head.seq).toBe(1); expect(list.body.active).toBeNull(); expect(list.body.revisions.length).toBe(1);
        const got = await call(revisions.getRoute, { pathParameters: { id: "g1", revisionId: id } });
        expect(got.status).toBe(200); expect(got.body.projection.nodes.length).toBe(2); expect(got.body.materialized).toBe(false);
        const built = await call(revisions.getRoute, { pathParameters: { id: "g1", revisionId: id }, queryStringParameters: { materialize: "1" } });
        expect(built.body.verified).toBe(true);
        expect((await call(revisions.getRoute, { pathParameters: { id: "g1", revisionId: "01J8ZK5K0B1C2D3E4F5G6H7J8C" } })).status).toBe(404);
        expect((await call(revisions.activateRoute, { pathParameters: { id: "g1", revisionId: id } })).status).toBe(200);
        expect((await call(revisions.activateRoute, { pathParameters: { id: "g1", revisionId: id }, principal: agent })).status).toBe(403);
        const restored = await call(revisions.restoreRoute, { pathParameters: { id: "g1", revisionId: id } });
        expect(restored.status).toBe(200); expect(restored.body.ok).toBe(true);
        expect((await call(revisions.listRoute, {})).body.active.revisionId).toBe(id);
    });
});
