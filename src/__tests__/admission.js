const Y = require("yjs");
const { fromJSON, toJSON, reconcile, encodeState, writeUpdate, toBase64, mergeUpdates } = require("@plastic-io/graph-crdt");
const CrdtStore = require("../crdtStore").default;
const CrdtService = require("../crdtService").default;
const { AdmissionService } = require("../admission/admit");
const { parseEnvelope, isEnvelopeError } = require("../admission/envelope");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

const graphJson = () => ({ id: "g1", url: "g1", version: 0, nodes: [{ id: "n1", url: "n1", edges: [], version: 0, graphId: "g1", artifact: null, url: "n1", data: null, properties: { inputs: [], outputs: [], groups: [], name: "n1", description: "", tags: [], icon: "", x: 0, y: 0, z: 0, presentation: { x: 0, y: 0, z: 0 } }, template: { set: "", vue: "" } }], properties: { name: "g1", description: "", exportable: false, icon: "", createdBy: "", createdOn: 0, lastUpdate: 0, height: 1, width: 1 } });
const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
const ULID_A = "01J8ZK5K0B1C2D3E4F5G6H7J8A", ULID_B = "01J8ZK5K0B1C2D3E4F5G6H7J8B";

/** a V2 update produced the way the editor produces one: a snapshot edit through reconcile() */
function updateFor(doc, mutate) {
    const snapshot = toJSON(doc); mutate(snapshot);
    let out; const h = (u) => (out = u); doc.on("updateV2", h); reconcile(doc, snapshot, { source: "test" }); doc.off("updateV2", h);
    return out;
}
function fakeBroadcast() {
    const b = { direct: [], channel: [] };
    b.postToClient = (domain, conn, payload, cb) => { b.direct.push(payload); cb(); };
    b._sendToChannel = (ch, val, cb) => { b.channel.push([ch, val]); cb(); };
    b.broadcast = (ch, val, cb) => { b.channel.push([ch, val]); cb(); };
    return b;
}
async function seeded() {
    const s3 = new FakeS3Service(); const store = new CrdtStore(s3);
    const doc = fromJSON(graphJson());
    await store.appendUpdate("g1", encodeState(doc), "seed", "system");
    return { s3, store, doc };
}
const keysUnder = (s3, prefix) => [...s3.objects.keys()].filter((k) => k.startsWith(prefix));

describe("envelope parsing", () => {
    test("v2 envelope with a mutationId; legacy envelope gets one minted", () => {
        const p = parseEnvelope({ action: "yjs", kind: "sync", graphId: "g1", payload: toBase64(new Uint8Array([1, 2, 3])), description: "x", format: 2, schemaVersion: 2, mutationId: ULID_A, clientInfo: { name: "editor", version: "2.0.0" } });
        expect(isEnvelopeError(p)).toBe(false); expect(p.mutationId).toBe(ULID_A); expect(p.legacy).toBe(false); expect(p.clientInfo.name).toBe("editor");
        const l = parseEnvelope({ action: "yjs", kind: "sync", graphId: "g1", payload: toBase64(new Uint8Array([1])), format: 2 });
        expect(l.legacy).toBe(true); expect(l.mutationId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); expect(l.description).toBe("Change");
    });
    test("bad graphId, bad mutationId, wrong format, missing payload, oversize payload are all SCHEMA_INVALID", () => {
        expect(parseEnvelope({ graphId: "../x", payload: "AA==" }).code).toBe("SCHEMA_INVALID");
        expect(parseEnvelope({ graphId: "g1", payload: "AA==", mutationId: "nope" }).code).toBe("SCHEMA_INVALID");
        expect(parseEnvelope({ graphId: "g1", payload: "AA==", format: 1 }).code).toBe("SCHEMA_INVALID");
        expect(parseEnvelope({ graphId: "g1" }).code).toBe("SCHEMA_INVALID");
        expect(parseEnvelope({ graphId: "g1", payload: "A".repeat(2 * 1024 * 1024) }).reason).toMatch(/MAX_UPDATE_BYTES/);
    });
});

