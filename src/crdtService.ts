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
import { subjectOf, principalFromAuthorizerContext } from "./auth/principal";
import { parseEnvelope, isEnvelopeError } from "./admission/envelope";
import { AdmissionService, AdmissionResult } from "./admission/admit";
import { POLICY_VERSION } from "./policy/decide";
import BroadcastService from "./broadcastService";
import TocStore from "./tocStore";
import { ensureBuilt, listGraph } from "./tocService";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": true,
};

/** How stale the JSON projection is allowed to get before a write refreshes it. */
const CHECKPOINT_INTERVAL_MS = Number(process.env.CHECKPOINT_INTERVAL_MS || 10000);

function userIdOf(event: any): string {
  return subjectOf(event);
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
  admission: AdmissionService;
  store: CrdtStore;
  tocStore: TocStore;
  broadcastService: BroadcastService;
  okResponse: { statusCode: number };

  constructor(store?: CrdtStore, broadcastService?: BroadcastService, tocStore?: TocStore) {
    this.store = store || new CrdtStore();
    this.broadcastService = broadcastService || new BroadcastService();
    this.tocStore = tocStore || new TocStore(this.store.store);
    this.admission = new AdmissionService(this.store);
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

  /** Send an admitted update to every replica of a graph (used by the revision service). */
  fanOutUpdate(graphId: string, content: Uint8Array): Promise<void> {
    return this.fanOut(graphId, "sync", writeUpdate(content));
  }

  /** A message on the graph's notification channel (activation, revision cuts). */
  notifyGraph(graphId: string, event: any): Promise<void> {
    return new Promise((resolve) => {
      this.broadcastService._sendToChannel(`graph-notify-${graphId}`, event, (err: any) => {
        if (err) {
          console.error("Cannot notify a graph channel.", err);
        }
        resolve();
      });
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
      const graph = await this.store.writeProjections(graphId);
      await this.listGraph(graph);
    } catch (err) {
      console.error("Checkpoint failed.", graphId, err);
    }
  }

  /**
   * Put this graph's entry in the list.
   *
   * Writing the projection is not enough on its own: without this a graph
   * someone has just created has a document and a projection but never turns
   * up on anybody's list.  Only this graph's entry is written, so the cost
   * does not grow with how many graphs there are.
   */
  private async listGraph(graph: any): Promise<void> {
    if (!graph || !graph.id) {
      return;
    }
    try {
      await ensureBuilt(this.tocStore);
      await listGraph(
        this.tocStore,
        this.broadcastService,
        graph,
        (graph.properties && graph.properties.lastUpdatedBy) || "Unknown",
      );
    } catch (err) {
      console.error("Cannot list the graph.", graph.id, err);
    }
  }

  /** Force the JSON projection up to date, for publishing and reads. */
  async ensureProjection(graphId: string): Promise<any | null> {
    if (!(await this.store.exists(graphId))) {
      return null;
    }
    await this.store.writeSnapshot(graphId);
    const graph = await this.store.writeProjections(graphId);
    await this.listGraph(graph);
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

    // A step 2 reply or a live update: admit it, then pass on exactly what was admitted.
    const result = await this.admitEnvelope(event, body, message.content);
    await this.post(event, { channelId: channelIdFor(graphId), response: { kind: result.decision === "accepted" ? "ack" : "reject", graphId, ...result } });
    if (result.decision !== "accepted") {
      return;
    }
    await this.fanOut(graphId, "sync", writeUpdate(message.content), ctx.connectionId);
    await this.maybeCheckpoint(graphId);
  }

  /** Run the envelope through admission with the server-derived principal. */
  private async admitEnvelope(event: any, body: any, content: Uint8Array): Promise<AdmissionResult> {
    const parsed = parseEnvelope(body);
    if (isEnvelopeError(parsed)) {
      return { mutationId: typeof body.mutationId === "string" ? body.mutationId : "", decision: "rejected", code: parsed.code, reason: parsed.reason, policyVersion: POLICY_VERSION };
    }
    const principal = event.principal || principalFromAuthorizerContext(event);
    return this.admission.admit({
      graphId: parsed.graphId,
      mutationId: parsed.mutationId,
      legacy: parsed.legacy,
      content,
      description: parsed.description,
      intent: parsed.intent,
      clientInfo: parsed.clientInfo,
      principal,
    });
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
    let message;
    try {
      message = readSyncMessage(fromBase64(body.payload));
    } catch (err) {
      return callback(null, { statusCode: 400, body: JSON.stringify({ decision: "rejected", code: "SCHEMA_INVALID", reason: "payload is not a sync message" }), headers: corsHeaders });
    }
    this.admitEnvelope(event, { ...body, graphId }, message.content)
      .then(async (result) => {
        if (result.decision === "accepted") {
          await this.fanOut(graphId, "sync", writeUpdate(message.content), body.origin);
          await this.maybeCheckpoint(graphId);
        }
        const statusCode = result.decision === "accepted" ? 200 : result.code === "ADMISSION_DENIED" ? 403 : 400;
        callback(null, { statusCode, body: JSON.stringify({ ok: result.decision === "accepted", ...result }), headers: corsHeaders });
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
