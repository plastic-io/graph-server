import TocStore from "../tocStore";
import FakeS3Service from "../__testHelpers__/fakeS3";

/**
 * What one save costs as the number of graphs grows.
 *
 * The previous design listed every object under the projections and read the
 * metadata of each one on every save, then rewrote the whole list. This
 * measures the replacement so a regression back towards that shape is visible.
 */
describe("the graph list at size", () => {
    const rows = [];

    afterAll(() => {
        // eslint-disable-next-line no-console
        console.table(rows);
    });

    [100, 1000, 10000].forEach((size) => {
        it(`saves one graph out of ${size} without reading the rest`, async () => {
            const s3 = new FakeS3Service();
            const toc = new TocStore(s3);
            await toc.putMany(Array.from({ length: size }, (_, i) => ({
                key: `graph-${i}`,
                entry: {
                    id: `graph-${i}`,
                    name: `Graph number ${i}`,
                    description: "A graph that does something useful",
                    icon: "mdi-graph",
                    type: "graph",
                    url: `graph-${i}`,
                    version: "12",
                },
            })));

            const storedBefore = [...s3.objects.values()].reduce((n, b) => n + b.length, 0);
            s3.calls = { list: 0, head: 0 };
            const started = Date.now();
            await toc.put("graph-7", { id: "graph-7", name: "Renamed", type: "graph" });
            const writeMs = Date.now() - started;
            const written = [...s3.objects.keys()]
                .filter((k) => k.indexOf("index/toc/crdt/v2/updates/") === 0)
                .sort()
                .slice(-1)
                .map((k) => s3.objects.get(k).length)[0];

            const readStarted = Date.now();
            const listed = await toc.project();
            const readMs = Date.now() - readStarted;

            rows.push({
                graphs: size,
                headRequestsPerSave: s3.calls.head,
                bytesWrittenPerSave: written,
                listSizeKb: Math.round(storedBefore / 1024),
                saveMs: writeMs,
                readMs,
            });

            expect(Object.keys(listed)).toHaveLength(size);
            expect(listed["graph-7"].name).toBe("Renamed");
            // The measurement that matters: a save never reads the other
            // graphs, at any size.
            expect(s3.calls.head).toBe(0);
            // And it writes a small, roughly constant amount.
            expect(written).toBeLessThan(2000);
        });
    });
});
