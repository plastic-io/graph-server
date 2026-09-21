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
                        pass(null);
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
    /** Read an object without assuming it holds JSON. */
    getRaw(key: string, callback: (err: any, data: Buffer) => void) {
        this.s3.getObject({
            Bucket: this.bucketName,
            Key: key,
        }, (err, data) => {
            if (err) {
                return callback(err, null);
            }
            callback(null, data.Body as Buffer);
        });
    }
    /**
     * S3 object metadata travels as HTTP headers, which may hold only ASCII.
     * Graph names and descriptions are written there and people write in every
     * language, so values are encoded rather than refused: a non-ASCII value is
     * percent-encoded (and marked, so a reader can decode it) instead of
     * failing the write, which is what "Invalid character in header content"
     * meant for a description with an arrow in it.
     */
    static safeMetadata(meta: any): Record<string, string> {
        const out: Record<string, string> = {};
        Object.keys(meta || {}).forEach((key) => {
            const value = meta[key];
            if (value === undefined || value === null) {
                return;
            }
            const text = String(value);
            // eslint-disable-next-line no-control-regex
            if (/^[\x20-\x7E]*$/.test(text)) {
                out[key] = text.length > 1024 ? text.slice(0, 1024) : text;
                return;
            }
            const encoded = encodeURIComponent(text);
            out[key] = encoded.length > 1024 ? encoded.slice(0, 1024) : encoded;
            out[`${key}-encoding`] = "uri";
        });
        return out;
    }

    /** Write an opaque binary body, used for Yjs updates and snapshots. */
    setRaw(key: string, body: Buffer, meta: any, callback: (err: any, data: any) => void) {
        this.s3.putObject({
            Body: body,
            Bucket: this.bucketName,
            Key: key,
            ContentType: "application/octet-stream",
            Metadata: S3Service.safeMetadata(meta),
        }, (err) => {
            if (err) {
                console.error("Error writing binary object", key, err);
                return callback(err, null);
            }
            callback(null, null);
        });
    }
    set(key: string, val: any, meta: any, callback: (err: any, data: any) => void) {
        this.s3.putObject({
            Body: JSON.stringify(val),
            Bucket: this.bucketName,
            Key: key,
            Metadata: S3Service.safeMetadata(meta),
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
