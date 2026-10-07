import {createHash} from "crypto";
import {encodeMessage, messagesFrom, mergePayloads} from "./document";

export interface ChatMessage {
    id: string;
    seq: number;
    at: string;
    sender: {id: string; userId: string; name: string; role: "human" | "agent"};
    text: string;
    phase: "message" | "thinking" | "doing" | "done" | "acknowledged";
    interrupt: boolean;
    acknowledges: string[];
}
export interface ChatStorage {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, value: any, meta: any, cb: (err: any, data?: any) => void): void;
    list(prefix: string, cb: (err: any, data: any) => void): void;
    getVersioned(key: string, cb: (err: any, data: any) => void): void;
    compareAndSet(key: string, value: any, etag: string | null, cb: (err: any, data?: any) => void): void;
}
interface Entry {id: string; seq: number; payload: string}
interface Page {seq: number; entries: Entry[]; previous: string | null; updateFormat: 2}
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const missing = (err: any) => err?.code === "NoSuchKey" || err?.code === "NotFound" || err?.statusCode === 404 || /^NoSuchKey:/.test(err?.message || "");
export const conflict = (err: any) => err?.statusCode === 412 || err?.statusCode === 409 || err?.code === "PreconditionFailed";
export class ChatError extends Error {
    constructor(public code: string, message: string) {super(message);}
}

/** A paged Yjs sidecar, independent of the graph definition. The durable data
 * is a collection of V2 Yjs updates; JSON messages are projections for MCP.
 * HEAD's CAS orders admitted updates and gives history a stable cursor. It
 * does not resolve CRDT conflicts: Yjs handles duplicate/out-of-order delivery.
 * Full pages are immutable and no untrusted client can overwrite old entries. */
