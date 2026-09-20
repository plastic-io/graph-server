import * as Y from "yjs";
import {
  UPDATE_EVENT,
  applyUpdate,
  mergeUpdates,
  diffUpdate,
  stateVectorFromUpdate,
} from "@plastic-io/graph-crdt";
import CrdtStore from "./crdtStore";
import S3Service from "./s3Service";

/**
 * The list of graphs, as a collaborative document.
 *
 * It used to be one JSON file rebuilt from scratch on every write: list every
 * object under the projections, HEAD each one for its metadata, assemble the
 * whole list and write it back. That is a request per graph per save, and the
 * whole file rewritten each time, so two saves landing together silently threw
 * one of the results away. With a hundred graphs it was already a hundred and
 * twenty round trips per save; there is no size at which it gets better.
 *
 * Now each entry is a key in a Y.Map. Saving a graph writes one small update
 * describing that entry and nothing else, updates from different graphs merge
 * rather than overwrite, and a reader takes a snapshot plus whatever has
 * happened since. Listing is never a fan-out.
 *
 * Deletion is a field on the entry rather than a separate index, so hiding and
 * restoring merge like anything else.
 */

/** The document's id within its storage root. */
export const TOC_DOCUMENT_ID = "toc";

/** Root map holding one entry per listed thing. */
const ENTRIES_KEY = "entries";

/** Legacy file, read once to migrate and then left alone. */
export const legacyTocKey = "graphs/projections/toc.json";

/** Legacy index of hidden graphs, read once to migrate. */
export const legacyDeletedKey = "graphs/projections/deleted.json";

export interface TocEntry {
  id: string;
  name?: string;
  description?: string;
  icon?: string;
  type?: string;
  url?: string;
  version?: string;
  deleted?: boolean;
  deletedOn?: number;
  deletedBy?: string;
  [key: string]: any;
}

/** How many updates may pile up before they are folded into a snapshot. */
const SNAPSHOT_AFTER_UPDATES = 50;

export default class TocStore {
  private crdt: CrdtStore;
  private store: S3Service;

  constructor(store?: S3Service) {
    this.store = store || new S3Service(process.env.S3_BUCKET);
    // A root of its own, so the index never turns up in a listing of graphs.
    this.crdt = new CrdtStore(this.store, { root: "index" });
  }

  /* ------------------------------------------------------------ reading */

  /** The document as stored, or null when there is nothing yet. */
  async loadMerged(): Promise<{ update: Uint8Array | null; headId: string | null }> {
    return this.crdt.loadMerged(TOC_DOCUMENT_ID);
  }

  private async loadDoc(): Promise<Y.Doc> {
    const doc = new Y.Doc();
    const { update } = await this.loadMerged();
    if (update) {
      applyUpdate(doc, update);
    }
    return doc;
  }

  /**
   * The list, in the shape callers have always received: an object keyed by
   * entry key. Hidden graphs are left out.
   */
  async project(options: { includeDeleted?: boolean } = {}): Promise<Record<string, TocEntry>> {
    const doc = await this.loadDoc();
    const entries = doc.getMap(ENTRIES_KEY);
    const out: Record<string, TocEntry> = {};
    entries.forEach((value: any, key: string) => {
      const entry = value instanceof Y.Map ? (value.toJSON() as TocEntry) : value;
      if (!entry || (!options.includeDeleted && entry.deleted)) {
        return;
      }
      out[key] = entry;
    });
    doc.destroy();
    return out;
  }

  /**
   * Every hidden graph, once each.
   *
   * A graph has an entry for itself and another for the endpoint it answers
   * on, and hiding marks both, so they are folded back into one row here.
   */
  async listDeleted(): Promise<TocEntry[]> {
    const all = await this.project({ includeDeleted: true });
    const byGraph = new Map<string, TocEntry>();
    Object.keys(all).forEach((key) => {
      const entry = all[key];
      if (!entry.deleted || !entry.id) {
        return;
      }
      const existing = byGraph.get(entry.id);
      if (!existing || entry.type === "graph") {
        byGraph.set(entry.id, entry);
      }
    });
    return Array.from(byGraph.values());
  }

