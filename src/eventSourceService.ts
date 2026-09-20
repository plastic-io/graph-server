import {Context, S3CreateEvent, APIGatewayEvent} from "aws-lambda";
import {diff, applyChange} from "deep-diff";
import {CRC32} from "jshashes";
import S3Service from "./s3Service";
import BroadcastService from "./broadcastService";
import CrdtService from "./crdtService";
import CrdtStore from "./crdtStore";
import {
    updateToc as buildToc,
    getDeletedIndex as readDeletedIndex,
    setDeletedIndex as writeDeletedIndex,
    deletedIndexKey,
} from "./tocService";

export interface EventSourceEvent {
    id: string;
    graphId: string;
    crc: number;
    version: number;
    changes: any[];
};
/** Creates a new v4 UUID */
export function newId() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        var r = Math.random() * 16 | 0, v = c == "x" ? r : (r & 0x3 | 0x8); // eslint-disable-line 
        return v.toString(16);
    });
}
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Credentials": true,
};
export default class EventSourceService {
    store: S3Service;
    broadcastService: BroadcastService;
    crdtService: CrdtService;
    crdtStore: CrdtStore;
    okResponse: {statusCode: number};
    constructor() {
        this.broadcastService = new BroadcastService();
        this.crdtService = new CrdtService();
        this.crdtStore = new CrdtStore();
        this.okResponse = {
            statusCode: 200
        };
        this.store = new S3Service(process.env.S3_BUCKET);
    }
    getEvents(event: any, context: any, callback: (err: any, response: any) => void) {
        this.store.list(`graphs/${event.pathParameters.id}/events/`, (err, events) => {
            if (err) {
                return callback(err, null);
            }
            callback(null, {
                statusCode: 200,
                body: JSON.stringify(events),
                headers: corsHeaders,
            });
        });
    }
    /** Graph ids that are hidden, keyed by id. */
    getDeletedIndex(callback: (err: any, index: any) => void) {
        readDeletedIndex(this.store, callback);
    }

    setDeletedIndex(index: any, callback: (err: any, response: any) => void) {
        writeDeletedIndex(this.store, index, callback);
    }

    /** Hide a graph, keeping everything it is made of. */
    softDeleteGraph(id: string, userId: string, callback: (err: any, response: any) => void) {
        this.getDeletedIndex((err, index) => {
            if (err) {
                return callback(err, null);
            }
            index[id] = { id, deletedOn: Date.now(), deletedBy: userId || "Unknown" };
            this.setDeletedIndex(index, (setErr) => {
                if (setErr) {
                    return callback(setErr, null);
                }
                this.updateToc(callback);
            });
        });
    }

    /** Put a hidden graph back. */
    restoreGraph(id: string, callback: (err: any, response: any) => void) {
        this.getDeletedIndex((err, index) => {
            if (err) {
                return callback(err, null);
            }
            if (!index[id]) {
                return callback(null, null);
            }
            delete index[id];
            this.setDeletedIndex(index, (setErr) => {
                if (setErr) {
                    return callback(setErr, null);
                }
                this.updateToc(callback);
            });
        });
    }

    /** Rebuild the list of graphs.  See tocService. */
    updateToc(callback: (err: any, response: any) => void) {
        buildToc(this.store, this.broadcastService, callback);
    }

