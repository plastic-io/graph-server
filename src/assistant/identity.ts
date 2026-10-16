import {Principal} from '../auth/principal';
import {digest} from '../chat/store';

// This authority exists only inside the trusted tool bridge. JSON, OAuth claims,
// graph properties and model arguments cannot manufacture this symbol.
const binding = Symbol('built-in-assistant-authority');
export const ASSISTANT_SCOPES = ['graph:read', 'graph:inspect-internals', 'graph:inspect-payloads',
    'graph:observe', 'graph:propose', 'iac:propose', 'iac:read-status'];
export function assistantSubject(ownerSub: string, graphId: string) {return `platform:opus:${digest(ownerSub + ':' + graphId)}`;}
export function assistantPrincipal(owner: Principal, graphId: string, expiresAt: number): Principal {
    if (owner.kind !== 'human' || !owner.sub || !graphId || expiresAt <= Date.now()) throw new Error('Invalid assistant delegation');
    return Object.freeze({sub: assistantSubject(owner.sub, graphId), name: 'Opus', kind: 'agent', tenant: owner.tenant,
        scopes: [...ASSISTANT_SCOPES], delegatedBy: owner.sub,
        [binding]: Object.freeze({ownerSub: owner.sub, graphId, expiresAt})}) as Principal;
}
export function assistantBinding(p: Principal | undefined): {ownerSub: string; graphId: string; expiresAt: number} | undefined {
    return p && (p as any)[binding];
}
export function resolveAssistant(p: Principal, graphId?: string): Principal | undefined {
    const grant = assistantBinding(p);
    if (!grant) return undefined;
    const valid = grant.graphId === graphId && grant.expiresAt > Date.now();
    return {...p, scopes: valid ? p.scopes.filter(s => ASSISTANT_SCOPES.includes(s)) : []};
}