  /** The whole document, or only what `stateVector` is missing. */
  async encodeFor(stateVector?: Uint8Array): Promise<{ payload: Uint8Array | null; stateVector: Uint8Array | null }> {
    const { update } = await this.loadMerged();
    if (!update) {
      return { payload: null, stateVector: null };
    }
    const mine = stateVectorFromUpdate(update);
    if (!stateVector) {
      return { payload: update, stateVector: mine };
    }
    return { payload: diffUpdate(update, stateVector), stateVector: mine };
  }

  /* ------------------------------------------------------------ writing */

  /**
   * Change the document and store the difference.
   *
   * Only what `mutate` touches is written, so saving a graph costs one small
   * object no matter how many graphs there are.
   */
  private async commit(description: string, userId: string, mutate: (entries: Y.Map<any>) => void): Promise<void> {
    const doc = await this.loadDoc();
    // Take the change from the document as it happens rather than encoding the
    // whole thing before and after and subtracting: the difference is what the
    // update event already carries.
    const produced: Uint8Array[] = [];
    doc.on(UPDATE_EVENT as any, (update: Uint8Array) => produced.push(update));
    doc.transact(() => {
      mutate(doc.getMap(ENTRIES_KEY));
    }, "toc");
    doc.destroy();
    if (produced.length === 0) {
      return;
    }
    await this.crdt.appendUpdate(TOC_DOCUMENT_ID, mergeUpdates(produced), description, userId);
    await this.maybeSnapshot();
  }

  /** Fold the log into a snapshot once enough has piled up. */
  private async maybeSnapshot(): Promise<void> {
    try {
      const snapshot = await this.crdt.latestSnapshot(TOC_DOCUMENT_ID);
      const since = await this.crdt.listUpdates(TOC_DOCUMENT_ID, snapshot ? snapshot.id : undefined);
      if (since.length >= SNAPSHOT_AFTER_UPDATES) {
        await this.crdt.writeSnapshot(TOC_DOCUMENT_ID);
      }
    } catch (err) {
      console.error("Cannot fold the graph list into a snapshot.", err);
    }
  }

  /** Add or update one entry. */
  async put(key: string, entry: TocEntry, userId = "Unknown"): Promise<void> {
    await this.commit(`List ${key}`, userId, (entries) => {
      const existing = entries.get(key);
      const target = existing instanceof Y.Map ? existing : new Y.Map();
      if (!(existing instanceof Y.Map)) {
        entries.set(key, target);
      }
      Object.keys(entry).forEach((field) => {
        if (entry[field] === undefined) {
          return;
        }
        if (target.get(field) !== entry[field]) {
          target.set(field, entry[field]);
        }
      });
      // A graph that is written again is no longer hidden.
      if (target.get("deleted")) {
        target.set("deleted", false);
      }
    });
  }

  /** Add or update several entries in one update. */
  async putMany(items: { key: string; entry: TocEntry }[], userId = "Unknown"): Promise<void> {
    if (items.length === 0) {
      return;
    }
    await this.commit(`List ${items.length} entries`, userId, (entries) => {
      items.forEach(({ key, entry }) => {
        const target = new Y.Map();
        Object.keys(entry).forEach((field) => {
          if (entry[field] !== undefined) {
            target.set(field, entry[field]);
          }
        });
        entries.set(key, target);
      });
    });
  }

  /** Hide every entry belonging to a graph, keeping the entries themselves. */
  async markDeleted(graphId: string, userId = "Unknown"): Promise<void> {
    await this.commit(`Hide ${graphId}`, userId, (entries) => {
      entries.forEach((value: any) => {
        if (value instanceof Y.Map && value.get("id") === graphId) {
          value.set("deleted", true);
          value.set("deletedOn", Date.now());
          value.set("deletedBy", userId);
        }
      });
    });
  }

  /** Put a hidden graph's entries back. */
  async markRestored(graphId: string, userId = "Unknown"): Promise<void> {
    await this.commit(`Restore ${graphId}`, userId, (entries) => {
      entries.forEach((value: any) => {
        if (value instanceof Y.Map && value.get("id") === graphId) {
          value.set("deleted", false);
          value.set("deletedOn", null);
          value.set("deletedBy", null);
        }
      });
    });
  }