export class ChatStore {
    constructor(readonly storage: ChatStorage, readonly pageSize = 50) {}
    static headKey(room: string) {return `chat/rooms/${room}/HEAD.json`;}
    async get(key: string): Promise<any | null> {
        return new Promise((resolve, reject) => this.storage.get(key, (err, data) => err ? missing(err) ? resolve(null) : reject(err) : resolve(data)));
    }
    async put(key: string, value: any): Promise<void> {
        return new Promise((resolve, reject) => this.storage.set(key, value, {}, err => err ? reject(err) : resolve()));
    }
    async keys(prefix: string): Promise<string[]> {
        return new Promise((resolve, reject) => this.storage.list(prefix, (err, items) => err ? reject(err) : resolve((items || []).map(i => i.Key))));
    }
    private async head(room: string): Promise<{value: Page; etag: string | null}> {
        return new Promise((resolve, reject) => this.storage.getVersioned(ChatStore.headKey(room), (err, data) => {
            if (err) return missing(err) ? resolve({value: {seq: 0, entries: [], previous: null, updateFormat: 2}, etag: null}) : reject(err);
            if (!data?.etag) return reject(new Error("Chat storage did not return an ETag"));
            resolve(data);
        }));
    }
    private async older(room: string, page: Page): Promise<Page | null> {
        if (!page.previous) return null;
        const previous = await this.get(`chat/rooms/${room}/pages/${page.previous}.json`);
        if (!previous) throw new Error("Chat history page is missing");
        return previous;
    }
    async read(room: string, options: {after?: number; before?: number; limit?: number; stateVector?: string} = {}) {
        const {value: head} = await this.head(room);
        const limit = Math.max(1, Math.min(50, options.limit || 10));
        let page: Page | null = head;
        let entries: Entry[] = [];
        while (page) {
            entries = page.entries.filter(m => (options.after === undefined || m.seq > options.after) && (options.before === undefined || m.seq < options.before)).concat(entries);
            if (options.after !== undefined ? !page.previous || page.entries[0]?.seq <= options.after + 1 : entries.length >= limit + 1) break;
            page = await this.older(room, page);
        }
        const more = entries.length > limit;
        entries = options.after !== undefined ? entries.slice(0, limit) : entries.slice(-limit);
        const complete = mergePayloads(entries.map(e => e.payload));
        const messages = messagesFrom(complete.payload);
        const update = options.stateVector ? mergePayloads(entries.map(e => e.payload), options.stateVector) : complete;
        return {...update, messages, latestSeq: head.seq, cursor: messages.length ? messages[messages.length - 1].seq : options.after || 0,
            hasMore: more, before: messages.length ? messages[0].seq : null};
    }
    /** A durable reservation precedes every append. Its sequence watermark
     * bounds recovery after a lost receipt; completed retries use the receipt
     * directly instead of scanning years of conversation history. */
    async append(room: string, input: Omit<ChatMessage, "seq" | "at">): Promise<ChatMessage> {
        const receiptKey = `chat/rooms/${room}/requests/${digest(input.id)}.json`;
        const fingerprint = digest(JSON.stringify(input));
        let receipt = await this.get(receiptKey);
        if (!receipt) {
            const {value: head} = await this.head(room);
            const reservation = {fingerprint, after: head.seq};
            try {await this.claim(receiptKey, reservation); receipt = reservation;}
            catch (err) {if (!conflict(err)) throw err; receipt = await this.get(receiptKey);}
        }
        if (!receipt || receipt.fingerprint !== fingerprint) throw new ChatError("IDEMPOTENCY_CONFLICT", "Use a new message ID when changing a message.");
        if (receipt.entry) return messagesFrom(receipt.entry.payload)[0];
        const finish = async (entry: Entry) => {
            await this.put(receiptKey, {...receipt, entry});
            return messagesFrom(entry.payload)[0];
        };
        for (let attempt = 0; attempt < 20; attempt++) {
            const {value: head, etag} = await this.head(room);
            let page: Page | null = head;
            while (page && page.seq > receipt.after) {
                const existing = page.entries.find(m => m.id === input.id);
                if (existing) {
                    const {seq, at, ...body} = messagesFrom(existing.payload)[0];
                    if (JSON.stringify(body) !== JSON.stringify(input)) throw new ChatError("IDEMPOTENCY_CONFLICT", "Use a new message ID when changing a message.");
                    return finish(existing);
                }
                page = await this.older(room, page);
            }
            let previous = head.previous;
            let entries = head.entries;
            if (entries.length >= this.pageSize) {
                // A content-addressed snapshot is safe for all concurrent writers
                // to create. Losing a CAS leaves at most an unreferenced page.
                previous = digest(JSON.stringify(head));
                await this.put(`chat/rooms/${room}/pages/${previous}.json`, head);
                entries = [];
            }
            const message = {...input, seq: head.seq + 1, at: new Date().toISOString()};
            const entry: Entry = {id: message.id, seq: message.seq, payload: encodeMessage(message)};
            try {
                await new Promise<void>((resolve, reject) => this.storage.compareAndSet(ChatStore.headKey(room), {seq: message.seq, previous, updateFormat: 2, entries: [...entries, entry]}, etag, err => err ? reject(err) : resolve()));
                return finish(entry);
            } catch (err) {
                if (!conflict(err)) throw err;
                await new Promise(resolve => setTimeout(resolve, Math.min(100, 3 * (attempt + 1)) + Math.random() * 10));
            }
        }
        throw new ChatError("BUSY", "The room is busy. Retry with the same message ID.");
    }
    async updateFor(room: string, id: string) {
        const receipt = await this.get(`chat/rooms/${room}/requests/${digest(id)}.json`);
        if (!receipt?.entry) throw new Error("Chat update receipt is missing");
        return {payload: receipt.entry.payload as string, updateFormat: 2};
    }
    async claim(key: string, value: any): Promise<void> {
        await new Promise<void>((resolve, reject) => this.storage.compareAndSet(key, value, null, err => err ? reject(err) : resolve()));
    }
}
