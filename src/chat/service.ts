import {Principal, connectionIsCurrent} from "../auth/principal";
import {DelegationStore} from "../policy/delegation";
import {decide} from "../policy/decide";
import {ChatStore, ChatStorage, ChatMessage, ChatError, digest, conflict} from "./store";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const GRAPH = /^[A-Za-z0-9_.-]{1,64}$/;
const USER = /^[a-f0-9]{64}$/;
export const userIdOf = (principal: Principal) => digest(principal.sub);
export const graphRoom = (graphId: string) => `graph-${graphId}`;
export const personalChannel = (principal: Principal) => `chat-user-${userIdOf(principal)}`;
export const graphChannel = (graphId: string) => `graph-chat-${graphId}`;
const directRoom = (a: string, b: string) => `direct-${digest([a, b].sort().join(":"))}`;
interface Person {id: string; name: string; handle: string}
interface Session {id: string; sub: string; graphId: string; name: string; joinedSeq: number; joinedAt: string; directCursors: Record<string, number>}
interface Broadcast {
    _sendToChannel(channel: string, value: any, cb: (err?: any) => void): void;
    postToClient(domain: string, connection: string, value: any, cb: (err?: any) => void): void;
}
export class ChatService {
    readonly log: ChatStore;
    readonly delegations: DelegationStore;
    constructor(storage: ChatStorage, private broadcast: Broadcast, private exists: (graphId: string) => Promise<boolean>) {
        this.log = new ChatStore(storage);
        this.delegations = new DelegationStore(storage as any);
    }
    private async authorize(principal: Principal | undefined, graphId?: string) {
        const effective = await this.delegations.resolve(principal, graphId);
        const decision = decide(effective, ["graph:read"]);
        if (!decision.allow) throw new ChatError("ADMISSION_DENIED", "You cannot access this conversation.");
        if (graphId !== undefined && (!GRAPH.test(graphId) || !(await this.exists(graphId)))) throw new ChatError("NOT_FOUND", "Save the graph before opening its chat.");
        return effective!;
    }
    /** Identity comes only from verified authentication, never message fields. */
    async person(principal: Principal): Promise<Person> {
        const id = userIdOf(principal);
        const name = String(principal.name || (principal.kind === "agent" ? "Agent" : "User")).slice(0, 80);
        const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "user";
        const person = {id, name, handle: `${slug}-${id.slice(0, 8)}`};
        await this.log.put(`chat/people/${id}.json`, person);
        return person;
    }
    async directory(principal: Principal, graphId?: string) {
        await this.authorize(principal, graphId);
        const me = await this.person(principal);
        const online = new Set<string>();
        const connections = await this.log.keys("connections/");
        for (const key of connections) {
            const record = await this.log.get(key);
            if (record?.principal && connectionIsCurrent(record.principal)) online.add(userIdOf(record.principal));
        }
        // Directory contains only accounts which have opened messaging. History
        // and message bodies are never exposed by presence or directory lookup.
        const people = await Promise.all((await this.log.keys("chat/people/")).map(key => this.log.get(key)));
        return {me, people: people.filter(Boolean).map(p => ({...p, online: online.has(p.id)})).sort((a, b) => a.handle.localeCompare(b.handle))};
    }
    async inbox(principal: Principal, graphId?: string) {
        await this.authorize(principal, graphId);
        const threads = await Promise.all((await this.log.keys(`chat/inboxes/${userIdOf(principal)}/`)).map(key => this.log.get(key)));
        const current = await Promise.all(threads.filter(Boolean).map(async thread => {
            const head = await this.log.read(thread.room, {limit: 1});
            return {...thread, latestSeq: head.latestSeq, at: head.messages[0]?.at || ""};
        }));
        return {threads: current.sort((a, b) => b.at.localeCompare(a.at))};
    }
    private sessionKey(principal: Principal, id: string) {return `chat/sessions/${userIdOf(principal)}/${id}.json`;}
    async join(graphId: string, principal: Principal, id: string, name: string) {
        await this.authorize(principal, graphId);
        if (!ID.test(id) || !name?.trim() || name.length > 80) throw new ChatError("SCHEMA_INVALID", "Supply a unique session ID and a short agent name.");
        const key = this.sessionKey(principal, id);
        const prior = await this.log.get(key);
        if (prior) {
            if (prior.graphId !== graphId || prior.name !== name.trim()) throw new ChatError("SESSION_CONFLICT", "Use another session ID for a different graph or agent.");
            return prior;
        }
        const head = await this.log.read(graphRoom(graphId), {limit: 1});
        const {threads} = await this.inbox(principal, graphId);
        const directCursors = Object.fromEntries(threads.map(thread => [thread.room, thread.latestSeq]));
        const session: Session = {id, sub: principal.sub, graphId, name: name.trim(), joinedSeq: head.latestSeq, joinedAt: new Date().toISOString(), directCursors};
        try {await this.log.claim(key, session);} catch (err) {if (!conflict(err)) throw err; return this.join(graphId, principal, id, name);}
        await this.person(principal);
        return session;
    }
    private async session(graphId: string, principal: Principal, id?: string): Promise<Session> {
        if (!id || !ID.test(id)) throw new ChatError("SESSION_REQUIRED", "Call chat.join with a unique agentSessionId, then include it in graph tool calls.");
        const session = await this.log.get(this.sessionKey(principal, id));
        if (!session || session.sub !== principal.sub || session.graphId !== graphId) throw new ChatError("SESSION_REQUIRED", "This agent session has not joined this graph.");
        return session;
    }
    private async room(principal: Principal, args: {graphId?: string; peerId?: string}) {
        await this.authorize(principal, args.graphId);
        if (args.peerId) {
            if (!USER.test(args.peerId) || !await this.log.get(`chat/people/${args.peerId}.json`)) throw new ChatError("NOT_FOUND", "That messaging account was not found.");
            return directRoom(userIdOf(principal), args.peerId);
        }
        if (!args.graphId) throw new ChatError("SCHEMA_INVALID", "Choose a graph or a direct-message recipient.");
        return graphRoom(args.graphId);
    }
    async read(principal: Principal, args: {graphId?: string; peerId?: string; after?: number; before?: number; limit?: number; stateVector?: string}) {
        for (const value of [args.after, args.before]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new ChatError("SCHEMA_INVALID", "Invalid history cursor.");
        if (args.after !== undefined && args.before !== undefined) throw new ChatError("SCHEMA_INVALID", "Use after or before, not both.");
        if (args.stateVector !== undefined && (typeof args.stateVector !== "string" || args.stateVector.length > 65536 || !/^[A-Za-z0-9+/]*={0,2}$/.test(args.stateVector))) throw new ChatError("SCHEMA_INVALID", "Invalid chat state vector.");
        return this.log.read(await this.room(principal, args), args);
    }
    async post(principal: Principal, args: {graphId?: string; peerId?: string; agentSessionId?: string; messageId: string; text: string; phase?: ChatMessage["phase"]; interrupt?: boolean; acknowledges?: string[]}, agent = false) {
        // A named mention is always private, including when an MCP caller
        // forgets peerId. Reject ambiguous/unknown mentions instead of leaking.
        if (typeof args.text === "string") {
            const mentions = [...args.text.matchAll(/(?:^|[^\w@])@([a-zA-Z0-9][a-zA-Z0-9_-]*)\b/g)].map(m => m[1].toLowerCase());
            const handles = [...new Set(mentions.filter(h => h !== "here"))];
            if (handles.length > 1 || ((handles.length || args.peerId) && mentions.includes("here"))) throw new ChatError("SCHEMA_INVALID", "Choose @here or one private @handle.");
            if (handles.length) {
                await this.authorize(principal, args.graphId);
                const people = await Promise.all((await this.log.keys("chat/people/")).map(key => this.log.get(key)));
                const found = people.filter(p => p && (p.handle === handles[0] || p.name.toLowerCase() === handles[0]));
                if (found.length !== 1 || (args.peerId && args.peerId !== found[0].id)) throw new ChatError("SCHEMA_INVALID", "Choose an exact @handle from chat.directory.");
                args = {...args, peerId: found[0].id};
            }
        }
        agent = agent || principal?.kind === "agent";
        const room = await this.room(principal, args);
        if (!ID.test(args.messageId || "") || typeof args.text !== "string" || !args.text.trim() || Buffer.byteLength(args.text, "utf8") > 2048) throw new ChatError("SCHEMA_INVALID", "Messages require a unique ID and 1–2048 UTF-8 bytes of text.");
        const phase = args.phase || "message";
        if (!["message", "thinking", "doing", "done", "acknowledged"].includes(phase) || (args.interrupt !== undefined && typeof args.interrupt !== "boolean")) throw new ChatError("SCHEMA_INVALID", "Invalid message state.");
        const person = await this.person(principal);
        const session = agent ? await this.session(args.graphId!, principal, args.agentSessionId) : null;
        const sender: ChatMessage["sender"] = {id: session ? `agent:${person.id}:${session.id}` : `human:${person.id}`, userId: person.id, name: session?.name || person.name, role: session ? "agent" : "human"};
        const acknowledges = args.acknowledges || [];
        if (!Array.isArray(acknowledges) || acknowledges.length > 50 || acknowledges.some(id => !USER.test(id))) throw new ChatError("SCHEMA_INVALID", "Invalid interruption acknowledgements.");
        if (acknowledges.length && (!agent || phase !== "acknowledged")) throw new ChatError("SCHEMA_INVALID", "Acknowledge interruptions with an agent reply in the same conversation.");
        if (acknowledges.length) {
            const pending = await this.interruptions(args.graphId!, principal, args.agentSessionId!);
            if (acknowledges.some(id => !pending.some(m => m.id === id && m.room === room))) {
                // Retrying an acknowledged message must still return the same
                // receipt; append checks its immutable ID and payload below.
                const prior = await this.all(room);
                const ownId = digest(`${sender.id}:${args.messageId}`);
                if (!prior.some(m => m.id === ownId)) throw new ChatError("NOT_FOUND", "An interruption was not found or was already acknowledged.");
            }
        }
        const message = await this.log.append(room, {id: digest(`${sender.id}:${args.messageId}`), sender, text: args.text.trim(), phase,
            interrupt: args.interrupt === true, acknowledges});
        const update = await this.log.updateFor(room, message.id);
        const event = {eventType: "chat.update", room, graphId: args.peerId ? undefined : args.graphId, message, ...update};
        if (args.peerId) {
            const peer = await this.log.get(`chat/people/${args.peerId}.json`);
            // The index holds no message text. A retry repairs a failed index
            // write and rebroadcasts the same durable, deduplicated message.
            await Promise.all([
                this.log.put(`chat/inboxes/${person.id}/${peer.id}.json`, {peer, room}),
                this.log.put(`chat/inboxes/${peer.id}/${person.id}.json`, {peer: person, room}),
            ]);
            await this.publish(`chat-user-${person.id}`, {...event, peer});
            if (peer.id !== person.id) await this.publish(`chat-user-${peer.id}`, {...event, peer: person});
        } else await this.publish(graphChannel(args.graphId!), event);
        return {message, room, ...update};
    }
    private publish(channel: string, event: any): Promise<void> {
        return new Promise((resolve, reject) => this.broadcast._sendToChannel(channel, event, err => err ? reject(err) : resolve()));
    }
    private async all(room: string, after = 0): Promise<ChatMessage[]> {
        const messages: ChatMessage[] = [];
        while (true) {
            const page = await this.log.read(room, {after, limit: 50});
            messages.push(...page.messages); after = page.cursor;
            if (!page.hasMore) return messages;
        }
    }
    async interruptions(graphId: string, principal: Principal, sessionId: string) {
        await this.authorize(principal, graphId);
        const session = await this.session(graphId, principal, sessionId);
        const senderId = `agent:${userIdOf(principal)}:${session.id}`;
        const room = graphRoom(graphId);
        const graphMessages = (await this.all(room, session.joinedSeq)).map(m => ({...m, room, peerId: undefined as string | undefined}));
        const {threads} = await this.inbox(principal, graphId);
        // Sequence watermarks avoid comparing clocks on separate Lambda writers.
        const directMessages = (await Promise.all(threads.map(async thread => (await this.all(thread.room, session.directCursors?.[thread.room] || 0))
            .map(m => ({...m, room: thread.room, peerId: thread.peer.id as string | undefined}))))).flat();
        const messages = graphMessages.concat(directMessages);
        const acknowledged = new Set(messages.filter(m => m.sender.id === senderId).flatMap(m => m.acknowledges));
        return messages.filter(m => (!m.peerId || m.sender.userId !== userIdOf(principal) || m.peerId === userIdOf(principal))
            && m.interrupt && m.sender.id !== senderId && !acknowledged.has(m.id));
    }

    async assertMayWork(graphId: string, principal: Principal, sessionId?: string) {
        await this.session(graphId, principal, sessionId);
        const pending = await this.interruptions(graphId, principal, sessionId!);
        if (pending.length) throw new ChatError("CHAT_INTERRUPTED", "Pause graph work, read chat.read, and respond with chat.post phase=acknowledged and the interruption IDs before continuing.");
    }
    /** Dedicated, authenticated WSS actions. Never accepts a sender/room ID. */
    route(event: any, _context: any, callback: (err: any, response: any) => void) {
        let body: any;
        try {body = JSON.parse(event.body);} catch {return callback(null, {statusCode: 400});}
        if (!ID.test(body?.messageId || "")) return callback(null, {statusCode: 400});
        const ctx = event.requestContext;
        const reply = async (response: any) => {
            // Directory/inbox metadata can outgrow one API Gateway frame even
            // though every individual chat message and history page is bounded.
            const field = Array.isArray(response.people) ? "people" : Array.isArray(response.threads) ? "threads" : undefined;
            const frames: any[] = [];
            if (field && Buffer.byteLength(JSON.stringify(response)) > 24000) {
                let batch: any[] = [];
                for (const item of response[field]) {
                    const next = [...batch, item];
                    if (batch.length && Buffer.byteLength(JSON.stringify({...response, [field]: next})) > 24000) {
                        frames.push({...response, [field]: batch, chunk: {field, final: false}}); batch = [];
                    }
                    batch.push(item);
                }
                frames.push({...response, [field]: batch, chunk: {field, final: true}});
            } else frames.push(response);
            try {
                for (const frame of frames) await new Promise<void>((resolve, reject) => this.broadcast.postToClient(ctx.domainName, ctx.connectionId,
                    {messageId: body.messageId, response: frame}, err => err ? reject(err) : resolve()));
                callback(null, {statusCode: 200});
            } catch (err) {callback(err, {statusCode: 500});}
        };
        const args = body.args || {};
        const principal = event.principal as Principal;
        const run = async () => {
            if (!principal) throw new ChatError("ADMISSION_DENIED", "Sign in to use messaging.");
            if (body.operation === "directory") return this.directory(principal, args.graphId);
            if (body.operation === "inbox") return this.inbox(principal, args.graphId);
            if (body.operation === "history") {
                let limit = Math.min(10, args.limit || 10);
                while (true) {
                    const {messages, ...sync} = await this.read(principal, {...args, limit});
                    if (Buffer.byteLength(JSON.stringify(sync)) <= 24000 || limit <= 1) return sync;
                    limit = Math.max(1, Math.floor(limit / 2));
                }
            }
            if (body.operation === "post") return this.post(principal, args);
            throw new ChatError("SCHEMA_INVALID", "Unknown chat operation.");
        };
        run().then(reply).catch(err => reply({error: err instanceof ChatError ? err.message : "Messaging is temporarily unavailable.", code: err.code || "INTERNAL"}));
    }
}
