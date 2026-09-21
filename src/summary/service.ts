import { RevisionService, Revision, SYSTEM_PRINCIPAL } from "../revisions/service";
import { ComponentService } from "../components/service";
import { canonical, definitionView } from "@plastic-io/graph-crdt";
import { createHash } from "crypto";

/**
 * Summaries and bounded traversal for agents (plan §4.2, §5.3 graph.summary /
 * graph.expand).  Everything is computed from a revision's projection, so an
 * agent always knows which state it is reading and can propose against it.
 */
export interface ComponentSummary {
    id: string;
    graphId: string;
    revisionId: string;
    kind: "graph" | "node" | "published-component";
    name: string;
    purpose: string;
    intentProvenance: "authored" | "generated" | "derived";
    freshness: { computedAt: string; sourceRevision: string; stale: boolean };
    inputs: any[];
    outputs: any[];
    invariants?: string[];
    dependencies?: any[];
    effects?: any[];
    placement: "browser" | "server" | "portable";
    pointers?: { node?: string; code?: string; observations?: string; tests?: string };
    degree: { in: number; out: number; nestedNodes?: number };
    untrusted?: ("purpose" | "invariants" | "name")[];
}

export const revRef = (revisionId: string) => (revisionId.startsWith("rev_") ? revisionId : `rev_${revisionId}`);
export const revId = (ref: string) => ref.replace(/^rev_/, "");
export const digestRef = (hex: string) => (hex.startsWith("sha256:") ? hex : `sha256:${hex}`);

const CAPABILITY_KINDS = ["net:https", "storage:kv", "storage:s3", "secret", "timer", "browser:dom", "browser:storage", "aws:cfn", "aws:codebuild", "llm", "graph:invoke"];

export function capabilityRequirement(c: any): any {
    const name = typeof c === "string" ? c : c && (c.kind || c.name);
    if (!name) return null;
    const kind = CAPABILITY_KINDS.includes(name) ? name : CAPABILITY_KINDS.find((k) => String(name).startsWith(k)) || "net:https";
    return { kind, scope: typeof c === "object" && Array.isArray(c.scope) ? c.scope : (String(name) === kind ? [] : [String(name)]), optional: !!(c && c.optional) };
}

function portContract(p: any): any {
    return { name: p.name, schema: p.schema && typeof p.schema === "object" ? p.schema : {}, required: !!p.required };
}

export class SummaryService {
    constructor(readonly revisions: RevisionService, readonly components: ComponentService) {}

    /**
     * The revision a read is answered from: HEAD, or a fresh cut when the graph
     * changed since HEAD (or has none), so an agent never reads a state it
     * cannot name.  The cut is the server's own act (system principal).
     */
    async headOrCut(graphId: string): Promise<Revision | null> {
        const head = await this.revisions.head(graphId);
        const live = await this.revisions.crdtStore.projectGraph(graphId);
        if (!live) {
            return null;
        }
        const liveDefinition = createHash("sha256").update(canonical(definitionView(live))).digest("hex");
        if (head) {
            const revision = await this.revisions.get(graphId, head.revisionId);
            if (revision && revision.digest.definition === liveDefinition) {
                return revision;
            }
        }
        const cut = await this.revisions.cut(graphId, SYSTEM_PRINCIPAL, "auto");
        return "error" in cut ? null : cut.revision;
    }

    async resolveRevision(graphId: string, revisionRef?: string): Promise<Revision | null> {
        if (revisionRef) {
            return this.revisions.get(graphId, revId(revisionRef));
        }
        return this.headOrCut(graphId);
    }

    /** Degree of a node within its graph. */
    static degree(projection: any, nodeId: string): { in: number; out: number } {
        let inDegree = 0;
        let outDegree = 0;
        (projection.nodes || []).forEach((n: any) => (n.edges || []).forEach((e: any) => (e.connectors || []).forEach((c: any) => {
            if (n.id === nodeId) outDegree += 1;
            if (c.nodeId === nodeId) inDegree += 1;
        })));
        return { in: inDegree, out: outDegree };
    }

