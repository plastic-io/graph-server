/**
 * Bringing graphs written before this server into it (plan §9.5, PB-122).
 * The migration fills in what can be derived, leaves alone what would be a
 * guess, says which is which, and can be run again without doing anything
 * twice.
 */
const { MigrationService, MIGRATION } = require("../migrations/backfill");
const CrdtStore = require("../crdtStore").default;
const CrdtService = require("../crdtService").default;
const TocStore = require("../tocStore").default;
const { RevisionService } = require("../revisions/service");
const { ComponentService } = require("../components/service");
const { fromJSON, encodeState } = require("@plastic-io/graph-crdt");
const { listGraph } = require("../tocService");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
const agent = { sub: "agent|a1", kind: "agent", tenant: "personal:auth0|u1", scopes: ["graph:read"] };
const port = (name) => ({ name, type: "Object", external: false, visible: true });
const node = (id, over = {}) => ({
    id, url: id, edges: [{ field: "out", connectors: [] }], version: 0, graphId: "old-graph", artifact: null, data: null,
    properties: { inputs: [port("in")], outputs: [port("out")], groups: [], name: id, description: "", tags: [], icon: "", x: 0, y: 0, z: 0, createdOn: 1, presentation: { x: 0, y: 0, z: 0 }, ...(over.properties || {}) },
    template: { set: "edges.out = value;", vue: "<template><div></div></template>" },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "properties")),
});
const oldGraph = (id = "old-graph", nodes) => ({
    id, url: id, version: 3, properties: { name: "An old graph", description: "written before any of this", createdBy: "auth0|u1", createdOn: 1, lastUpdate: 2, height: 1, width: 1 },
    nodes: nodes || [
        node("plain"),
        node("imported", { artifact: "https://api.example.com/dev/artifacts/some-component/7" }),
        node("secretive", { properties: { capabilities: ["secret:openai"] } }),
        node("odd", { artifact: "something that is not an artifact path" }),
    ],
});

async function setup() {
    const s3 = new FakeS3Service();
    const store = new CrdtStore(s3);
    const broadcast = { channel: [], postToClient: (d, c, p, cb) => cb(), _sendToChannel: (ch, v, cb) => cb(), broadcast: (ch, v, cb) => cb() };
    const crdt = new CrdtService(store, broadcast);
    const tocStore = new TocStore(s3);
    const revisions = new RevisionService(store, crdt.admission, { fanOut: (g, u) => crdt.fanOutUpdate(g, u) });
    const components = new ComponentService(store, revisions, crdt.admission, { tocStore, broadcastService: broadcast });
    const migrations = new MigrationService(s3, store, tocStore, { revisions, components, admission: crdt.admission });
    return { s3, store, tocStore, revisions, migrations, crdt, broadcast };
}
/** A graph as it exists today for a 2.0 server: a stored projection and a table of contents entry, with no document. */
async function seedLegacy({ s3, store, tocStore, broadcast }, graph) {
    await new Promise((resolve) => s3.set(`graphs/projections/latest/${graph.id}.json`, graph, {}, resolve));
    await listGraph(tocStore, broadcast, graph, "auth0|u1");
}

