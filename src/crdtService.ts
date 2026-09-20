import * as Y from "yjs";
import {
  MESSAGE_SYNC_STEP1,
  readSyncMessage,
  writeSyncStep1,
  writeSyncStep2,
  writeUpdate,
  toBase64,
  fromBase64,
  channelIdFor,
  UPDATE_FORMAT,
  encodeState,
  mergeUpdates,
  diffUpdate,
  stateVectorFromUpdate,
  encodeStateVector,
} from "@plastic-io/graph-crdt";
import CrdtStore, { decodeUlidTime } from "./crdtStore";
import BroadcastService from "./broadcastService";
import { updateToc } from "./tocService";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": true,
};

/** How stale the JSON projection is allowed to get before a write refreshes it. */
const CHECKPOINT_INTERVAL_MS = Number(process.env.CHECKPOINT_INTERVAL_MS || 10000);

function userIdOf(event: any): string {
  const ctx = event && event.requestContext;
  if (!ctx) {
    return "Unknown";
  }
  return (ctx.identity && ctx.identity.userArn) || ctx.connectionId || "Unknown";
}

/**
 * Collaborative editing over the existing API Gateway WebSocket.
 *
 * The important property of this service is that handling an edit never reads
 * the graph.  An update is written to its own object and fanned out, and that
 * is the whole hot path.  Merging is the reader's job, and Yjs updates
 * commute, so two people editing the same graph at the same moment cannot
 * overwrite one another the way the previous read-modify-write projection did.
 */
export default class CrdtService {
  store: CrdtStore;
  broadcastService: BroadcastService;
  okResponse: { statusCode: number };

  constructor(store?: CrdtStore, broadcastService?: BroadcastService) {
    this.store = store || new CrdtStore();
    this.broadcastService = broadcastService || new BroadcastService();
    this.okResponse = { statusCode: 200 };
  }

  private post(event: any, payload: any): Promise<void> {
    const ctx = event.requestContext;
    return new Promise((resolve) => {
      if (!ctx || !ctx.connectionId) {
        return resolve();
      }
      this.broadcastService.postToClient(ctx.domainName, ctx.connectionId, payload, (err) => {
        if (err) {
          console.error("Cannot post a sync message to the client.", err);
        }
        resolve();
      });
    });
  }

  private fanOut(graphId: string, kind: string, payload: Uint8Array, excludeConnectionId?: string): Promise<void> {
    return new Promise((resolve) => {
      this.broadcastService._sendToChannel(
        channelIdFor(graphId),
        { kind, graphId, payload: toBase64(payload) },
        (err) => {
          if (err) {
            console.error("Cannot fan out a sync message.", err);
          }
          resolve();
        },
        excludeConnectionId,
      );
    });
  }

  /**
   * Refresh the JSON projection when it has gone stale.  Graph execution,
   * publishing and the table of contents all still read those files, so they
   * have to keep up, but regenerating them on every keystroke would undo the
   * point of a cheap write path.
   */
  private async maybeCheckpoint(graphId: string): Promise<void> {
    try {
      const snapshot = await this.store.latestSnapshot(graphId);
      const age = snapshot ? Date.now() - decodeUlidTime(snapshot.id) : Infinity;
      if (age < CHECKPOINT_INTERVAL_MS) {
        return;
      }
      await this.store.writeSnapshot(graphId);
      await this.store.writeProjections(graphId);
      await this.refreshGraphList();
    } catch (err) {
      console.error("Checkpoint failed.", graphId, err);
    }
  }

  /**
   * Rebuild the list of graphs.
   *
   * Writing the projection is not enough on its own: without this a graph
   * someone has just created has a document and a projection but never turns
   * up on anybody's list.
   */
  private refreshGraphList(): Promise<void> {
    return new Promise((resolve) => {
      updateToc(this.store.store, this.broadcastService, (err) => {
        if (err) {
          console.error("Cannot refresh the graph list.", err);
        }
        resolve();
      });
    });
  }

  /** Force the JSON projection up to date, for publishing and reads. */
  async ensureProjection(graphId: string): Promise<any | null> {
    if (!(await this.store.exists(graphId))) {
      return null;
    }
    await this.store.writeSnapshot(graphId);
    const graph = await this.store.writeProjections(graphId);
    await this.refreshGraphList();
    return graph;
  }

  /* ------------------------------------------------------ websocket */

  async handleMessage(event: any): Promise<void> {
    const body = JSON.parse(event.body);
    const graphId = body.graphId;
    const ctx = event.requestContext || {};
    if (!graphId) {
      throw new TypeError("A sync message arrived without a graphId.");
    }

    if (body.kind === "awareness") {
      // Presence has its own encoding, is ephemeral by definition, and is
      // fanned out without ever being stored.
      await this.fanOut(graphId, "awareness", fromBase64(body.payload), ctx.connectionId);
      return;
    }

    // A client speaking the other update encoding must be turned away rather
    // than have its bytes stored: Yjs would decode them into a different
    // document instead of reporting a problem.
    if (body.format !== undefined && body.format !== UPDATE_FORMAT) {
      console.error(
        `Refusing a sync message in update format ${body.format}; this server speaks ${UPDATE_FORMAT}.`,
      );
      return;
    }

    const message = readSyncMessage(fromBase64(body.payload));

    if (message.type === MESSAGE_SYNC_STEP1) {
      const { update } = await this.store.loadMerged(graphId);
      const empty = encodeState(new Y.Doc());
      const missing = update ? diffUpdate(update, message.content) : empty;
      await this.post(event, {
        channelId: channelIdFor(graphId),
        response: {
          kind: "sync",
          graphId,
          payload: toBase64(writeSyncStep2(missing)),
        },
      });
      // Ask for whatever the client has that we do not, which is how work done
      // offline gets back in.
      const serverVector = update
        ? stateVectorFromUpdate(update)
        : encodeStateVector(new Y.Doc());
      await this.post(event, {
        channelId: channelIdFor(graphId),
        response: {
          kind: "sync",
          graphId,
          payload: toBase64(writeSyncStep1(serverVector)),
        },
      });
      return;
    }

    // A step 2 reply or a live update: record it and pass it on.
    await this.store.appendUpdate(
      graphId,
      message.content,
      body.description || "Change",
      userIdOf(event),
    );
    await this.fanOut(graphId, "sync", writeUpdate(message.content), ctx.connectionId);
    await this.maybeCheckpoint(graphId);
  }

