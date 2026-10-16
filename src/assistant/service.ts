import {Principal} from '../auth/principal';
import {ChatService, Person, userIdOf} from '../chat/service';
import {ChatMessage, ChatError, conflict, digest} from '../chat/store';
import {assistantPrincipal} from './identity';
import {AgentRequest, AgentStore} from './store';
import {LIMITS, MODEL_ID} from './contract';
export class AssistantService {
    readonly store: AgentStore;
    constructor(readonly chat: ChatService, readonly enqueue: (id: string, room: string) => Promise<void>, readonly enabled = () => process.env.BEDROCK_AGENT_ENABLED === 'true') {
        this.store = new AgentStore(chat.log.storage);
    }
    async peer(owner: Principal, graphId?: string): Promise<Person | undefined> {
        if (!this.enabled() || owner.kind !== 'human' || !graphId) return undefined;
        return this.chat.person(assistantPrincipal(owner, graphId, Date.now() + LIMITS.requestTtlMs));
    }
    async posted(owner: Principal, peer: Person, message: ChatMessage, room: string) {
        if (!this.enabled()) throw new ChatError('ASSISTANT_DISABLED', 'Opus is not enabled on this server.');
        if (owner.kind !== 'human' || !peer.assistant || peer.assistant.ownerId !== userIdOf(owner)) throw new ChatError('ADMISSION_DENIED', 'Only the authenticated conversation owner can invoke Opus.');
        const id = digest(`${room}:${message.id}`), key = AgentStore.requestKey(id);
        let request: AgentRequest = await this.store.get(key);
        if (!request) {
            const now = Date.now();
            request = {id, graphId: peer.assistant.graphId, room, peerId: peer.id, messageId: message.id, seq: message.seq, createdAt: now,
                expiresAt: Math.min(now + LIMITS.requestTtlMs, owner.expiresAt ? owner.expiresAt * 1000 : Infinity), modelId: process.env.BEDROCK_MODEL_ID || MODEL_ID,
                // Explicit copy: never persist an auth header, token, email or model-supplied identity.
                owner: {sub: owner.sub, kind: 'human', tenant: owner.tenant, name: owner.name, scopes: []}};
            try {await this.store.claim(key, request);} catch (err) {if (!conflict(err)) throw err; request = await this.store.get(key);}
        }
        const state = await this.store.get(AgentStore.stateKey(id));
        if (state && state.status !== 'queued') return;
        if (!await this.store.quota(userIdOf(owner), id, request.createdAt)) {
            await this.reply(request, 'limit', 'Opus has reached the limit of 20 requests per user this UTC hour. Your message is saved; send a new message next hour.', 'done');
            try {await this.store.claim(AgentStore.stateKey(id), {status: 'failed', code: 'REQUEST_LIMIT', endedAt: Date.now()});} catch (err) {if (!conflict(err)) throw err;}
            return;
        }
        await this.reply(request, 'queued', 'Opus is queued. I can inspect this graph and prepare proposals for review.', 'thinking');
        if (!state) {try {await this.store.claim(AgentStore.stateKey(id), {status: 'queued'});} catch (err) {if (!conflict(err)) throw err;}}
        await this.enqueue(id, room);
    }
    async reply(request: AgentRequest, key: string, text: string, phase: ChatMessage['phase'] = 'message', acknowledges: string[] = []) {
        const principal = assistantPrincipal(request.owner, request.graphId, Date.now() + 60000);
        const session = `opus-${request.id.slice(0, 40)}`;
        await this.chat.join(request.graphId, principal, session, 'Opus');
        return this.chat.post(principal, {graphId: request.graphId, peerId: userIdOf(request.owner), agentSessionId: session,
            messageId: digest(`${request.id}:${key}`), text, phase, ...(acknowledges.length ? {acknowledges} : {})}, true);
    }
}
