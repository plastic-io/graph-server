import {Context, S3CreateEvent, APIGatewayEvent} from "aws-lambda";
import {ApiGatewayManagementApi} from "aws-sdk";
import S3Service from './s3Service';
const STAGE = process.env.STAGE;
const BACKOFF_TIMER_ADD = 35;
export default class BroadcastService {
    store: S3Service;
    okResponse: {statusCode: number};
    constructor() {
        this.okResponse = {
            statusCode: 200
        };
        this.store = new S3Service(process.env.S3_BUCKET);
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
        let backoffTimer = 0;
        const buffer = Buffer.from(JSON.stringify(message, getCircularReplacer()));
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
        setTimeout(post, backoffTimer);
        backoffTimer += BACKOFF_TIMER_ADD;
    }
    connect(event: any, context: Context, callback: (err: any, response: any) => void) {
        const ctx = event.requestContext;
        this.store.set(`connections/${ctx.connectionId}/${ctx.domainName}`, event, (err) => {
            if (err) {
                console.error("Cannot create connection record", err);
            }
        });
        callback(null, this.okResponse);
    }
    _disconnect(domainName, connectionId) {
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
        this.store.set(`subscriptions-reverse/${ctx.connectionId}/${body.channelId}/${ctx.domainName}`, event, (err) => {
            if (err) {
                console.error("Cannot create reverse subscription record", err);
            }
        });
        this.store.set(`subscriptions/${body.channelId}/${ctx.connectionId}/${ctx.domainName}`, event, (err) => {
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
    broadcast(channelId: string, value: any, callback: (err: any, response: any) => void) {
        this._listSubscribers(channelId, (err: any, subscribers: any) => {
            subscribers.forEach((subscriber) => {
                const path = subscriber.Key.split("/");
                const domainName = path[3];
                const connectionId = path[2];
                this.postToClient(domainName, connectionId, value, (err) => {
                    if (err) {
                        console.error("Error transmitting to a connection", err);
                        return callback(err, null);
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
    _sendToChannel(channelId: string, value: any, callback: (err: any, response: any) => void) {
        this.broadcast(channelId, {
            channelId,
            response: value,
        }, callback);
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
