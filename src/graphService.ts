import {Context, S3CreateEvent, APIGatewayEvent, APIGatewayEventRequestContext} from "aws-lambda";
import Scheduler, {Vector, Graph} from "@plastic-io/plastic-io";
import S3Service from "./s3Service";
import * as AWS from "aws-sdk";
import * as path from "path";
import BroadcastService from "./broadcastService";
const STAGE = process.env.STAGE;
const objectCache = {};
class GraphService {
    graph: Graph;
    state: any;
    store: S3Service;
    logLevel: number;
    graphEvents: string[];
    broadcastConnectors: string[];
    broadcastEvents: string[];
    broadcastService: BroadcastService;
    constructor() {
        this.state = {};
        this.store = new S3Service(process.env.S3_BUCKET);
        this.broadcastService = new BroadcastService();
        this.logLevel = 0;
        this.graphEvents = [
            "begin",
            "end",
            "beginconnector",
            "endconnector",
            "set",
            "afterSet",
            "error",
            "warning",
            "load",
        ];
        this.broadcastEvents = [
            "begin",
            "end",
            "beginconnector",
            "endconnector",
            "set",
            "afterSet",
            "error",
            "warning",
            "load",
        ];
    }
    send(type: string) {
        return (e: any) => {
            e.eventType = type;
            delete e.vectorInterface;
            this.broadcastService._sendToChannel("graph-notify-" + this.graph.id, e, (err) => {
                if (err) {
                    console.error("Cannot send graph notification.", err);
                }
            });
        }
    }
    getGraph(key: string, callback: (err: any, graph: any) => void) {
        if (objectCache[key] && STAGE !== "production") {
            return callback(null, objectCache[key]);
        }
        this.store.get(key, (err, graph) => {
            if (err) {
                return callback(err, null);
            }
            if (STAGE === "production") {
                objectCache[key] = graph;
            }
            callback(null, graph);
        });
    }
    router(event: any, context: Context, callback: (err: any, response: any) => void) {
        const startTimer = Date.now();
        const parsedPath = path.parse(event.path);
        const graphUrl = parsedPath.name;
        const target = parsedPath.ext ? parsedPath.ext.substring(1) : "index";
        const storePath = STAGE === "production"
            ? `graphs/published/endpoints/${graphUrl}.json`
            : `graphs/projections/endpoints/${graphUrl}.json`;
        console.log("Fetching graph ", storePath);
        this.getGraph(storePath, (err, graph) => {
            if (err) {
                return callback(err, null);
            }
            console.log("Found graph ", graph.id);
            this.graph = graph;
            const timeout = setTimeout(() => {
                const vect = graph.vectors.find((v: any) => {
                    return v.url === target;
                });
                this.send("error")({
                    graphId: graph.id,
                    vectorId: vect ? vect.id : undefined,
                    targetUrl: target,
                    message: "Response timeout.  You muse respond to HTTP requests within 30 seconds.",
                });
                callback(null, {
                    statusCode: 500,
                    body: "internal server error",
                });
            }, 25000);
            const cb = (err, response) => {
                const duration = Date.now() - startTimer;
                console.log("Request duration " + duration + "ms");
                clearTimeout(timeout);
                if (!response.headers) {
                    response.headers = {
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Credentials": true,
                    };
                }
                callback(null, response);
            };
            const logger = {
                error: (e: any) => {
                    if (this.logLevel > -1) {
                        this.send("log")({
                            level: "error",
                            err: {
                                message: e,
                            }
                        });
                        console.error(e);
                    }
                },
                warn: (e: any) => {
                    if (this.logLevel > 0) {
                        this.send("log")({
                            level: "warn",
                            message: e
                        });
                        console.warn(e);
                    }
                },
                log: (e: any) => {
                    if (this.logLevel > 1) {
                        this.send("log")({
                            level: "log",
                            message: e
                        });
                        console.log(e);
                    }
                },
                info: (e: any) => {
                    if (this.logLevel > 2) {
                        this.send("log")({
                            level: "info",
                            message: e
                        });
                        console.info(e);
                    }
                },
                debug: (e: any) => {
                    if (this.logLevel > 3) {
                        this.send("log")({
                            level: "debug",
                            message: e
                        });
                        console.debug(e);
                    }
                },
            };
            if (graph.properties.broadcastConnectors !== undefined && typeof graph.properties.broadcastConnectors === "string") {
                this.broadcastConnectors = graph.properties.broadcastConnectors.split(",");
            }
            if (graph.properties.broadcastEvents !== undefined && typeof graph.properties.broadcastEvents === "string") {
                this.broadcastEvents = graph.properties.broadcastEvents.split(",");
            }
            if (graph.properties.logLevel !== undefined && !isNaN(graph.properties.logLevel)) {
                this.logLevel = graph.properties.logLevel;
            }
            function uncaught(err) {
                this.send("log")({
                    level: "error",
                    err: {
                        message: err ? err.toString() : "Unknown exception error",
                    }
                });
                console.error("Unhandled error", err);
            }
            process.on('unhandledRejection', uncaught);
            process.on('uncaughtException', uncaught);
            console.log("Instantiate scheduler");
            const scheduler = new Scheduler(graph, {event, context, callback: cb}, this.state, logger);
            console.log("Add scheduler events");
            scheduler.addEventListener("set", (e: any) => {
                if (!e.vectorInterface) {
                    return;
                }
                e.setContext({
                    event,
                    context,
                    callback: cb,
                    AWS,
                    console: {
                        log: (e) => { 
                            console.log(e);
                            this.send("log")({level: "log", message: e});
                        },
                        warn: (e) => {
                            console.warn(e);
                            this.send("log")({level: "warn", message: e});
                        },
                        debug: (e) => {
                            console.debug(e);
                            this.send("log")({level: "debug", message: e});
                        },
                        info: (e) => {
                            console.info(e);
                            this.send("log")({level: "info", message: e});
                        },
                        error: (e) => {
                            console.error(e);
                            this.send("log")({level: "error", err: { message: e }});
                        },
                    }
                });
            });
            this.graphEvents.forEach((eventName) => {
                scheduler.addEventListener(eventName, (ev) => {
                    this.send(eventName)(ev);
                });
            });
            console.log("Navigate to vector URL: ", event.path);
            scheduler.url(target, event, event.path, null).then(() => {
                console.log("URL promise completed: ", event.path);
            }).catch((err) => {
                this.send("log")({
                    level: "error",
                    err: {
                        message: err,
                    }
                });
            });
        });
    }
}
export default GraphService;