describe("the migration", () => {
    test("gives a graph that has no document one, so it can be versioned and read at all", async () => {
        const ctx = await setup();
        await seedLegacy(ctx, oldGraph());
        expect(await ctx.store.projectGraph("old-graph").catch(() => null)).toBeFalsy();
        const r = await ctx.migrations.graph("old-graph", owner);
        expect(r.did).toEqual(expect.arrayContaining([expect.stringContaining("seeded a document")]));
        const projected = await ctx.store.projectGraph("old-graph");
        // the document orders nodes deterministically (createdOn, then id), so every peer sees the same order
        expect(projected.nodes.map((n) => n.id)).toEqual(["imported", "odd", "plain", "secretive"]);
        expect(projected.properties.name).toBe("An old graph");
    });

    test("pins what was imported, places what must be placed, and leaves the rest alone", async () => {
        const ctx = await setup();
        await seedLegacy(ctx, oldGraph());
        const r = await ctx.migrations.graph("old-graph", owner);
        expect(r.did).toEqual(expect.arrayContaining([
            expect.stringContaining("pinned 1 imported node"),
            expect.stringContaining("recorded where 1 node(s) must run"),
        ]));
        expect(r.left).toEqual(expect.arrayContaining([
            expect.stringContaining("1 node(s) name an artifact in a shape this cannot read"),
            "activation is left to a person",
        ]));
        const projected = await ctx.store.projectGraph("old-graph");
        const byId = Object.fromEntries(projected.nodes.map((n) => [n.id, n]));
        expect(byId.imported.properties.component).toMatchObject({ publishedId: "some-component", version: 7 });
        expect(byId.secretive.properties.placement).toBe("server");
        // a node that says nothing about where it runs keeps running wherever it is invoked
        expect(byId.plain.properties.placement).toBeUndefined();
        expect(byId.odd.properties.component).toBeUndefined();
        expect(r.schemaVersion).toBe(2);
    });

    test("cuts a first version, and leaves execution following live edits", async () => {
        const ctx = await setup();
        await seedLegacy(ctx, oldGraph());
        const r = await ctx.migrations.graph("old-graph", owner);
        expect(r.did).toEqual(expect.arrayContaining([expect.stringContaining("cut the first version")]));
        expect(r.seq).toBe(1);
        const revisions = await ctx.revisions.list("old-graph");
        expect(revisions).toHaveLength(1);
        expect(await ctx.revisions.active("old-graph")).toBeNull();
        expect(r.left).toContain("activation is left to a person");
    });

    test("running it again does nothing, and a forced run says the same thing", async () => {
        const ctx = await setup();
        await seedLegacy(ctx, oldGraph());
        const first = await ctx.migrations.graph("old-graph", owner);
        const again = await ctx.migrations.graph("old-graph", owner);
        expect(again).toEqual(first);
        const forced = await ctx.migrations.graph("old-graph", owner, { force: true });
        expect(forced.did).toEqual([]);                                   // there is nothing left to do
        expect(forced.left).toEqual(expect.arrayContaining([expect.stringContaining("it already has 1 version(s)")]));
        expect((await ctx.revisions.list("old-graph"))).toHaveLength(1);  // and no second version appeared
    });

    test("a dry run says what it would do and changes nothing", async () => {
        const ctx = await setup();
        await seedLegacy(ctx, oldGraph());
        const r = await ctx.migrations.graph("old-graph", owner, { dryRun: true });
        expect(r.did).toEqual(expect.arrayContaining([expect.stringContaining("seeded a document")]));
        expect(await ctx.store.projectGraph("old-graph").catch(() => null)).toBeFalsy();
        expect(await ctx.revisions.list("old-graph")).toEqual([]);
        expect(ctx.s3.objects.has(MigrationService.key("old-graph"))).toBe(false);
    });

    test("it works through the whole table of contents, resuming where it stopped", async () => {
        const ctx = await setup();
        for (const id of ["one", "two", "three"]) {
            await seedLegacy(ctx, oldGraph(id, [node("plain")]));
        }
        const first = await ctx.migrations.run(owner, { limit: 2 });
        expect(first).toMatchObject({ migration: MIGRATION, graphs: 3, migrated: 2, alreadyDone: 0, remaining: 1 });
        const second = await ctx.migrations.run(owner, { limit: 10 });
        expect(second).toMatchObject({ graphs: 3, migrated: 1, alreadyDone: 2, remaining: 0 });
        const third = await ctx.migrations.run(owner, { limit: 10 });
        expect(third).toMatchObject({ migrated: 0, alreadyDone: 3, remaining: 0 });
        expect(await ctx.migrations.status(owner)).toMatchObject({ graphs: 3, done: 3, remaining: 0 });
    });

    test("it finds graphs the table of contents never knew: the ones only the 2.0 endpoint file records", async () => {
        const ctx = await setup();
        const old2 = oldGraph("only-an-endpoint", [node("plain")]);
        old2.url = "OnlyAnEndpoint";
        await new Promise((resolve) => ctx.s3.set(`graphs/projections/endpoints/${old2.url}.json`, old2, {}, resolve));
        // it is in no table of contents and has no latest projection; it is only what the 2.0 server executed
        expect(Object.keys(await ctx.tocStore.project())).toEqual([]);
        const r = await ctx.migrations.run(owner, { limit: 10 });
        expect(r.migrated).toBe(1);
        expect(r.results[0]).toMatchObject({ graphId: "only-an-endpoint", did: expect.arrayContaining([expect.stringContaining("seeded a document")]) });
        const projected = await ctx.store.projectGraph("only-an-endpoint");
        expect(projected.nodes.map((n) => n.id)).toEqual(["plain"]);
        expect(await ctx.revisions.list("only-an-endpoint")).toHaveLength(1);
    });

    test("a graph with nothing to seed from is left alone and said so", async () => {
        const ctx = await setup();
        await ctx.tocStore.write ? null : null;
        const { listGraph: list } = require("../tocService");
        await list(ctx.tocStore, ctx.broadcast, { id: "ghost", url: "ghost", version: 0, nodes: [], properties: { name: "Ghost" } }, "auth0|u1");
        const r = await ctx.migrations.graph("ghost", owner);
        expect(r.left).toEqual(expect.arrayContaining([expect.stringContaining("no document and no stored projection")]));
        expect(r.did).toEqual([]);
    });

    test("only someone who could commit the change may run it", async () => {
        const ctx = await setup();
        await seedLegacy(ctx, oldGraph());
        expect(await ctx.migrations.graph("old-graph", agent)).toMatchObject({ code: "ADMISSION_DENIED" });
        expect(await ctx.migrations.run(agent, {})).toMatchObject({ code: "ADMISSION_DENIED" });
        expect(await ctx.migrations.status(agent)).toMatchObject({ graphs: expect.any(Number) });
    });
});
