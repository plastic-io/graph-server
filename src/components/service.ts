import { createHash } from "crypto";
import { canonical, componentView, DiffSummary } from "@plastic-io/graph-crdt";
import { Principal } from "../auth/principal";
import { decide } from "../policy/decide";
import { AdmissionService } from "../admission/admit";
import { RevisionService, Revision, SCHEDULER_VERSION } from "../revisions/service";
import CrdtStore from "../crdtStore";
import TocStore from "../tocStore";
import { ensureBuilt, listArtifact } from "../tocService";
import { undeclaredEffects, GateFinding } from "../gates/gates";

/**
 * Published components (plan §4.3), grown out of revisions.
 *
 * Publishing a graph, or a node of a graph, names the graph as it stands (a
 * revision, §4.7) and writes an immutable manifest plus the artifact under
 * `components/<publishedId>/<version>/`.  The published version *is* the
 * revision's sequence number, so "version 3 of this graph" and "the graph's
 * third named revision" are the same thing, and republishing an unchanged
 * graph returns the version that already exists instead of minting another.
 *
 * The manifest's `digest` is taken over the component view (graph-crdt
 * digest.ts): what a consumer's embedded copy must still equal.  Admission
 * checks that copy against it whenever a pinned node's copy changes.
 *
 * The 2.0 layout (`graphs/projections/published/artifacts/<id>.<version>.json`
 * and the published endpoint file) is still written, so old registries, the
 * `artifacts/{id}.{version}` addressing and production execution keep working.
 */
export interface ComponentManifest {
    schemaVersion: 1;
    publishedId: string;
    version: number;
    kind: "graph" | "node";
    name: string;
    description: string;
    icon: string;
    url: string;
    label: string;
    digest: string;            // sha256 of canonical(componentView(kind, artifact))
    artifactDigest: string;    // sha256 of canonical(artifact) exactly as stored
    revisionDigest: string;    // the revision's full digest
    contract: { inputs: any[]; outputs: any[] };
    capabilities: any[];
    placement: "browser" | "server" | "portable";
    dependencies: { publishedId: string; version: number; digest?: string }[];
    summary: { intent: string; invariants: string[]; provenance: "authored" | "generated" };
    tests: any[];
    budgets?: any;
    provenance: { publishedBy: { sub: string; kind: string; tenant: string } | null; fromGraph: { graphId: string; revisionId: string; seq: number }; at: string; mutationId: string | null };
    compat: { runtime: { ts: string } };
    counts: { nodes: number; connectors: number };
}

export interface IntegrityProblem {
    nodeId: string;
    publishedId: string;
    version: number;
    reason: string;
}

interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
    list(prefix: string, cb: (err: any, data: any) => void): void;
}

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": true };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const LEGACY_ARTIFACT = (id: string, version: number | string) => `graphs/projections/published/artifacts/${id}.${version}.json`;
const LEGACY_ENDPOINT = (url: string) => `graphs/projections/published/endpoints/${url}.json`;

export function componentDigest(kind: "graph" | "node", artifact: any): string {
    return sha256(canonical(componentView(kind, artifact)));
}

/** `artifacts/<id>.<version>` or `artifacts/<id>/<version>` → the pair, or null. */
export function parseArtifactRef(ref: any): { publishedId: string; version: number } | null {
    if (typeof ref !== "string") return null;
    const m = ref.match(/artifacts\/([A-Za-z0-9_.-]+?)[./](\d+)(?:\.json)?$/);
    return m ? { publishedId: m[1], version: Number(m[2]) } : null;
}

export class ComponentService {
    readonly crdtStore: CrdtStore;
    readonly revisions: RevisionService;
    readonly admission: AdmissionService;
    private store: Store;
    private tocStore: TocStore | null;
    private broadcastService: any;
    private notify: (graphId: string, event: any) => Promise<void>;
    gate: ((graphId: string, revisionId: string, projection: any) => Promise<GateFinding[]>) | null;

