import {Context, S3CreateEvent, APIGatewayEvent} from "aws-lambda";
import {diff, applyChange} from "deep-diff";
import {CRC32} from "jshashes";
import S3Service from "./s3Service";
import BroadcastService from "./broadcastService";
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
    okResponse: {statusCode: number};
    constructor() {
        this.broadcastService = new BroadcastService();
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
    // TODO something less expensive
    updateToc(callback: (err: any, response: any) => void) {
        this.store.list("graphs/projections/", (err, graphs) => {
            if (err) {
                console.error("Cannot read graphs/projections/ to write TOC.", err);
                return;
            }
            const suffixJsonReg = /\.json$/;
            const endpointMatch = /.*\/([^\/]+\d?)/;
            const normalMatch = /.*\/([^\/]+\d?).json/;
            const toc = {};
            Promise.all(graphs.filter((item) => {
                return item.Key !== "graphs/projections/toc.json";
            }).map((item) => {
                return new Promise((success, failure) => {
                    this.store.head(item.Key, (err, data) => {
                        if (err) {
                            return failure(new Error(err));
                        }
                        Object.keys(data.Metadata).forEach((metaKey) => {
                            item[metaKey.replace("x-amz-meta-", "")] = data.Metadata[metaKey];
                        });
                        if (/^graphs\/projections\/endpoints\//.test(item.Key)) {
                            item.type = "endpoint";
                        }
                        const tocId = item.type === "endpoint" ? ("endpoint/" + item.id) : item.id;
                        const tocKey = tocId + (/published/.test(item.type) ? ("." + item.version) : "");
                        toc[tocKey] = item;
                        success();
                    });
                });
            })).then(() => {
                this.store.set(`graphs/projections/toc.json`, toc, {}, (err) => {
                    if (err) {
                        callback(err, null);
                        return console.error("Cannot write TOC.", err);
                    }
                    callback(null, null);
                    this.broadcastService.broadcast("toc.json", {
                        channelId: "toc.json",
                        response: {
                            type: "toc",
                            toc,
                        },
                    }, (err) => {
                        if (err) {
                            console.error("Cannot broadcast TOC.", err);
                        }
                    });
                });
            }).catch((err) => {
                console.error("Cannot broadcast TOC.", err);
                callback(err, null);
            });
        });
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
            event.time = Date.now();
            event.changes.forEach((change) => {
                applyChange(graph, true, change);
            });
            const serializedState = JSON.stringify(graph);
            const crc = CRC32(serializedState);
            if (crc !== event.crc) {
                return callback(new Error(`Event CRC failure.  Expected ${crc} got ${event.crc}.`), null);
            }
            const ver = Number(graph.version) + 1;
            graph.version = ver;
            graph.vectors.forEach((v: any) => {
                v.version = ver;
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
                "tags": graph.properties.tags.join(",") || "None",
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
                        success();
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
                        success();
                    });
                }),
                new Promise((success, failure) => {
                    // store versioned projection
                    this.store.set(`graphs/${graphId}/projections/${graphId}.${graph.version}.json`, graph, graphMeta, (err) => {
                        if (err) {
                            console.error("Error storing version projection.", graphMeta);
                            return failure(err);
                        }
                        success();
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
                            success();
                        });
                    } else {
                        success();
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
                        success();
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
            this.broadcastService.postToClient(ctx.domainName, ctx.connectionId, {
                messageId: body.messageId,
                response: { success: true, event },
            }, (err) => {
                if (err) {
                    console.error("Error sending graph to client");
                }
            });
            callback(null, this.okResponse);
        });
    }
    publishVectorWs(event: any, context: any, callback: (err: any, response: any) => void) {
        const ctx = event.requestContext;
        const body = JSON.parse(event.body);
        const graphId = body.graphId;
        const vectorId = body.vectorId;
        const version = body.version;
        this.store.get(`graphs/${graphId}/projections/${graphId}.${version}.json`, (err, graph) => {
            if (err) {
                console.error("Error getting graph to publish vector", err);
                return callback(err, null);
            }
            const vector = graph.vectors.find((v: any) => {
                return v.id === vectorId;
            });
            if (!vector) {
                this.broadcastService.postToClient(ctx.domainName, ctx.connectionId, {
                    messageId: body.messageId,
                    error: true,
                    response: {
                        err: "Cannot find vector",
                    },
                }, (err) => {
                    if (err) {
                        console.error("Error sending error to client");
                    }
                });
            }
            vector.publishedOn = Date.now();
            vector.userId = event.requestContext.identity.userArn || "Unknown userArn";
            const vectorMeta = {
                "graph-id": graph.id,
                "graph-url": graph.url,
                "id": "artifacts/" + vector.id,
                "name": vector.properties.name || "Unnamed",
                "version": String(vector.version),
                "description": vector.properties.description || "No description",
                "icon": vector.properties.icon || "mdi-vector-point",
                "tags": vector.properties.tags.join(",") || "None",
                "type": "publishedVector",
                "url": vector.url || vector.id,
                "artifact-url": "artifacts/" + vector.id + "/" + vector.version,
                "user-id": vector.userId || "Unknown",
            }
            this.store.set(`graphs/projections/published/artifacts/${vector.id}.${vector.version}.json`, vector, vectorMeta, (err) => {
                if (err) {
                    console.error("Error writing published graph to store.");
                    return callback(err, null);
                }
                console.log(`Publish vector success ${vector.id}`);
                this.broadcastService.postToClient(ctx.domainName, ctx.connectionId, {
                    messageId: body.messageId,
                    error: false,
                    response: {
                        type: "vector",
                        url: vector.id,
                        publishedBy: vector.publishedBy,
                        publishedOn: vector.publishedOn,
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
                "tags": graph.properties.tags.join(",") || "None",
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
        const path = (body.version === "latest" || !body.version)
            ? `graphs/projections/latest/${body.id}.json`
            : `graphs/${body.id}/projections/${body.id}.${body.version}.json`;
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
        const path = event.path.version === "latest"
            ? `graphs/projections/latest/${event.pathParameters.id}.json`
            : `graphs/${event.pathParameters.id}.${event.pathParameters.version}.json`;
        this.store.get(path, (err, graph) => {
            if (err) {
                return callback(err, null);
            }
            callback(null, graph);
        });
    }
    _deleteGraph(id: string, callback: (err: any, response: any) => void) {
        this.store.head(`graphs/projections/latest/${id}.json`, (err, data) => {
            if (err) {
                return console.error("Delete graph all failure: ", err);
            }
            const url = data.Metadata["x-amz-meta-url"];
            Promise.all([
                new Promise((success, failure) => {
                    this.store.removePath(`graphs/${id}/projections`, (err) => {
                        if (err) {
                            return failure(err);
                        }
                        success();
                    });
                }),
                new Promise((success, failure) => {
                    this.store.removePath(`graphs/${id}/events`, (err) => {
                        if (err) {
                            return failure(err);
                        }
                        success();
                    });
                }),
                new Promise((success, failure) => {
                    this.store.remove(`graphs/projections/endpoints/${id}.json`, (err) => {
                        if (err) {
                            return failure(err);
                        }
                        success();
                    });
                }),
                new Promise((success, failure) => {
                    this.store.remove(`graphs/projections/endpoints/${url}.json`, (err) => {
                        if (err) {
                            return failure(err);
                        }
                        success();
                    });
                }),
                new Promise((success, failure) => {
                    this.store.remove(`graphs/projections/latest/${id}.json`, (err) => {
                        if (err) {
                            return failure(err);
                        }
                        success();
                    });
                }),
            ]).then(() => {
                this.updateToc((err) => {
                    if (err) {
                        return callback(err, null);
                    }
                    callback(null, null);
                });
            }).catch((err) => {
                console.error("Delete graph all failure: ", err);
                callback(err, null);
            });
        });
    }
    deleteGraph(event: any, context: any, callback: (err: any, response: any) => void) {
        this._deleteGraph(event.path.id, (err) => {
            if (err) {
                return callback(err, null);
            }
            callback(null, this.okResponse);
        });
    }
    deleteGraphWs(event: any, context: any, callback: (err: any, response: any) => void) {
        const body = JSON.parse(event.body);
        this._deleteGraph(body.id, (err) => {
            if (err) {
                return callback(err, null);
            }
            callback(null, this.okResponse);
        });
    }
}
