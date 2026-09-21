import * as Y from "yjs";
import { ulid } from "ulid";
import { fromJSON, encodeState, applyUpdate, reconcile, placementOf, componentView, canonical, UPDATE_EVENT } from "@plastic-io/graph-crdt";
import { createHash } from "crypto";
import { Principal } from "../auth/principal";
import { decide } from "../policy/decide";
import CrdtStore from "../crdtStore";
import TocStore from "../tocStore";
import { RevisionService, SYSTEM_PRINCIPAL } from "../revisions/service";
import { ComponentService } from "../components/service";
import { AdmissionService } from "../admission/admit";

/**
 * Bringing the graphs that already exist into the world the plan describes
 * (plan §9.5, PB-122).
 *
 * These graphs were written before revisions, placement, component pins or
 * capabilities existed.  Nothing about them is wrong; they simply predate the
 * questions this server now asks, so this fills in the answers that can be
 * derived and leaves alone the ones that cannot:
 *
 *  - a graph with no document gets one, seeded from its stored projection, so
 *    it can be versioned, proposed against and read by an agent at all;
 *  - a node that imported a published artifact gets a pin to that component,
 *    where the artifact is still there to pin to;
 *  - placement is derived only where a node's capabilities say where it must
 *    run; everything else stays portable, which is exactly how it behaves
 *    today, because guessing would move code between domains;
 *  - every graph gets a first revision, so there is a named state to compare
 *    against and to go back to.
 *
 * Activation is not part of that: pointing execution at a revision freezes it
 * there until someone activates another, and a graph people are editing should
 * keep running what they are editing unless they say otherwise.
 *
 * Every step is recorded per graph, so an interrupted run resumes and a
 * finished one does nothing.
 */

export const MIGRATION = "schema-v2";

export interface GraphMigration {
    graphId: string;
    at: string;
    /** What this run did, in the order it did it. */
    did: string[];
    /** What it deliberately left alone, and why. */
    left: string[];
    revisionId?: string;
    seq?: number;
    schemaVersion?: number;
    error?: string;
}

interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
    list(prefix: string, cb: (err: any, items: any[]) => void): void;
}

const LEGACY_ARTIFACT = /artifacts\/([^/.]+)[/.](\d+)(?:\.json)?$/;

export class MigrationService {
    constructor(
        private store: Store,
        private crdtStore: CrdtStore,
        private tocStore: TocStore,
        private deps: { revisions: RevisionService; components: ComponentService; admission: AdmissionService; fanOut?: (graphId: string, update: Uint8Array) => Promise<void> },
    ) {}

