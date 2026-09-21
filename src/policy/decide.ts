import { Principal } from "../auth/principal";

/** The authorities of plan §4.4.5.  The full matrix arrives with the admission service (PB-013/022). */
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

export const POLICY_VERSION = "m1-owner";

/**
 * Reference-instance policy (decided 2026-09-20): every authenticated principal is an owner
 * with every authority, unless OWNER_SUBS lists who may act, in which case anyone else is
 * denied.  Agent tokens that carry scopes are narrowed to those scopes.
 */
export function decide(principal: Principal | undefined, required: Authority[]): Decision {
    if (!principal) {
        return { allow: false, reason: "unauthenticated", policyVersion: POLICY_VERSION };
    }
    const owners = (process.env.OWNER_SUBS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (owners.length && !owners.includes(principal.sub)) {
        return { allow: false, reason: `${principal.sub} is not an owner of this instance`, policyVersion: POLICY_VERSION };
    }
    if (principal.kind === "agent" && principal.scopes.length) {
        const missing = required.filter((a) => !principal.scopes.includes(a));
        if (missing.length) {
            return { allow: false, reason: `agent token lacks ${missing.join(", ")}`, policyVersion: POLICY_VERSION };
        }
    }
    return { allow: true, policyVersion: POLICY_VERSION };
}
