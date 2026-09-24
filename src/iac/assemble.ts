import { IacPolicy, IacProblem } from "./types";

/**
 * Infrastructure composed as a graph (D-48, revising plan §4.9.2).
 *
 * A stack is not a file a node carries; it is what reaches a stack node along
 * the wires.  Each resource node declares one CloudFormation resource, and the
 * connectors say which stack it belongs to — so the arrangement on the canvas
 * *is* the arrangement in the account, and a resource is a component like any
 * other: publishable, reusable, pinned by version.
 *
 * The template is assembled when a plan is asked for, from the graph as the
 * revision has it.  That is a pure function of the projection: no node code
 * runs, nothing is fetched, and the same graph assembles to the same bytes,
 * which is what lets a plan and the apply that follows be about one thing.
 *
 * What it will not do quietly:
 *
 *   - two resources with one logical id, which would silently drop one;
 *   - a `Ref` or `GetAtt` naming a logical id that is not in this stack, which
 *     CloudFormation would refuse minutes later with less to say about it;
 *   - a resource wired into nothing, which is a resource somebody believes is
 *     being deployed and is not.
 */

export interface ResourceFragment {
    nodeId: string;
    logicalId: string;
    type: string;
    properties: Record<string, any>;
    dependsOn?: string[];
    deletionPolicy?: string;
    condition?: string;
    metadata?: Record<string, any>;
}

export interface Assembly {
    ok: boolean;
    problems: IacProblem[];
    /** The template, as JSON: CloudFormation reads it as readily as YAML. */
    template: any;
    text: string;
    fragments: ResourceFragment[];
    /** Resource nodes that reach no stack at all. */
    orphans: { nodeId: string; name: string }[];
}

const LOGICAL_ID = /^[A-Za-z0-9]{1,255}$/;

/** A logical id from what a person called the node, since that is what they will read in AWS. */
export function logicalIdFor(node: any): string {
    const declared = node && node.properties && node.properties.iac && node.properties.iac.resource && node.properties.iac.resource.logicalId;
    if (typeof declared === "string" && declared) {
        return declared;
    }
    const name = (node && node.properties && node.properties.name) || (node && node.id) || "Resource";
    const cleaned = String(name).replace(/[^A-Za-z0-9]/g, "");
    return cleaned || "Resource";
}

/** The resource a node declares, if it declares one. */
export function fragmentOf(node: any): ResourceFragment | null {
    const iac = node && node.properties && node.properties.iac;
    const resource = iac && iac.resource;
    if (!resource || typeof resource !== "object" || typeof resource.type !== "string") {
        return null;
    }
    return {
        nodeId: String(node.id),
        logicalId: logicalIdFor(node),
        type: String(resource.type),
        properties: (resource.properties && typeof resource.properties === "object") ? resource.properties : {},
        dependsOn: Array.isArray(resource.dependsOn) ? resource.dependsOn.map(String) : undefined,
        deletionPolicy: typeof resource.deletionPolicy === "string" ? resource.deletionPolicy : undefined,
        condition: typeof resource.condition === "string" ? resource.condition : undefined,
        metadata: resource.metadata && typeof resource.metadata === "object" ? resource.metadata : undefined,
    };
}

/** Is this node a stack — something a resource can be wired into? */
export function isStackNode(node: any): boolean {
    const iac = node && node.properties && node.properties.iac;
    return !!(iac && iac.stack && typeof iac.stack === "object");
}

/** Everything that reaches this node along connectors, however far upstream. */
export function reaches(projection: any, targetId: string): Set<string> {
    const nodes = (projection && projection.nodes) || [];
    const feeds = new Map<string, string[]>();   // node -> the nodes it delivers to
    nodes.forEach((node: any) => {
        const to: string[] = [];
        ((node.edges) || []).forEach((edge: any) => {
            ((edge.connectors) || []).forEach((connector: any) => {
                if (connector && connector.nodeId) {
                    to.push(String(connector.nodeId));
                }
            });
        });
        feeds.set(String(node.id), to);
    });
    const upstream = new Set<string>();
    let frontier = [targetId];
    // walk backwards, breadth first; a cycle simply stops, because a node
    // already seen is already counted
    while (frontier.length) {
        const next: string[] = [];
        for (const [from, to] of feeds.entries()) {
            if (from === targetId || upstream.has(from)) {
                continue;
            }
            if (to.some((id) => frontier.includes(id))) {
                upstream.add(from);
                next.push(from);
            }
        }
        frontier = next;
    }
    return upstream;
}

/** Logical ids named by `Ref` and `Fn::GetAtt` anywhere in a value. */
export function referencesIn(value: any): string[] {
    const found = new Set<string>();
    const walk = (v: any) => {
        if (Array.isArray(v)) {
            v.forEach(walk);
            return;
        }
        if (!v || typeof v !== "object") {
            return;
        }
        Object.keys(v).forEach((key) => {
            const inner = v[key];
            if (key === "Ref" && typeof inner === "string") {
                found.add(inner);
            } else if (key === "Fn::GetAtt") {
                const name = Array.isArray(inner) ? inner[0] : String(inner).split(".")[0];
                if (name) {
                    found.add(String(name));
                }
            }
            walk(inner);
        });
    };
    walk(value);
    return Array.from(found);
}

