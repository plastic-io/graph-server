import { Principal } from "../auth/principal";
import { decide } from "./decide";

/**
 * How much of an agent's work a person wants to see before it takes effect.
 *
 * Two separate questions run through this system, and conflating them is how
 * autonomy turns into a mess: a delegation says *what* an agent may do, and
 * this says *whether a person reviews it first*.  An agent with no commit
 * delegation cannot commit in either mode; an agent with one commits alone in
 * `auto` and waits for a person in `supervised`.
 *
 * It is settable in two places, because there are two reasons to want it: a
 * graph can say it for itself (`properties.autonomy`, a privileged change like
 * any other, so it shows in the diff and is audited), and a person can say it
 * for everything of theirs (`policy/users/<sub>.json`, which only they may
 * set).  The graph wins where both speak; where neither does, work is
 * supervised, which is the answer that surprises nobody.
 *
 * What autonomy never does is skip the gates.  Tests and journeys still decide
 * whether something may be published or become the version that runs: `auto`
 * removes the person from the loop, not the checks.
 */

export type Autonomy = "supervised" | "auto";

export interface UserPolicy {
    sub: string;
    autonomy: Autonomy;
    updatedAt: string;
    updatedBy: string;
    /** Why they set it, for whoever reads this later. */
    note?: string;
}

interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
}

export const isAutonomy = (value: any): value is Autonomy => value === "auto" || value === "supervised";

export class AutonomyStore {
    constructor(private store: Store) {}

    static key(sub: string) { return `policy/users/${encodeURIComponent(sub)}.json`; }

    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }

    /** What this person said about their own work, if anything. */
    async forUser(sub: string | undefined): Promise<UserPolicy | null> {
        if (!sub) {
            return null;
        }
        const stored = await this.getJson(AutonomyStore.key(sub));
        return stored && isAutonomy(stored.autonomy) ? stored : null;
    }

    /**
     * The mode that applies to work on this graph: what the graph says, else
     * what the person who owns the delegation said, else supervised.
     */
    async resolve(graph: any, delegatedBy: string | undefined): Promise<{ autonomy: Autonomy; from: "graph" | "profile" | "default" }> {
        const fromGraph = graph && graph.properties && graph.properties.autonomy;
        if (isAutonomy(fromGraph)) {
            return { autonomy: fromGraph, from: "graph" };
        }
        const profile = await this.forUser(delegatedBy);
        if (profile) {
            return { autonomy: profile.autonomy, from: "profile" };
        }
        return { autonomy: "supervised", from: "default" };
    }

    /** Set it for a person; only they, or someone who administers policy, may. */
    async put(sub: string, principal: Principal | undefined, body: { autonomy: any; note?: string }): Promise<UserPolicy | { error: string; code: string }> {
        if (!principal) {
            return { error: "unauthenticated", code: "ADMISSION_DENIED" };
        }
        // Only the person themselves, and nobody on their behalf.  Every human
        // principal holds every authority in this single-owner model, so a
        // `policy:admin` check here would let anyone signed in change anyone
        // else's setting; whose work runs unreviewed is not a thing to be
        // decided for someone.
        if (principal.sub !== sub) {
            return { error: `only ${sub} can set how much of their work is reviewed`, code: "ADMISSION_DENIED" };
        }
        const allowed = decide(principal, ["graph:read"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        if (!isAutonomy(body.autonomy)) {
            return { error: "autonomy is either supervised or auto", code: "SCHEMA_INVALID" };
        }
        const policy: UserPolicy = {
            sub,
            autonomy: body.autonomy,
            updatedAt: new Date().toISOString(),
            updatedBy: principal.sub,
            note: body.note ? String(body.note).slice(0, 500) : undefined,
        };
        await new Promise<void>((resolve, reject) => this.store.set(AutonomyStore.key(sub), policy, {}, (err: any) => (err ? reject(err) : resolve())));
        return policy;
    }

    /** `GET /policy/autonomy`, `PUT /policy/autonomy` (the caller's own). */
    route(event: any, context: any, callback: (err: any, r: any) => void) {
        const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": true };
        const principal = event.principal;
        const sub = (event.queryStringParameters && event.queryStringParameters.sub) || (principal && principal.sub);
        if (!principal || !sub) {
            callback(null, { statusCode: 401, body: JSON.stringify({ error: "unauthenticated", code: "ADMISSION_DENIED" }), headers });
            return;
        }
        if (event.httpMethod === "PUT" || event.httpMethod === "POST") {
            let body: any = {};
            try { body = event.body ? JSON.parse(event.body) : {}; } catch (err) { body = {}; }
            this.put(sub, principal, body)
                .then((r: any) => callback(null, { statusCode: r.error ? (r.code === "ADMISSION_DENIED" ? 403 : 400) : 200, body: JSON.stringify(r.error ? r : { policy: r }), headers }))
                .catch((err) => { console.error("Cannot set autonomy.", err); callback(null, { statusCode: 500, headers }); });
            return;
        }
        this.forUser(sub)
            .then((policy) => callback(null, { statusCode: 200, body: JSON.stringify({ sub, policy, autonomy: policy ? policy.autonomy : "supervised", from: policy ? "profile" : "default" }), headers }))
            .catch((err) => { console.error("Cannot read autonomy.", err); callback(null, { statusCode: 500, headers }); });
    }
}
