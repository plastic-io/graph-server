import {Principal} from '../auth/principal';
import {ChatStorage, ChatStore, conflict, missing} from '../chat/store';
import {LIMITS} from './contract';
export interface AgentRequest {id: string; graphId: string; room: string; peerId: string; owner: Principal; messageId: string; seq: number; createdAt: number; expiresAt: number; modelId: string;}
export interface AgentState {status: 'queued' | 'running' | 'done' | 'failed' | 'interrupted'; token?: string; startedAt?: number; endedAt?: number; usage?: {inputTokens: number; outputTokens: number}; code?: string;}
export class AgentStore extends ChatStore {
    constructor(storage: ChatStorage) {super(storage);}
    static requestKey(id: string) {return `assistant/requests/${id}.json`;}
    static stateKey(id: string) {return `assistant/jobs/${id}.json`;}
    async version(key: string): Promise<{value: any; etag: string | null}> {
        return new Promise((resolve, reject) => this.storage.getVersioned(key, (err, value) => err ? missing(err) ? resolve({value: null, etag: null}) : reject(err) : resolve(value)));
    }
    async swap(key: string, value: any, etag: string | null) {
        return new Promise<void>((resolve, reject) => this.storage.compareAndSet(key, value, etag, err => err ? reject(err) : resolve()));
    }
    async quota(ownerId: string, id: string, at: number): Promise<boolean> {
        const key = `assistant/limits/${ownerId}/${Math.floor(at / 3600000)}.json`;
        for (let attempt = 0; attempt <= LIMITS.requestsPerHour; attempt++) {
            const {value, etag} = await this.version(key), ids: string[] = value?.ids || [];
            if (ids.includes(id)) return true;
            if (ids.length >= LIMITS.requestsPerHour) return false;
            try {await this.swap(key, {ids: [...ids, id]}, etag); return true;} catch (err) {if (!conflict(err)) throw err;}
        }
        throw new Error('Assistant request limit is busy; retry with the same message ID.');
    }
    async claimRun(id: string, token: string): Promise<'claimed' | 'finished' | 'abandoned'> {
        const key = AgentStore.stateKey(id), {value, etag} = await this.version(key);
        if (value && value.status !== 'queued') {
            if (value.status !== 'running') return 'finished';
            if (Date.now() - value.startedAt < 330000) throw new Error('Assistant turn is still running');
            // Never replay a graph tool after a lost worker. A new human turn is needed.
            await this.swap(key, {...value, status: 'failed', code: 'WORKER_INTERRUPTED', endedAt: Date.now()}, etag);
            return 'abandoned';
        }
        await this.swap(key, {status: 'running', token, startedAt: Date.now()}, etag);
        return 'claimed';
    }
    async finish(id: string, token: string, result: Partial<AgentState>) {
        const key = AgentStore.stateKey(id), {value, etag} = await this.version(key);
        if (value?.token !== token || value?.status !== 'running') throw new Error('Assistant lease is no longer current');
        await this.swap(key, {...value, ...result, endedAt: Date.now()}, etag);
    }
}
