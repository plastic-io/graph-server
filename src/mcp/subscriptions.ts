import type { ServerEvent, ServerEventBus } from "@modelcontextprotocol/server";
import { revRef } from "../summary/service";

/**
 * Long-lived notifications: `subscriptions/listen` (plan §5, PB-085, spike S-3).
 *
 * A read tool answers what is true now.  An agent that wants to know when that
 * stops being true has had one option until now — ask again — and the plan's
 * fallback was exactly that: poll `observations.query {since}`.  This is the
 * other half: a stream the client holds open, on which the server says which
 * resources changed, so the client re-reads only those.
 *
 * What a stream is told comes from the store, not from memory.  A Lambda that
 * serves one stream never sees the request that changed a graph — that runs in
 * another sandbox, minutes later, with nothing shared but S3.  So the feed
 * watches what is durable: the audit chain (every mutation, proposal, revision
 * and publish is a record in it) and the execution index.  A change is
 * something written, which also means a reconnecting client is told about
 * anything that happened while it was away — the cursor is a key, not a
 * position in a process's memory.
 *
 * The SDK owns the wire (ack first, per-stream filtering, keep-alive comments,
 * teardown); this is only where the events come from.
 */

export interface FeedStore {
    get(key: string, cb: (err: any, data: any) => void): void;
    list(prefix: string, cb: (err: any, data: any) => void): void;
}

/** What one stream asked to hear about, grouped by the graph it belongs to. */
export interface Watch {
    graphId: string;
    /** Whether anything subscribed needs the execution index polled as well. */
    executions: boolean;
}

const GRAPH_URI = /^plastic:\/\/graph\/([A-Za-z0-9_.:|-]+)(?:\/(.*))?$/;

/** The graph a `plastic://` resource URI belongs to, if it belongs to one. */
export function graphOfUri(uri: string): string | undefined {
    const match = GRAPH_URI.exec(String(uri || ""));
    return match ? match[1] : undefined;
}

/**
 * The watches one subscription filter needs.  A URI that names no graph (a
 * component, the graph list) is not watched per graph and is left out.
 */
export function watchesFor(uris: string[]): Watch[] {
    const byGraph = new Map<string, Watch>();
    (uris || []).forEach((uri) => {
        const match = GRAPH_URI.exec(String(uri || ""));
        if (!match) {
            return;
        }
        const [, graphId, rest = ""] = match;
        const watch = byGraph.get(graphId) || { graphId, executions: false };
        if (rest === "executions" || rest.indexOf("execution/") === 0) {
            watch.executions = true;
        }
        byGraph.set(graphId, watch);
    });
    return [...byGraph.values()];
}

/**
 * Which resource URIs one audit record changed.
 *
 * Everything lands on `…/history`, because the history resource *is* the audit
 * chain and a record is a change to it; a record that changed what a resource
 * says — a mutation that was accepted, a revision, a proposal — names that
 * resource too.  A refused mutation changed the history and nothing else,
 * which is the point of recording it.
 */
export function urisFor(graphId: string, record: any): string[] {
    const graph = `plastic://graph/${graphId}`;
    const history = `${graph}/history`;
    const kind = String((record && record.kind) || "");
    if (kind === "mutation.accepted") {
        return [graph, history];
    }
    if (kind === "proposal.committed") {
        return [`${graph}/proposal/${record.proposalId}`, graph, history];
    }
    if (kind.indexOf("proposal.") === 0 && record.proposalId) {
        return [`${graph}/proposal/${record.proposalId}`, history];
    }
    if (kind.indexOf("revision.") === 0 && record.revisionId) {
        return [`${graph}/rev/${revRef(record.revisionId)}`, graph, history];
    }
    if (kind === "component.published" && record.publishedId) {
        return [`plastic://component/${record.publishedId}`, `plastic://component/${record.publishedId}/${record.version}`, history];
    }
    return [history];
}

export interface ChangeFeedOptions {
    /** How often the store is asked what changed. */
    pollMs?: number;
    /** The graphs a listing may name, so a stream cannot hear about a graph it may not read. */
    readable?: (graphId: string) => Promise<boolean> | boolean;
    /** The graph list, when a stream asked for `resourcesListChanged`. */
    graphList?: () => Promise<string[]>;
    /** Records read from one chain in one pass; the rest arrive at the next. */
    maxRecords?: number;
    onerror?: (err: Error) => void;
}

/**
 * The change-event source for one stream.  It is a `ServerEventBus`, so the
 * SDK's listen router subscribes to it exactly as it would to the in-process
 * default — the difference is where the events come from.
 */
export class ChangeFeed implements ServerEventBus {
    private store: FeedStore;
    private watches: Watch[];
    private options: ChangeFeedOptions;
    private listeners = new Set<(event: ServerEvent) => void>();
    /** The newest audit record already accounted for, per graph. */
    private auditCursor = new Map<string, string>();
    /**
     * The executions already accounted for, by id rather than by a high-water
     * mark.  An execution id is made wherever the execution started — the
     * server for one it owns, the browser for one the browser owns — so the
     * index is not in id order, and a cursor of "the largest id seen" silently
     * swallows every server execution that lands after a browser one.  (That is
     * not hypothetical: it is what the dev stage did.)
     */
    private executionsSeen = new Map<string, Set<string>>();
    private graphs: string[] | undefined;
    private timer: any;
    private polling = false;
    /** Published events, in order — what a test reads and what a stream received. */
    readonly published: ServerEvent[] = [];

