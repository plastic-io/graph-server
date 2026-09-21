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

const PORT = Number(process.env.PORT || 3030);

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
const eventSourceService = new EventSourceService();
(eventSourceService as any).store = store;
(eventSourceService as any).broadcastService = broadcastService;
(eventSourceService as any).crdtStore = crdtStore;
(eventSourceService as any).crdtService = crdtService;

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
    if (parts[0] === "components" && parts.length === 2) {
      return eventSourceService.components.listRoute({ pathParameters: { id: parts[1] } }, {}, send);
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
