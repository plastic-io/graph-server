/** In-memory stand-in for S3Service, good enough for the CRDT store's needs. */
class FakeS3Service {
    constructor() {
        this.objects = new Map();
        this.meta = new Map();
    }
    getRaw(key, callback) {
        if (!this.objects.has(key)) {
            return callback(new Error("NoSuchKey: " + key), null);
        }
        callback(null, this.objects.get(key));
    }
    setRaw(key, body, meta, callback) {
        this.objects.set(key, Buffer.from(body));
        this.meta.set(key, meta || {});
        callback(null, null);
    }
    get(key, callback) {
        if (!this.objects.has(key)) {
            return callback(new Error("NoSuchKey: " + key), null);
        }
        callback(null, JSON.parse(this.objects.get(key).toString()));
    }
    set(key, value, meta, callback) {
        this.objects.set(key, Buffer.from(JSON.stringify(value)));
        this.meta.set(key, meta || {});
        callback(null, null);
    }
    head(key, callback) {
        if (!this.objects.has(key)) {
            return callback(new Error("NotFound"), null);
        }
        callback(null, { Metadata: this.meta.get(key) || {} });
    }
    removePath(prefix, callback) {
        [...this.objects.keys()]
            .filter((key) => key.indexOf(prefix) === 0)
            .forEach((key) => {
                this.objects.delete(key);
                this.meta.delete(key);
            });
        callback(null, null);
    }
    remove(key, callback) {
        this.objects.delete(key);
        this.meta.delete(key);
        callback(null, null);
    }
    list(prefix, callback) {
        const keys = [...this.objects.keys()]
            .filter((key) => key.indexOf(prefix) === 0)
            .sort();
        callback(null, keys.map((Key) => ({ Key })));
    }
}
module.exports = FakeS3Service;
