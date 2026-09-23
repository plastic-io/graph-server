/**
 * A local stand-in for the deployed graph server.
 *
 * It runs the real `CrdtService` and `EventSourceService` against an in-memory
 * object store and a plain WebSocket, emulating just enough of API Gateway for
 * the editor to talk to it.  That makes it possible to work on collaborative
 * editing, and to watch two browsers converge, without deploying to AWS.
 *
 * Not for production: nothing here authenticates, and the store is lost when
 * the process exits.
 *
 *   npm run dev-server
 */
import * as http from "http";
// Imported rather than taken from the global scope: the Lambda tsconfig
// targets the Node libraries only, without the DOM, so these are not global
// there even though the runtime provides them.
import { URL, URLSearchParams } from "url";
import { WebSocketServer, WebSocket } from "ws";
import CrdtService from "./crdtService";
import CrdtStore from "./crdtStore";
import EventSourceService from "./eventSourceService";
import { makeMcpStreamHandler } from "./mcp/stream";
import { ExecutionRunner } from "./runtime/executor";

const PORT = Number(process.env.PORT || 3030);
/** Nothing here authenticates; every request is the same local person. */
const DEV_PRINCIPAL = { sub: "dev:http", kind: "human", tenant: "personal:dev", scopes: [] };

/* ------------------------------------------------------------------ *
 * an object store that lives in memory
 * ------------------------------------------------------------------ */

class MemoryStore {
  objects = new Map<string, Buffer>();
  meta = new Map<string, any>();

  getRaw(key: string, callback: (err: any, data: Buffer | null) => void) {
    const value = this.objects.get(key);
    if (!value) {
      return callback(new Error("NoSuchKey: " + key), null);
    }
    callback(null, value);
  }
  setRaw(key: string, body: Buffer, meta: any, callback: (err: any, data: any) => void) {
    this.objects.set(key, Buffer.from(body));
    this.meta.set(key, meta || {});
    callback(null, null);
  }
  get(key: string, callback: (err: any, data: any) => void) {
    const value = this.objects.get(key);
    if (!value) {
      return callback(new Error("NoSuchKey: " + key), null);
    }
    callback(null, JSON.parse(value.toString()));
  }
  set(key: string, value: any, meta: any, callback: (err: any, data: any) => void) {
    this.objects.set(key, Buffer.from(JSON.stringify(value)));
    this.meta.set(key, meta || {});
    callback(null, null);
  }
  head(key: string, callback: (err: any, data: any) => void) {
    if (!this.objects.has(key)) {
      return callback(new Error("NotFound"), null);
    }
    callback(null, { Metadata: this.meta.get(key) || {} });
  }
  remove(key: string, callback: (err: any, data: any) => void) {
    this.objects.delete(key);
    this.meta.delete(key);
    callback(null, null);
  }
  removePath(prefix: string, callback: (err: any, data: any) => void) {
    [...this.objects.keys()]
      .filter((key) => key.indexOf(prefix) === 0)
      .forEach((key) => this.objects.delete(key));
    callback(null, null);
  }
  list(prefix: string, callback: (err: any, data: any) => void) {
    callback(
      null,
      [...this.objects.keys()]
        .filter((key) => key.indexOf(prefix) === 0)
        .sort()
        .map((Key) => ({ Key })),
    );
  }
}

/* ------------------------------------------------------------------ *
 * connection and subscription management
 * ------------------------------------------------------------------ */

const sockets = new Map<string, WebSocket>();
const channels = new Map<string, Set<string>>();

class DevBroadcastService {
  postToClient(_domainName: string, connectionId: string, message: any, callback: (err: any, data: any) => void) {
    const socket = sockets.get(connectionId);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
    callback(null, null);
  }
  broadcast(channelId: string, value: any, callback: (err: any, data: any) => void, exclude?: string) {
    (channels.get(channelId) || new Set()).forEach((connectionId) => {
      if (exclude && connectionId === exclude) {
        return;
      }
      this.postToClient("dev", connectionId, value, () => undefined);
    });
    callback(null, null);
  }
  _sendToChannel(channelId: string, value: any, callback: (err: any, data: any) => void, exclude?: string) {
    this.broadcast(channelId, { channelId, response: value }, callback, exclude);
  }
  subscribe(connectionId: string, channelId: string) {
    if (!channels.has(channelId)) {
      channels.set(channelId, new Set());
    }
    channels.get(channelId)!.add(connectionId);
    this.postToClient("dev", connectionId, { subscribed: channelId }, () => undefined);
  }
  unsubscribe(connectionId: string, channelId: string) {
    const set = channels.get(channelId);
    if (set) {
      set.delete(connectionId);
    }
    this.postToClient("dev", connectionId, { unsubscribed: channelId }, () => undefined);
  }
  dropConnection(connectionId: string) {
    channels.forEach((set) => set.delete(connectionId));
    sockets.delete(connectionId);
  }
}

