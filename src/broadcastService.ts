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
        let backoffTimer = 0;
        const buffer = Buffer.from(JSON.stringify(message));
        const client = new ApiGatewayManagementApi({
            apiVersion: "2018-11-29",
            endpoint: `https://${domainName}/${STAGE}`,
        });
        function post() {
            client.postToConnection({
                ConnectionId: connectionId,
                Data: buffer,
            }, (err) => {
                if (err && err.statusCode === 410) {
                    console.error("Error transmitting to a connection, client was disconnected unexpectedly, removing connection.");
                    return;
                } else if (err && err.statusCode === 429) {
                    console.warn("Connection throttled, backing off: ", err);
                    setTimeout(post, backoffTimer);
                } else if (err) {
                    console.error("Error transmitting to a connection: ", err);
                }
                callback(null, this.okResponse);
            });
        }
        backoffTimer += BACKOFF_TIMER_ADD;
        setTimeout(post, backoffTimer);
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
    disconnect(event: any, context: Context, callback: (err: any, response: any) => void) {
        const ctx = event.requestContext;
        this.store.remove(`connections/${ctx.connectionId}/${ctx.domainName}`, (err) => {
            if (err) {
                console.error("Cannot remove connection record", err);
            }
        });
        this.listSubscriptions(ctx.connectionId, (err, channels) => {
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
        callback(null, this.okResponse);
    }
    unsubscribe(event: any, context: Context, callback: (err: any, response: any) => void) {
        const ctx = event.requestContext;
        const body = JSON.parse(event.body);
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
        callback(null, this.okResponse);
    }
    subscribe(event: any, context: Context, callback: (err: any, response: any) => void) {
        const ctx = event.requestContext;
        const body = JSON.parse(event.body);
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
        callback(null, this.okResponse);
    }
    broadcast(channelId: string, value: any, callback: (err: any, response: any) => void) {
        this.listSubscribers(channelId, (err: any, subscribers: any) => {
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
    listSubscriptions(connectionId: string, callback: (err: any, channels: any[]) => void) {
        this.store.list(`subscriptions-reverse/${connectionId}`, (err: any, channels: any) => {
            if (err) {
                console.error("Cannot list channels", err);
                return callback(err, null);
            }
            callback(null, channels);
        });
    }
    listSubscribers(channelId: string, callback: (err: any, subscriptions: any[]) => void) {
        this.store.list(`subscriptions/${channelId}`, (err: any, subscriptions: any) => {
            if (err) {
                console.error("Cannot list subscribers", err);
                return callback(err, null);
            }
            callback(null, subscriptions);
        });
    }
    sendToChannel(event: any, context: Context, callback: (err: any, response: any) => void) {
        const body = JSON.parse(event.body);
        this.broadcast(body.channelId, body.value, callback);
        callback(null, this.okResponse);
    }
    sendToConnection(event: any, context: Context, callback: (err: any, response: any) => void) {
        const body = JSON.parse(event.body);
        this.postToClient(body.domainName, body.connectionId, JSON.parse(body.value), (err) => {
            if (err) {
                console.error("Error posting to client", err);
                return callback(err, null);
            }
        });
        callback(null, this.okResponse);
    }
}
