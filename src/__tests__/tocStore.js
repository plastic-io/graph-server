import TocStore, { legacyTocKey, legacyDeletedKey } from "../tocStore";
import FakeS3Service from "../__testHelpers__/fakeS3";

function graph(id, name, url) {
    return {
        id,
        version: 3,
        url: url || id,
        properties: { name, description: "a graph", icon: "mdi-graph", lastUpdate: 1700000000000 },
    };
}

/** Write a projection the way the graph writer does, for the scan path. */
function seedProjection(store, g) {
    const meta = {
        id: g.id, name: g.properties.name, version: String(g.version),
        description: g.properties.description, icon: g.properties.icon,
        type: "graph", url: g.url,
    };
    store.set(`graphs/projections/latest/${g.id}.json`, g, meta, () => undefined);
    store.set(`graphs/projections/endpoints/${g.url}.json`, g, { ...meta, type: "endpoint" }, () => undefined);
}

describe("the graph list as a document", () => {
    let s3;
    let toc;

    beforeEach(() => {
        s3 = new FakeS3Service();
        toc = new TocStore(s3);
    });

    it("starts empty", async () => {
        expect(await toc.isEmpty()).toBe(true);
        expect(await toc.project()).toEqual({});
    });

    it("keeps an entry and reads it back", async () => {
        await toc.put("g1", { id: "g1", name: "First", type: "graph" });
        const listed = await toc.project();
        expect(listed.g1.name).toBe("First");
        expect(await toc.isEmpty()).toBe(false);
    });

    it("stores only the difference when one entry changes", async () => {
        const many = Array.from({ length: 60 }, (_, i) => ({
            key: `g${i}`,
            entry: { id: `g${i}`, name: `Graph ${i}`, type: "graph", description: "x".repeat(200) },
        }));
        await toc.putMany(many);
        const sizeOfAll = [...s3.objects.values()].reduce((n, b) => n + b.length, 0);

        await toc.put("g7", { id: "g7", name: "Renamed", type: "graph" });
        const keys = [...s3.objects.keys()].filter((k) => k.indexOf("index/toc/crdt") === 0);
        const newest = keys.sort().pop();
        // Changing one name writes a fraction of what the list weighs, rather
        // than rewriting the whole thing as the previous file did.
        expect(s3.objects.get(newest).length).toBeLessThan(sizeOfAll / 4);
        expect((await toc.project()).g7.name).toBe("Renamed");
    });

    it("does not read other entries in order to write one", async () => {
        await toc.putMany(Array.from({ length: 30 }, (_, i) => ({
            key: `g${i}`, entry: { id: `g${i}`, name: `Graph ${i}`, type: "graph" },
        })));
        s3.calls = { list: 0, head: 0 };
        await toc.put("g3", { id: "g3", name: "Changed", type: "graph" });
        // The old design read the metadata of every object on every write.
        expect(s3.calls.head).toBe(0);
    });

    it("merges two writes that happened at the same time", async () => {
        await toc.put("g1", { id: "g1", name: "First", type: "graph" });

        // Two servers, each holding the list as it was, writing different
        // entries.  The previous file would have kept only one of them.
        const a = new TocStore(s3);
        const b = new TocStore(s3);
        await Promise.all([
            a.put("g2", { id: "g2", name: "From A", type: "graph" }),
            b.put("g3", { id: "g3", name: "From B", type: "graph" }),
        ]);

        const listed = await toc.project();
        expect(Object.keys(listed).sort()).toEqual(["g1", "g2", "g3"]);
        expect(listed.g2.name).toBe("From A");
        expect(listed.g3.name).toBe("From B");
    });

    it("hides and restores a graph, entries and all", async () => {
        await toc.putMany([
            { key: "g1", entry: { id: "g1", name: "First", type: "graph" } },
            { key: "endpoint/g1", entry: { id: "g1", name: "First", type: "endpoint" } },
            { key: "g2", entry: { id: "g2", name: "Second", type: "graph" } },
        ]);
        await toc.markDeleted("g1", "tester");
        expect(Object.keys(await toc.project())).toEqual(["g2"]);
        const hidden = await toc.listDeleted();
        expect(hidden).toHaveLength(1);
        expect(hidden[0].id).toBe("g1");
        expect(hidden[0].deletedBy).toBe("tester");

        await toc.markRestored("g1");
        expect(Object.keys(await toc.project()).sort()).toEqual(["endpoint/g1", "g1", "g2"]);
    });

    it("takes a graph out for good", async () => {
        await toc.putMany([
            { key: "g1", entry: { id: "g1", name: "First", type: "graph" } },
            { key: "endpoint/g1", entry: { id: "g1", name: "First", type: "endpoint" } },
        ]);
        await toc.remove("g1");
        expect(await toc.project()).toEqual({});
        expect(await toc.listDeleted()).toEqual([]);
    });

    it("writing a hidden graph again brings it back", async () => {
        await toc.put("g1", { id: "g1", name: "First", type: "graph" });
        await toc.markDeleted("g1");
        expect(await toc.project()).toEqual({});
        await toc.put("g1", { id: "g1", name: "First", type: "graph", version: "4" });
        expect(Object.keys(await toc.project())).toEqual(["g1"]);
    });

    it("sends only what a caller is missing", async () => {
        await toc.put("g1", { id: "g1", name: "First", type: "graph" });
        const whole = await toc.encodeFor();
        expect(whole.payload).toBeTruthy();

        await toc.put("g2", { id: "g2", name: "Second", type: "graph" });
        const difference = await toc.encodeFor(whole.stateVector);
        expect(difference.payload.length).toBeLessThan((await toc.encodeFor()).payload.length);
    });

    describe("migration", () => {
        it("builds itself from the list that was there before", async () => {
            s3.set(legacyTocKey, {
                "g1": { id: "g1", name: "First", type: "graph", url: "First" },
                "endpoint/g1": { id: "g1", name: "First", type: "endpoint", url: "First" },
                "g2": { id: "g2", name: "Second", type: "graph", url: "Second" },
            }, {}, () => undefined);

            const result = await toc.migrate();
            expect(result.migrated).toBe(true);
            expect(result.entries).toBe(3);
            expect(result.from).toBe("the previous list");
            expect(Object.keys(await toc.project()).sort()).toEqual(["endpoint/g1", "g1", "g2"]);
        });

        it("carries the graphs that were hidden across with it", async () => {
            s3.set(legacyTocKey, {
                "g1": { id: "g1", name: "First", type: "graph" },
                "g2": { id: "g2", name: "Second", type: "graph" },
            }, {}, () => undefined);
            s3.set(legacyDeletedKey, {
                "g2": { id: "g2", deletedOn: 123, deletedBy: "someone" },
            }, {}, () => undefined);

            await toc.migrate();
            expect(Object.keys(await toc.project())).toEqual(["g1"]);
            const hidden = await toc.listDeleted();
            expect(hidden).toHaveLength(1);
            expect(hidden[0].deletedBy).toBe("someone");
        });

        it("falls back to reading the projections when there is no list", async () => {
            seedProjection(s3, graph("g1", "First", "FirstUrl"));
            seedProjection(s3, graph("g2", "Second", "SecondUrl"));

            const result = await toc.migrate();
            expect(result.migrated).toBe(true);
            expect(result.from).toBe("a scan of the projections");
            const listed = await toc.project();
            expect(Object.keys(listed).sort()).toEqual(["endpoint/g1", "endpoint/g2", "g1", "g2"]);
            expect(listed.g1.name).toBe("First");
        });

        it("only builds itself once", async () => {
            s3.set(legacyTocKey, { "g1": { id: "g1", name: "First", type: "graph" } }, {}, () => undefined);
            expect((await toc.migrate()).migrated).toBe(true);
            const second = await toc.migrate();
            expect(second.migrated).toBe(false);
            expect(second.from).toBe("already built");
        });

        it("does not lose work done since it was built", async () => {
            s3.set(legacyTocKey, { "g1": { id: "g1", name: "First", type: "graph" } }, {}, () => undefined);
            await toc.migrate();
            await toc.put("g2", { id: "g2", name: "Added after", type: "graph" });
            // A second attempt must not wipe what has happened since.
            await toc.migrate();
            expect(Object.keys(await toc.project()).sort()).toEqual(["g1", "g2"]);
        });

        it("rebuilds over the top without losing entries that are only in the document", async () => {
            await toc.put("only-here", { id: "only-here", name: "Kept", type: "graph" });
            seedProjection(s3, graph("g1", "From the store", "G1"));
            const result = await toc.rebuild();
            expect(result.entries).toBe(2);
            const listed = await toc.project();
            expect(Object.keys(listed).sort()).toEqual(["endpoint/g1", "g1", "only-here"]);
        });
    });

    it("folds a long log into a snapshot", async () => {
        for (let i = 0; i < 55; i += 1) {
            await toc.put(`g${i}`, { id: `g${i}`, name: `Graph ${i}`, type: "graph" });
        }
        const snapshots = [...s3.objects.keys()].filter((k) => k.indexOf("index/toc/crdt/v2/snapshots/") === 0);
        expect(snapshots.length).toBeGreaterThan(0);
        expect(Object.keys(await toc.project())).toHaveLength(55);
    });
});
