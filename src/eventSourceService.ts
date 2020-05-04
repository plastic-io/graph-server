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
    add(event: {graphId: string, crc: number, changes: any[], id: string}, callback: (err: any, response: any) => void) {
        const graphId = event.graphId;
        this.store.get(`/graphs/{graphId}.json`, (err, graph) => {
            if (err.code === "NoSuchKey") {
                graph = {};
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
                    this.store.set(`/graphs/{graphId}/events/{versionEvent.id}.json`, versionEvent, (err) => {
                        this.broadcastService.broadcast(graphId, event, (err) => {
                            if (err) {
                                return failure(err);
                            }
                            success();
                        });
                    });
                }),
                new Promise((success, failure) => {
                    this.store.set(`/graphs/{graphId}/events/{event.id}.json`, event, (err) => {
                        if (err) {
                            return failure(err);
                        }
                        success();
                    });
                }),
                new Promise((success, failure) => {
                    this.store.set(`/graphs/{graphId}.json`, graph, (err) => {
                        if (err) {
                            return failure(err);
                        }
                        success();
                    });
                }),
                new Promise((success, failure) => {
                    this.store.set(`/graphs/{graphId}.{graph.version}.json`, graph, (err) => {
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
            callback(null, null);
        });
    }
    getGraph(event: any, context: any, callback: (err: any, response: any) => void) {
        this.store.get(`/graphs/{graphId}.json`, (err, graph) => {
            if (err) {
                return callback(err, null);
            }
            callback(null, graph);
        });
    }
}
