import { Principal } from "../auth/principal";
import { decide } from "../policy/decide";

/**
 * Who uses a published component (plan §4.3, PB-044).
 *
 * Publishing a component is only half of what a person needs to know: the
 * other half is who is running the version they are about to replace.  A pin
 * (`node.properties.component`) says which component and which version a node
 * carries, so the set of pins in a graph is the set of components it consumes;
 * this keeps that as an index, both ways round, so "who uses c@1" does not
 * mean reading every graph in the instance.
 *
 * The index is written when a mutation is **accepted**, never as a condition of
 * accepting it: a graph that could not be indexed is still a graph that was
 * edited, and an index that can refuse an edit is a worse index than a stale
 * one.  It is derived data, and can be rebuilt from the projections.
 */

export interface ComponentUse {
    nodeId: string;
    name: string;
    version: number;
    digest?: string;
}

export interface ConsumerRecord {
    schemaVersion: 1;
    publishedId: string;
    graphId: string;
    graphUrl: string;
    graphName: string;
    at: string;
    uses: ComponentUse[];
}

interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
    list(prefix: string, cb: (err: any, data: any) => void): void;
    remove(key: string, cb: (err: any, data: any) => void): void;
}

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": true };

export interface ConsumerIndexHooks {
    /**
     * Whether this caller may know that graph exists.  Asking which graphs use
     * a component is asking about graphs, so the answer is narrowed to the ones
     * the caller could have read directly — otherwise an agent delegated on one
     * graph learns the names of every other graph that imports the same thing.
     */
    readable?: (graphId: string, principal: Principal | undefined) => Promise<boolean>;
    /** Every graph in the instance, for rebuilding the index from the graphs themselves. */
    graphIds?: () => Promise<string[]>;
    /** A graph as it now stands. */
    project?: (graphId: string) => Promise<any>;
}

export class ConsumerIndex {
    private store: Store;
    private hooks: ConsumerIndexHooks;
    constructor(store: Store, hooks: ConsumerIndexHooks = {}) {
        this.store = store;
        this.hooks = hooks;
    }