const store = new MemoryStore() as any;
const broadcastService = new DevBroadcastService() as any;
const crdtStore = new CrdtStore(store);
const crdtService = new CrdtService(crdtStore, broadcastService);
// The store goes in through the constructor: every service inside holds the
// one it was given, so replacing the field afterwards left half of them
// talking to S3 — which is why the runtime routes could not be served here.
const eventSourceService = new EventSourceService(store, crdtStore);
// There is no second Lambda here, so a task's work happens in this process,
// started and not waited for — which is what the worker does anyway.
(eventSourceService as any).tasks.deps.dispatch = async (task: any) => {
  setTimeout(() => {
    (eventSourceService as any).tasks.work(task.taskId, (record: any, cancelled: any) => runTaskLocally(record, cancelled))
      .catch((err: any) => console.error("A task could not be run.", err));
  }, 0);
};
async function runTaskLocally(task: any, cancelled: () => Promise<boolean>): Promise<any> {
  if (await cancelled()) {
    return { cancelled: true };
  }
  if (task.kind === "tests.run") {
    if (task.input && task.input.testId) {
      return await eventSourceService.tests.run(task.graphId, task.input.testId, task.principal, { by: "request" });
    }
    const all: any = await eventSourceService.tests.runAll(task.graphId, task.principal, { by: "request" });
    return { runs: all.runs, failed: all.failed.length };
  }
  if (task.kind === "journey.run") {
    return await eventSourceService.journeys.run(task.graphId, task.input.journeyId, "request", task.principal);
  }
  return { error: `the dev server does not know how to do ${task.kind}`, code: "SCHEMA_INVALID" };
}
(eventSourceService as any).broadcastService = broadcastService;
(eventSourceService as any).crdtService = crdtService;

/**
 * MCP, including the one thing only the streaming endpoint can do: hold a
 * subscriptions/listen open (plan PB-085).  Deployed, that endpoint is a Lambda
 * Function URL; here it is this process, so a client can be pointed at
 * http://localhost:PORT/mcp and watch a graph change while it edits it.
 */
const mcp = makeMcpStreamHandler({
  crdtStore,
  tocStore: (eventSourceService as any).tocStore,
  admission: crdtService.admission,
  revisions: (eventSourceService as any).revisions,
  components: (eventSourceService as any).components,
  proposals: (eventSourceService as any).proposals,
  summaries: (eventSourceService as any).summaries,
  delegations: (eventSourceService as any).delegations,
  journeys: (eventSourceService as any).journeys,
  tests: (eventSourceService as any).tests,
  tasks: (eventSourceService as any).tasks,
  simulations: (eventSourceService as any).simulations,
  consumers: (eventSourceService as any).consumers,
  iac: (eventSourceService as any).iac,
} as any, { store, pollMs: 500 });

function apiEvent(connectionId: string, body: any) {
  return {
    body: JSON.stringify(body),
    requestContext: {
      connectionId,
      domainName: "localhost",
      identity: { userArn: "dev:" + connectionId },
      authorizer: { sub: "dev:" + connectionId, kind: "human", tenant: "personal:dev", scopes: "[]" },
    },
  };
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
};

