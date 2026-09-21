import BroadcastService from "../broadcastService";
const AWS = require("aws-sdk");
describe("Broadcast service", () => {
    beforeEach(() => {
        AWS.mocks.S3.putObject.mockClear();
        AWS.mocks.S3.headObject.mockClear();
        AWS.mocks.S3.getObject.mockClear();
        AWS.mocks.S3.deleteObject.mockClear();
        AWS.mocks.S3.listObjects.mockClear();
        AWS.mocks.ApiGatewayManagementApi.postToConnection.mockClear();
    });
    it("Connect should store the connection's principal, not the raw event.", (done) => {
        const broadcastService = new BroadcastService();
        const req = require("./__data__/event_http_request.json");
        const event = { ...req.event, requestContext: { ...req.event.requestContext, authorizer: { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: "[]" } } };
        AWS.mocks.S3.putObject.mockImplementation((params, cb) => cb(null, {}));   // connect now waits for the record to be written
        broadcastService.connect(event, req.context, (err, response) => {
            expect(response.statusCode).toBe(200);
            const call = AWS.mocks.S3.putObject.mock.calls[0][0];
            expect(call.Key).toBe("connections/123456/localhost");
            expect(JSON.parse(call.Body)).toMatchObject({ principal: { sub: "auth0|u1", tenant: "personal:auth0|u1" }, connectionId: "123456", domainName: "localhost" });
            expect(JSON.parse(call.Body).headers).toBeUndefined();
            done();
        });
    });
    it("Connect without a principal is refused and nothing is stored.", (done) => {
        const broadcastService = new BroadcastService();
        const req = require("./__data__/event_http_request.json");
        broadcastService.connect(req.event, req.context, (err, response) => {
            expect(response.statusCode).toBe(401);
            expect(AWS.mocks.S3.putObject.mock.calls.length).toBe(0);
            done();
        });
    });
    it("Disconnect should call S3 and remove a connection.", (done) => {
        const broadcastService = new BroadcastService();
        const req = require("./__data__/event_http_request.json");
        broadcastService.disconnect(req.event, req.context, (err, response) => {
            expect(AWS.mocks.S3.deleteObject.mock.calls[0][0]).toEqual({
                Key: "connections/123456/localhost",
            });
            done();
        });
    });
    it("Subscribe should call S3 twice and call postToConnection.", (done) => {
        const broadcastService = new BroadcastService();
        const req = require("./__data__/event_http_request.json");
        req.event.body = JSON.stringify({
            channelId: "blah",
        });
        broadcastService.subscribe(req.event, req.context, (err, response) => {
            expect(AWS.mocks.S3.putObject.mock.calls[0][0]).toEqual({
                Key: "subscriptions-reverse/123456/blah/localhost",
                Body: JSON.stringify({requestContext:{domainName: "localhost", connectionId: "123456"},body: JSON.stringify({channelId: "blah"})}),
                Metadata: {},
            });
            expect(AWS.mocks.S3.putObject.mock.calls[1][0]).toEqual({
                Key: "subscriptions/blah/123456/localhost",
                Body: JSON.stringify({requestContext:{domainName: "localhost", connectionId: "123456"},body: JSON.stringify({channelId: "blah"})}),
                Metadata: {},
            });
            expect(AWS.mocks.ApiGatewayManagementApi.postToConnection).toHaveBeenCalled();
            done();
        });
    });
    it("Unsubscribe should call S3 twice and call postToConnection.", (done) => {
        const broadcastService = new BroadcastService();
        const req = require("./__data__/event_http_request.json");
        req.event.body = JSON.stringify({
            channelId: "blah",
        });
        broadcastService.unsubscribe(req.event, req.context, (err, response) => {
            expect(AWS.mocks.S3.deleteObject.mock.calls[1][0]).toEqual({
                Key: "subscriptions-reverse/123456/blah/localhost",
            });
            expect(AWS.mocks.S3.deleteObject.mock.calls[0][0]).toEqual({
                Key: "subscriptions/blah/123456/localhost",
            });
            expect(AWS.mocks.ApiGatewayManagementApi.postToConnection).toHaveBeenCalled();
            done();
        });
    });
    it("Should call postToConnection when postToClient is called.", (done) => {
        const broadcastService = new BroadcastService();
        broadcastService.postToClient("localhost", "12345", "Hello World");
        expect(AWS.mocks.ApiGatewayManagementApi.postToConnection).toHaveBeenCalled();
        done();
    });
    it("Should read from S3 and then call postToConnection when listSubscribers is called.", (done) => {
        const broadcastService = new BroadcastService();
        const req = require("./__data__/event_http_request.json");
        req.event.body = JSON.stringify({
            channelId: "blah",
        });
        broadcastService.listSubscribers(req.event, req.context);
        expect(AWS.mocks.S3.listObjects).toHaveBeenCalled();
        AWS.mocks.S3.listObjects.mock.calls[0][1](null, {
            Contents: [],
        });
        // after the S3 list callback, it should call postToConnection
        expect(AWS.mocks.ApiGatewayManagementApi.postToConnection).toHaveBeenCalled();
        done();
    });
    it("Should read from S3 and then call postToConnection when listSubscriptions is called.", (done) => {
        const broadcastService = new BroadcastService();
        const req = require("./__data__/event_http_request.json");
        req.event.body = JSON.stringify({
            connectionId: "blah",
        });
        broadcastService.listSubscriptions(req.event, req.context);
        expect(AWS.mocks.S3.listObjects).toHaveBeenCalled();
        AWS.mocks.S3.listObjects.mock.calls[0][1](null, {
            Contents: [],
        });
        // after the S3 list callback, it should call postToConnection
        expect(AWS.mocks.ApiGatewayManagementApi.postToConnection).toHaveBeenCalled();
        done();
    });
    it("Should read from S3 and then call postToConnection when sendToAll is called.", (done) => {
        const broadcastService = new BroadcastService();
        const req = require("./__data__/event_http_request.json");
        req.event.body = JSON.stringify({
            value: "blah",
        });
        broadcastService.sendToAll(req.event, req.context);
        expect(AWS.mocks.S3.listObjects).toHaveBeenCalled();
        AWS.mocks.S3.listObjects.mock.calls[0][1](null, {
            Contents: [
                {
                    Key: "blah/1234/bleh/2345"
                }
            ],
        });
        // after the S3 list callback, it should call postToConnection
        expect(AWS.mocks.ApiGatewayManagementApi.postToConnection).toHaveBeenCalled();
        done();
    });
    it("Should read from S3 and then call postToConnection when sendToChannel is called.", (done) => {
        const broadcastService = new BroadcastService();
        const req = require("./__data__/event_http_request.json");
        req.event.body = JSON.stringify({
            channelId: "1234",
            value: "blah",
        });
        broadcastService.sendToChannel(req.event, req.context, () => {});
        expect(AWS.mocks.S3.listObjects).toHaveBeenCalled();
        AWS.mocks.S3.listObjects.mock.calls[0][1](null, {
            Contents: [
                {
                    Key: "blah/1234/bleh/2345"
                }
            ],
        });
        // after the S3 list callback, it should call postToConnection
        expect(AWS.mocks.ApiGatewayManagementApi.postToConnection).toHaveBeenCalled();
        done();
    });
    it("Should answer a broadcast that reaches nobody.", (done) => {
        // A graph only one person has open has no other subscribers.  The
        // callback still has to come back, or whatever is awaiting the
        // broadcast hangs until its Lambda is cut off, which took the HTTP
        // update route down with it.
        const broadcastService = new BroadcastService();
        let calls = 0;
        broadcastService.broadcast("empty-channel", {}, (err) => {
            calls += 1;
            expect(err).toBeFalsy();
            expect(calls).toBe(1);
            expect(AWS.mocks.ApiGatewayManagementApi.postToConnection).not.toHaveBeenCalled();
            done();
        });
        AWS.mocks.S3.listObjects.mock.calls[0][1](null, { Contents: [] });
    });
    it("Should answer a broadcast whose only subscriber is the sender.", (done) => {
        const broadcastService = new BroadcastService();
        broadcastService.broadcast("channel", {}, (err) => {
            expect(err).toBeFalsy();
            expect(AWS.mocks.ApiGatewayManagementApi.postToConnection).not.toHaveBeenCalled();
            done();
        }, "sender-connection");
        AWS.mocks.S3.listObjects.mock.calls[0][1](null, {
            Contents: [{ Key: "subscriptions/channel/sender-connection/example.com" }],
        });
    });
    it("Should answer once when a broadcast reaches several subscribers.", (done) => {
        const broadcastService = new BroadcastService();
        let calls = 0;
        broadcastService.broadcast("channel", {}, () => {
            calls += 1;
            expect(calls).toBe(1);
            done();
        });
        AWS.mocks.S3.listObjects.mock.calls[0][1](null, {
            Contents: [
                { Key: "subscriptions/channel/conn-1/example.com" },
                { Key: "subscriptions/channel/conn-2/example.com" },
            ],
        });
        AWS.mocks.ApiGatewayManagementApi.postToConnection.mock.calls.forEach((call) => call[1](null));
    });
    it("Should call postToConnection when sendToConnection is called.", (done) => {
        const broadcastService = new BroadcastService();
        const req = require("./__data__/event_http_request.json");
        req.event.body = JSON.stringify({
            connectionId: "1234",
            value: "blah",
        });
        broadcastService.sendToConnection(req.event, req.context, () => {});
        // after the S3 list callback, it should call postToConnection
        expect(AWS.mocks.ApiGatewayManagementApi.postToConnection).toHaveBeenCalled();
        done();
    });
});
