import {Context, S3CreateEvent, APIGatewayEvent, APIGatewayEventRequestContext} from "aws-lambda";
import Scheduler, {Vector, Graph} from "@plastic-io/plastic-io";
import S3Service from "./s3Service";
import * as path from "path";
import BroadcastService from "./broadcastService";
class GraphService {
    graph: Graph;
    state: any;
    store: S3Service;
    broadcastService: BroadcastService;
    constructor() {
        this.state = {};
        this.store = new S3Service(process.env.S3_BUCKET);
        this.broadcastService = new BroadcastService();
    }
    send(type: string) {
        return (e: any) => {
            e.eventType = type;
            delete e.vectorInterface;
            delete e.graph;
            delete e.vector;
            this.broadcastService._sendToChannel("graph-notify-" + this.graph.id, e, (err) => {
                if (err) {
                    console.error("Cannot send graph notification.", err);
                }
            });
        }
    }
    router(event: any, context: Context, callback: (err: any, response: any) => void) {
        const parsedPath = path.parse(event.path);
        this.store.get(`graphs/latest/${parsedPath.name}.json`, (err, graph) => {
            if (err) {
                return callback(err, null);
            }
            this.graph = graph;
            const timeout = setTimeout(() => {
                callback(null, {
                    statusCode: 500,
                    body: "internal server error",
                });
            }, 29000);
            const cb = (err, response) => {
                clearTimeout(timeout);
                callback(null, response);
            };
            const scheduler = new Scheduler(graph, {event, context, callback: cb}, this.state, console);
            const target = parsedPath.ext ? parsedPath.ext.substring(1) : "index";
            scheduler.url(target, event, event.path, null);
            [
                "begin",
                "end",
                "beginconnector",
                "endconnector",
                "set",
                "afterSet",
                "error",
                "warning",
                "load",
            ].forEach((eventName) => {
                scheduler.addEventListener(eventName, (ev) => { this.send(eventName)(ev); });
            });
        });
    }
}
export default GraphService;
