import EventSourceService from "../EventSourceService";
const AWS = require("aws-sdk");
describe("Event Source Service", () => {
    beforeEach(() => {
        AWS.mocks.S3.putObject.mockClear();
        AWS.mocks.S3.headObject.mockClear();
        AWS.mocks.S3.getObject.mockClear();
        AWS.mocks.S3.deleteObject.mockClear();
        AWS.mocks.S3.listObjects.mockClear();
        AWS.mocks.ApiGatewayManagementApi.postToConnection.mockClear();
    });
    it("Should call S3 getObject to fetch an object.", (done) => {
        const eventSourceService = new EventSourceService();
        const req = require("./__data__/event_http_request.json");
        req.event.pathParameters = {
            id: "1234",
        };
        eventSourceService.getEvents(req.event, req.context);
        expect(AWS.mocks.S3.listObjects).toHaveBeenCalled();
        done();
    });
    it("updateToc should call list, then it should call set, then it should callbroadcoast.", (done) => {
        const eventSourceService = new EventSourceService();
        const req = require("./__data__/event_http_request.json");
        req.event.pathParameters = {
            id: "1234",
        };
        eventSourceService.updateToc(() => {});
        setTimeout(() => {
            expect(AWS.mocks.S3.listObjects).toHaveBeenCalled();
            
            AWS.mocks.S3.listObjects.mock.calls[0][1](null, {
                Contents: [
                    {
                        Key: "blah/1234/bleh/2345"
                    }
                ],
            });
            AWS.mocks.S3.listObjects.mockClear();
            expect(AWS.mocks.S3.headObject).toHaveBeenCalled();
            AWS.mocks.S3.headObject.mock.calls[0][1](null, {
                Key: "/graphs/projections/endpoints/1234.json",
                Metadata: {
                    "x-amz-meta-foo": "bar",
                    "x-amz-meta-id": "1234",
                },
            });
            setTimeout(() => {
                expect(AWS.mocks.S3.putObject).toHaveBeenCalled();
                AWS.mocks.S3.putObject.mock.calls[0][1](null);
                expect(AWS.mocks.S3.listObjects).toHaveBeenCalled();
                // simulate listing of channel subscribers
                AWS.mocks.S3.listObjects.mock.calls[0][1](null, {
                    Contents: [
                        {
                            Key: "blah/1234/bleh/2345"
                        }
                    ],
                });
                expect(AWS.mocks.ApiGatewayManagementApi.postToConnection).toHaveBeenCalled();
                done();
            }, 1);
        }, 250);
    });
    it("getToc should call S3 to fetch the TOC.", (done) => {
        const eventSourceService = new EventSourceService();
        eventSourceService.getToc();
        expect(AWS.mocks.S3.getObject).toHaveBeenCalled();
        done();
    });
    it("getToc should call S3 to fetch the TOC.", (done) => {
        const eventSourceService = new EventSourceService();
        eventSourceService.getToc();
        expect(AWS.mocks.S3.getObject).toHaveBeenCalled();
        done();
    });
});
