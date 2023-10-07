// NOTE: This code file is in an experimental state

// import { Worker, isMainThread, workerData } from 'worker_threads';
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');

import {Context, S3CreateEvent, APIGatewayEvent, APIGatewayEventRequestContext} from "aws-lambda";
import OpenAI from 'openai';
import Scheduler, {Node, Graph} from "@plastic-io/plastic-io";
import {createDeepProxy, type Path} from "./proxy";
import {toJSON} from "flatted";
import S3Service from "./s3Service";
import * as AWS from "aws-sdk";
import * as path from "path";
import BroadcastService from "./broadcastService";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const STAGE = process.env.STAGE;
const objectCache = {};
const MAX_PANIC_FAILSAFE_TIME = 2000;
const MAX_TIMEOUT = 900000;
const HEARTBEAT_INTERVAL = 500;

let responseTimeout;
let paniking = 0;
let graphExecutionComplete = false;
let graphTimeout = 25000;

const getSecret = async () => {
    const secret_name = "OPENAI_API_KEY";
    const client = new SecretsManagerClient({
      region: "us-west-1",
    });
    let response;
    try {
      response = await client.send(
        new GetSecretValueCommand({
          SecretId: secret_name,
          VersionStage: "AWSCURRENT", // VersionStage defaults to AWSCURRENT if unspecified
        })
      );
    } catch (error) {
      // For a list of exceptions thrown, see
      // https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html
      throw error;
    }
    return response.SecretString;
};
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Credentials": true,
};
export const panic = (event: any, context: Context, callback: (err: any, response: any) => void) => {
    const body = JSON.parse(event.body);
    const ctx = event.requestContext;
    const s3 = new S3Service(process.env.S3_BUCKET);
    paniking = Date.now();
    // store edit event
    s3.set(`panic/${body.graphId}.json`, "PANIC!", {}, (err) => {
        if (err) {
            console.error('cannot write panic file', err);
            callback(null, {
                statusCode: 500,
                body: "internal server error",
            });
            // in the case that we cannot write a panic file the lambda should be shut down
            return process.exit(1);
        }
        const broadcastService = new BroadcastService();
        broadcastService.postToClient(ctx.domainName, ctx.connectionId, {
            graphId: body.graphId,
            response: { panicFileWritten: true },
        }, (err) => {
            if (err) {
                console.error("Error sending panic callback message to client");
            }
            callback(null, {
                statusCode: 200,
                body: "ok",
            });
        });
    });
}
class GraphService {
    graph: Graph;
    node: any;
    worker: any;
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
        return (e: any): Promise<void> => {
            return new Promise((resolve, reject) => {
                if (paniking > 0 && Date.now() - paniking > MAX_PANIC_FAILSAFE_TIME) {
                    console.error('MAX_PANIC_FAILSAFE_TIME reached, exiting now.')
                    process.exit(1);
                }
                e.eventType = type;
                delete e.nodeInterface;
                this.broadcastService._sendToChannel("graph-notify-" + this.graph.id, e, (err) => {
                    if (err) {
                        console.error("Cannot send graph notification.", err);
                        return reject(err);
                    }
                    resolve();
                });
            })
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
    checkPanic(graphId, callback: (panic: boolean) => void) {
        const key = `panic/${graphId}`;
        this.store.get(key, (err, panic) => {
            if (err) {
                return callback(false);
            }
            this.store.remove(key, () => {
                callback(true);
            });
        });
    }
    init(event: any, context: Context): Promise<any> {
        const startTimer = Date.now();
        return new Promise((resolve) => {
            const isWs = !event.path;
            let graphUrl, nodeUrl, target, value, field;
            // normalize ws/http
            if (isWs) {
                // websocket event
                const body = JSON.parse(event.body);
                graphUrl = body.graphUrl;
                nodeUrl = body.nodeUrl;
                field = body.field;
                value = body.value;
            } else {
                // Split the path into segments based on both '/' and '.' delimiters
                const segments = event.path.split(/[/.]/);
                // Extract graphUrl and nodeUrl from the segments
                graphUrl = segments[1];  // Assumes that the path starts with '/'
                nodeUrl = segments[2];
                value = event;
                field = event.path;
            }
            // Default to 'index' if nodeUrl is undefined
            target = nodeUrl || 'index';
            // Determine the storePath based on the STAGE environment variable
            const storePath = STAGE === 'production'
                ? `graphs/published/endpoints/${graphUrl}.json`
                : `graphs/projections/endpoints/${graphUrl}.json`;
            console.log('loading s3 graph document', storePath);
            this.getGraph(storePath, async (err, graph) => {
                if (err) {
                    console.error('Error fetching graph', err);
                    return resolve({
                        statusCode: 500,
                        body: "internal server error",
                    });
                }
                this.graph = graph;
                const node = graph.nodes.find((n) => n.url === nodeUrl);
                this.node = node;
                const params = JSON.stringify({
                    graph,
                    nodeUrl,
                    value,
                    field,
                    event,
                    context,
                });
                console.log('got graph, starting worker', __filename);

                this.worker = new Worker(__filename, {
                    workerData: params,
                });
                this.worker.on("message", (result) => {
                    console.log("worker-message", result);
                    if (result === 'shutdown') {
                        console.log("Shutting down");
                        this.worker.terminate().then((exitCode) => {
                            console.log("Shutdown exit code", exitCode);
                            resolve({ statusCode: 200, body: "ok", });
                        });
                        
                    }
                });
                this.worker.on("error", async (error) => {
                    console.log("worker-error", error);
                    console.log("worker-error-this", this);
                    await this.send("info")({
                        graphId: graph.id,
                        nodeId: this.node.id,
                        nodeUrl: nodeUrl,
                        field: field,
                        error: {
                            message: error,
                        },
                    });
                    resolve({ statusCode: 200, body: "ok", });
                });
                this.worker.on("exit", async (exitCode) => {
                    console.log("worker-exit", exitCode);
                    await this.send("info")({
                        graphId: graph.id,
                        nodeId: this.node.id,
                        nodeUrl: nodeUrl,
                        field: field,
                        message: {exitCode},
                    });
                    resolve({ statusCode: 200, body: "ok", });
                });
                
                console.log('worker started, promise waiting for exit');
            });
        });
    }
    router(graph: any, nodeUrl: string, field: string, value: string, event: any, context: any): Promise<any> {
        return new Promise(async (resolve) => {
            const startTimer = Date.now();
            console.log('starting router');
            this.graph = graph;
            const node = graph.nodes.find((n) => n.url === nodeUrl);
            this.node = node;
            graphTimeout = Math.min(MAX_TIMEOUT, ((this.graph.properties as any).timeout || graphTimeout));
            responseTimeout = setTimeout(() => {
                this.send("info")({
                    graphId: graph.id,
                    nodeId: node.id,
                    nodeUrl: nodeUrl,
                    message: `Graph lambda shutting down after ${graphTimeout}ms seconds`,
                });
                resolve({ statusCode: 200, body: "ok", });
            }, graphTimeout);
            const cb = (err, response) => {
                const duration = Date.now() - startTimer;
                console.log("Graph Invoked Callback: Request duration " + duration + "ms");
                clearTimeout(responseTimeout);
                resolve(response);
            };
            const logger = {
                error: async (e: any) => {
                    if (this.logLevel > -1) {
                        await this.send("log")({
                            level: "error",
                            graphId: graph.id,
                            nodeId: node.id,
                            nodeUrl: nodeUrl,
                            error: {
                                message: e,
                            }
                        });
                        console.error('Scheduler:', e);
                        // errors should crash the graph
                        resolve({ statusCode: 200, body: 'ok', });
                    }
                },
                warn: (e: any) => {
                    if (this.logLevel > 0) {
                        this.send("log")({
                            level: "warn",
                            graphId: graph.id,
                            nodeId: node.id,
                            nodeUrl: nodeUrl,
                            message: e
                        });
                        console.warn('Scheduler:', e);
                    }
                },
                log: (e: any) => {
                    if (this.logLevel > 1) {
                        this.send("log")({
                            level: "log",
                            graphId: graph.id,
                            nodeId: node.id,
                            nodeUrl: nodeUrl,
                            message: e
                        });
                        console.log('Scheduler:', e);
                    }
                },
                info: (e: any) => {
                    if (this.logLevel > 2) {
                        this.send("log")({
                            level: "info",
                            graphId: graph.id,
                            nodeId: node.id,
                            nodeUrl: nodeUrl,
                            message: e
                        });
                        console.info('Scheduler:', e);
                    }
                },
                debug: (e: any) => {
                    if (this.logLevel > 3) {
                        this.send("log")({
                            level: "debug",
                            graphId: graph.id,
                            nodeId: node.id,
                            nodeUrl: nodeUrl,
                            message: e
                        });
                        console.debug('Scheduler:', e);
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
            const uncaught = (err) => {
                this.send("log")({
                    level: "error",
                    graphId: graph.id,
                    nodeId: node.id,
                    nodeUrl: nodeUrl,
                    error: {
                        message: err ? err.toString() : "Unknown exception error",
                    }
                });
                parentPort.postMessage('shutdown');
                console.error("router: Unhandled error", err);
                resolve({ statusCode: 200, body: "ok", });
            }
            process.on('unhandledRejection', uncaught);
            process.on('uncaughtException', uncaught);
            console.log("Instantiate scheduler");

            const sendUpdate = (path: Path, value: any): void => {
                this.send('state-update')({
                    path,
                    value,
                });
            };

            const workerObj: { [key: string]: any } = {foo: 'bar'};

            const workerObjProxy = createDeepProxy(workerObj, [], sendUpdate);

            let obj: any = workerObj;
            const nodes = {} as any;
            graph.nodes.forEach((node: any) => {
              nodes[node.id] = {};
              node.properties.inputs.forEach((input: any) => {
                nodes[node.id][input.name] = {};
              });
            });
            workerObjProxy.nodes = nodes;

            const apiKey = await getSecret();
            const openai = new OpenAI({
                apiKey,
            });
            (global as any).openai = openai;

            const scheduler = new Scheduler(graph, {openai, event, context, callback: cb}, workerObjProxy, logger);

            scheduler.addEventListener("set", (e: any) => {
                if (!e.nodeInterface) {
                    return;
                }
                const logContext = {
                    graphId: graph.id,
                    nodeId: node.id,
                    nodeUrl: nodeUrl,
                };
                e.setContext({
                    openai,
                    event,
                    context,
                    callback: cb,
                    AWS,
                    console: {
                        log: (e) => { 
                            console.log('node-serializer-interface:', e);
                            this.send("log")({level: "log", message: e, ...logContext});
                        },
                        warn: (e) => {
                            console.warn('node-serializer-interface:', e);
                            this.send("log")({level: "warn", message: e, ...logContext});
                        },
                        debug: (e) => {
                            console.debug('node-serializer-interface:', e);
                            this.send("log")({level: "debug", message: e, ...logContext});
                        },
                        info: (e) => {
                            console.info('node-serializer-interface:', e);
                            this.send("log")({level: "info", message: e, ...logContext});
                        },
                        error: (e) => {
                            console.error('node-serializer-interface:', e);
                            this.send("log")({level: "error", err: { message: e }, ...logContext});
                        },
                    }
                });
            });
            this.graphEvents.forEach((eventName) => {
                scheduler.addEventListener(eventName, (ev) => {
                    this.send(eventName)(ev);
                });
            });
            console.log("Navigate to node URL/field: ", nodeUrl, field);
            const graphCatch = (err) => {
                console.error("Error in graph", err);
                graphExecutionComplete = true;
                clearTimeout(responseTimeout);
                this.send("log")({
                    graphId: graph.id,
                    nodeId: node.id,
                    nodeUrl: nodeUrl,
                    level: "error",
                    error: {
                        message: err,
                    }
                });
                resolve({ statusCode: 200, body: "ok", });
            };
            const postGraph = async () => {
                const duration = Date.now() - startTimer;
                console.log("URL promise completed field: ", nodeUrl, field);
                console.log("Promise Invoked Callback: Request duration " + duration + "ms");
                resolve({ statusCode: 200, body: "ok", });
            }
            try {
                scheduler.url(nodeUrl, value, field, null).then(postGraph).catch(graphCatch);
            } catch (err) {
                graphCatch(err);
            }
        });
    }
}
export default GraphService;

if (!isMainThread) {
    const graphService = new GraphService();
    const parsedData = JSON.parse(workerData);
    console.log("worker: starting router");
    graphService.router(parsedData.graph,
        parsedData.nodeUrl,
        parsedData.field,
        parsedData.value,
        parsedData.event,
        parsedData.context)
    .then(() => {
        console.log("worker: ending router");
        let activityTimeout;
        const pollActivity = () => {
            clearTimeout(activityTimeout);
            activityTimeout = setTimeout(() => {
                const handles = (process as any)._getActiveHandles();
                const requests = (process as any)._getActiveRequests();
                graphService.send('info')({
                    graphId: parsedData.graph.id,
                    message: {
                        performance: {
                            handles: handles.length,
                            request: requests.length,
                        }
                    }
                });
                if (handles.length === 0 && requests.length === 0) {
                    clearTimeout(activityTimeout);
                    console.log("worker: empty event loop, worker shutting down");
                    parentPort.postMessage('shutdown');
                    return;
                }
                pollActivity();
            }, HEARTBEAT_INTERVAL);
        };
        pollActivity();
    }).catch((err) => {
        console.log("worker: ending router with error" + err);
        process.exit(1);
    });
    
}