  sync(event: any, context: any, callback: (err: any, response: any) => void) {
    this.handleMessage(event)
      .then(() => callback(null, this.okResponse))
      .catch((err) => {
        console.error("Sync message failed.", err);
        callback(null, this.okResponse);
      });
  }

  /* ------------------------------------------------------ http */

  /**
   * The document, for the initial load.  This goes over HTTP because a whole
   * graph does not fit in a WebSocket frame.
   *
   * A caller that already holds part of the graph, which is any browser that
   * has opened it before, sends its state vector as `sv`.  The reply then
   * carries only what that caller is missing, following the state vector
   * exchange Yjs documents for syncing without loading the document into
   * memory: `diffUpdate(storedState, theirStateVector)`.
   *
   * The reply also carries the server's own state vector, so the caller can
   * work out what the server is missing and push it in the same round trip
   * rather than waiting for the socket handshake.
   */
  getState(event: any, context: any, callback: (err: any, response: any) => void) {
    const graphId = event.pathParameters.id;
    const query = event.queryStringParameters || {};
    this.store
      .loadMerged(graphId)
      .then(({ update }) => {
        if (!update) {
          return callback(null, {
            statusCode: 200,
            body: JSON.stringify({
              graphId,
              exists: false,
              format: UPDATE_FORMAT,
              payload: null,
              stateVector: null,
            }),
            headers: corsHeaders,
          });
        }
        const serverVector = stateVectorFromUpdate(update);
        let payload = update;
        if (query.sv) {
          try {
            payload = diffUpdate(update, fromBase64(query.sv));
          } catch (err) {
            console.warn("Unusable state vector; sending the whole document.", err);
          }
        }
        callback(null, {
          statusCode: 200,
          body: JSON.stringify({
            graphId,
            exists: true,
            format: UPDATE_FORMAT,
            payload: toBase64(payload),
            stateVector: toBase64(serverVector),
          }),
          headers: corsHeaders,
        });
      })
      .catch((err) => {
        console.error("Cannot read the document state.", err);
        callback(null, { statusCode: 500, headers: corsHeaders });
      });
  }

  /** The action log for the rewind transport. */
  getHistory(event: any, context: any, callback: (err: any, response: any) => void) {
    this.store
      .history(event.pathParameters.id)
      .then((history) => {
        callback(null, {
          statusCode: 200,
          body: JSON.stringify(history),
          headers: corsHeaders,
        });
      })
      .catch((err) => {
        console.error("Cannot read the graph history.", err);
        callback(null, { statusCode: 500, headers: corsHeaders });
      });
  }

  /** The graph as it stood at a point in the log, as one merged update. */
  getStateAt(event: any, context: any, callback: (err: any, response: any) => void) {
    const graphId = event.pathParameters.id;
    const id = event.pathParameters.updateId;
    this.store
      .updatesUpTo(graphId, id)
      .then((updates) => {
        const merged = updates.length > 0 ? mergeUpdates(updates) : null;
        callback(null, {
          statusCode: 200,
          body: JSON.stringify({
            graphId,
            format: UPDATE_FORMAT,
            payload: merged ? toBase64(merged) : null,
          }),
          headers: corsHeaders,
        });
      })
      .catch((err) => {
        console.error("Cannot rebuild a past state.", err);
        callback(null, { statusCode: 500, headers: corsHeaders });
      });
  }

  /** Fallback for updates too large for a WebSocket frame. */
  postUpdate(event: any, context: any, callback: (err: any, response: any) => void) {
    const graphId = event.pathParameters.id;
    const body = JSON.parse(event.body);
    if (body.format !== undefined && body.format !== UPDATE_FORMAT) {
      return callback(null, {
        statusCode: 409,
        body: JSON.stringify({
          error: `This server speaks update format ${UPDATE_FORMAT}.`,
        }),
        headers: corsHeaders,
      });
    }
    const message = readSyncMessage(fromBase64(body.payload));
    this.store
      .appendUpdate(graphId, message.content, body.description || "Change", userIdOf(event))
      .then(() => this.fanOut(graphId, "sync", writeUpdate(message.content), body.origin))
      .then(() => this.maybeCheckpoint(graphId))
      .then(() => {
        callback(null, {
          statusCode: 200,
          body: JSON.stringify({ ok: true }),
          headers: corsHeaders,
        });
      })
      .catch((err) => {
        console.error("Cannot store an update posted over HTTP.", err);
        callback(null, { statusCode: 500, headers: corsHeaders });
      });
  }

  /** Force the snapshot and JSON projections up to date. */
  checkpoint(event: any, context: any, callback: (err: any, response: any) => void) {
    this.ensureProjection(event.pathParameters.id)
      .then((graph) => {
        callback(null, {
          statusCode: 200,
          body: JSON.stringify({ ok: !!graph, version: graph ? graph.version : null }),
          headers: corsHeaders,
        });
      })
      .catch((err) => {
        console.error("Checkpoint failed.", err);
        callback(null, { statusCode: 500, headers: corsHeaders });
      });
  }
}