    getToc(event: any, context: any, callback: (err: any, response: any) => void) {
        this.store.get(`graphs/projections/toc.json`, (err, toc) => {
            if (err && /NoSuchKey/.test(err.toString())) {
                toc = {};
                console.log("No TOC found.  Using empty object.");
            } else if (err) {
                return callback(err, null);
            }
            callback(null, {
                statusCode: 200,
                body: JSON.stringify(toc),
                headers: corsHeaders,
            });
        });
    }
    /**
     * DEPRECATED.  The pre-CRDT write path: read the projection, apply a diff,
     * write it back.  Two edits arriving together lose one of them, which is
     * why graphs now sync through `crdtService` instead.
     *
     * It is kept only so that an editor bundle still cached on a CDN keeps
     * working until it is replaced.  Nothing in the current editor calls it,
     * and it can be deleted once no old clients remain.
     */
    add(event: {graphId: string, crc: number, changes: any[], id: string, graph: any, time?: number, userId: string},
        callback: (err: any, response: any) => void) {
        const graphId = event.graphId;
        this.store.get(`graphs/projections/latest/${graphId}.json`, (err, graph) => {
            if (err && /NoSuchKey/.test(err.toString())) {
                graph = {};
                console.log("No graph found.  Using empty object.");
            } else if (err) {
                return callback(err, null);
            }
            const nodeChangeIds = [];
            event.time = Date.now();
            event.changes.forEach((change) => {
                applyChange(graph, true, change);
                if (change
                    && change.path
                    && change.path[0] === 'nodes'
                    && change.path[1]
                    && graph.nodes
                    && graph.nodes.length > 0) {
                    nodeChangeIds.push(graph.nodes[change.path[1]].id);
                }
            });
            
            const serializedState = JSON.stringify(graph);
            const crc = CRC32(serializedState);
            const ver = Number(graph.version) + 1;
            graph.properties.lastUpdate = Date.now();
            graph.properties.lastUpdatedBy = event.userId;
            graph.version = ver;
            graph.nodes.forEach((v: any) => {
                if (nodeChangeIds.indexOf(v.id) === -1) { return; }
                v.version = ver;
                v.properties.lastUpdate = Date.now();
                v.properties.lastUpdatedBy = event.userId;
                v.edges.forEach((edge: any) => {
                    edge.connectors.forEach((connector: any) => {
                        connector.version = ver;
                    });
                });
            });
            const versionChanges = diff(JSON.parse(serializedState), graph);
            const versionCrc = CRC32(JSON.stringify(graph));
            const graphMeta = {
                "id": graph.id,
                "name": graph.properties.name || "Unnamed",
                "version": String(graph.version),
                "description": graph.properties.description || "No description",
                "icon": graph.properties.icon || "mdi-graph",
                "type": "graph",
                "url": graph.url || graph.id,
                "user-id": event.userId || "Unknown",
            };
            Promise.all([
                new Promise((success, failure) => {
                    // store latest projection
                    this.store.set(`graphs/projections/latest/${graphId}.json`, graph, graphMeta, (err) => {
                        if (err) {
                            console.error("Error storing latest version.", graphMeta);
                            return failure(err);
                        }
                        // TODO maybe don't do this every time, check the event.changes for triggers
                        this.updateToc(success);
                    });
                }),
                new Promise((success, failure) => {
                    const versionEvent = {
                        id: newId(),
                        graphId,
                        changes: versionChanges,
                        crc: versionCrc,
                        time: Date.now(),
                        userId: event.userId,
                    };
                    // store version event
                    this.store.set(`graphs/${graphId}/events/${versionEvent.id}.json`, versionEvent, {
                        ...graphMeta,
                        type: "event",
                    }, (err) => {
                        if (err) {
                            console.error("Error storing version event.", graphMeta);
                            return failure(err);
                        }
                        success(null);
                        // broadcast edit and version events
                        this.broadcastService.broadcast("graph-event-" + graphId, {
                            channelId: "graph-event-" + graphId,
                            response: [event, versionEvent],
                        }, (err) => {
                            if (err) {
                                return console.error("Error sending message to graph event subscribers.", graphMeta);
                            }
                        });
                    });
                }),
                new Promise((success, failure) => {
                    // store edit event
                    this.store.set(`graphs/${graphId}/events/${event.id}.json`, event, {
                        ...graphMeta,
                        type: "event",
                    }, (err) => {
                        if (err) {
                            console.error("Error storing edit event.", graphMeta);
                            return failure(err);
                        }
                        success(null);
                    });
                }),
                new Promise((success, failure) => {
                    // store versioned projection
                    this.store.set(`graphs/${graphId}/projections/${graphId}.${graph.version}.json`, graph, graphMeta, (err) => {
                        if (err) {
                            console.error("Error storing version projection.", graphMeta);
                            return failure(err);
                        }
                        success(null);
                    });
                }),
                new Promise((success, failure) => {
                    let urlChange = event.changes.find((change) => {
                        return change.path[0] === "url"
                            && change.path.length === 1
                            && change.kind === "E";
                    });
                    if (urlChange) {
                        this.store.remove(`graphs/projections/endpoints/${urlChange.lhs}.json`, (err) => {
                            if (err) {
                                console.error("Error removing previous named endpoint.", graphMeta);
                                return failure(err);
                            }
                            success(null);
                        });
                    } else {
                        success(null);
                    }
                }),
                // store endpoint graph
                new Promise((success, failure) => {
                    this.store.set(`graphs/projections/endpoints/${graph.url}.json`, graph, {
                        ...graphMeta,
                        type: "endpoint",
                    }, (err) => {
                        if (err) {
                            console.error("Error storing endpoint.", graphMeta);
                            return failure(err);
                        }
                        success(null);
                    });
                }),
            ]).then(() => {
                console.log("add event success");
                callback(null, this.okResponse);
            }).catch((err) => {
                console.log("add event failure", err);
                callback(err, null);
            });
        });
    }
    addEvent(_event: any, context: any, callback: (err: any, response: any) => void) {
        const body = JSON.parse(_event.body);
        const event = body.event;
        const ctx = _event.requestContext;
        event.time = Date.now();
        event.userId = ctx.identity.userArn || "Unknown userArn";
        this.add(event, (err) => {
            if (err) {
                return this.broadcastService.postToClient(ctx.domainName, ctx.connectionId, {
                    messageId: event.id,
                    error: true,
                    response: {
                        eventId: event.id,
                        err: err.toString(),
                    },
                }, (err) => {
                    if (err) {
                        console.error("Error sending graph to client");
                    }
                    return callback(err, null);
                });
            }
            if (ctx.connectionId) {
                this.broadcastService.postToClient(ctx.domainName, ctx.connectionId, {
                    messageId: body.messageId,
                    response: { success: true, event },
                }, (err) => {
                    if (err) {
                        console.error("Error sending graph to client");
                    }
                });
                callback(null, this.okResponse);
                return;
            }
            callback(null, {
                statusCode: 200,
                body: JSON.stringify({
                    messageId: body.messageId,
                    response: { success: true, event },
                }),
                headers: corsHeaders,
            });
        });
    }
    publishNodeWs(event: any, context: any, callback: (err: any, response: any) => void) {
        // Publishing reads a versioned projection file, and under the CRDT
        // pipeline those are only written at checkpoints, so force one first.
        this.crdtService.ensureProjection(JSON.parse(event.body).graphId)
            .catch((err) => console.error("Cannot refresh projection before publishing a node.", err))
            .then(() => this._publishNodeWs(event, context, callback));
    }
    _publishNodeWs(event: any, context: any, callback: (err: any, response: any) => void) {
        const ctx = event.requestContext;
        const body = JSON.parse(event.body);
        const graphId = body.graphId;
        const nodeId = body.nodeId;
        const version = body.version;
        this.store.get(`graphs/${graphId}/projections/${graphId}.${version}.json`, (err, graph) => {
            if (err) {
                console.error("Error getting graph to publish node", err);
                return callback(err, null);
            }
            const node = graph.nodes.find((v: any) => {
                return v.id === nodeId;
            });
            if (!node) {
                this.broadcastService.postToClient(ctx.domainName, ctx.connectionId, {
                    messageId: body.messageId,
                    error: true,
                    response: {
                        err: "Cannot find node",
                    },
                }, (err) => {
                    if (err) {
                        console.error("Error sending error to client");
                    }
                });
            }
            node.publishedOn = Date.now();
            node.userId = event.requestContext.identity.userArn || "Unknown userArn";
            const nodeMeta = {
                "graph-id": graph.id,
                "graph-url": graph.url,
                "id": "artifacts/" + node.id,
                "name": node.properties.name || "Unnamed",
                "version": String(node.version),
                "description": node.properties.description || "No description",
                "icon": node.properties.icon || "mdi-node-point",
                "type": "publishedNode",
                "url": node.url || node.id,
                "artifact-url": "artifacts/" + node.id + "/" + node.version,
                "user-id": node.userId || "Unknown",
            }
            this.store.set(`graphs/projections/published/artifacts/${node.id}.${node.version}.json`, node, nodeMeta, (err) => {
                if (err) {
                    console.error("Error writing published graph to store.");
                    return callback(err, null);
                }
                console.log(`Publish node success ${node.id}`);
                this.broadcastService.postToClient(ctx.domainName, ctx.connectionId, {
                    messageId: body.messageId,
                    error: false,
                    response: {
                        type: "node",
                        url: node.id,
                        publishedBy: node.publishedBy,
                        publishedOn: node.publishedOn,
                    },
                }, (err) => {
                    if (err) {
                        console.error("Error sending error to client");
                        callback(err, null);
                    }
                });
            });
            this.updateToc(() => {
                callback(null, this.okResponse);
            });
        });
    }
    publishGraphWs(event: any, context: any, callback: (err: any, response: any) => void) {
        this.crdtService.ensureProjection(JSON.parse(event.body).id)
            .catch((err) => console.error("Cannot refresh projection before publishing a graph.", err))
            .then(() => this._publishGraphWs(event, context, callback));
    }
    _publishGraphWs(event: any, context: any, callback: (err: any, response: any) => void) {
        const ctx = event.requestContext;
        const body = JSON.parse(event.body);
        const graphId = body.id;
        const version = body.version;
        this.store.get(`graphs/${graphId}/projections/${graphId}.${version}.json`, (err, graph) => {
            if (err) {
                console.error("Error getting graph to publish", err);
                return callback(err, null);
            }
            graph.publishedOn = Date.now();
            graph.publishedBy = event.requestContext.identity.userArn || "Unknown userArn";
            const sendResponse = (err) => {
                if (err) {
                    console.error("Error writing published graph to store.");
                    return callback(err, null);
                }
                console.log(`Publish graph success ${graph.url}`);
                this.broadcastService.postToClient(ctx.domainName, ctx.connectionId, {
                    messageId: body.messageId,
                    error: false,
                    response: {
                        type: "graph",
                        url: graph.url,
                        publishedBy: graph.publishedBy,
                        publishedOn: graph.publishedOn,
                    },
                }, (err) => {
                    if (err) {
                        console.error("Error sending error to client");
                    }
                });
            };
            const graphMeta = {
                "id": "artifacts/" + graph.id,
                "name": graph.properties.name || "Unnamed",
                "version": String(graph.version),
                "description": graph.properties.description || "No description",
                "icon": graph.properties.icon || "mdi-graph",
                "type": "publishedGraph",
                "url": graph.url || graph.id,
                "artifact-url": "artifacts/" + graph.id + "/" + graph.version,
                "user-id": event.requestContext.identity.userArn || "Unknown userArn",
            };
            this.store.set(`graphs/projections/published/artifacts/${graph.id}.${graph.version}.json`, graph, graphMeta, sendResponse);
            this.store.set(`graphs/projections/published/endpoints/${graph.url}.json`, graph, graphMeta, sendResponse);
            this.updateToc(() => {
                callback(null, this.okResponse);
            });
        });
    }
    getArtifact(event: any, context: any, callback: (err: any, response: any) => void) {
        this.store.get(`graphs/projections/published/artifacts/${event.pathParameters.id}.${event.pathParameters.version}.json`, (err, artifact) => {
            if (err) {
                if (/NoSuchKey/.test(err.toString())) {
                    return callback(err, {
                        statusCode: 404,
                        headers: corsHeaders,
                    });
                }
                return callback(err, {
                    statusCode: 500,
                    headers: corsHeaders,
                });
            }
            callback(null, {
                statusCode: 200,
                body: JSON.stringify(artifact),
                headers: corsHeaders,
            });
        });
    }
    getGraphWs(event: any, context: any, callback: (err: any, response: any) => void) {
        const ctx = event.requestContext;
        const body = JSON.parse(event.body);
        const wantsLatest = body.version === "latest" || !body.version;
        const path = wantsLatest
            ? `graphs/projections/latest/${body.id}.json`
            : `graphs/${body.id}/projections/${body.id}.${body.version}.json`;
        if (wantsLatest) {
            // A collaborative graph is projected straight from its document, so
            // a read never waits for the next checkpoint to catch up.
            this.crdtStore.projectGraph(body.id).then((graph) => {
                if (!graph) {
                    return this.getStoredGraphWs(event, path, callback);
                }
                this.broadcastService.postToClient(ctx.domainName, ctx.connectionId, {
                    messageId: body.messageId,
                    response: graph,
                }, (err) => {
                    if (err) {
                        console.error("Error sending graph to client");
                    }
                });
                callback(null, this.okResponse);
            }).catch(() => {
                this.getStoredGraphWs(event, path, callback);
            });
            return;
        }
        this.getStoredGraphWs(event, path, callback);
    }
    getStoredGraphWs(event: any, path: string, callback: (err: any, response: any) => void) {
        const ctx = event.requestContext;
        const body = JSON.parse(event.body);
        this.store.get(path, (err, graph) => {
            if (err) {
                console.error("Cannot find graph at path:", path);
                this.broadcastService.postToClient(ctx.domainName, ctx.connectionId, {
                    messageId: body.messageId,
                    error: true,
                    response: {
                        err: err.toString(),
                    },
                }, (err) => {
                    if (err) {
                        console.error("Error sending error to client");
                    }
                });
                return;
            }
            this.broadcastService.postToClient(ctx.domainName, ctx.connectionId, {
                messageId: body.messageId,
                response: graph,
            }, (err) => {
                if (err) {
                    console.error("Error sending graph to client");
                }
            });
        });
        callback(null, this.okResponse);
    }
    getGraph(event: any, context: any, callback: (err: any, response: any) => void) {
        const wantsLatest = event.pathParameters.version === "latest";
        const path = wantsLatest
            ? `graphs/projections/latest/${event.pathParameters.id}.json`
            : `graphs/${event.pathParameters.id}/projections/${event.pathParameters.id}.${event.pathParameters.version}.json`;
        console.log('getGraph: Getting path:', path);
        if (wantsLatest) {
            this.crdtStore.projectGraph(event.pathParameters.id).then((graph) => {
                if (!graph) {
                    return this.getStoredGraph(path, callback);
                }
                callback(null, {
                    statusCode: 200,
                    body: JSON.stringify(graph),
                    headers: corsHeaders,
                });
            }).catch(() => this.getStoredGraph(path, callback));
            return;
        }
        this.getStoredGraph(path, callback);
    }
    getStoredGraph(path: string, callback: (err: any, response: any) => void) {
        this.store.get(path, (err, graph) => {
            if (err) {
                console.log('getGraph: Error getting path:', err);
                return callback(err, null);
            }
            console.log('getGraph: Got graph', graph);
            callback(null, {
                statusCode: 200,
                body: JSON.stringify(graph),
                headers: corsHeaders,
            });
        });
    }
    _deleteGraph(id: string, callback: (err: any, response: any) => void) {
        this.crdtStore.removeAll(id).catch((err) => {
            console.error("Cannot remove the collaborative document.", id, err);
        });
        this.store.head(`graphs/projections/latest/${id}.json`, (err, data) => {
            if (err) {
                return console.error("Delete graph all failure: ", err);
            }
            // S3 returns user metadata with the x-amz-meta- prefix already
            // stripped.  Reading the prefixed name gave undefined, so the
            // endpoint file was left behind by every permanent delete.  Both
            // spellings are accepted so the behaviour does not depend on which
            // client wrote the object.
            const url = data.Metadata.url || data.Metadata["x-amz-meta-url"];
            Promise.all([
                new Promise((success, failure) => {
                    this.store.removePath(`graphs/${id}/projections`, (err) => {
                        if (err) {
                            return failure(err);
                        }
                        success(null);
                    });
                }),
                new Promise((success, failure) => {
                    this.store.removePath(`graphs/${id}/events`, (err) => {
                        if (err) {
                            return failure(err);
                        }
                        success(null);
                    });
                }),
                new Promise((success, failure) => {
                    this.store.remove(`graphs/projections/endpoints/${id}.json`, (err) => {
                        if (err) {
                            return failure(err);
                        }
                        success(null);
                    });
                }),
                new Promise((success, failure) => {
                    this.store.remove(`graphs/projections/endpoints/${url}.json`, (err) => {
                        if (err) {
                            return failure(err);
                        }
                        success(null);
                    });
                }),
                new Promise((success, failure) => {
                    this.store.remove(`graphs/projections/latest/${id}.json`, (err) => {
                        if (err) {
                            return failure(err);
                        }
                        success(null);
                    });
                }),
            ]).then(() => {
                // Nothing is left to hide, so the marker goes too.
                this.getDeletedIndex((indexErr, index) => {
                    if (indexErr || !index[id]) {
                        return this.updateToc(callback);
                    }
                    delete index[id];
                    this.setDeletedIndex(index, () => this.updateToc(callback));
                });
            }).catch((err) => {
                console.error("Delete graph all failure: ", err);
                callback(err, null);
            });
        });
    }
    /**
     * Delete a graph.
     *
     * Deleting hides the graph and keeps everything it is made of, so an
     * accidental delete costs nothing. `?permanent=true` destroys it instead,
     * which is a debugging tool: it removes the events, the projections, the
     * endpoint and the collaborative document, and none of that comes back.
     */
    deleteGraph(event: any, context: any, callback: (err: any, response: any) => void) {
        const id = (event.pathParameters || {}).id;
        if (!id) {
            return callback(null, {
                statusCode: 400,
                body: JSON.stringify({ error: "No graph id was given." }),
                headers: corsHeaders,
            });
        }
        const query = event.queryStringParameters || {};
        const permanent = String(query.permanent) === "true";
        const userId = ((event.requestContext || {}).identity || {}).userArn;
        const done = (err: any) => {
            if (err) {
                console.error("Cannot delete graph.", id, err);
                return callback(null, { statusCode: 500, headers: corsHeaders });
            }
            callback(null, {
                statusCode: 200,
                body: JSON.stringify({ id, permanent }),
                headers: corsHeaders,
            });
        };
        if (permanent) {
            return this._deleteGraph(id, done);
        }
        this.softDeleteGraph(id, userId, done);
    }