    constructor(store: FeedStore, watches: Watch[], options: ChangeFeedOptions = {}) {
        this.store = store;
        this.watches = watches;
        this.options = options;
    }

    publish(event: ServerEvent): void {
        this.published.push(event);
        this.listeners.forEach((listener) => {
            try {
                listener(event);
            } catch (err: any) {
                this.report(err);
            }
        });
    }

    subscribe(listener: (event: ServerEvent) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private report(err: any) {
        if (this.options.onerror) {
            this.options.onerror(err instanceof Error ? err : new Error(String(err)));
        } else {
            console.error("A change feed could not read the store.", err);
        }
    }

    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }
    private list(prefix: string): Promise<string[]> {
        return new Promise((resolve) => this.store.list(prefix, (err: any, items: any[]) => resolve(err ? [] : (items || []).map((item: any) => item.Key))));
    }

    /**
     * Take the cursors to where the store is now, without saying anything.
     * What happened before a stream opened is the client's to read, not the
     * stream's to announce.
     */
    async prime(): Promise<void> {
        await this.pass(false);
        if (this.options.graphList) {
            this.graphs = await this.options.graphList().catch(() => undefined);
        }
    }

    /** One look at the store; returns how many events it published. */
    async poll(): Promise<number> {
        const before = this.published.length;
        await this.pass(true);
        return this.published.length - before;
    }

    private async pass(announce: boolean): Promise<void> {
        for (const watch of this.watches) {
            try {
                await this.passAudit(watch, announce);
                if (watch.executions) {
                    await this.passExecutions(watch, announce);
                }
            } catch (err: any) {
                this.report(err);
            }
        }
        if (announce && this.options.graphList) {
            await this.passGraphList();
        }
    }

    private async passAudit(watch: Watch, announce: boolean): Promise<void> {
        const prefix = `audit/${watch.graphId}/`;
        const head = await this.getJson(`${prefix}HEAD.json`);
        const cursor = this.auditCursor.get(watch.graphId);
        if (!head || !head.id || head.id === cursor) {
            return;                      // nothing has been appended since the last look
        }
        if (!announce) {
            this.auditCursor.set(watch.graphId, head.id);
            return;
        }
        // Audit ids are all made on the server, in time order, and HEAD names the
        // newest, so a high-water mark is enough here — unlike the execution
        // index, whose ids come from two domains.  Listing is only reached when
        // HEAD says something was appended.
        const keys = (await this.list(prefix)).filter((key) => key !== `${prefix}HEAD.json`).sort();
        const ids = keys.map((key) => key.slice(prefix.length).replace(/\.json$/, ""))
            .filter((id) => !cursor || id > cursor);
        const limit = this.options.maxRecords || 200;
        const wanted = ids.slice(-limit);
        const uris = new Set<string>();
        for (const id of wanted) {
            const record = await this.getJson(`${prefix}${id}.json`);
            if (record) {
                urisFor(watch.graphId, record).forEach((uri) => uris.add(uri));
            }
        }
        this.auditCursor.set(watch.graphId, head.id);
        uris.forEach((uri) => this.publish({ kind: "resource_updated", uri }));
    }

    private async passExecutions(watch: Watch, announce: boolean): Promise<void> {
        const prefix = `executions/by-graph/${watch.graphId}/`;
        const ids = (await this.list(prefix)).map((key) => key.slice(prefix.length).replace(/\.json$/, ""));
        let seen = this.executionsSeen.get(watch.graphId);
        if (!seen) {
            seen = new Set<string>();
            this.executionsSeen.set(watch.graphId, seen);
        }
        const arrived = ids.filter((id) => !seen!.has(id));
        arrived.forEach((id) => seen!.add(id));
        if (!announce || !arrived.length) {
            return;
        }
        this.publish({ kind: "resource_updated", uri: `plastic://graph/${watch.graphId}/executions` });
        arrived.forEach((id) => this.publish({ kind: "resource_updated", uri: `plastic://graph/${watch.graphId}/execution/${id}` }));
    }

    private async passGraphList(): Promise<void> {
        const graphs = await this.options.graphList!().catch((err: any) => { this.report(err); return undefined; });
        if (!graphs) {
            return;
        }
        const before = this.graphs;
        this.graphs = graphs;
        if (!before) {
            return;
        }
        const changed = before.length !== graphs.length || graphs.some((id, i) => before[i] !== id);
        if (changed) {
            this.publish({ kind: "resources_list_changed" });
        }
    }

    /** Poll until stopped.  One pass at a time: a slow store must not stack up. */
    start(): void {
        if (this.timer || (!this.watches.length && !this.options.graphList)) {
            return;
        }
        const every = this.options.pollMs || 2000;
        this.timer = setInterval(() => {
            if (this.polling) {
                return;
            }
            this.polling = true;
            this.poll().catch((err: any) => this.report(err)).then(() => { this.polling = false; });
        }, every);
        if (this.timer.unref) {
            this.timer.unref();
        }
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.listeners.clear();
    }
}