    constructor(crdtStore: CrdtStore, revisions: RevisionService, admission: AdmissionService, hooks: {
        tocStore?: TocStore | null;
        broadcastService?: any;
        notify?: (graphId: string, event: any) => Promise<void>;
        /** What else must hold before something may be published (the tests of this graph). */
        gate?: (graphId: string, revisionId: string, projection: any) => Promise<GateFinding[]>;
    } = {}) {
        this.crdtStore = crdtStore;
        this.revisions = revisions;
        this.admission = admission;
        this.store = crdtStore.store as any;
        this.tocStore = hooks.tocStore || null;
        this.broadcastService = hooks.broadcastService || null;
        this.notify = hooks.notify || (async () => undefined);
        this.gate = hooks.gate || null;
    }

    static manifestKey(id: string, version: number | string) { return `components/${id}/${version}/manifest.json`; }
    static artifactKey(id: string, version: number | string) { return `components/${id}/${version}/artifact.json`; }
    static headKey(id: string) { return `components/${id}/HEAD.json`; }

    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }
    private putJson(key: string, value: any, meta: any = {}): Promise<void> {
        return new Promise((resolve, reject) => this.store.set(key, value, meta, (err: any) => (err ? reject(err) : resolve())));
    }
    private listKeys(prefix: string): Promise<string[]> {
        return new Promise((resolve, reject) => this.store.list(prefix, (err: any, items: any[]) => (err ? reject(err) : resolve((items || []).map((i: any) => i.Key)))));
    }

    /* ------------------------------------------------------------ reading */

    async head(publishedId: string): Promise<{ version: number; revisionId: string; at: string } | null> {
        return this.getJson(ComponentService.headKey(publishedId));
    }
    async manifest(publishedId: string, version: number | string): Promise<ComponentManifest | null> {
        if (version === "latest") {
            const head = await this.head(publishedId);
            if (!head) return null;
            version = head.version;
        }
        return this.getJson(ComponentService.manifestKey(publishedId, version));
    }
    async artifact(publishedId: string, version: number | string): Promise<any | null> {
        if (version === "latest") {
            const head = await this.head(publishedId);
            if (!head) return null;
            version = head.version;
        }
        const stored = await this.getJson(ComponentService.artifactKey(publishedId, version));
        return stored || this.getJson(LEGACY_ARTIFACT(publishedId, version));   // pre-revision publications
    }
    /** Every published version, newest first, without the heavy fields. */
    async list(publishedId: string): Promise<Partial<ComponentManifest>[]> {
        const keys = (await this.listKeys(`components/${publishedId}/`)).filter((k) => k.endsWith("/manifest.json"));
        const out: any[] = [];
        for (const key of keys) {
            const m = await this.getJson(key);
            if (m) {
                const { contract, dependencies, ...rest } = m;
                out.push({ ...rest, inputs: contract ? contract.inputs.length : 0, outputs: contract ? contract.outputs.length : 0, dependencies: (dependencies || []).length });
            }
        }
        return out.sort((a, b) => b.version - a.version);
    }
    /** Which versions of a graph (or of nodes cut from it) exist, by revision seq. */
    async publishedVersionsOf(publishedId: string): Promise<Record<number, { at: string; kind: string }>> {
        const out: Record<number, { at: string; kind: string }> = {};
        (await this.list(publishedId)).forEach((m: any) => { out[m.version] = { at: m.provenance && m.provenance.at, kind: m.kind }; });
        return out;
    }

    /* ------------------------------------------------------------ publishing */

    private buildManifest(kind: "graph" | "node", publishedId: string, artifact: any, revision: Revision, principal: Principal | undefined, label: string): ComponentManifest {
        const nodes: any[] = kind === "graph" ? artifact.nodes || [] : [artifact];
        const props = artifact.properties || {};
        const ports = (list: any[]) => (Array.isArray(list) ? list : []).map((p: any) => ({ name: p.name, type: p.type || "Object", schema: {}, required: false, visible: p.visible === undefined ? true : p.visible }));
        const contract = kind === "graph"
            ? {
                inputs: nodes.flatMap((n: any) => ((n.properties && n.properties.inputs) || []).filter((p: any) => p.external).map((p: any) => ({ ...p, nodeId: n.id }))).map((p: any) => ({ ...ports([p])[0], nodeId: p.nodeId })),
                outputs: nodes.flatMap((n: any) => ((n.properties && n.properties.outputs) || []).filter((p: any) => p.external).map((p: any) => ({ ...p, nodeId: n.id }))).map((p: any) => ({ ...ports([p])[0], nodeId: p.nodeId })),
            }
            : { inputs: ports(props.inputs), outputs: ports(props.outputs) };
        const capabilities = Array.from(new Set(nodes.flatMap((n: any) => (n.properties && Array.isArray(n.properties.capabilities) ? n.properties.capabilities : []))));
        const placement = nodes.some((n: any) => n.properties && n.properties.placement === "server") ? "server" : "portable";
        const dependencies: ComponentManifest["dependencies"] = [];
        const seen = new Set<string>();
        nodes.forEach((n: any) => {
            const pin = n.properties && n.properties.component;
            const dep = pin && pin.publishedId ? { publishedId: String(pin.publishedId), version: Number(pin.version), digest: pin.digest } : parseArtifactRef(n.artifact);
            if (dep && !seen.has(`${dep.publishedId}@${dep.version}`)) {
                seen.add(`${dep.publishedId}@${dep.version}`);
                dependencies.push(dep as any);
            }
        });
        return {
            schemaVersion: 1,
            publishedId,
            version: revision.seq,
            kind,
            name: props.name || "Unnamed",
            description: props.description || "",
            icon: props.icon || (kind === "graph" ? "mdi-graph" : "mdi-node-point"),
            url: artifact.url || publishedId,
            label,
            digest: componentDigest(kind, artifact),
            artifactDigest: sha256(canonical(artifact)),
            revisionDigest: revision.digest.full,
            contract,
            capabilities,
            placement,
            dependencies,
            summary: { intent: props.description || "", invariants: [], provenance: "authored" },
            tests: [],
            provenance: {
                publishedBy: principal ? { sub: principal.sub, kind: principal.kind, tenant: principal.tenant } : null,
                fromGraph: { graphId: revision.graphId, revisionId: revision.revisionId, seq: revision.seq },
                at: new Date().toISOString(),
                mutationId: revision.mutationIds.length ? revision.mutationIds[revision.mutationIds.length - 1] : null,
            },
            compat: { runtime: { ts: SCHEDULER_VERSION } },
            counts: { nodes: nodes.length, connectors: nodes.reduce((c: number, n: any) => c + ((n.edges || []) as any[]).reduce((m: number, e: any) => m + ((e.connectors || []).length), 0), 0) },
        };
    }

    /**
     * Publish a graph (or one of its nodes) at a revision: the head, cut now if the
     * graph changed since the last one, or an older revision by id.
     */
    async publish(graphId: string, principal: Principal | undefined, options: { nodeId?: string; label?: string; revisionId?: string; force?: boolean } = {}): Promise<{ manifest: ComponentManifest; created: boolean; revision: Revision } | { error: string; code: string }> {
        const allowed = decide(principal, ["component:publish"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        let revision: Revision | null;
        if (options.revisionId) {
            revision = await this.revisions.get(graphId, options.revisionId);
            if (!revision) {
                return { error: "no such revision", code: "NOT_FOUND" };
            }
        } else {
            const cut = await this.revisions.cut(graphId, principal, options.label || "");
            if ("error" in cut) {
                return cut;
            }
            revision = cut.revision;
        }
        const projection = await this.revisions.projection(graphId, revision.revisionId);
        if (!projection) {
            return { error: "the revision has no projection", code: "NOT_FOUND" };
        }
        /**
         * The publication gate (plan §8.1.8): what is published is what other
         * graphs will import and run, so it has to say what it does and to
         * still keep its word.  `force` is honoured only for a caller who
         * could publish anyway, and is recorded on the manifest.
         */
        if (!options.force) {
            const findings = undeclaredEffects(projection, options.nodeId);
            const failures = this.gate ? await this.gate(graphId, revision.revisionId, projection) : [];
            const all = findings.concat(failures);
            if (all.length) {
                return {
                    error: `this cannot be published yet: ${all.map((f) => f.says).join("; ")}`,
                    code: "GATE_FAILED",
                    details: { findings: all },
                } as any;
            }
        }
        const kind: "graph" | "node" = options.nodeId ? "node" : "graph";
        const publishedId = options.nodeId || graphId;
        let artifact: any = projection;
        if (options.nodeId) {
            artifact = (projection.nodes || []).find((n: any) => n.id === options.nodeId);
            if (!artifact) {
                return { error: "no such node in that revision", code: "NOT_FOUND" };
            }
        }
        // one version per revision: the object is immutable, so a repeat is the same answer
        const existing = await this.manifest(publishedId, revision.seq);
        if (existing) {
            return { manifest: existing, created: false, revision };
        }
        const at = new Date().toISOString();
        const stamped = { ...artifact, publishedOn: Date.parse(at), publishedBy: principal ? principal.sub : "Unknown" };
        const manifest = this.buildManifest(kind, publishedId, stamped, revision, principal, options.label || revision.label || "");
        const meta = {
            "id": "artifacts/" + publishedId,
            "name": manifest.name,
            "version": String(manifest.version),
            "description": manifest.description || "No description",
            "icon": manifest.icon,
            "type": kind === "graph" ? "publishedGraph" : "publishedNode",
            "url": manifest.url,
            "artifact-url": `artifacts/${publishedId}/${manifest.version}`,
            "user-id": principal ? principal.sub : "Unknown",
            "revision-id": revision.revisionId,
            "digest": manifest.digest,
            ...(kind === "node" ? { "graph-id": graphId, "graph-url": projection.url || graphId } : {}),
        };
        await this.putJson(ComponentService.artifactKey(publishedId, manifest.version), stamped, meta);
        await this.putJson(ComponentService.manifestKey(publishedId, manifest.version), manifest);
        await this.putJson(ComponentService.headKey(publishedId), { version: manifest.version, revisionId: revision.revisionId, at });
        // the 2.0 layout, for old registries and production execution
        await this.putJson(LEGACY_ARTIFACT(publishedId, manifest.version), stamped, meta);
        if (kind === "graph") {
            await this.putJson(LEGACY_ENDPOINT(manifest.url), stamped, meta);
        }
        if (this.tocStore) {
            try {
                await ensureBuilt(this.tocStore);
                await listArtifact(this.tocStore, this.broadcastService, `artifacts/${publishedId}.${manifest.version}`, {
                    id: `artifacts/${publishedId}`,
                    name: meta.name, description: meta.description, icon: meta.icon, type: meta.type, url: meta.url,
                    version: meta.version, "artifact-url": meta["artifact-url"], "revision-id": revision.revisionId, digest: manifest.digest,
                    ...(kind === "node" ? { "graph-id": graphId } : {}),
                }, meta["user-id"]);
            } catch (err) {
                console.error("Cannot list the published artifact.", err);
            }
        }
        await this.admission.chain.append(graphId, {
            kind: "component.published", at, graphId, publishedId, version: manifest.version, componentKind: kind,
            revisionId: revision.revisionId, digest: manifest.digest, principal: manifest.provenance.publishedBy, label: manifest.label,
        });
        await this.notify(graphId, { eventType: "component", action: "published", publishedId, version: manifest.version, kind, revisionId: revision.revisionId });
        return { manifest, created: true, revision };
    }

    /* ------------------------------------------------------------ integrity */

    /** Does a consumer's embedded copy still equal the component it pins? */
    async verifyEmbedded(node: any): Promise<{ ok: boolean; reason?: string; expected?: string; actual?: string; manifest?: ComponentManifest | null }> {
        const pin = node && node.properties && node.properties.component;
        if (!pin || !pin.publishedId) {
            return { ok: true };
        }
        const manifest = await this.manifest(String(pin.publishedId), Number(pin.version));
        if (!manifest) {
            return { ok: false, reason: `no published component ${pin.publishedId}@${pin.version}`, manifest: null };
        }
        if (pin.digest && pin.digest !== manifest.digest) {
            return { ok: false, reason: `the pin's digest is not the manifest's`, expected: manifest.digest, actual: pin.digest, manifest };
        }
        const embedded = node.linkedGraph ? node.linkedGraph.graph : node.linkedNode;
        if (!embedded) {
            return { ok: true, manifest };   // nothing embedded to drift
        }
        const actual = componentDigest(manifest.kind, embedded);
        if (actual !== manifest.digest) {
            return { ok: false, reason: `the embedded copy of ${pin.publishedId}@${pin.version} differs from what was published`, expected: manifest.digest, actual, manifest };
        }
        return { ok: true, manifest };
    }

    /**
     * Admission hook: every node the change added, re-pinned, or whose embedded
     * copy, code or ports it touched is checked against its manifest.
     */
    async integrityCheck(after: any, diff: DiffSummary): Promise<{ problems: IntegrityProblem[] }> {
        const problems: IntegrityProblem[] = [];
        if (!after || !Array.isArray(after.nodes)) {
            return { problems };
        }
        const touched = new Set<string>();
        diff.ops.forEach((op: any) => {
            if (!op.nodeId) return;
            const keys: string[] = op.keys || [];
            if (op.op === "add-node" || op.op === "set-component-pin" || op.op === "set-node-code"
                || (op.op === "set-node-fields" && keys.some((k) => k === "linkedGraph" || k === "linkedNode" || k === "data"))
                || (op.op === "set-node-props" && keys.some((k) => k === "inputs" || k === "outputs"))) {
                touched.add(String(op.nodeId));
            }
        });
        for (const node of after.nodes) {
            if (!node || !touched.has(String(node.id)) || !(node.properties && node.properties.component)) continue;
            const check = await this.verifyEmbedded(node);
            if (!check.ok) {
                problems.push({ nodeId: node.id, publishedId: String(node.properties.component.publishedId), version: Number(node.properties.component.version), reason: check.reason || "integrity failure" });
            }
        }
        return { problems };
    }

    /* ------------------------------------------------------------ http */

    private reply(callback: (err: any, r: any) => void, statusCode: number, body: any) {
        callback(null, { statusCode, body: JSON.stringify(body), headers: corsHeaders });
    }
    private statusFor(code: string): number {
        return code === "ADMISSION_DENIED" ? 403 : code === "NOT_FOUND" ? 404 : 400;
    }

    /** POST /crdt/{id}/publish  {label?, nodeId?, revisionId?} */
    publishRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const graphId = event.pathParameters.id;
        let body: any = {};
        try { body = event.body ? JSON.parse(event.body) : {}; } catch (err) { body = {}; }
        this.publish(graphId, event.principal, { label: body.label, nodeId: body.nodeId, revisionId: body.revisionId })
            .then((r: any) => r.error ? this.reply(callback, this.statusFor(r.code), r) : this.reply(callback, r.created ? 201 : 200, { manifest: r.manifest, created: r.created, revision: { revisionId: r.revision.revisionId, seq: r.revision.seq, label: r.revision.label } }))
            .catch((err) => { console.error("Cannot publish.", err); callback(null, { statusCode: 500, headers: corsHeaders }); });
    }
    /** GET /components/{id} */
    listRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const id = event.pathParameters.id;
        Promise.all([this.list(id), this.head(id)])
            .then(([versions, head]) => this.reply(callback, 200, { publishedId: id, head, versions }))
            .catch((err) => { console.error("Cannot list components.", err); callback(null, { statusCode: 500, headers: corsHeaders }); });
    }
    /** GET /components/{id}/{version}  (version may be "latest") */
    getRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const { id, version } = event.pathParameters;
        Promise.all([this.manifest(id, version === "latest" ? "latest" : Number(version)), this.artifact(id, version === "latest" ? "latest" : Number(version))])
            .then(([manifest, artifact]) => {
                if (!artifact) return this.reply(callback, 404, { error: "no such component", code: "NOT_FOUND" });
                return this.reply(callback, 200, { manifest, artifact });
            })
            .catch((err) => { console.error("Cannot read a component.", err); callback(null, { statusCode: 500, headers: corsHeaders }); });
    }
    /** GET /artifacts/{id}/{version}: the 2.0 route, now served from components first. */
    artifactRoute(event: any, context: any, callback: (err: any, r: any) => void) {
        const { id, version } = event.pathParameters;
        this.artifact(id, version === "latest" ? "latest" : Number(version))
            .then((artifact) => artifact ? this.reply(callback, 200, artifact) : callback(null, { statusCode: 404, headers: corsHeaders }))
            .catch((err) => { console.error("Cannot read an artifact.", err); callback(null, { statusCode: 500, headers: corsHeaders }); });
    }
}
