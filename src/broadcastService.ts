import {Context, S3CreateEvent, APIGatewayEvent} from "aws-lambda";
import {ApiGatewayManagementApi} from "aws-sdk";
import S3Service from './s3Service';
import { principalFromAuthorizerContext, connectionKey, forgetConnection } from './auth/principal';
import {newId} from './eventSourceService';
const STAGE = process.env.STAGE;
const BACKOFF_TIMER_ADD = 35;
const CHUNK_SIZE = 35000;
export default class BroadcastService {
    store: S3Service;
    okResponse: {statusCode: number};
    constructor() {
        this.okResponse = {
            statusCode: 200
        };
        this.store = new S3Service(process.env.S3_BUCKET);
    }
    createChunks(msg, chunkCollectionId, chunkSize) {
        const chunks = [];
        const parts = Math.ceil(msg.length / chunkSize);
        const totalLength = msg.length;
        for (let x = 0, part = 0; x < totalLength; x += chunkSize, part += 1) {
            chunks.push({
                chunkCollectionId,
                totalLength,
                chunkSize,
                parts,
                part,
                value: msg.substring(x, x + chunkSize),
            });
        }
        return chunks;
    }
    postToClient(domainName: string, connectionId: string, message: any, callback: (err: any, data: any) => void) {
        const getCircularReplacer = () => {
            const seen = new WeakSet();
            return (key, value) => {
                if (typeof value === "object" && value !== null) {
                    if (seen.has(value)) {
                        return;
                    }
                    seen.add(value);
                }
                return value;
            };
        };
        const postChunk = (chunk: string) => {
            let backoffTimer = 0;
            const buffer = Buffer.from(chunk);
            const client = new ApiGatewayManagementApi({
                apiVersion: "2018-11-29",
                endpoint: `https://${domainName}/${STAGE}`,
            });
            const post = () => {
                client.postToConnection({
                    ConnectionId: connectionId,
                    Data: buffer,
                }, (err) => {
                    if (err && err.statusCode === 410) {
                        console.error(`Error transmitting to a connection, client was disconnected unexpectedly domainName: ${domainName} connectionId: ${connectionId}.`);
                        this._disconnect(domainName, connectionId);
                    } else if (err && err.statusCode === 429) {
                        console.warn("Connection throttled, backing off: ", err);
                        backoffTimer += BACKOFF_TIMER_ADD;
                        return setTimeout(post, backoffTimer);
                    } else if (err) {
                        console.error("Error transmitting to a connection: ", err);
                    }
                    callback(null, this.okResponse);
                });
            };
            post();
        }
        const msgVal = JSON.stringify(message, getCircularReplacer());
        const valueLen = msgVal.length;
        if (valueLen > CHUNK_SIZE) {
            const chunkCollectionId = newId();
            const chunks = this.createChunks(msgVal, chunkCollectionId, CHUNK_SIZE);
            console.log("POST CHUNK COLLECTION", chunkCollectionId, valueLen, chunks);
            chunks.forEach((chunk: any) => {
                const val = JSON.stringify(chunk);
                console.log("POST chunk", val);
                postChunk(val);
            });
            return;
        }
        postChunk(msgVal);
    }
    connect(event: any, context: Context, callback: (err: any, response: any) => void) {
        const ctx = event.requestContext;
        // The principal comes from the $connect authorizer; every later message on this
        // connection is attributed by reading this record (auth/principal.ts).
        const principal = event.principal || principalFromAuthorizerContext(event);
        if (!principal) {
            console.error("Refusing a connection without a principal", ctx.connectionId);
            return callback(null, { statusCode: 401, body: "unauthenticated" });
        }
        const record = { principal, connectionId: ctx.connectionId, domainName: ctx.domainName, connectedAt: Date.now() };
        this.store.set(connectionKey(ctx), record, {}, (err) => {
            if (err) {
                console.error("Cannot create connection record", err);
                return callback(null, { statusCode: 500, body: "cannot record connection" });
            }
            // Browsers can only send the token as a subprotocol; the handshake completes only if
            // the server selects one, so echo the marker back.
            const requested = String((event.headers || {})["Sec-WebSocket-Protocol"] || (event.headers || {})["sec-websocket-protocol"] || "");
            const response: any = { statusCode: 200 };
            if (/(^|,)\s*access_token\s*(,|$)/.test(requested)) {
                response.headers = { "Sec-WebSocket-Protocol": "access_token" };
            }
            callback(null, response);
        });
    }
    _disconnect(domainName, connectionId) {
        forgetConnection({ connectionId, domainName });
        this.store.remove(`connections/${connectionId}/${domainName}`, (err) => {
            if (err) {
                console.error("Cannot remove connection record", err);
            }
        });
        this._listSubscriptions(connectionId, (err, channels) => {
            channels.forEach((channel) => {
                const path = channel.Key.split("/");
                const connectionId = path[1];
                const channelId = path[2];
                const domainName = path[3];
                console.log("remove subscriptions on disconnect", `subscriptions/${channelId}/${connectionId}/${domainName}`);
                this.store.remove(`subscriptions/${channelId}/${connectionId}/${domainName}`, (err) => {
                    if (err) {
                        console.error("disconnect: Cannot remove subscription record", err);
                    }
                });
                this.store.remove(`subscriptions-reverse/${connectionId}/${channelId}/${domainName}`, (err) => {
                    if (err) {
                        console.error("disconnect: Cannot remove reverse subscription record", err);
                    }
                });
            });
        });
    }
    disconnect(event: any, context: Context, callback: (err: any, response: any) => void) {
        const ctx = event.requestContext;
        this._disconnect(ctx.domainName, ctx.connectionId);
        callback(null, this.okResponse);
    }
    unsubscribe(event: any, context: Context, callback: (err: any, response: any) => void) {
        const ctx = event.requestContext;
        const body = JSON.parse(event.body);
        if (!body.channelId) {
            throw new TypeError("unsubscribe: Messages missing channelId from connection: " + ctx.connectionId);
        }
        this.store.remove(`subscriptions/${body.channelId}/${ctx.connectionId}/${ctx.domainName}`, (err) => {
            if (err) {
                console.error("unsubscribe: Cannot remove subscription record", err);
            }
        });
        this.store.remove(`subscriptions-reverse/${ctx.connectionId}/${body.channelId}/${ctx.domainName}`, (err) => {
            if (err) {
                console.error("unsubscribe: Cannot remove reverse subscription record", err);
            }
        });
        this.postToClient(ctx.domainName, ctx.connectionId, {unsubscribed: body.channelId}, (err) => {
            if (err) {
                console.error("Error posting to client", err);
                return callback(err, null);
            }
        });
        callback(null, this.okResponse);
    }
    subscribe(event: any, context: Context, callback: (err: any, response: any) => void) {
        const ctx = event.requestContext;
        const body = JSON.parse(event.body);
        if (!body.channelId) {
            throw new TypeError("subscribe: Messages missing channelId from connection: " + ctx.connectionId);
        }
        this.store.set(`subscriptions-reverse/${ctx.connectionId}/${body.channelId}/${ctx.domainName}`, event, {}, (err) => {
            if (err) {
                console.error("Cannot create reverse subscription record", err);
            }
        });
        this.store.set(`subscriptions/${body.channelId}/${ctx.connectionId}/${ctx.domainName}`, event, {}, (err) => {
            if (err) {
                console.error("Cannot create subscription record", err);
            }
        });
        this.postToClient(ctx.domainName, ctx.connectionId, {subscribed: body.channelId}, (err) => {
            if (err) {
                console.error("Error posting to client", err);
                return callback(err, null);
            }
        });
        callback(null, this.okResponse);
    }
    /**
     * Send `value` to everyone subscribed to `channelId`.
     *
     * The callback fires exactly once, when every recipient has been attempted
     * or the subscriber list could not be read.  That includes the case where
     * there are no subscribers at all, which is the common one for a graph
     * only one person has open: the previous version returned only from inside
     * the delivery loop, so a broadcast to nobody simply never came back, and
     * a caller awaiting it hung until its Lambda was cut off.
     */
    broadcast(channelId: string, value: any, callback: (err: any, response: any) => void,
              excludeConnectionId?: string) {
        this._listSubscribers(channelId, (err: any, subscribers: any) => {
            if (err) {
                return callback(err, null);
            }
            const targets = (subscribers || []).map((subscriber) => {
                const path = subscriber.Key.split("/");
                return { connectionId: path[2], domainName: path[3] };
            }).filter((target) => {
                // The sender already has the change it just made.  Echoing it
                // back would double every edit on the wire and force the client
                // to guess which messages were its own.
                return !(excludeConnectionId && target.connectionId === excludeConnectionId);
            });
            if (targets.length === 0) {
                return callback(null, null);
            }
            let remaining = targets.length;
            let firstError: any = null;
            const settled = new Set<string>();
            targets.forEach((target) => {
                this.postToClient(target.domainName, target.connectionId, value, (postErr) => {
                    // A chunked message calls back once per chunk, so only the
                    // first answer for a recipient counts towards being done.
                    if (settled.has(target.connectionId)) {
                        return;
                    }
                    settled.add(target.connectionId);
                    if (postErr) {
                        console.error("Error transmitting to a connection", postErr);
                        firstError = firstError || postErr;
                    }
                    remaining -= 1;
                    if (remaining === 0) {
                        callback(firstError, null);
                    }
                });
            });
        });
    }
    _listSubscriptions(connectionId: string, callback: (err: any, channels: any[]) => void) {
        this.store.list(`subscriptions-reverse/${connectionId}`, (err: any, channels: any) => {
            if (err) {
                console.error("Cannot list channels", err);
                return callback(err, null);
            }
            callback(null, channels);
        });
    }
    _listSubscribers(channelId: string, callback: (err: any, subscriptions: any[]) => void) {
        this.store.list(`subscriptions/${channelId}`, (err: any, subscriptions: any) => {
            if (err) {
                console.error("Cannot list subscribers", err);
                return callback(err, null);
            }
            callback(null, subscriptions);
        });
    }
    listSubscribers(event: any, context: Context, callback: (err: any, response: any) => void) {
        const ctx = event.requestContext;
        const body = JSON.parse(event.body);
        if (!body.channelId) {
            throw new TypeError("sendToChannel: Messages missing channelId from connection: " + ctx.connectionId);
        }
        this._listSubscriptions(body.channelId, (err, subscribers) => {
            if (err) {
                console.error("Error listing subscribers", err);
                return callback(err, null);
            }
            const value = {
                messageId: body.messageId,
                response: subscribers,
            };
            this.postToClient(ctx.domainName, ctx.connectionId, value, (err) => {
                if (err) {
                    console.error("Error posting to client", err);
                    return callback(err, null);
                }
                callback(null, this.okResponse);
            });
        });
    }
    listSubscriptions(event: any, context: Context, callback: (err: any, response: any) => void) {
        const ctx = event.requestContext;
        const body = JSON.parse(event.body);
        if (!body.connectionId) {
            throw new TypeError("sendToConnection: Messages missing connectionId from connection: " + ctx.connectionId);
        }
        this._listSubscriptions(body.connectionId || ctx.connectionId, (err, subscriptions) => {
            if (err) {
                console.error("Error listing subscriptions", err);
                return callback(err, null);
            }
            const value = {
                messageId: body.messageId,
                response: subscriptions,
            };
            this.postToClient(ctx.domainName, ctx.connectionId, value, (err) => {
                if (err) {
                    console.error("Error posting to client", err);
                    return callback(err, null);
                }
                callback(null, this.okResponse);
            });
        });
    }
    _sendToAll(value: any) {
        this.store.list(`connections/`, (err, connections) => {
            connections.forEach((connection) => {
                const path = connection.Key.split("/");
                const domainName = path[2];
                const connectionId = path[1];
                this.postToClient(domainName, connectionId, value, (err) => {
                    if (err) {
                        console.error("Error posting to client", err);
                    }
                });
            });
        });
    }
    sendToAll(event: any, context: Context) {
        const body = JSON.parse(event.body);
        const ctx = event.requestContext;
        const value = {
            broadcast: true,
            from: ctx.connectionId,
            response: body.value,
        };
        this._sendToAll(value);
    }
    _sendToChannel(channelId: string, value: any, callback: (err: any, response: any) => void,
                   excludeConnectionId?: string) {
        this.broadcast(channelId, {
            channelId,
            response: value,
        }, callback, excludeConnectionId);
    }
    sendToChannel(event: any, context: Context, callback: (err: any, response: any) => void) {
        const body = JSON.parse(event.body);
        const ctx = event.requestContext;
        this._sendToChannel(body.channelId, body.value, (err) => {
            if (err) {
                console.error(`Error sending to channel ${body.channelId} from connection ${ctx.connectionId}.`, err);
            }
        });
        callback(null, this.okResponse);
    }
    sendToConnection(event: any, context: Context, callback: (err: any, response: any) => void) {
        const ctx = event.requestContext;
        const body = JSON.parse(event.body);
        if (!body.connectionId) {
            throw new TypeError("sendToConnection: Messages missing connectionId from connection: " + ctx.connectionId);
        }
        const value = {
            to: body.connectionId,
            from: ctx.connectionId,
            response: body.value,
        };
        this.postToClient(body.domainName || ctx.domainName, body.connectionId, value, (err) => {
            if (err) {
                console.error("Error posting to client", err);
                return callback(err, null);
            }
        });
        callback(null, this.okResponse);
    }
}
