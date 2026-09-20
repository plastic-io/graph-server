import * as Y from "yjs";
import { monotonicFactory } from "ulid";
import {
  toJSON,
  UPDATE_FORMAT,
  applyUpdate,
  mergeUpdates,
} from "@plastic-io/graph-crdt";
import S3Service from "./s3Service";

/**
 * Storage for the collaborative document of one graph.
 *
 * The layout is deliberately append-only.  A write never reads, so two people
 * editing at the same time cannot overwrite each other, which is precisely the
 * failure the previous read-modify-write projection had.  Merging is left to
 * the reader, and Yjs updates commute, so the order objects land in does not
 * matter.
 *
 *   graphs/<id>/crdt/snapshots/<ulid>.bin        merged state up to <ulid>
 *   graphs/<id>/crdt/updates/<ulid>~<label>.bin  one update
 *
 * Snapshots are an optimisation, never a source of truth: a reader takes the
 * newest snapshot plus every update that sorts after it.  Updates are kept
 * after a snapshot is written, because the log is also what rewind reads, and
 * because keeping them means a snapshot write can never race a delete into
 * losing data.
 */

const MAX_LABEL = 160;

/**
 * Plain ULIDs generated in the same millisecond sort in random order, which
 * would make the log's ordering ambiguous.  The monotonic factory guarantees
 * increasing ids within a process.
 */
const ulid = monotonicFactory();

/**
 * Two Lambda instances can still mint ids in the same millisecond, so a
 * snapshot cannot assume that every id below its own sorts before it.  Reading
 * a little further back than strictly necessary closes that window: Yjs
 * updates are idempotent, so folding one in twice changes nothing, while
 * missing one would lose an edit.
 */
const SNAPSHOT_SAFETY_WINDOW_MS = 60000;

export interface HistoryEntry {
  seq: number;
  id: string;
  time: number;
  description: string;
  userId: string;
}

/**
 * The update format is part of the path.
 *
 * Yjs does not reject an update written in the other encoding, it decodes it
 * into the wrong document, so the two must never end up in the same listing.
 * Putting the format in the prefix makes that structurally impossible and
 * leaves room to migrate by writing a new prefix rather than rewriting one.
 */
/** Where a document's objects live.  Graphs sit under `graphs`; the index of
 * graphs sits under `index`, so the two never appear in one listing. */
const DEFAULT_ROOT = "graphs";

function snapshotPrefix(root: string, id: string): string {
  return `${root}/${id}/crdt/v${UPDATE_FORMAT}/snapshots/`;
}

function updatePrefix(root: string, id: string): string {
  return `${root}/${id}/crdt/v${UPDATE_FORMAT}/updates/`;
}

/** Every prefix a document's collaborative state has ever used, for deletion. */
function allCrdtPrefixes(root: string, id: string): string[] {
  return [`${root}/${id}/crdt/`];
}

/** Descriptions travel in the object key so that listing a log is one call. */
export function encodeLabel(description: string, userId: string): string {
  const raw = JSON.stringify({ d: description || "", u: userId || "" });
  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
    .slice(0, MAX_LABEL);
}

export function decodeLabel(label: string): { description: string; userId: string } {
  try {
    const padded = label.replace(/-/g, "+").replace(/_/g, "/");
    const raw = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(raw);
    return { description: parsed.d || "Change", userId: parsed.u || "Unknown" };
  } catch (err) {
    return { description: "Change", userId: "Unknown" };
  }
}

function parseUpdateKey(key: string): { id: string; description: string; userId: string } | null {
  const name = key.substring(key.lastIndexOf("/") + 1);
  const match = /^([0-9A-HJKMNP-TV-Z]{26})~([^.]*)\.bin$/.exec(name);
  if (!match) {
    return null;
  }
  return { id: match[1], ...decodeLabel(match[2]) };
}

function parseSnapshotKey(key: string): string | null {
  const name = key.substring(key.lastIndexOf("/") + 1);
  const match = /^([0-9A-HJKMNP-TV-Z]{26})\.bin$/.exec(name);
  return match ? match[1] : null;
}

export default class CrdtStore {
  store: S3Service;
  readonly root: string;

  constructor(store?: S3Service, options: { root?: string } = {}) {
    this.store = store || new S3Service(process.env.S3_BUCKET);
    this.root = options.root || DEFAULT_ROOT;
  }

