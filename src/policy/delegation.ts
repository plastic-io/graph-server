import { Principal } from "../auth/principal";
import { Authority } from "./decide";

/**
 * Agent delegations (plan §5.0, PB-086).
 *
 * An agent's token says who it is; a delegation record says what a human let
 * it do, on which graph, until when.  `policy/agents/<agentSub>/<graphId>.json`
 * (or `_all.json` for every graph) is written only by a principal with
 * `policy:admin`, with scopes no wider than the delegator's own, and an
 * agent's effective authority is the intersection of its token scopes (when
 * the token carries any) and the delegation.  No record, no authority.
 */
export interface Delegation {
    agentSub: string;
    graphId: string;            // "*" for every graph
    delegatedBy: string;
    scopes: Authority[];
    expiresAt: string | null;
    createdAt: string;
    label?: string;
}

interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
    list(prefix: string, cb: (err: any, data: any) => void): void;
    remove(key: string, cb: (err: any, data: any) => void): void;
}

const ALL = "_all";

export class DelegationStore {
    private store: Store;
    constructor(store: Store) {
        this.store = store;
    }
    static key(agentSub: string, graphId: string) {
        return `policy/agents/${encodeURIComponent(agentSub)}/${graphId === "*" ? ALL : graphId}.json`;
    }
    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }
    private putJson(key: string, value: any): Promise<void> {
        return new Promise((resolve, reject) => this.store.set(key, value, {}, (err: any) => (err ? reject(err) : resolve())));
    }
    private del(key: string): Promise<void> {
        return new Promise((resolve, reject) => this.store.remove(key, (err: any) => (err ? reject(err) : resolve())));
    }
    private listKeys(prefix: string): Promise<string[]> {
        return new Promise((resolve, reject) => this.store.list(prefix, (err: any, items: any[]) => (err ? reject(err) : resolve((items || []).map((i: any) => i.Key)))));
    }

    async get(agentSub: string, graphId: string): Promise<Delegation | null> {
        return this.getJson(DelegationStore.key(agentSub, graphId));
    }
    async list(): Promise<Delegation[]> {
        const keys = await this.listKeys("policy/agents/");
        const out: Delegation[] = [];
        for (const key of keys) {
            const d = await this.getJson(key);
            if (d) out.push(d);
        }
        return out.sort((a, b) => (a.agentSub + a.graphId).localeCompare(b.agentSub + b.graphId));
    }
    async put(delegation: Delegation): Promise<void> {
        await this.putJson(DelegationStore.key(delegation.agentSub, delegation.graphId), delegation);
    }
    async remove(agentSub: string, graphId: string): Promise<void> {
        await this.del(DelegationStore.key(agentSub, graphId));
    }

    /** The delegation that applies to a graph: the graph's own, else the one for every graph. */
    async applicable(agentSub: string, graphId: string | undefined): Promise<Delegation | null> {
        const live = (d: Delegation | null) => (d && !(d.expiresAt && Date.parse(d.expiresAt) < Date.now()) ? d : null);
        const specific = graphId ? live(await this.get(agentSub, graphId)) : null;
        return specific || live(await this.get(agentSub, "*"));
    }

    /**
     * The principal as policy should see it for this graph.  Humans pass
     * through; an agent gets `delegatedBy` and its effective scopes, or no
     * scopes at all when nobody delegated to it.
     */
    async resolve(principal: Principal | undefined, graphId: string | undefined): Promise<Principal | undefined> {
        if (!principal || principal.kind !== "agent") {
            return principal;
        }
        const delegation = await this.applicable(principal.sub, graphId);
        if (!delegation) {
            return { ...principal, scopes: [], delegatedBy: undefined, delegation: null } as any;
        }
        const tokenScopes = principal.scopes || [];
        const effective = tokenScopes.length ? delegation.scopes.filter((s) => tokenScopes.includes(s)) : delegation.scopes.slice();
        return { ...principal, scopes: effective, delegatedBy: delegation.delegatedBy, delegation: { graphId: delegation.graphId, expiresAt: delegation.expiresAt } } as any;
    }
}