    static key(graphId: string) { return `migrations/${MIGRATION}/${graphId}.json`; }

    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }
    private putJson(key: string, value: any): Promise<void> {
        return new Promise((resolve, reject) => this.store.set(key, value, {}, (err: any) => (err ? reject(err) : resolve())));
    }

    /**
     * One graph.  Returns what it did and what it left alone; running it again
     * is safe and says the same thing about a graph it already finished.
     */
    async graph(graphId: string, principal: Principal | undefined, options: { force?: boolean; dryRun?: boolean; seedKey?: string } = {}): Promise<GraphMigration | { error: string; code: string }> {
        const allowed = decide(principal, ["graph:commit"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const done = await this.getJson(MigrationService.key(graphId));
        if (done && !options.force) {
            return done;
        }
        const result: GraphMigration = { graphId, at: new Date().toISOString(), did: [], left: [] };
        try {
            /* ---------------------------------------- a document to work with */
            let projection: any = await this.crdtStore.projectGraph(graphId).catch(() => null);
            const hasDocument = !!(projection && projection.id && Array.isArray(projection.nodes));
            if (!hasDocument) {
                // The newer layout first, then the 2.0 endpoint file, which is
                // all a graph written before that layout ever had.
                const stored: any = (options.seedKey ? await this.getJson(options.seedKey) : null)
                    || await this.getJson(`graphs/projections/latest/${graphId}.json`);
                if (!stored || !Array.isArray(stored.nodes)) {
                    result.left.push("no document and no stored projection to seed one from");
                    return this.finish(result, options);
                }
                if (!options.dryRun) {
                    const seeded = fromJSON(stored);
                    await this.admit(graphId, encodeState(seeded), `Seed the document of ${stored.properties && stored.properties.name ? stored.properties.name : graphId}`, "seed a document for a graph that predates them");
                }
                projection = stored;
                result.did.push("seeded a document from the stored projection");
            }

            /* ------------------------------------- what can be derived, derived */
            const derived = this.derive(projection);
            if (derived.changes.length) {
                if (!options.dryRun) {
                    const doc = new Y.Doc();
                    const merged = await this.crdtStore.loadMerged(graphId);
                    if (merged.update) {
                        applyUpdate(doc, merged.update);
                    } else {
                        applyUpdate(doc, encodeState(fromJSON(projection)));
                    }
                    let update: Uint8Array | null = null;
                    const capture = (u: Uint8Array) => { update = u; };
                    doc.on(UPDATE_EVENT as any, capture);
                    doc.transact(() => {
                        reconcile(doc, derived.projection);
                        const root = doc.getMap("graph");
                        let meta = root.get("meta") as Y.Map<any> | undefined;
                        if (!(meta instanceof Y.Map)) {
                            meta = new Y.Map<any>();
                            root.set("meta", meta);
                        }
                        meta.set("schemaVersion", 2);
                    }, { source: "migration" });
                    doc.off(UPDATE_EVENT as any, capture);
                    if (update) {
                        await this.admit(graphId, update, "Fill in what this graph predates", derived.changes.join("; "));
                    }
                }
                result.did.push(...derived.changes);
                result.schemaVersion = 2;
            }
            result.left.push(...derived.left);

            /* -------------------------------------------------- a first revision */
            const revisions = await this.deps.revisions.list(graphId);
            if (!revisions.length) {
                if (!options.dryRun) {
                    const cut: any = await this.deps.revisions.cut(graphId, SYSTEM_PRINCIPAL, "Version 1");
                    if (cut.error) {
                        result.left.push(`no first version: ${cut.error}`);
                    } else {
                        result.revisionId = cut.revision.revisionId;
                        result.seq = cut.revision.seq;
                        result.did.push(`cut the first version (${cut.revision.seq})`);
                    }
                } else {
                    result.did.push("would cut the first version");
                }
            } else {
                result.revisionId = revisions[revisions.length - 1].revisionId;
                result.seq = revisions[revisions.length - 1].seq;
                result.left.push(`it already has ${revisions.length} version(s)`);
            }
            // Execution keeps following live edits until someone activates a
            // revision; a graph people are editing should run what they edit.
            result.left.push("activation is left to a person");
            return this.finish(result, options);
        } catch (err: any) {
            result.error = String((err && err.message) || err);
            return this.finish(result, options);
        }
    }

    /**
     * What can be read off a graph without guessing: a pin for every node that
     * imported a published artifact, and placement where capabilities settle
     * it.  Returns the changed projection and what it changed, in words.
     */
    private derive(projection: any): { projection: any; changes: string[]; left: string[] } {
        const changes: string[] = [];
        const left: string[] = [];
        const copy = JSON.parse(JSON.stringify(projection));
        let pinned = 0;
        let placed = 0;
        let unresolved = 0;
        (copy.nodes || []).forEach((node: any) => {
            node.properties = node.properties || {};
            if (!node.properties.component && typeof node.artifact === "string" && node.artifact) {
                const match = LEGACY_ARTIFACT.exec(node.artifact);
                if (match) {
                    node.properties.component = { publishedId: match[1], version: Number(match[2]), digest: null, derived: "from the artifact it was imported from" };
                    pinned += 1;
                } else {
                    unresolved += 1;
                }
            }
            if (!node.properties.placement) {
                const placement = placementOf(node);
                if (placement !== "portable") {
                    node.properties.placement = placement;
                    placed += 1;
                }
            }
        });
        if (pinned) changes.push(`pinned ${pinned} imported node(s) to the component they came from`);
        if (placed) changes.push(`recorded where ${placed} node(s) must run`);
        if (unresolved) left.push(`${unresolved} node(s) name an artifact in a shape this cannot read`);
        if (!placed) left.push("every node stays portable: nothing about them says where they must run");
        return { projection: copy, changes, left };
    }

    /** A migration is a mutation like any other: admitted, audited, fanned out. */
    private async admit(graphId: string, update: Uint8Array, description: string, intent: string) {
        const result = await this.deps.admission.admit({
            graphId, mutationId: ulid(), content: update, description, intent,
            clientInfo: { name: "graph-server", version: MIGRATION }, principal: SYSTEM_PRINCIPAL,
        });
        if (result.decision !== "accepted") {
            throw new Error(`${description}: ${result.reason || result.code}`);
        }
        if (this.deps.fanOut) {
            await this.deps.fanOut(graphId, update);
        }
        await this.crdtStore.writeProjections(graphId);
        return result;
    }

    private async finish(result: GraphMigration, options: { dryRun?: boolean }): Promise<GraphMigration> {
        if (!options.dryRun) {
            await this.putJson(MigrationService.key(result.graphId), result);
        }
        return result;
    }

    /** Every graph in the table of contents, oldest first, resuming where a previous run stopped. */
    async run(principal: Principal | undefined, options: { limit?: number; force?: boolean; dryRun?: boolean } = {}): Promise<any> {
        const allowed = decide(principal, ["graph:commit"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const graphIds = await this.graphIds();
        const limit = Math.min(options.limit || 25, 200);
        const results: GraphMigration[] = [];
        let skipped = 0;
        for (const { graphId, seedKey } of graphIds) {
            if (results.length >= limit) {
                break;
            }
            const done = await this.getJson(MigrationService.key(graphId));
            if (done && !options.force) {
                skipped += 1;
                continue;
            }
            const r = await this.graph(graphId, principal, { ...options, seedKey });
            if (!("error" in r)) {
                results.push(r);
            }
        }
        const remaining = graphIds.length - skipped - results.length;
        return {
            migration: MIGRATION,
            graphs: graphIds.length,
            migrated: results.length,
            alreadyDone: skipped,
            remaining: Math.max(0, remaining),
            dryRun: !!options.dryRun,
            results,
        };
    }

    /** `POST /migrations/run`, `GET /migrations` */
    route(event: any, context: any, callback: (err: any, r: any) => void) {
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": true };
        let body: any = {};
        try { body = event.body ? JSON.parse(event.body) : {}; } catch (err) { body = {}; }
        const answer = event.httpMethod === "POST"
            ? this.run(event.principal, { limit: body.limit, force: !!body.force, dryRun: !!body.dryRun })
            : this.status(event.principal);
        answer
            .then((r: any) => callback(null, { statusCode: r && r.error ? (r.code === "ADMISSION_DENIED" ? 403 : 400) : 200, body: JSON.stringify(r), headers }))
            .catch((err: any) => { console.error("Cannot run the migration.", err); callback(null, { statusCode: 500, headers }); });
    }

    /**
     * Every graph that exists, wherever it is recorded.  The table of contents
     * knows the ones this server has seen (and also carries an
     * `endpoint/<url>` entry per graph, which is a way in rather than a thing
     * to migrate); older graphs exist only as the endpoint file the 2.0 server
     * executed, and those are exactly the ones with most to gain here.
     */
    private async graphIds(): Promise<{ graphId: string; seedKey?: string }[]> {
        const found = new Map<string, { graphId: string; seedKey?: string }>();
        const toc = await this.tocStore.project();
        Object.keys(toc || {})
            .filter((key) => !key.includes("/") && (toc as any)[key] && (toc as any)[key].type !== "endpoint")
            .forEach((graphId) => found.set(graphId, { graphId }));
        const latest: string[] = await new Promise((resolve) => this.store.list("graphs/projections/latest/", (err: any, items: any[]) => resolve(err ? [] : (items || []).map((i: any) => i.Key))));
        latest.forEach((key) => {
            const graphId = key.slice("graphs/projections/latest/".length).replace(/\.json$/, "");
            if (graphId && !found.has(graphId)) {
                found.set(graphId, { graphId, seedKey: key });
            }
        });
        const endpoints: string[] = await new Promise((resolve) => this.store.list("graphs/projections/endpoints/", (err: any, items: any[]) => resolve(err ? [] : (items || []).map((i: any) => i.Key))));
        for (const key of endpoints) {
            const projection: any = await this.getJson(key);
            const graphId = projection && projection.id;
            if (graphId && Array.isArray(projection.nodes) && !found.has(graphId)) {
                found.set(graphId, { graphId, seedKey: key });
            }
        }
        return [...found.values()];
    }

    /** How far the migration has got. */
    async status(principal: Principal | undefined): Promise<any> {
        const allowed = decide(principal, ["graph:read"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const keys: string[] = await new Promise((resolve) => this.store.list(`migrations/${MIGRATION}/`, (err: any, items: any[]) => resolve(err ? [] : (items || []).map((i: any) => i.Key))));
        const graphs = await this.graphIds();
        return { migration: MIGRATION, graphs: graphs.length, done: keys.length, remaining: Math.max(0, graphs.length - keys.length) };
    }
}

/** The digest a legacy artifact would have, for pins that can be checked later. */
export function artifactDigest(kind: "graph" | "node", artifact: any): string {
    return `sha256:${createHash("sha256").update(canonical(componentView(kind, artifact))).digest("hex")}`;
}