  private snapshots(id: string): string {
    return snapshotPrefix(this.root, id);
  }

  private updates(id: string): string {
    return updatePrefix(this.root, id);
  }

  /* ---------------------------------------------------------- promises */

  private list(prefix: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
      this.store.list(prefix, (err, items) => {
        if (err) {
          return reject(err);
        }
        resolve(items || []);
      });
    });
  }

  private getRaw(key: string): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      this.store.getRaw(key, (err, body) => {
        if (err) {
          if (/NoSuchKey|NotFound/.test(String(err))) {
            return resolve(null);
          }
          return reject(err);
        }
        resolve(body);
      });
    });
  }

  private setRaw(key: string, body: Buffer, meta: any): Promise<void> {
    return new Promise((resolve, reject) => {
      this.store.setRaw(key, body, meta, (err) => (err ? reject(err) : resolve()));
    });
  }

  private setJson(key: string, value: any, meta: any): Promise<void> {
    return new Promise((resolve, reject) => {
      this.store.set(key, value, meta, (err) => (err ? reject(err) : resolve()));
    });
  }

  /* ---------------------------------------------------------- reading */

  /** The newest snapshot for a graph, or null when there is none yet. */
  async latestSnapshot(graphId: string): Promise<{ id: string; body: Buffer } | null> {
    const items = await this.list(this.snapshots(graphId));
    const ids = items
      .map((item) => ({ key: item.Key, id: parseSnapshotKey(item.Key) }))
      .filter((item) => item.id)
      .sort((a, b) => (a.id! < b.id! ? -1 : 1));
    if (ids.length === 0) {
      return null;
    }
    const newest = ids[ids.length - 1];
    const body = await this.getRaw(newest.key);
    if (!body) {
      return null;
    }
    return { id: newest.id!, body };
  }

  /** Every update that is not already folded into `afterId`, oldest first. */
  async listUpdates(graphId: string, afterId?: string): Promise<
    { key: string; id: string; description: string; userId: string }[]
  > {
    const items = await this.list(this.updates(graphId));
    return items
      .map((item) => {
        const parsed = parseUpdateKey(item.Key);
        return parsed ? { key: item.Key, ...parsed } : null;
      })
      .filter((item): item is { key: string; id: string; description: string; userId: string } => !!item)
      .filter((item) => {
        if (!afterId) {
          return true;
        }
        if (item.id > afterId) {
          return true;
        }
        return decodeUlidTime(item.id) >= decodeUlidTime(afterId) - SNAPSHOT_SAFETY_WINDOW_MS;
      })
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /**
   * The whole document as one merged Yjs update, or null when the graph has
   * no collaborative state yet.
   */
  async loadMerged(graphId: string): Promise<{ update: Uint8Array | null; headId: string | null }> {
    const snapshot = await this.latestSnapshot(graphId);
    const updates = await this.listUpdates(graphId, snapshot ? snapshot.id : undefined);
    const parts: Uint8Array[] = [];
    if (snapshot) {
      parts.push(new Uint8Array(snapshot.body));
    }
    for (const entry of updates) {
      const body = await this.getRaw(entry.key);
      if (body) {
        parts.push(new Uint8Array(body));
      }
    }
    if (parts.length === 0) {
      return { update: null, headId: null };
    }
    const newestUpdateId = updates.length > 0 ? updates[updates.length - 1].id : null;
    const headId = [newestUpdateId, snapshot ? snapshot.id : null]
      .filter((id): id is string => !!id)
      .sort()
      .pop() || null;
    return { update: mergeUpdates(parts), headId };
  }

  /** The graph projected back into the plain JSON every other service reads. */
  async projectGraph(graphId: string): Promise<any | null> {
    const { update } = await this.loadMerged(graphId);
    if (!update) {
      return null;
    }
    const doc = new Y.Doc();
    applyUpdate(doc, update);
    const graph = toJSON(doc);
    doc.destroy();
    return graph;
  }

  /** The action log, oldest first, for the rewind transport. */
  async history(graphId: string): Promise<HistoryEntry[]> {
    const updates = await this.listUpdates(graphId);
    return updates.map((entry, index) => ({
      seq: index + 1,
      id: entry.id,
      time: decodeUlidTime(entry.id),
      description: entry.description,
      userId: entry.userId,
    }));
  }

  /** Every update up to and including `id`, for replaying a past state. */
  async updatesUpTo(graphId: string, id: string): Promise<Uint8Array[]> {  // eslint-disable-line
    const entries = (await this.listUpdates(graphId)).filter((entry) => entry.id <= id);
    const out: Uint8Array[] = [];
    for (const entry of entries) {
      const body = await this.getRaw(entry.key);
      if (body) {
        out.push(new Uint8Array(body));
      }
    }
    return out;
  }

  /* ---------------------------------------------------------- writing */

  /**
   * Record one update.  This is the hot path and it deliberately does not read
   * anything first, which is what makes concurrent edits safe.
   */
  async appendUpdate(
    graphId: string,
    update: Uint8Array,
    description: string,
    userId: string,
  ): Promise<string> {
    const id = ulid();
    const key = `${this.updates(graphId)}${id}~${encodeLabel(description, userId)}.bin`;
    await this.setRaw(key, Buffer.from(update), {
      "graph-id": graphId,
      "user-id": userId || "Unknown",
      "update-format": String(UPDATE_FORMAT),
    });
    return id;
  }

  /** Fold the log into a snapshot so later reads are one object, not many. */
  async writeSnapshot(graphId: string): Promise<string | null> {
    const { update, headId } = await this.loadMerged(graphId);
    if (!update || !headId) {
      return null;
    }
    await this.setRaw(`${this.snapshots(graphId)}${headId}.bin`, Buffer.from(update), {
      "graph-id": graphId,
      "update-format": String(UPDATE_FORMAT),
    });
    return headId;
  }

  /**
   * Refresh the plain JSON files that graph execution, publishing and the
   * table of contents all still read.
   */
  async writeProjections(graphId: string): Promise<any | null> {
    const graph = await this.projectGraph(graphId);
    if (!graph || !graph.id) {
      return null;
    }
    const meta = {
      id: graph.id,
      name: (graph.properties && graph.properties.name) || "Unnamed",
      version: String(graph.version),
      description: (graph.properties && graph.properties.description) || "No description",
      icon: (graph.properties && graph.properties.icon) || "mdi-graph",
      type: "graph",
      url: graph.url || graph.id,
      "user-id": (graph.properties && graph.properties.lastUpdatedBy) || "Unknown",
    };
    await Promise.all([
      this.setJson(`graphs/projections/latest/${graphId}.json`, graph, meta),
      this.setJson(`graphs/${graphId}/projections/${graphId}.${graph.version}.json`, graph, meta),
      this.setJson(`graphs/projections/endpoints/${graph.url}.json`, graph, {
        ...meta,
        type: "endpoint",
      }),
    ]);
    return graph;
  }

  /** True when the graph has collaborative state stored. */
  async exists(graphId: string): Promise<boolean> {
    const snapshot = await this.list(this.snapshots(graphId));
    if (snapshot.length > 0) {
      return true;
    }
    const updates = await this.list(this.updates(graphId));
    return updates.length > 0;
  }

  /** Seed a graph's document from a pre-CRDT JSON projection. */
  async seedFromJson(graphId: string, graph: any, userId: string): Promise<void> {
    const doc = new Y.Doc();
    const { fromJSON, encodeState } = await import("@plastic-io/graph-crdt");
    fromJSON(graph, doc);
    const update = encodeState(doc);
    doc.destroy();
    await this.appendUpdate(graphId, update, "Start", userId);
  }

  async removeAll(graphId: string): Promise<void> {
    const listings = await Promise.all(allCrdtPrefixes(this.root, graphId).map((p) => this.list(p)));
    const keys = listings.reduce((all, items) => all.concat(items), []).map((item) => item.Key);
    await Promise.all(
      keys.map(
        (key) =>
          new Promise<void>((resolve) => {
            this.store.remove(key, () => resolve());
          }),
      ),
    );
  }
}

/** ULIDs carry their creation time in the first ten characters. */
export function decodeUlidTime(id: string): number {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = 0;
  for (let i = 0; i < 10; i += 1) {
    const index = alphabet.indexOf(id[i]);
    if (index === -1) {
      return 0;
    }
    time = time * 32 + index;
  }
  return time;
}
