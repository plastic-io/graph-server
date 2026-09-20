import S3Service from "./s3Service";

/**
 * Building the list of graphs.
 *
 * This lives on its own because two things need it: the pre-CRDT write path,
 * and the checkpoint that refreshes a collaborative graph's projection. When
 * only the first of them rebuilt the list, a graph created in the editor had a
 * document and a projection but never appeared on anyone's list.
 */

/** Delay before rebuilding, so a burst of writes produces one rebuild. */
const tocUpdateTimeout = 250;

export const tocKey = "graphs/projections/toc.json";

/** Graphs that have been deleted but not destroyed. */
export const deletedIndexKey = "graphs/projections/deleted.json";

/** Files that sit beside the projections but are not graphs. */
const notGraphs = [tocKey, deletedIndexKey];

export function getDeletedIndex(store: S3Service, callback: (err: any, index: any) => void) {
    store.get(deletedIndexKey, (err, index) => {
        if (err && /NoSuchKey/.test(String(err))) {
            return callback(null, {});
        }
        if (err) {
            return callback(err, null);
        }
        callback(null, index || {});
    });
}

export function setDeletedIndex(store: S3Service, index: any, callback: (err: any, response: any) => void) {
    store.set(deletedIndexKey, index, {}, callback);
}

/**
 * Rebuild the list of graphs and tell anyone watching.
 *
 * Deleted graphs keep their projection and their endpoint, so both are left
 * out here rather than removed from storage.
 */
export function updateToc(
    store: S3Service,
    broadcastService: any,
    callback: (err: any, response: any) => void,
) {
    const update = () => {
        store.list("graphs/projections/", (err, graphs) => {
            if (err) {
                console.error("Cannot read graphs/projections/ to write the graph list.", err);
                return callback(err, null);
            }
            const toc = {};
            Promise.all((graphs || []).filter((item) => {
                return notGraphs.indexOf(item.Key) === -1;
            }).map((item): Promise<void> => {
                return new Promise((success, failure) => {
                    store.head(item.Key, (headErr, data) => {
                        if (headErr) {
                            return failure(new Error(String(headErr)));
                        }
                        Object.keys(data.Metadata).forEach((metaKey) => {
                            item[metaKey.replace("x-amz-meta-", "")] = data.Metadata[metaKey];
                        });
                        if (/^graphs\/projections\/endpoints\//.test(item.Key)) {
                            item.type = "endpoint";
                        }
                        if (!item.id) {
                            // Not a graph: it carries none of the metadata a
                            // projection is written with.
                            return success();
                        }
                        const tocId = item.type === "endpoint" ? ("endpoint/" + item.id) : item.id;
                        const key = tocId + (/published/.test(item.type) ? ("." + item.version) : "");
                        toc[key] = item;
                        success();
                    });
                });
            })).then(() => {
                return new Promise<void>((done) => {
                    getDeletedIndex(store, (indexErr, deleted) => {
                        if (indexErr) {
                            console.error("Cannot read the deleted index; listing everything.", indexErr);
                            return done();
                        }
                        Object.keys(toc).forEach((key) => {
                            if (toc[key] && deleted[toc[key].id]) {
                                delete toc[key];
                            }
                        });
                        done();
                    });
                });
            }).then(() => {
                store.set(tocKey, toc, {}, (setErr) => {
                    if (setErr) {
                        console.error("Cannot write the graph list.", setErr);
                        return callback(setErr, null);
                    }
                    callback(null, null);
                    if (!broadcastService) {
                        return;
                    }
                    broadcastService.broadcast(tocKey, {
                        channelId: tocKey,
                        response: { type: "toc", toc },
                    }, (broadcastErr) => {
                        if (broadcastErr) {
                            console.error("Cannot announce the graph list.", broadcastErr);
                        }
                    });
                });
            }).catch((thrown) => {
                console.error("Cannot build the graph list.", thrown);
                callback(thrown, null);
            });
        });
    };
    setTimeout(update, tocUpdateTimeout);
}