    static recordKey(publishedId: string, graphId: string) { return `components/${publishedId}/consumers/${graphId}.json`; }
    static prefix(publishedId: string) { return `components/${publishedId}/consumers/`; }
    /** What this graph used last time, so a component it no longer uses can be forgotten. */
    static byGraphKey(graphId: string) { return `consumers/by-graph/${graphId}.json`; }

    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }
    private putJson(key: string, value: any): Promise<void> {
        return new Promise((resolve, reject) => this.store.set(key, value, {}, (err: any) => (err ? reject(err) : resolve())));
    }
    private remove(key: string): Promise<void> {
        return new Promise((resolve) => this.store.remove(key, () => resolve()));
    }
    private listKeys(prefix: string): Promise<string[]> {
        return new Promise((resolve) => this.store.list(prefix, (err: any, items: any[]) => resolve(err ? [] : (items || []).map((i: any) => i.Key))));
    }

    /** The components a graph carries, as its pins say. */
    static usesOf(graph: any): Record<string, ComponentUse[]> {
        const uses: Record<string, ComponentUse[]> = {};
        ((graph && graph.nodes) || []).forEach((node: any) => {
            const pin = node && node.properties && node.properties.component;
            if (!pin || !pin.publishedId) {
                return;
            }
            const id = String(pin.publishedId);
            uses[id] = uses[id] || [];
            uses[id].push({
                nodeId: String(node.id),
                name: (node.properties && node.properties.name) || String(node.id),
                version: Number(pin.version),
                digest: pin.digest,
            });
        });
        return uses;
    }

    /**
     * Bring the index in line with this graph as it now stands.  Answers with
     * what changed, which is what a test asks about and what a log entry says.
     */
    async record(graph: any, at = new Date().toISOString()): Promise<{ added: string[]; updated: string[]; removed: string[] }> {
        const graphId = String(graph && graph.id);
        if (!graphId || graphId === "undefined") {
            return { added: [], updated: [], removed: [] };
        }
        const uses = ConsumerIndex.usesOf(graph);
        const now = Object.keys(uses).sort();
        const before: string[] = ((await this.getJson(ConsumerIndex.byGraphKey(graphId))) || {}).components || [];
        const added: string[] = [];
        const updated: string[] = [];
        for (const publishedId of now) {
            const existing = await this.getJson(ConsumerIndex.recordKey(publishedId, graphId));
            const record: ConsumerRecord = {
                schemaVersion: 1,
                publishedId,
                graphId,
                graphUrl: String(graph.url || graphId),
                graphName: (graph.properties && graph.properties.name) || String(graph.url || graphId),
                at,
                uses: uses[publishedId],
            };
            await this.putJson(ConsumerIndex.recordKey(publishedId, graphId), record);
            (existing ? updated : added).push(publishedId);
        }
        const removed = before.filter((publishedId: string) => now.indexOf(publishedId) === -1);
        for (const publishedId of removed) {
            await this.remove(ConsumerIndex.recordKey(publishedId, graphId));
        }
        await this.putJson(ConsumerIndex.byGraphKey(graphId), { graphId, components: now, at });
        return { added, updated, removed };
    }

    /** Every graph that carries this component, of the ones this caller may see. */
    async consumers(publishedId: string, principal?: Principal): Promise<ConsumerRecord[]> {
        const keys = await this.listKeys(ConsumerIndex.prefix(publishedId));
        const records: ConsumerRecord[] = [];
        for (const key of keys) {
            const record = await this.getJson(key);
            if (!record || !record.graphId) {
                continue;
            }
            if (this.hooks.readable && !(await this.hooks.readable(record.graphId, principal))) {
                continue;
            }
            records.push(record);
        }
        return records.sort((a, b) => (a.graphName < b.graphName ? -1 : a.graphName > b.graphName ? 1 : 0));
    }

    /**
     * What publishing this version would mean for the graphs already using it:
     * who is behind, who is level, and who is ahead — which happens when a
     * version is rolled back and says something is wrong rather than nothing.
     */
    async impact(publishedId: string, version: number, principal?: Principal): Promise<any> {
        const records = await this.consumers(publishedId, principal);
        const at = (pick: (v: number) => boolean) => records
            .filter((r) => r.uses.some((u) => pick(u.version)))
            .map((r) => ({
                graphId: r.graphId,
                graphName: r.graphName,
                versions: Array.from(new Set(r.uses.filter((u) => pick(u.version)).map((u) => u.version))).sort((a, b) => a - b),
                nodes: r.uses.filter((u) => pick(u.version)).map((u) => ({ nodeId: u.nodeId, name: u.name })),
            }));
        return {
            publishedId,
            version,
            consumers: records.length,
            behind: at((v) => v < version),
            current: at((v) => v === version),
            ahead: at((v) => v > version),
        };
    }

    /**
     * Rebuild the index from the graphs themselves.
     *
     * The index is written as changes are accepted, so a graph nobody has
     * edited since the index existed is missing from it — and "nobody uses
     * this" is the one answer that must not be wrong by omission, because it
     * is the answer people publish on.  This is derived data: rebuilding it
     * cannot lose anything, and it is safe to run at any time.
     */
    async rebuild(): Promise<any> {
        if (!this.hooks.graphIds || !this.hooks.project) {
            return { error: "this index cannot enumerate the graphs", code: "UNSUPPORTED" };
        }
        const graphIds = await this.hooks.graphIds();
        const changed: string[] = [];
        const failed: { graphId: string; error: string }[] = [];
        let consumers = 0;
        for (const graphId of graphIds) {
            try {
                const graph = await this.hooks.project!(graphId);
                if (!graph) {
                    continue;
                }
                const r = await this.record(graph);
                if (r.added.length || r.updated.length || r.removed.length) {
                    changed.push(graphId);
                }
                consumers += r.added.length + r.updated.length;
            } catch (err: any) {
                failed.push({ graphId, error: (err && err.message) || String(err) });
            }
        }
        return { graphs: graphIds.length, changed: changed.length, consumers, graphsChanged: changed, failed };
    }

    /** POST /components/consumers/rebuild */
    rebuildRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const allowed = decide(event.principal, ["policy:admin"]);
        if (!allowed.allow) {
            return callback(null, { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: allowed.reason || "denied", code: "ADMISSION_DENIED" }) });
        }
        this.rebuild()
            .then((body: any) => callback(null, { statusCode: body && body.error ? 400 : 200, headers: corsHeaders, body: JSON.stringify(body) }))
            .catch((err: any) => {
                console.error("Cannot rebuild the consumers index.", err);
                callback(null, { statusCode: 500, headers: corsHeaders });
            });
    }

    /** GET /components/{id}/consumers[?version=n] */
    route(event: any, context: any, callback: (err: any, r: any) => void) {
        const publishedId = event.pathParameters.id;
        const principal: Principal | undefined = event.principal;
        const allowed = decide(principal, ["graph:read"]);
        if (!allowed.allow) {
            return callback(null, { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: allowed.reason || "denied", code: "ADMISSION_DENIED" }) });
        }
        const asked = event.queryStringParameters && event.queryStringParameters.version;
        const answer = asked !== undefined && asked !== null && asked !== ""
            ? this.impact(publishedId, Number(asked), principal)
            : this.consumers(publishedId, principal).then((consumers) => ({ publishedId, consumers }));
        answer
            .then((body: any) => callback(null, { statusCode: 200, headers: corsHeaders, body: JSON.stringify(body) }))
            .catch((err: any) => {
                console.error("Cannot read a component's consumers.", err);
                callback(null, { statusCode: 500, headers: corsHeaders });
            });
    }
}
