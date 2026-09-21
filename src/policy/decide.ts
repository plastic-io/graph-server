import { Principal } from "../auth/principal";
import { DiffSummary, PRIVILEGE_NAMESPACES, SERVER_OWNED_NAMESPACES } from "@plastic-io/graph-crdt";

/** The authorities of plan §4.4.5. */
export type Authority =
    | "graph:read" | "graph:inspect-internals" | "graph:inspect-payloads" | "graph:observe"
    | "graph:propose" | "graph:approve" | "graph:commit" | "graph:activate" | "graph:rollback"
    | "graph:execute" | "graph:simulate" | "graph:test" | "graph:connect-privileged"
    | "component:publish" | "registry:read" | "iac:propose" | "iac:approve" | "iac:read-status" | "policy:admin";

export interface Decision {
    allow: boolean;
    reason?: string;
    policyVersion: string;
}

export const POLICY_VERSION = "m1-diff";

/**
 * What a change needs, read off its semantic diff (plan §7.2 step 4): every commit
 * needs graph:commit; widening what a node may do, or wiring into a node that is
 * already privileged, needs graph:connect-privileged; reaching into the cloud
 * account needs the IaC approver.
 */
export function requiredAuthorities(diff: DiffSummary | null | undefined): Authority[] {
    const required = new Set<Authority>(["graph:commit"]);
    if (!diff) {
        return Array.from(required);
    }
    const privileged = diff.namespaces.some((ns) => (PRIVILEGE_NAMESPACES as string[]).includes(ns))
        || diff.privilegeDelta.privilegedEdges.length > 0;
    if (privileged) {
        required.add("graph:connect-privileged");
    }
    if (diff.namespaces.includes("iac")) {
        required.add("iac:propose");
    }
    if (diff.privilegeDelta.infrastructure) {
        required.add("iac:approve");
    }
    return Array.from(required);
}

/**
 * Namespaces only the server writes (schema meta, observed state mirrors, policy).
 * A client update that touches them is refused whoever sent it, except the first
 * update of a new graph, which has to stamp the schema version.
 */
export function serverOwnedViolation(diff: DiffSummary | null | undefined, principal: Principal | undefined): string | null {
    if (!diff) {
        return null;
    }
    const touched = diff.namespaces.filter((ns) => (SERVER_OWNED_NAMESPACES as string[]).includes(ns));
    if (touched.length === 0 || (principal && principal.kind === "system")) {
        return null;
    }
    if (diff.seed && touched.every((ns) => ns === "meta")) {
        return null;
    }
    return `the ${touched.join(", ")} namespace is written only by the server`;
}

/**
 * Reference-instance policy (decided 2026-09-20): every authenticated principal is an owner
 * with every authority, unless OWNER_SUBS lists who may act, in which case anyone else is
 * denied.  Agent tokens that carry scopes are narrowed to those scopes.
 */
export function decide(principal: Principal | undefined, required: Authority[]): Decision {
    if (!principal) {
        return { allow: false, reason: "unauthenticated", policyVersion: POLICY_VERSION };
    }
    if (principal.kind === "system") {
        // the server acting on its own behalf (revision stamps, observed-state mirrors)
        return { allow: true, policyVersion: POLICY_VERSION };
    }
    const owners = (process.env.OWNER_SUBS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (owners.length && !owners.includes(principal.sub)) {
        return { allow: false, reason: `${principal.sub} is not an owner of this instance`, policyVersion: POLICY_VERSION };
    }
    if (principal.kind === "agent") {
        // an agent holds only what a human delegated to it (policy/delegation.ts resolves that into scopes)
        const scopes = principal.scopes || [];
        if (!scopes.length) {
            return { allow: false, reason: `agent ${principal.sub} has no delegation for this graph`, policyVersion: POLICY_VERSION };
        }
        const missing = required.filter((a) => !scopes.includes(a));
        if (missing.length) {
            return { allow: false, reason: `agent ${principal.sub} lacks ${missing.join(", ")}`, policyVersion: POLICY_VERSION };
        }
    }
    return { allow: true, policyVersion: POLICY_VERSION };
}
