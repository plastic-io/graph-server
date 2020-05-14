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
        this.store.list(`graphs/${event.path.id}/events/`, (err, events) => {
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
    updateToc(callback: (err: any, response: any) => void) {
        this.store.list("graphs/latest/", (err, graphs) => {
            if (err) {
                console.error("Cannot read graphs/latest to write TOC.", err);
                return;
            }
            const suffixJsonReg = /\.json$/;
            const toc = {};
            graphs.forEach((item) => {
                const path = item.Key.split("/");
                item.type = path[0] === "artifacts" ? "publishedGraph" : "graph";
                item.id = item.type === "graph"
                    ? path[2].replace(suffixJsonReg, "")
                    : path[3].replace(suffixJsonReg, "");
                item.lastUpdate = new Date(item.LastModified).getTime();
                item.name = item.id;
                toc[item.id] = item;
            });
            this.store.set(`graphs/toc.json`, toc, (err) => {
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
        });
    }
    getToc(event: any, context: any, callback: (err: any, response: any) => void) {
        this.store.get(`graphs/toc.json`, (err, toc) => {
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
    add(event: {graphId: string, crc: number, changes: any[], id: string, graph: any}, callback: (err: any, response: any) => void) {
        const graphId = event.graphId;
        this.store.get(`graphs/latest/${graphId}.json`, (err, graph) => {
            if (err && /NoSuchKey/.test(err.toString())) {
                graph = {};
                console.log("No graph found.  Using empty object.");
            } else if (err) {
                return callback(err, null);
            }
            event.changes.forEach((change) => {
                applyChange(graph, true, change);
            });
            const serializedState = JSON.stringify(graph);
            const crc = CRC32(serializedState);
            if (crc !== event.crc) {
                return callback(new Error(`Event CRC failure.  Expected ${crc} got ${event.crc}.`), null);
            }
            const ver = Number(graph.version + 1);
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
            Promise.all([
                new Promise((success, failure) => {
                    this.store.set(`graphs/latest/${graphId}.json`, graph, (err) => {
                        if (err) {
                            return failure(err);
                        }
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
                    this.store.set(`graphs/${graphId}/events/${versionEvent.id}.json`, versionEvent, (err) => {
                        if (err) {
                            return failure(err);
                        }
                        success();
                        this.broadcastService.broadcast("graph-event-" + graphId, {
                            channelId: "graph-event-" + graphId,
                            response: [event, versionEvent],
                        }, (err) => {
                            if (err) {
                                return console.error("Error sending message to graph event subscribers.");
                            }
                        });
                    });
                }),
                new Promise((success, failure) => {
                    this.store.set(`graphs/${graphId}/events/${event.id}.json`, event, (err) => {
                        if (err) {
                            return failure(err);
                        }
                        success();
                    });
                }),
                new Promise((success, failure) => {
                    this.store.set(`graphs/${graphId}/projections/${graphId}.${graph.version}.json`, graph, (err) => {
                        if (err) {
                            return failure(err);
                        }
                        success();
                    });
                }),
                new Promise((success, failure) => {
                    this.store.set(`graphs/endpoints/${graph.url}.json`, graph, (err) => {
                        if (err) {
                            return failure(err);
                        }
                        success();
                    });
                }),
            ]).then(() => {
                console.log("add success");
                callback(null, this.okResponse);
            }).catch((err) => {
                console.log("add failure", err);
                callback(err, null);
            });
        });
    }
    addEvent(_event: any, context: any, callback: (err: any, response: any) => void) {
        const body = JSON.parse(_event.body);
        const event = body.event;
        const ctx = _event.requestContext;
        event.time = Date.now();
        this.add(event, (err) => {
            if (err) {
                this.broadcastService.postToClient(ctx.domainName, ctx.connectionId, {
                    messageId: body.messageId,
                    error: true,
                    response: err,
                }, (err) => {
                    if (err) {
                        console.error("Error sending graph to client");
                    }
                });
                return callback(err, null);
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
            vector.publishedBy = event.requestContext.identity.userArn || "Unknown userArn";
            this.store.set(`graphs/published/vectors/${vector.id}.json`, vector, (err) => {
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
            callback(null, this.okResponse);
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
            this.store.set(`graphs/published/graphs/${graph.id}.latest.json`, graph, sendResponse);
            this.store.set(`graphs/published/graphs/${graph.id}.${graph.version}.json`, graph, sendResponse);
            this.store.set(`graphs/published/endpoints/${graph.url}.json`, graph, sendResponse);
            callback(null, this.okResponse);
        });
    }
    getGraphWs(event: any, context: any, callback: (err: any, response: any) => void) {
        const ctx = event.requestContext;
        const body = JSON.parse(event.body);
        const path = (body.version === "latest" || !body.version)
            ? `graphs/latest/${body.id}.json`
            : `graphs/${body.id}/projections/${body.id}.${body.version}.json`;
        this.store.get(path, (err, graph) => {
            if (err) {
                console.error("Cannot find graph at path:", path);
                this.broadcastService.postToClient(ctx.domainName, ctx.connectionId, {
                    messageId: body.messageId,
                    error: true,
                    response: err
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
            ? `graphs/latest/${event.path.id}.json`
            : `graphs/${event.path.id}.${event.path.version}.json`;
        this.store.get(path, (err, graph) => {
            if (err) {
                return callback(err, null);
            }
            callback(null, graph);
        });
    }
    _deleteGraph(id: string, callback: (err: any, response: any) => void) {
        Promise.all([
            new Promise((success, failure) => {
                this.store.list(`graphs/${id}`, (err, events) => {
                    Promise.all(events.map((ev) => {
                        return new Promise((pass, fail) => {
                            this.store.remove(ev.Key, (err) => {
                                if (err) {
                                    return fail(err);
                                }
                                pass();
                            });
                        });
                    })).then(() => {
                        success();
                    }).catch((err) => {
                        failure(err);
                    });
                });
            }),
            new Promise((success, failure) => {
                this.store.remove(`graphs/latest/${id}.json`, (err) => {
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
