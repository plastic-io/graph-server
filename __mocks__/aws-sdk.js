/* global jest */
const mocks = {
    S3: {
        getObject: jest.fn(),
        deleteObject: jest.fn(),
        listObjects: jest.fn(),
        putObject: jest.fn(),
        headObject: jest.fn(),
    },
    ApiGatewayManagementApi: {
        postToConnection: jest.fn(),
    },
};
module.exports = {
    mocks,
    S3: function () {
        return mocks.S3;
    },
    ApiGatewayManagementApi: function () {
        return mocks.ApiGatewayManagementApi;
    },
};