/** API Gateway hands handlers a plain object, not a URLSearchParams. */
function searchParamsToObject(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  params.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
    });
    request.on("end", () => resolve(data));
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://localhost:${PORT}`);
  const path = url.pathname.replace(/^\/+/, "");
  const send = (_err: any, result: any) => {
    const status = (result && result.statusCode) || 200;
    response.writeHead(status, { "Content-Type": "application/json", ...CORS });
    response.end((result && result.body) || "{}");
  };

  if (request.method === "OPTIONS") {
    response.writeHead(204, CORS);
    return response.end();
  }

  const parts = path.split("/");
  try {
    if (path === "debug/keys") {
      // Handy when working on storage: everything the server is holding.
      response.writeHead(200, { "Content-Type": "application/json", ...CORS });
      return response.end(JSON.stringify([...store.objects.keys()], null, 1));
    }
    if (path === "debug/object") {
      // One object, for a test or a person asking what the store actually holds.
      const key = url.searchParams.get("key") || "";
      const body = store.objects.get(key);
      response.writeHead(body ? 200 : 404, { "Content-Type": "application/json", ...CORS });
      return response.end(body ? body.toString() : "{}");
    }
    if (path === "debug/park" && request.method === "POST") {
      // Staging a hop handed to the browsers, without a server-owned
      // execution to produce one: what the deployed server does inside
      // `deliver`, asked for directly.
      const body = JSON.parse((await readBody(request)) || "{}");
      const parked = await eventSourceService.parking.park(body.graphId, body.delivery, body.ttlMs);
      response.writeHead(parked ? 200 : 400, { "Content-Type": "application/json", ...CORS });
      return response.end(JSON.stringify(parked || { error: "that is not a delivery" }));
    }
    if (path === "debug/run" && request.method === "POST") {
      // Running a graph *here*, the way the deployed server runs one.  The
      // dev server could serve everything about an execution except starting
      // one, which left the server half of a linked or published component
      // testable only against AWS.
      const body = JSON.parse((await readBody(request)) || "{}");
      const graph = await crdtStore.projectGraph(body.graphId);
      if (!graph || !Array.isArray(graph.nodes)) {
        response.writeHead(404, { "Content-Type": "application/json", ...CORS });
        return response.end(JSON.stringify({ error: "no such graph", graphId: body.graphId }));
      }
      const entry = graph.nodes.find((n: any) => n.url === body.nodeUrl || n.id === body.nodeUrl);
      if (!entry) {
        response.writeHead(404, { "Content-Type": "application/json", ...CORS });
        return response.end(JSON.stringify({ error: "no such node", nodeUrl: body.nodeUrl }));
      }
      const runner = new ExecutionRunner(store);
      const summary = await runner.run({
        graph,
        nodeUrl: entry.url,
        field: body.field || "in",
        value: body.value,
        principal: DEV_PRINCIPAL,
        revisionId: "live",
        budget: { wallMs: 20000, hops: 10000, fanOut: 1000, depth: 64, ...(body.budget || {}) },
        // What a linked node asks for by path: the published component first,
        // then the 2.0 artifact, then the live document — the same order the
        // deployed server answers in (graphService.resolveArtifact).
        resolve: async (artifactPath: string) => {
          const match = /^artifacts\/(graph|nodes)\/(.+)\.(\d+)$/.exec(String(artifactPath || ""));
          if (!match) {
            return null;
          }
          const [, kind, id, version] = match;
          const get = (key: string) => new Promise<any | null>((res) => store.get(key, (err: any, data: any) => res(err ? null : data)));
          const component: any = await get(`components/${id}/${version}/artifact.json`);
          if (component) {
            return component.artifact || component;
          }
          const legacy: any = await get(`graphs/projections/published/artifacts/${id}.${version}.json`);
          if (legacy) {
            return legacy.artifact || legacy;
          }
          if (kind === "graph") {
            return await get(`graphs/projections/latest/${id}.json`);
          }
          return null;
        },
        deliver: async (d: any) => {
          await eventSourceService.parking.park(body.graphId, d).catch(() => undefined);
          broadcastService._sendToChannel("graph-notify-" + body.graphId, { ...d, eventType: "edge.deliver" }, () => undefined);
        },
      } as any);
      response.writeHead(200, { "Content-Type": "application/json", ...CORS });
      return response.end(JSON.stringify(summary));
    }
    if (path === "debug/sweep" && request.method === "POST") {
      // The tick that would do this in production is EventBridge; here it is
      // a request, so parking and its time limit can be exercised locally.
      const swept = await eventSourceService.parking.sweep();
      response.writeHead(200, { "Content-Type": "application/json", ...CORS });
      return response.end(JSON.stringify(swept));
    }
    if (path === "mcp" || path === "mcp/stream") {
      // Served by the streaming handler whichever path it came in on: one
      // endpoint that answers requests and holds subscriptions open.
      const body = await readBody(request);
      const headers = new Headers();
      Object.keys(request.headers).forEach((k) => {
        const value = request.headers[k];
        if (typeof value === "string") {
          headers.set(k, value);
        }
      });
      headers.delete("authorization");            // nothing here authenticates
      const served = await mcp.serve(
        new Request(`http://localhost:${PORT}/${path}`, { method: request.method || "POST", headers, body: body || undefined }),
        DEV_PRINCIPAL as any,
      );
      const outHeaders: Record<string, string> = { ...CORS };
      served.headers.forEach((value, key) => { outHeaders[key] = value; });
      response.writeHead(served.status, outHeaders);
      if (!served.body) {
        return response.end(await served.text());
      }
      const reader = (served.body as any).getReader();
      request.on("close", () => reader.cancel().catch(() => undefined));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        response.write(Buffer.from(value));
      }
      return response.end();
    }
    if (path === "toc.json") {
      return eventSourceService.getToc({}, {}, send);
    }
    if (parts[0] === "crdt" && parts[2] === "state" && parts.length === 3) {
      return crdtService.getState(
        {
          pathParameters: { id: parts[1] },
          // API Gateway hands the handler its query string this way, so the
          // state vector exchange is exercised here exactly as in production.
          queryStringParameters: searchParamsToObject(url.searchParams),
        },
        {},
        send,
      );
    }
    if (parts[0] === "crdt" && parts[2] === "state" && parts.length === 4) {
      return crdtService.getStateAt(
        { pathParameters: { id: parts[1], updateId: parts[3] } }, {}, send);
    }
    if (parts[0] === "crdt" && parts[2] === "history") {
      return crdtService.getHistory({ pathParameters: { id: parts[1] } }, {}, send);
    }
    if (parts[0] === "crdt" && parts[2] === "update") {
      const body = await readBody(request);
      return crdtService.postUpdate(
        { pathParameters: { id: parts[1] }, body, requestContext: { identity: { userArn: "dev:http" }, authorizer: { sub: "dev:http", kind: "human", tenant: "personal:dev", scopes: "[]" } } },
        {}, send);
    }
    if (parts[0] === "crdt" && parts[2] === "checkpoint") {
      return crdtService.checkpoint({ pathParameters: { id: parts[1] } }, {}, send);
    }
    if (parts[0] === "crdt" && parts[2] === "publish" && request.method === "POST") {
      const body = await readBody(request);
      return eventSourceService.components.publishRoute(
        { pathParameters: { id: parts[1] }, body, principal: { sub: "dev:http", kind: "human", tenant: "personal:dev", scopes: [] } }, {}, send);
    }
    /* the runtime routes: what ran, what crossed a wire, and the hops handed
       between the two domains (plan §4.5.3, §4.8.2) */
    if (parts[0] === "crdt" && parts[2] === "executions" && request.method === "POST") {
      const body = await readBody(request);
      return eventSourceService.executions.route({ pathParameters: { id: parts[1] }, body, principal: DEV_PRINCIPAL }, {}, send);
    }
    if (parts[0] === "crdt" && parts[2] === "executions") {
      return eventSourceService.executions.listRoute({
        pathParameters: { id: parts[1], executionId: parts[3] },
        queryStringParameters: searchParamsToObject(url.searchParams),
        principal: DEV_PRINCIPAL,
      }, {}, send);
    }
    if (parts[0] === "crdt" && parts[2] === "observations") {
      return eventSourceService.executions.queryRoute({
        pathParameters: { id: parts[1] },
        queryStringParameters: searchParamsToObject(url.searchParams),
        principal: DEV_PRINCIPAL,
      }, {}, send);
    }
    if (parts[0] === "crdt" && parts[2] === "deliveries" && parts[3] === "pending") {
      return eventSourceService.parking.pendingRoute({
        pathParameters: { id: parts[1] },
        queryStringParameters: searchParamsToObject(url.searchParams),
        principal: DEV_PRINCIPAL,
      }, {}, send);
    }
    if (parts[0] === "crdt" && parts[2] === "deliveries" && parts[3] === "claim" && request.method === "POST") {
      const body = await readBody(request);
      return eventSourceService.parking.claimRoute({ pathParameters: { id: parts[1] }, body, principal: DEV_PRINCIPAL }, {}, send);
    }
    if (parts[0] === "crdt" && parts[2] === "deliveries" && request.method === "POST") {
      const body = await readBody(request);
      return eventSourceService.deliveries.route({ pathParameters: { id: parts[1] }, body, principal: DEV_PRINCIPAL }, {}, send);
    }
    if (parts[0] === "components" && parts.length === 2) {
      return eventSourceService.components.listRoute({ pathParameters: { id: parts[1] } }, {}, send);
    }
    if (parts[0] === "crdt" && parts[2] === "iac") {
      const body = await readBody(request);
      return eventSourceService.iac.route({
        pathParameters: { id: parts[1], nodeId: parts[3] },
        httpMethod: parts[4] === "plan" ? "POST" : request.method,
        body, principal: DEV_PRINCIPAL,
      }, {}, send);
    }
    if (parts[0] === "crdt" && parts[2] === "stacks") {
      return eventSourceService.iac.overview(parts[1], DEV_PRINCIPAL as any)
        .then((body: any) => send(null, { statusCode: body && body.error ? 400 : 200, body: JSON.stringify(body) }));
    }
    if (parts[0] === "components" && parts[1] === "consumers" && parts[2] === "rebuild") {
      return eventSourceService.consumers.rebuildRoute({ principal: DEV_PRINCIPAL }, {}, send);
    }
    if (parts[0] === "components" && parts[2] === "consumers") {
      return eventSourceService.consumers.route({
        pathParameters: { id: parts[1] },
        queryStringParameters: searchParamsToObject(url.searchParams),
        principal: DEV_PRINCIPAL,
      }, {}, send);
    }
    if (parts[0] === "components" && parts.length === 3) {
      return eventSourceService.components.getRoute({ pathParameters: { id: parts[1], version: parts[2] } }, {}, send);
    }
    if (parts[0] === "artifacts" && parts.length === 3) {
      return eventSourceService.getArtifact(
        { pathParameters: { id: parts[1], version: parts[2] } }, {}, send);
    }
    if (parts[0] === "graph" && parts.length === 3) {
      return eventSourceService.getGraph(
        { pathParameters: { id: parts[1], version: parts[2] } }, {}, send);
    }
    response.writeHead(404, CORS);
    response.end("{}");
  } catch (err) {
    console.error("Request failed", path, err);
    response.writeHead(500, CORS);
    response.end("{}");
  }
});

