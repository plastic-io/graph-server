import {Context, S3CreateEvent, APIGatewayEvent, APIGatewayEventRequestContext} from "aws-lambda";
import {S3} from "aws-sdk";
export default class S3Service {
    s3: any;
    bucketName: string;
    constructor(bucketName) {
        this.bucketName = bucketName;
        this.s3 = new S3({
            signatureVersion: "v4",
        });
    }
    get(key: string, callback: (err: any, data: any) => void) {
        this.s3.getObject({
            Bucket: this.bucketName,
            Key: key,
        }, (err, data) => {
            if (err) {
                console.error("Cannot get file", err);
                return callback(err, null);
            }
            const decodedData = data.Body.toString();
            const parsedData = JSON.parse(decodedData);
            callback(null, parsedData);
        });
    }
    removePath(path: string, callback: (err: any, data: any) => void) {
        this.list(path, (err, items) => {
            Promise.all(items.map((item) => {
                return new Promise((pass, fail) => {
                    this.remove(item.Key, (err) => {
                        if (err) {
                            return fail(err);
                        }
                        pass();
                    });
                });
            })).then(() => {
                callback(null, null);
            }).catch((err) => {
                callback(err, null);
            });
        });
    }
    remove(key: string, callback: (err: any, data: any) => void) {
        this.s3.deleteObject({
            Bucket: this.bucketName,
            Key: key,
        }, (err) => {
            if (err) {
                console.error("Cannot remove the file", err);
                callback(err, null);
            }
            callback(null, null);
        });
    }
    head(key: string, callback: (err: any, data: any) => void) {
        this.s3.headObject({
            Bucket: this.bucketName,
            Key: key,
        }, callback);
    }
    set(key: string, val: any, meta: any, callback: (err: any, data: any) => void) {
        this.s3.putObject({
            Body: JSON.stringify(val),
            Bucket: this.bucketName,
            Key: key,
            Metadata: meta,
        }, (err) => {
            if (err) {
                console.error("Error writing file", err);
                return callback(err, null);
            }
            callback(null, null);
        });
    }
    list(prefix: string, callback: (err: any, data: any) => void) {
        const objects = [];
        const listObjects = (marker?: string) => {
            this.s3.listObjects({
                Prefix: prefix,
                Bucket: this.bucketName,
                Marker: marker,
            }, (err, response) => {
                if (err) {
                    console.error("list error", err);
                    return callback(err, null);
                }
                objects.push(...response.Contents);
                if (response.IsTruncated) {
                    return listObjects(response.NextMarker);
                }
                callback(null, objects);
            });
        };
        listObjects();
    }
}