    nodeSummary(graphId: string, revision: Revision, projection: any, node: any, include: string[] = []): ComponentSummary {
        const props = node.properties || {};
        const degree: any = SummaryService.degree(projection, node.id);
        if (node.linkedGraph && node.linkedGraph.graph) {
            degree.nestedNodes = (node.linkedGraph.graph.nodes || []).length;
        }
        const out: ComponentSummary = {
            id: node.id,
            graphId,
            revisionId: revRef(revision.revisionId),
            kind: "node",
            name: String(props.name || node.url || node.id).slice(0, 128),
            purpose: String(props.description || "").slice(0, 2000),
            intentProvenance: "authored",
            freshness: { computedAt: new Date().toISOString(), sourceRevision: revRef(revision.revisionId), stale: false },
            inputs: (props.inputs || []).map(portContract),
            outputs: (props.outputs || []).map(portContract),
            placement: props.placement === "server" ? "server" : props.placement === "browser" ? "browser" : "portable",
            pointers: {
                node: `plastic://graph/${graphId}/rev/${revRef(revision.revisionId)}/node/${node.id}`,
                code: `plastic://graph/${graphId}/rev/${revRef(revision.revisionId)}/node/${node.id}?expand=code`,
            },
            degree,
            untrusted: props.description ? ["purpose"] : [],
        };
        if (!include.length || include.includes("deps")) {
            const deps: any[] = [];
            if (props.component) deps.push({ publishedId: String(props.component.publishedId), version: Number(props.component.version), digest: props.component.digest ? digestRef(props.component.digest) : undefined });
            out.dependencies = deps;
        }
        if (!include.length || include.includes("capabilities")) {
            out.effects = (Array.isArray(props.capabilities) ? props.capabilities : []).map(capabilityRequirement).filter(Boolean);
        }
        return out;
    }

    graphSummary(graphId: string, revision: Revision, projection: any, include: string[] = []): ComponentSummary {
        const props = projection.properties || {};
        const nodes: any[] = projection.nodes || [];
        const external = (key: "inputs" | "outputs") => nodes.flatMap((n: any) => ((n.properties && n.properties[key]) || []).filter((p: any) => p.external).map(portContract));
        const out: ComponentSummary = {
            id: graphId,
            graphId,
            revisionId: revRef(revision.revisionId),
            kind: "graph",
            name: String(props.name || projection.url || graphId).slice(0, 128),
            purpose: String(props.description || "").slice(0, 2000),
            intentProvenance: "authored",
            freshness: { computedAt: new Date().toISOString(), sourceRevision: revRef(revision.revisionId), stale: false },
            inputs: external("inputs"),
            outputs: external("outputs"),
            placement: nodes.some((n: any) => n.properties && n.properties.placement === "server") ? "server" : "portable",
            pointers: { node: `plastic://graph/${graphId}/rev/${revRef(revision.revisionId)}` },
            degree: { in: 0, out: 0, nestedNodes: nodes.length },
            untrusted: props.description ? ["purpose"] : [],
        };
        if (!include.length || include.includes("deps")) {
            out.dependencies = revision.pins.components.map((c: any) => ({ publishedId: String(c.publishedId), version: Number(c.version), digest: c.digest ? digestRef(c.digest) : undefined }));
        }
        if (!include.length || include.includes("capabilities")) {
            out.effects = Array.from(new Set(nodes.flatMap((n: any) => (n.properties && Array.isArray(n.properties.capabilities) ? n.properties.capabilities : []))))
                .map(capabilityRequirement).filter(Boolean);
        }
        return out;
    }

