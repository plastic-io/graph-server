import {Context, S3CreateEvent, APIGatewayEvent, APIGatewayEventRequestContext} from "aws-lambda";
import Scheduler, {Vector, Graph} from "@plastic-io/plastic-io";
import S3Service from "./s3Service";
import * as path from "path";
import BroadcastService from "./broadcastService";
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
    router(event: any, context: Context, callback: (err: any, response: any) => void) {
        const startTimer = Date.now();
        const parsedPath = path.parse(event.path);
        this.store.get(`graphs/latest/${parsedPath.name}.json`, (err, graph) => {
            if (err) {
                return callback(err, null);
            }
            this.graph = graph;
            const timeout = setTimeout(() => {
                const duration = Date.now() - startTimer;
                console.log("Request duration " + duration + "ms");
                callback(null, {
                    statusCode: 500,
                    body: "internal server error",
                });
            }, 25000);
            const cb = (err, response) => {
                const duration = Date.now() - startTimer;
                console.log("Request duration " + duration + "ms");
                clearTimeout(timeout);
                callback(null, response);
            };
            const logger = {
                error: (e: any) => {
                    if (this.logLevel > -1) {
                        e.logLevel = "error";
                        this.send("log")(e);
                        console.error(e);
                    }
                },
                warn: (e: any) => {
                    if (this.logLevel > 0) {
                        e.logLevel = "warn";
                        this.send("log")(e);
                        console.warn(e);
                    }
                },
                log: (e: any) => {
                    if (this.logLevel > 1) {
                        e.logLevel = "log";
                        this.send("log")(e);
                        console.log(e);
                    }
                },
                info: (e: any) => {
                    if (this.logLevel > 2) {
                        e.logLevel = "info";
                        this.send("log")(e);
                        console.info(e);
                    }
                },
                debug: (e: any) => {
                    if (this.logLevel > 3) {
                        e.logLevel = "debug";
                        this.send("log")(e);
                        console.info(e);
                    }
                    console.debug(e);
                },
            };
            const target = parsedPath.ext ? parsedPath.ext.substring(1) : "index";
            if (graph.properties.broadcastConnectors !== undefined && typeof graph.properties.broadcastConnectors === "string") {
                this.broadcastConnectors = graph.properties.broadcastConnectors.split(",");
            }
            if (graph.properties.broadcastEvents !== undefined && typeof graph.properties.broadcastEvents === "string") {
                this.broadcastEvents = graph.properties.broadcastEvents.split(",");
            }
            if (graph.properties.logLevel !== undefined && !isNaN(graph.properties.logLevel)) {
                this.logLevel = graph.properties.logLevel;
            }
            const scheduler = new Scheduler(graph, {event, context, callback: cb}, this.state, logger);
            this.graphEvents.forEach((eventName) => {
                scheduler.addEventListener(eventName, (ev) => {
                    this.send(eventName)(ev);
                });
            });
            scheduler.url(target, event, event.path, null);
        });
    }
}
export default GraphService;