/* ------------------------------------------------------------------ *
 * WebSocket
 * ------------------------------------------------------------------ */

const wss = new WebSocketServer({ server });
let nextConnectionId = 0;

wss.on("connection", (socket) => {
  const connectionId = "conn-" + (nextConnectionId += 1);
  sockets.set(connectionId, socket);
  console.log("connected", connectionId);

  socket.on("message", (raw) => {
    let message: any;
    try {
      message = JSON.parse(raw.toString());
    } catch (err) {
      return console.error("Cannot parse a message", raw.toString());
    }
    const event = apiEvent(connectionId, message);
    const reply = (_err: any, _result: any) => undefined;
    switch (message.action) {
      case "subscribe":
        return broadcastService.subscribe(connectionId, message.channelId);
      case "unsubscribe":
        return broadcastService.unsubscribe(connectionId, message.channelId);
      case "yjs":
        return crdtService.sync(event, {}, reply);
      case "getGraph":
        return eventSourceService.getGraphWs(event, {}, reply);
      case "deleteGraph":
        return eventSourceService.deleteGraphWs(event, {}, reply);
      case "publishGraph":
        return eventSourceService.publishGraphWs(event, {}, reply);
      case "publishNode":
        return eventSourceService.publishNodeWs(event, {}, reply);
      default:
        console.log("ignoring action", message.action);
    }
  });

  socket.on("close", () => {
    console.log("disconnected", connectionId);
    broadcastService.dropConnection(connectionId);
  });
});

server.listen(PORT, () => {
  console.log(`Graph dev server on http://localhost:${PORT}/ and ws://localhost:${PORT}/`);
});
