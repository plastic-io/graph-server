// NOTE: This code file is in an experimental state

// import { Worker, isMainThread, workerData } from 'worker_threads';
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');

import {Context, S3CreateEvent, APIGatewayEvent, APIGatewayEventRequestContext} from "aws-lambda";
import OpenAI from 'openai';
import {Node, Graph} from "@plastic-io/plastic-io";
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
import { ulid } from "ulid";
import { ExecutionRunner } from "./runtime/executor";
import { ParkingService } from "./runtime/parking";
import CrdtStore from "./crdtStore";

/** Secret references node code may name through host.secret(ref): ref=SecretsManager name, comma separated. */
const SECRET_REFS: Record<string, string> = (process.env.SECRET_REFS || "openai=OPENAI_API_KEY").split(",").reduce((acc: Record<string, string>, pair) => {
    const [ref, name] = pair.split("=").map((s) => s.trim());
    if (ref && name) acc[ref] = name;
    return acc;
}, {});

const STAGE = process.env.STAGE;
const objectCache = {};
const MAX_PANIC_FAILSAFE_TIME = 2000;
const MAX_TIMEOUT = 900000;
const HEARTBEAT_INTERVAL = 500;

let responseTimeout;
let paniking = 0;
let graphExecutionComplete = false;
let graphTimeout = 25000;

