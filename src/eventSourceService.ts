import {Context, S3CreateEvent, APIGatewayEvent} from "aws-lambda";
import {diff, applyChange} from "deep-diff";
import {CRC32} from "jshashes";
import S3Service from './s3Service';
import BroadcastService from './broadcastService';
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
    updateToc() {
        this.store.list("graphs/latest/", (err, graphs) => {
            if (err) {
                console.error("Cannot read graphs/latest to write TOC.", err);
                return;
            }
            const toc = {};
            graphs.forEach((item) => {
                const path = item.Key.split("/");
                item.type = path[0] === "artifacts" ? "publishedGraph" : "graph";
                toc[item.Key] = item;
            });
            this.store.set(`graphs/toc.json`, toc, (err, toc) => {
                if (err) {
                    return console.error("Cannot write TOC.", err);
                }
                this.broadcastService.broadcast("toc.json", toc, (err) => {
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
    add(event: {graphId: string, crc: number, changes: any[], id: string}, callback: (err: any, response: any) => void) {
        const graphId = event.graphId;
        this.store.get(`graphs/${graphId}.json`, (err, graph) => {
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
                return callback(new Error("Event CRC failure."), null);
            }
            graph.version += 1;
            const versionChanges = diff(JSON.parse(serializedState), graph);
            const versionCrc = CRC32(JSON.stringify(graph));
            Promise.all([
                new Promise((success, failure) => {
                    const versionEvent = {
                        id: newId(),
                        graphId,
                        changes: versionChanges,
                        crc: versionCrc,
                    };
                    this.store.set(`graphs/${graphId}/events/${versionEvent.id}.json`, versionEvent, (err) => {
                        this.broadcastService.broadcast(graphId, event, (err) => {
                            if (err) {
                                return failure(err);
                            }
                            success();
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
                    this.store.set(`graphs/latest/${graphId}.json`, graph, (err) => {
                        if (err) {
                            return failure(err);
                        }
                        this.updateToc();
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
            ]).then(() => {
                callback(null, this.okResponse);
            }).catch((err) => {
                callback(err, null);
            });
        });
    }
    addEvent(_event: any, context: any, callback: (err: any, response: any) => void) {
        const body = JSON.parse(_event.body);
        const event = body.event;
        this.add(event, (err) => {
            if (err) {
                callback(err, null);
            }
            callback(null, this.okResponse);
        });
    }
    getGraph(event: any, context: any, callback: (err: any, response: any) => void) {
        const path = event.path.version === "latest"
            ? `graphs/${event.path.id}.json` 
            : `graphs/${event.path.id}.${event.path.version}.json`;
        this.store.get(path, (err, graph) => {
            if (err) {
                return callback(err, null);
            }
            callback(null, graph);
        });
    }
}
