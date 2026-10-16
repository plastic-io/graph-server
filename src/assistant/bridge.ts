import {McpDeps} from '../mcp/server';
import {decide} from '../policy/decide';
import {AssistantService} from './service';
import {AgentRequest, AgentStore} from './store';
import {assistantPrincipal} from './identity';
import {withGraphTools} from './tools';
import {boundedResult, chatChunks, safeText} from './safety';
import {LIMITS} from './contract';
import {userIdOf} from '../chat/service';

/** IAM-invoked only. Caller identity is loaded from an immutable server record,
 * never accepted from the worker/model. The worker cannot write that record. */
export function makeAssistantBridge(service: AssistantService, deps: McpDeps) {
    return async (event: any) => {
        if (!/^[a-f0-9]{64}$/.test(event?.id || '') || !service.enabled()) throw new Error('Assistant is unavailable');
        const request: AgentRequest = await service.store.get(AgentStore.requestKey(event.id));
        if (!request || request.owner.kind !== 'human' || !decide(request.owner, ['graph:read', 'graph:propose']).allow || !await deps.crdtStore.exists(request.graphId)) throw new Error('Assistant graph access denied');
        const state = await service.store.get(AgentStore.stateKey(request.id));
        if (event.action === 'abandoned' && state?.code === 'WORKER_INTERRUPTED') {
            await service.reply(request, 'abandoned', 'The Opus worker stopped before finishing. Previously attempted tools will not be replayed. Inspect the current graph and send a new message to continue safely.', 'done');
            return {status: 'failed'};
        }
        if (!state || state.status !== 'running' || state.token !== event.token) throw new Error('Assistant turn is no longer active');
        const session = `opus-${request.id.slice(0, 40)}`;
        const principal = assistantPrincipal(request.owner, request.graphId, Date.now() + 60000);
        await service.chat.join(request.graphId, principal, session, 'Opus');
        const pending = await service.chat.interruptions(request.graphId, principal, session);
        const expired = request.expiresAt <= Date.now();
        if (event.action === 'control') return {interrupted: pending.length > 0, expired};
        if (event.action === 'finish') {
            if (!['done', 'failed', 'interrupted'].includes(event.status)) throw new Error('Invalid terminal status');
            if (event.status === 'done' && pending.length) {
                event = {...event, status: 'interrupted', code: 'CHAT_INTERRUPTED', text: 'Paused after an interruption. This turn has stopped; already created proposals remain available for review.'};
            }
            const ownerId = (await service.chat.person(request.owner)).id;
            const privateInterruptions = pending.filter(m => m.peerId === ownerId).map(m => m.id);
            if (privateInterruptions.length) await service.reply(request, 'interruption-ack', 'Paused this turn. Your feedback will be handled in the next queued conversation turn.', 'acknowledged', privateInterruptions.slice(0, 50));
            for (const [index, text] of chatChunks(event.text || '').entries()) await service.reply(request, `final-${index}`, text, 'done');
            // Stop acknowledgement is deliberately private, even for a public interruption.
            // It does not clear another participant's public interruption or resume work.
            await service.store.finish(request.id, event.token, {status: event.status, code: String(event.code || '').slice(0, 80),
                usage: {inputTokens: Math.max(0, Number(event.usage?.inputTokens) || 0), outputTokens: Math.max(0, Number(event.usage?.outputTokens) || 0)}});
            return {status: event.status};
        }
        if (expired) throw new Error('The original sign-in or queued request expired. Sign in and send a new message.');
        if (pending.length) throw Object.assign(new Error('A participant interrupted this turn. Stop work and read the new message.'), {code: 'CHAT_INTERRUPTED'});
        if (event.action === 'bootstrap') {
            const history = await service.chat.read(principal, {graphId: request.graphId, peerId: (await service.chat.person(request.owner)).id, limit: LIMITS.historyMessages, before: request.seq + 1});
            return withGraphTools(deps, principal, request.graphId, session, async tools => ({graphId: request.graphId,
                history: history.messages.map(m => ({role: m.sender.userId === userIdOf(request.owner) ? 'user' : 'assistant', text: safeText(m.text)})), tools: await tools.list()}));
        }
        if (event.action === 'tool') {
            if (!/^[A-Za-z0-9_-]{1,64}$/.test(event.callId || '')) throw new Error('Invalid tool call ID');
            await service.reply(request, `tool-${event.callId}`, `Using ${safeText(event.name, 80)}.`, 'doing');
            return withGraphTools(deps, principal, request.graphId, session, async tools => boundedResult(await tools.call(event.name, event.args)));
        }
        throw new Error('Unknown assistant bridge action');
    };
}