    /**
     * Bounded BFS from a node (plan §4.2): ordered by (depth, nodeId), capped by
     * depth, count and bytes, resumable with a cursor bound to the revision.
     */
    expand(graphId: string, revision: Revision, projection: any, options: { root: string; direction: "in" | "out" | "both"; depth: number; maxNodes: number; maxBytes: number; includeCode?: boolean; cursor?: string }) {
        const nodes: any[] = projection.nodes || [];
        const byId = new Map(nodes.map((n: any) => [n.id, n]));
        const neighbours = (id: string): { id: string; edge: any }[] => {
            const out: { id: string; edge: any }[] = [];
            const node = byId.get(id);
            if ((options.direction === "out" || options.direction === "both") && node) {
                (node.edges || []).forEach((e: any) => (e.connectors || []).forEach((c: any) => {
                    if (byId.has(c.nodeId)) out.push({ id: c.nodeId, edge: { from: { nodeId: id, field: e.field }, to: { nodeId: c.nodeId, field: c.field }, connectorId: c.id } });
                }));
            }
            if (options.direction === "in" || options.direction === "both") {
                nodes.forEach((n: any) => (n.edges || []).forEach((e: any) => (e.connectors || []).forEach((c: any) => {
                    if (c.nodeId === id) out.push({ id: n.id, edge: { from: { nodeId: n.id, field: e.field }, to: { nodeId: id, field: c.field }, connectorId: c.id } });
                })));
            }
            return out.sort((a, b) => a.id.localeCompare(b.id));
        };
        let frontier: { id: string; depth: number }[] = [];
        const visited = new Set<string>();
        if (options.cursor) {
            let state: any;
            try { state = JSON.parse(Buffer.from(options.cursor, "base64").toString("utf8")); } catch (err) { state = null; }
            if (!state || state.revisionId !== revision.revisionId) {
                return { error: { code: "STALE_BASE", message: "the cursor belongs to another revision", rebaseTo: revRef(revision.revisionId) } };
            }
            frontier = state.frontier;
            (state.visited || []).forEach((v: string) => visited.add(v));
        } else {
            if (!byId.has(options.root)) {
                return { error: { code: "NOT_FOUND", message: `no node ${options.root}` } };
            }
            frontier = [{ id: options.root, depth: 0 }];
        }
        const result: any[] = [];
        const edges: any[] = [];
        const edgeIds = new Set<string>();
        const truncated = { byDepth: false, byCount: false, byBytes: false };
        let bytes = 0;
        while (frontier.length) {
            const { id, depth } = frontier[0];
            if (visited.has(id)) { frontier.shift(); continue; }
            const node = byId.get(id);
            const summary: any = this.nodeSummary(graphId, revision, projection, node, []);
            if (options.includeCode) summary.code = node.template;
            const size = Buffer.byteLength(JSON.stringify(summary));
            if (result.length >= options.maxNodes) { truncated.byCount = true; break; }
            if (bytes + size > options.maxBytes && result.length > 0) { truncated.byBytes = true; break; }
            frontier.shift();
            visited.add(id);
            bytes += size;
            result.push(summary);
            if (depth >= options.depth) { if (neighbours(id).some((n) => !visited.has(n.id))) truncated.byDepth = true; continue; }
            neighbours(id).forEach((n) => {
                if (!edgeIds.has(n.edge.connectorId)) { edgeIds.add(n.edge.connectorId); edges.push(n.edge); }
                if (!visited.has(n.id) && !frontier.some((f) => f.id === n.id)) frontier.push({ id: n.id, depth: depth + 1 });
            });
            frontier.sort((a, b) => (a.depth - b.depth) || a.id.localeCompare(b.id));
        }
        const nextCursor = frontier.length && (truncated.byCount || truncated.byBytes)
            ? Buffer.from(JSON.stringify({ revisionId: revision.revisionId, frontier, visited: Array.from(visited) })).toString("base64")
            : undefined;
        return { nodes: result, edges, truncated, nextCursor };
    }
}