  /** Take a graph's entries out of the list for good. */
  async remove(graphId: string, userId = "Unknown"): Promise<void> {
    await this.commit(`Unlist ${graphId}`, userId, (entries) => {
      const doomed: string[] = [];
      entries.forEach((value: any, key: string) => {
        if (value instanceof Y.Map && value.get("id") === graphId) {
          doomed.push(key);
        }
      });
      doomed.forEach((key) => entries.delete(key));
    });
  }

  /* ---------------------------------------------------------- migration */

  /** True when the document has never been written. */
  async isEmpty(): Promise<boolean> {
    const { update } = await this.loadMerged();
    return !update;
  }

  /**
   * Fill an empty document from what is already stored.
   *
   * The old list is read if it is there, because it is one object and already
   * holds everything. Otherwise the projections are walked, which is the
   * expensive path this design exists to avoid and is therefore only taken
   * once.
   */
  async migrate(userId = "migration"): Promise<{ migrated: boolean; entries: number; from: string }> {
    if (!(await this.isEmpty())) {
      return { migrated: false, entries: 0, from: "already built" };
    }
    const fromLegacy = await this.readLegacyToc();
    if (fromLegacy) {
      const deleted = await this.readLegacyDeleted();
      const items = Object.keys(fromLegacy)
        .filter((key) => key !== "id" && fromLegacy[key] && fromLegacy[key].id)
        .map((key) => ({
          key,
          entry: deleted[fromLegacy[key].id]
            ? { ...fromLegacy[key], deleted: true, ...deleted[fromLegacy[key].id] }
            : fromLegacy[key],
        }));
      await this.putMany(items, userId);
      return { migrated: true, entries: items.length, from: "the previous list" };
    }
    const scanned = await this.scanProjections();
    await this.putMany(scanned, userId);
    return { migrated: true, entries: scanned.length, from: "a scan of the projections" };
  }

  /**
   * Rebuild from the projections, merging over whatever is there.
   *
   * This is the repair tool. It is the expensive walk, so nothing calls it on
   * the write path.
   */
  async rebuild(userId = "rebuild"): Promise<{ entries: number }> {
    const scanned = await this.scanProjections();
    await this.putMany(scanned, userId);
    return { entries: scanned.length };
  }

  private readLegacyToc(): Promise<Record<string, any> | null> {
    return new Promise((resolve) => {
      this.store.get(legacyTocKey, (err, toc) => {
        if (err || !toc || Object.keys(toc).length === 0) {
          return resolve(null);
        }
        resolve(toc);
      });
    });
  }

  private readLegacyDeleted(): Promise<Record<string, any>> {
    return new Promise((resolve) => {
      this.store.get(legacyDeletedKey, (err, index) => {
        resolve(err || !index ? {} : index);
      });
    });
  }

  private scanProjections(): Promise<{ key: string; entry: TocEntry }[]> {
    return new Promise((resolve, reject) => {
      this.store.list("graphs/projections/", (err, objects) => {
        if (err) {
          return reject(err);
        }
        const skip = [legacyTocKey, legacyDeletedKey];
        const candidates = (objects || []).filter((item) => skip.indexOf(item.Key) === -1);
        Promise.all(candidates.map((item) => new Promise<any>((done) => {
          this.store.head(item.Key, (headErr, data) => {
            if (headErr || !data) {
              return done(null);
            }
            const entry: any = {};
            Object.keys(data.Metadata || {}).forEach((metaKey) => {
              entry[metaKey.replace("x-amz-meta-", "")] = data.Metadata[metaKey];
            });
            if (/^graphs\/projections\/endpoints\//.test(item.Key)) {
              entry.type = "endpoint";
            }
            if (!entry.id) {
              return done(null);
            }
            const tocId = entry.type === "endpoint" ? `endpoint/${entry.id}` : entry.id;
            const key = tocId + (/published/.test(entry.type) ? `.${entry.version}` : "");
            done({ key, entry });
          });
        }))).then((found) => {
          resolve(found.filter((item) => !!item));
        }).catch(reject);
      });
    });
  }
}
