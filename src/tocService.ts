import S3Service from "./s3Service";
import TocStore, { TocEntry } from "./tocStore";

/**
 * Keeping the list of graphs up to date.
 *
 * Every write here touches one entry. Nothing walks the whole store, which is
 * what the previous version did on every single save.
 */

export const tocKey = "graphs/projections/toc.json";

/** Announce the list to anyone watching it. */
function announce(store: TocStore, broadcastService: any) {
    if (!broadcastService) {
        return;
    }
    store.project().then((toc) => {
        broadcastService.broadcast(tocKey, {
            channelId: tocKey,
            response: { type: "toc", toc },
        }, (err) => {
            if (err) {
                console.error("Cannot announce the graph list.", err);
            }
        });
    }).catch((err) => {
        console.error("Cannot read the graph list to announce it.", err);
    });
}

/** The entry a graph's projection should have. */
export function entryForGraph(graph: any, type = "graph"): { key: string; entry: TocEntry } {
    const id = graph.id;
    const key = type === "endpoint" ? `endpoint/${id}` : id;
    return {
        key,
        entry: {
            id,
            name: (graph.properties && graph.properties.name) || "Unnamed",
            description: (graph.properties && graph.properties.description) || "No description",
            icon: (graph.properties && graph.properties.icon) || "mdi-graph",
            version: String(graph.version),
            url: graph.url || id,
            type,
            lastUpdate: (graph.properties && graph.properties.lastUpdate) || Date.now(),
        },
    };
}

/** List a graph, and the endpoint it answers on. */
export async function listGraph(
    store: TocStore,
    broadcastService: any,
    graph: any,
    userId = "Unknown",
): Promise<void> {
    if (!graph || !graph.id) {
        return;
    }
    await store.putMany([entryForGraph(graph, "graph"), entryForGraph(graph, "endpoint")], userId);
    announce(store, broadcastService);
}

/** List a published artifact. */
export async function listArtifact(
    store: TocStore,
    broadcastService: any,
    key: string,
    entry: TocEntry,
    userId = "Unknown",
): Promise<void> {
    await store.put(key, entry, userId);
    announce(store, broadcastService);
}

/** Hide a graph. */
export async function hideGraph(
    store: TocStore,
    broadcastService: any,
    graphId: string,
    userId = "Unknown",
): Promise<void> {
    await store.markDeleted(graphId, userId);
    announce(store, broadcastService);
}

/** Put a hidden graph back. */
export async function showGraph(
    store: TocStore,
    broadcastService: any,
    graphId: string,
    userId = "Unknown",
): Promise<void> {
    await store.markRestored(graphId, userId);
    announce(store, broadcastService);
}

/** Take a graph out of the list for good. */
export async function unlistGraph(
    store: TocStore,
    broadcastService: any,
    graphId: string,
    userId = "Unknown",
): Promise<void> {
    await store.remove(graphId, userId);
    announce(store, broadcastService);
}

/**
 * Make sure the list exists, building it once from what is already stored.
 * Safe to call on any path; it does nothing once the list is there.
 */
export async function ensureBuilt(store: TocStore): Promise<void> {
    try {
        const result = await store.migrate();
        if (result.migrated) {
            console.log(`Built the graph list from ${result.from}: ${result.entries} entries.`);
        }
    } catch (err) {
        console.error("Cannot build the graph list.", err);
    }
}

/** Kept for callers that still hold an S3Service rather than a TocStore. */
export function updateToc(
    store: S3Service,
    broadcastService: any,
    callback: (err: any, response: any) => void,
) {
    const tocStore = new TocStore(store);
    ensureBuilt(tocStore).then(() => {
        announce(tocStore, broadcastService);
        callback(null, null);
    }).catch((err) => callback(err, null));
}