    /** Put a hidden graph back in the list. */
    undeleteGraph(event: any, context: any, callback: (err: any, response: any) => void) {
        const id = (event.pathParameters || {}).id;
        if (!id) {
            return callback(null, {
                statusCode: 400,
                body: JSON.stringify({ error: "No graph id was given." }),
                headers: corsHeaders,
            });
        }
        this.restoreGraph(id, (err) => {
            if (err) {
                console.error("Cannot restore graph.", id, err);
                return callback(null, { statusCode: 500, headers: corsHeaders });
            }
            callback(null, {
                statusCode: 200,
                body: JSON.stringify({ id, restored: true }),
                headers: corsHeaders,
            });
        });
    }

    /** Everything currently hidden. */
    listDeletedGraphs(event: any, context: any, callback: (err: any, response: any) => void) {
        this.getDeletedIndex((err, index) => {
            if (err) {
                return callback(null, { statusCode: 500, headers: corsHeaders });
            }
            callback(null, {
                statusCode: 200,
                body: JSON.stringify(Object.keys(index).map((key) => index[key])),
                headers: corsHeaders,
            });
        });
    }
    deleteGraphWs(event: any, context: any, callback: (err: any, response: any) => void) {
        const body = JSON.parse(event.body);
        const done = (err: any) => {
            if (err) {
                console.error("Cannot delete graph.", body.id, err);
            }
            callback(null, this.okResponse);
        };
        if (body.permanent === true) {
            return this._deleteGraph(body.id, done);
        }
        const userId = ((event.requestContext || {}).identity || {}).userArn;
        this.softDeleteGraph(body.id, userId, done);
    }

    undeleteGraphWs(event: any, context: any, callback: (err: any, response: any) => void) {
        const body = JSON.parse(event.body);
        this.restoreGraph(body.id, (err) => {
            if (err) {
                console.error("Cannot restore graph.", body.id, err);
            }
            callback(null, this.okResponse);
        });
    }
}