const getSecret = async (secret_name = "OPENAI_API_KEY") => {
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
    parking: ParkingService;
    constructor() {
        this.state = {};
        this.store = new S3Service(process.env.S3_BUCKET);
        this.parking = new ParkingService(this.store as any);
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
            if (isWs && process.env.WS_EXECUTION_ENABLED !== 'true') {
                // Interim: WebSocket execution has no authorizer and no API key, so it is
                // off unless the stage was deployed with --wsExecution true.
                console.error('Execution over WebSocket is disabled on this stage (WS_EXECUTION_ENABLED != true)');
                return resolve({ statusCode: 403, body: 'websocket execution disabled' });
            }
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
                this.node = node || { id: "unknown" };
                // the execution's identity and the revision it runs (plan §4.5.3, §4.7.4)
                const executionId = (event.headers && (event.headers["x-execution-id"] || event.headers["X-Execution-Id"])) || ulid();
                const active: any = await new Promise((res) => this.store.get(CrdtStore.activeKey(graph.id), (e, d) => res(e ? null : d)));
                const principal = event.principal ? { sub: event.principal.sub, kind: event.principal.kind, tenant: event.principal.tenant } : null;
                const params = JSON.stringify({
                    graph,
                    nodeUrl,
                    value,
                    field,
                    event: { ...event, principal: undefined },
                    context,
                    executionId,
                    revisionId: active && active.revisionId ? active.revisionId : "live",
                    principal,
                });
                let customResponse: any = null;
                let summary: any = null;
                console.log('got graph, starting worker', __filename);

                this.worker = new Worker(__filename, {
                    workerData: params,
                });
                this.worker.on("message", (result) => {
                    console.log("worker-message", typeof result === "string" ? result : result && result.type);
                    if (result && result.type === "response") {
                        customResponse = result.response;   // the node answered the request itself (this.callback)
                        return;
                    }
                    if (result && result.type === "summary") {
                        summary = result.summary;
                        return;
                    }
                    if (result === 'shutdown') {
                        console.log("Shutting down");
                        this.worker.terminate().then((exitCode) => {
                            console.log("Shutdown exit code", exitCode);
                            if (customResponse) {
                                return resolve(customResponse);
                            }
                            resolve({
                                statusCode: 200,
                                headers: { ...corsHeaders, "Content-Type": "application/json", "X-Execution-Id": executionId },
                                body: JSON.stringify(summary || { executionId, state: "unknown" }),
                            });
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
    router(graph: any, nodeUrl: string, field: string, value: string, event: any, context: any, execution: { executionId?: string; revisionId?: string; principal?: any } = {}): Promise<any> {
        return new Promise(async (resolve) => {
            const startTimer = Date.now();
            console.log('starting router');
            this.graph = graph;
            const node = graph.nodes.find((n) => n.url === nodeUrl) || { id: "unknown" };
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
                // the node answered the HTTP request itself: hand that answer to the main thread
                if (!isMainThread && parentPort && response) {
                    parentPort.postMessage({ type: "response", response });
                }
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
            const uncaught = async (err) => {
                await this.send("log")({
                    level: "error",
                    graphId: graph.id,
                    nodeId: node.id,
                    nodeUrl: nodeUrl,
                    error: {
                        message: err ? err.toString() : "Unknown exception error",
                    }
                });
                console.error("router: Unhandled error", err);
                parentPort.postMessage('shutdown');
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
              nodes[node.id] = nodes[node.id] || {};
              node.properties.inputs.forEach((input: any) => {
                nodes[node.id][input.name] = nodes[node.id][input.name] || undefined;
              });
            });
            workerObjProxy.nodes = nodes;

            // The OpenAI key is fetched only for graphs that opt in; every other graph's
            // node code sees `this.openai === undefined`.
            let openai;
            if (graph.properties && graph.properties.openai === true) {
                const apiKey = await getSecret();
                openai = new OpenAI({
                    apiKey,
                });
                (global as any).openai = openai;
            }

            // The execution runner (src/runtime/executor.ts) builds scheduler 2.1 with the budget, the
            // capability host, contract hooks and the observation recorder; legacy events still go to the
            // notify channel and the 2.0 `this` context is kept for graphs that use it.
            const logContext = {
                graphId: graph.id,
                nodeId: node.id,
                nodeUrl: nodeUrl,
            };
            const legacyContext = () => ({
                openai,
                event,
                context,
                callback: cb,
                AWS,
                console: {
                    log: (e) => { console.log('node-serializer-interface:', e); this.send("log")({level: "log", message: e, ...logContext}); },
                    warn: (e) => { console.warn('node-serializer-interface:', e); this.send("log")({level: "warn", message: e, ...logContext}); },
                    debug: (e) => { console.debug('node-serializer-interface:', e); this.send("log")({level: "debug", message: e, ...logContext}); },
                    info: (e) => { console.info('node-serializer-interface:', e); this.send("log")({level: "info", message: e, ...logContext}); },
                    error: (e) => { console.error('node-serializer-interface:', e); this.send("log")({level: "error", err: { message: e }, ...logContext}); },
                },
            });
            const runner = new ExecutionRunner(this.store as any, {
                secrets: async (ref: string) => {
                    const name = SECRET_REFS[ref];
                    if (!name) throw new Error(`no secret is registered as ${ref}`);
                    return getSecret(name);
                },
                live: (observation) => {
                    if (this.broadcastEvents.indexOf("observation") !== -1 || observation.kind === "exec.error" || observation.kind === "effect.denied" || observation.kind === "contract.violation") {
                        this.send("observation")({ ...observation });
                    }
                },
            });
            /**
             * Linked graphs and published nodes the scheduler asks for.  The
             * component layout answers first (a pin names a published version),
             * then the 2.0 artifacts, then the live document of that graph,
             * which is what an unpublished linked graph actually is.
             */
            const resolveArtifact = async (path: string): Promise<any | null> => {
                const match = /^artifacts\/(graph|nodes)\/(.+)\.(\d+)$/.exec(String(path || ""));
                if (!match) {
                    return null;
                }
                const [, kind, id, version] = match;
                const get = (key: string) => new Promise<any | null>((res) => this.store.get(key, (err: any, data: any) => res(err ? null : data)));
                const component: any = await get(`components/${id}/${version}/artifact.json`);
                if (component) {
                    return component.artifact || component;
                }
                const legacy: any = await get(`graphs/projections/published/artifacts/${id}.${version}.json`);
                if (legacy) {
                    return legacy.artifact || legacy;
                }
                if (kind === "graph") {
                    const live: any = await get(`graphs/projections/latest/${id}.json`);
                    if (live) {
                        return live;
                    }
                }
                console.warn("Cannot resolve", path);
                return null;
            };
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
            const postGraph = async (summary: any) => {
                const duration = Date.now() - startTimer;
                console.log("URL promise completed field: ", nodeUrl, field);
                console.log("Promise Invoked Callback: Request duration " + duration + "ms");
                if (summary && summary.state) {
                    this.send("info")({
                        graphId: graph.id,
                        nodeId: node.id,
                        nodeUrl,
                        message: { execution: { id: summary.executionId, state: summary.state, reason: summary.reason, hops: summary.hops, errors: summary.errors, duration: summary.duration, observations: summary.observations } },
                    });
                    if (!isMainThread && parentPort) {
                        parentPort.postMessage({ type: "summary", summary });
                    }
                }
                resolve({ statusCode: 200, body: JSON.stringify(summary || { ok: true }), headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
            // a pinned component runs under its published manifest's capabilities (plan §4.5.4)
            const manifests: Record<string, any> = {};
            await Promise.all((graph.nodes || []).filter((n: any) => n.properties && n.properties.component && n.properties.component.publishedId).map((n: any) => new Promise<void>((done) => {
                this.store.get(`components/${n.properties.component.publishedId}/${n.properties.component.version}/manifest.json`, (e: any, m: any) => { if (!e && m) manifests[n.id] = m; done(); });
            })));
            try {
                runner.run({
                    graph, nodeUrl, field, value,
                    manifestCapabilities: (n: any) => (manifests[n.id] ? (manifests[n.id].capabilities || []) : null),
                    context: { openai, event, context, callback: cb },
                    state: workerObjProxy,
                    logger,
                    principal: execution.principal || null,
                    executionId: execution.executionId,
                    revisionId: execution.revisionId,
                    budget: { wallMs: graphTimeout, hops: 100000, fanOut: 10000, depth: 512 },
                    maxObservations: Number(process.env.MAX_OBSERVATIONS) || undefined,
                    resolve: resolveArtifact,
                    initiator: event.headers && (event.headers["x-session-id"] || event.headers["X-Session-Id"]),
                    deliver: async (delivery: any) => {
                        // the browsers watching this graph receive the value; the
                        // one that matches the target runs the node (plan §4.8.2).
                        // It is parked first, so a delivery nobody takes is
                        // recorded rather than lost (PB-072).
                        await this.parking.park(graph.id, delivery, graph.properties && (graph.properties as any).deliveryTtlMs)
                            .catch((err: any) => console.error("Cannot park a delivery.", err));
                        await this.send("edge.deliver")({ ...delivery });
                    },
                    defaultContainment: process.env.DEFAULT_CONTAINMENT === "isolate" ? "isolate" : "worker",
                    isolateLimits: {
                        timeoutMs: Math.min(Number(process.env.ISOLATE_TIMEOUT_MS) || 10000, graphTimeout),
                        memoryMb: Number(process.env.ISOLATE_MEMORY_MB) || 128,
                    },
                    onEvent: (name, e) => {
                        if (this.graphEvents.indexOf(name) !== -1) {
                            this.send(name)({ ...e });
                        }
                    },
                    setContext: legacyContext,
                }).then(postGraph).catch(graphCatch);
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
    console.log("Worker: Starting router");
    graphService.router(parsedData.graph,
        parsedData.nodeUrl,
        parsedData.field,
        parsedData.value,
        parsedData.event,
        parsedData.context,
        { executionId: parsedData.executionId, revisionId: parsedData.revisionId, principal: parsedData.principal })
    .then(() => {
        console.log("Worker: Ending router, waiting for handles and requests to complete.");
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
                    console.log("Worker: Empty event loop, worker shutting down");
                    parentPort.postMessage('shutdown');
                    return;
                }
                pollActivity();
            }, HEARTBEAT_INTERVAL);
        };
        pollActivity();
    }).catch((err) => {
        console.log("Worker: Ending router with error" + err);
        process.exit(1);
    });
    
}