describe("admission (stage A)", () => {
    test("the poisoning frame from the discovery record is rejected before anything is stored", async () => {
        const { s3, store } = await seeded(); const admission = new AdmissionService(store);
        const before = keysUnder(s3, "graphs/g1/").length;
        const r = await admission.admit({ graphId: "g1", mutationId: ULID_A, content: new Uint8Array([2, 3, 1, 2, 3]), description: "garbage", principal: owner });
        expect(r).toMatchObject({ decision: "rejected", code: "SCHEMA_INVALID" });
        expect(keysUnder(s3, "graphs/g1/").length).toBe(before);              // no update object
        expect(keysUnder(s3, "audit/g1/").length).toBe(1);                      // the rejection is audited
        expect(keysUnder(s3, "mutations/g1/").length).toBe(0);                  // no record for a rejected mutation
        const { update } = await store.loadMerged("g1"); expect(toJSON(new (require("yjs").Doc)()) === null || update).toBeTruthy();  // graph still readable
    });
    test("a real update is stored, recorded and audited, and the same mutationId replays the same answer without a second object", async () => {
        const { s3, store, doc } = await seeded(); const admission = new AdmissionService(store);
        const content = updateFor(doc, (g) => { g.properties.name = "renamed"; });
        const r1 = await admission.admit({ graphId: "g1", mutationId: ULID_A, content, description: "Rename", principal: owner });
        expect(r1).toMatchObject({ decision: "accepted", policyVersion: "m1-owner" }); expect(r1.updateId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        const objects = keysUnder(s3, "graphs/g1/crdt/v2/updates/").length;
        const r2 = await admission.admit({ graphId: "g1", mutationId: ULID_A, content, description: "Rename", principal: owner });
        expect(r2.updateId).toBe(r1.updateId); expect(r2.replayed).toBe(true);
        expect(keysUnder(s3, "graphs/g1/crdt/v2/updates/").length).toBe(objects);
        expect(keysUnder(s3, "mutations/g1/").length).toBe(1);
        const projected = await store.projectGraph("g1"); expect(projected.properties.name).toBe("renamed");
        const audit = keysUnder(s3, "audit/g1/"); expect(audit.length).toBe(1);
        const record = JSON.parse(s3.objects.get(audit[0]).toString()); expect(record).toMatchObject({ kind: "mutation.accepted", principal: { sub: "auth0|u1" }, description: "Rename" }); expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
    });
    test("reusing a mutationId for different content is refused", async () => {
        const { store, doc } = await seeded(); const admission = new AdmissionService(store);
        await admission.admit({ graphId: "g1", mutationId: ULID_A, content: updateFor(doc, (g) => { g.properties.name = "a"; }), description: "a", principal: owner });
        const r = await admission.admit({ graphId: "g1", mutationId: ULID_A, content: updateFor(doc, (g) => { g.properties.name = "b"; }), description: "b", principal: owner });
        expect(r).toMatchObject({ decision: "rejected", code: "SCHEMA_INVALID" }); expect(r.reason).toMatch(/already used/);
    });
    test("policy: unauthenticated and non-owner principals are denied, nothing stored", async () => {
        const { s3, store, doc } = await seeded(); const admission = new AdmissionService(store);
        const content = updateFor(doc, (g) => { g.properties.name = "x"; });
        expect((await admission.admit({ graphId: "g1", mutationId: ULID_A, content, description: "x", principal: undefined })).code).toBe("ADMISSION_DENIED");
        process.env.OWNER_SUBS = "auth0|someone-else";
        const r = await admission.admit({ graphId: "g1", mutationId: ULID_B, content, description: "x", principal: owner });
        delete process.env.OWNER_SUBS;
        expect(r).toMatchObject({ decision: "rejected", code: "ADMISSION_DENIED" });
        expect(keysUnder(s3, "graphs/g1/crdt/v2/updates/").length).toBe(1);   // only the seed
    });
});

describe("admission over the transports", () => {
    function wsEvent(body, principal) { return { body: JSON.stringify(body), requestContext: { connectionId: "c1", domainName: "example.test" }, principal }; }
    test("WebSocket: an admitted update is fanned out and acknowledged to the sender; a rejected one is neither stored nor fanned out", async () => {
        const { s3, store, doc } = await seeded(); const broadcast = fakeBroadcast(); const service = new CrdtService(store, broadcast);
        const content = updateFor(doc, (g) => { g.properties.name = "ws"; });
        const good = { action: "yjs", kind: "sync", graphId: "g1", payload: toBase64(writeUpdate(content)), description: "ws edit", format: 2, schemaVersion: 2, mutationId: ULID_A };
        await new Promise((res) => service.sync(wsEvent(good, owner), {}, res));
        expect(broadcast.direct[0].response).toMatchObject({ kind: "ack", graphId: "g1", mutationId: ULID_A, decision: "accepted" });
        expect(broadcast.channel.filter(([ch, v]) => ch === "graph-crdt-g1" && v.kind === "sync").length).toBe(1);
        const bad = { ...good, mutationId: ULID_B, payload: toBase64(writeUpdate(new Uint8Array([2, 3, 1, 2, 3]))) };
        const objects = keysUnder(s3, "graphs/g1/crdt/v2/updates/").length;
        await new Promise((res) => service.sync(wsEvent(bad, owner), {}, res));
        expect(broadcast.direct[1].response).toMatchObject({ kind: "reject", mutationId: ULID_B, code: "SCHEMA_INVALID" });
        expect(broadcast.channel.filter(([ch, v]) => ch === "graph-crdt-g1" && v.kind === "sync").length).toBe(1);
        expect(keysUnder(s3, "graphs/g1/crdt/v2/updates/").length).toBe(objects);
    });
    test("HTTP: the admission result is the response; denied is 403, malformed is 400", async () => {
        const { store, doc } = await seeded(); const broadcast = fakeBroadcast(); const service = new CrdtService(store, broadcast);
        const content = updateFor(doc, (g) => { g.properties.name = "http"; });
        const call = (body, principal) => new Promise((res) => service.postUpdate({ body: JSON.stringify(body), pathParameters: { id: "g1" }, requestContext: {}, principal }, {}, (e, r) => res(r)));
        const ok = await call({ payload: toBase64(writeUpdate(content)), description: "http edit", format: 2, schemaVersion: 2, mutationId: ULID_A }, owner);
        expect(ok.statusCode).toBe(200); expect(JSON.parse(ok.body)).toMatchObject({ ok: true, decision: "accepted", mutationId: ULID_A });
        const denied = await call({ payload: toBase64(writeUpdate(content)), format: 2, mutationId: ULID_B }, undefined);
        expect(denied.statusCode).toBe(403); expect(JSON.parse(denied.body).code).toBe("ADMISSION_DENIED");
        const malformed = await call({ payload: toBase64(writeUpdate(new Uint8Array([2, 3, 1, 2, 3]))), format: 2 }, owner);
        expect(malformed.statusCode).toBe(400); expect(JSON.parse(malformed.body).code).toBe("SCHEMA_INVALID");
    });
});
