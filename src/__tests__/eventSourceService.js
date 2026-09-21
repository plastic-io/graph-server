import EventSourceService from "../eventSourceService";
import TocStore from "../tocStore";
import FakeS3Service from "../__testHelpers__/fakeS3";
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
    it("does not walk the store to answer for the list.", (done) => {
        // The list used to be rebuilt from every object under the projections
        // on each save, which is a request per graph.  It is a document now,
        // so reading it is a read of that document.
        const eventSourceService = new EventSourceService();
        eventSourceService.tocStore = new TocStore(new FakeS3Service());
        eventSourceService.getToc({}, {}, (err, response) => {
            expect(response.statusCode).toBe(200);
            expect(AWS.mocks.S3.headObject).not.toHaveBeenCalled();
            done();
        });
    });
    it("reports an empty list when nothing is stored yet.", (done) => {
        const eventSourceService = new EventSourceService();
        eventSourceService.tocStore = new TocStore(new FakeS3Service());
        eventSourceService.getToc({}, {}, (err, response) => {
            expect(JSON.parse(response.body)).toEqual({});
            done();
        });
    });
});
