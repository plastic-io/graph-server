import S3Service from "../s3Service";
const AWS = require("aws-sdk");
describe("S3 CRUD + List functions", () => {
    beforeEach(() => {
        AWS.mocks.S3.putObject.mockClear();
        AWS.mocks.S3.headObject.mockClear();
        AWS.mocks.S3.getObject.mockClear();
        AWS.mocks.S3.deleteObject.mockClear();
        AWS.mocks.S3.listObjects.mockClear();
    });
    it("Should call S3 getObject to fetch an object.", (done) => {
        const s3Service = new S3Service("blah");
        s3Service.get("Hello");
        expect(AWS.mocks.S3.getObject.mock.calls[0][0]).toEqual({
            Bucket: "blah",
            Key: "Hello"
        });
        done();
    });
    it("Should call S3 headObject to fetch an objects meta data.", (done) => {
        const s3Service = new S3Service("blah");
        s3Service.head("Hello");
        expect(AWS.mocks.S3.headObject.mock.calls[0][0]).toEqual({
            Bucket: "blah",
            Key: "Hello"
        });
        done();
    });
    it("Should call S3 putObject to store an object.", (done) => {
        const s3Service = new S3Service("blah");
        s3Service.set("Hello", "World", {foo: "bar"});
        expect(AWS.mocks.S3.putObject.mock.calls[0][0]).toEqual({
            Bucket: "blah",
            Key: "Hello",
            Body: "\"World\"",
            Metadata: {foo: "bar"}
        });
        done();
    });
    it("Should call S3 deleteObject to fetch an object.", (done) => {
        const s3Service = new S3Service("blah");
        s3Service.remove("Hello");
        expect(AWS.mocks.S3.deleteObject.mock.calls[0][0]).toEqual({
            Bucket: "blah",
            Key: "Hello"
        });
        done();
    });
    it("Should call S3 deleteObject to fetch an object.", (done) => {
        const s3Service = new S3Service("blah");
        s3Service.remove("Hello");
        expect(AWS.mocks.S3.deleteObject.mock.calls[0][0]).toEqual({
            Bucket: "blah",
            Key: "Hello"
        });
        done();
    });
    it("Should call S3 listObjects to get a list of items.", (done) => {
        const s3Service = new S3Service("blah");
        s3Service.list("Hello");
        expect(AWS.mocks.S3.listObjects.mock.calls[0][0]).toEqual({
            Bucket: "blah",
            Prefix: "Hello"
        });
        done();
    });
});