/** Names CloudFormation provides itself, which are not resources in this stack. */
const PSEUDO = ["AWS::AccountId", "AWS::Region", "AWS::StackName", "AWS::StackId", "AWS::Partition", "AWS::URLSuffix", "AWS::NoValue", "AWS::NotificationARNs"];

/**
 * The template this stack node's graph describes.
 */
export function assemble(projection: any, stackNodeId: string, policy?: IacPolicy): Assembly {
    const problems: IacProblem[] = [];
    const push = (code: IacProblem["code"], message: string, path?: string, resource?: string) => problems.push({ code, message, path, resource });
    const nodes = (projection && projection.nodes) || [];
    const stackNode = nodes.find((n: any) => n.id === stackNodeId || n.url === stackNodeId);
    const empty: Assembly = { ok: false, problems, template: null, text: "", fragments: [], orphans: [] };
    if (!stackNode) {
        push("SCHEMA_INVALID", `no node ${stackNodeId}`);
        return empty;
    }
    const carried = (stackNode.properties && stackNode.properties.iac) || {};
    const upstream = reaches(projection, String(stackNode.id));
    const fragments: ResourceFragment[] = [];
    const byLogicalId = new Map<string, ResourceFragment>();

    nodes.forEach((node: any) => {
        if (!upstream.has(String(node.id))) {
            return;
        }
        const fragment = fragmentOf(node);
        if (!fragment) {
            return;   // a node that shapes a value on the way is not a resource
        }
        if (!LOGICAL_ID.test(fragment.logicalId)) {
            push("SCHEMA_INVALID", `"${fragment.logicalId}" cannot be a logical id: letters and digits only`, `Resources.${fragment.logicalId}`, fragment.nodeId);
            return;
        }
        const clash = byLogicalId.get(fragment.logicalId);
        if (clash) {
            push("SCHEMA_INVALID", `two resources are both called ${fragment.logicalId} (nodes ${clash.nodeId} and ${fragment.nodeId}); one would silently replace the other`, `Resources.${fragment.logicalId}`, fragment.nodeId);
            return;
        }
        byLogicalId.set(fragment.logicalId, fragment);
        fragments.push(fragment);
    });

    // a resource nobody wired into a stack is a resource somebody thinks is being deployed
    const orphans = nodes
        .filter((node: any) => fragmentOf(node) && !upstream.has(String(node.id)) && String(node.id) !== String(stackNode.id))
        .filter((node: any) => !nodes.some((other: any) => isStackNode(other) && other.id !== stackNode.id && reaches(projection, String(other.id)).has(String(node.id))))
        .map((node: any) => ({ nodeId: String(node.id), name: (node.properties && node.properties.name) || String(node.id) }));

    if (!fragments.length) {
        push("TEMPLATE_EMPTY", "nothing is wired into this stack, so it describes no resources");
        return { ...empty, orphans };
    }

    fragments.forEach((fragment) => {
        referencesIn(fragment.properties).forEach((name) => {
            if (PSEUDO.includes(name) || byLogicalId.has(name) || (carried.parameters && carried.parameters[name] !== undefined)) {
                return;
            }
            push("SCHEMA_INVALID", `${fragment.logicalId} refers to ${name}, which is not in this stack; wire that resource into the same stack, or name a parameter`, `Resources.${fragment.logicalId}`, fragment.nodeId);
        });
        (fragment.dependsOn || []).forEach((name) => {
            if (!byLogicalId.has(name)) {
                push("SCHEMA_INVALID", `${fragment.logicalId} depends on ${name}, which is not in this stack`, `Resources.${fragment.logicalId}.DependsOn`, fragment.nodeId);
            }
        });
    });

    const Resources: Record<string, any> = {};
    fragments.forEach((fragment) => {
        Resources[fragment.logicalId] = {
            Type: fragment.type,
            Properties: fragment.properties,
            ...(fragment.dependsOn ? { DependsOn: fragment.dependsOn } : {}),
            ...(fragment.deletionPolicy ? { DeletionPolicy: fragment.deletionPolicy } : {}),
            ...(fragment.condition ? { Condition: fragment.condition } : {}),
            ...(fragment.metadata ? { Metadata: fragment.metadata } : {}),
        };
    });
    const template: any = {
        AWSTemplateFormatVersion: "2010-09-09",
        Description: String((stackNode.properties && stackNode.properties.description) || `${(carried.stack && carried.stack.name) || "stack"}, as this graph describes it`).slice(0, 1024),
        Resources,
        ...(carried.outputs && typeof carried.outputs === "object" ? { Outputs: carried.outputs } : {}),
        ...(carried.templateParameters && typeof carried.templateParameters === "object" ? { Parameters: carried.templateParameters } : {}),
    };
    return {
        ok: problems.length === 0,
        problems,
        template,
        text: JSON.stringify(template, null, 2),
        fragments,
        orphans,
    };
}
