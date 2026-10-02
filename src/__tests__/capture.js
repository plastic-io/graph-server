const { CaptureService, MAX_BYTES } = require("../view/capture");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

/**
 * Seeing what was built (PB-149).
 *
 * The thing this exists to prevent is an agent believing a page works because
 * a proposal was accepted.  So the tests are mostly about the answers that are
 * not a picture: what it refuses to photograph, what it says when nobody is
 * watching, and what it hands back when the page came up blank.
 */

const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
const agent = { sub: "agent|a1", kind: "agent", tenant: "personal:auth0|u1", scopes: [] };
const BASE = "https://api.example.com/dev";
const graph = {
    id: "g1", url: "storefront",
    nodes: [{ id: "n1", url: "index", properties: { name: "Storefront" } }],
    properties: { name: "Flat Falcon" },
};
const png = Buffer.from("89504e470d0a1a0a", "hex");

function serviceWith(over = {}) {
    const store = new FakeS3Service();
    const asked = [];
    const shots = [];
    const service = new CaptureService(store, {
        projection: async (id) => (id === "g1" ? graph : null),
        baseUrl: () => BASE,
        origins: () => over.origins || [],
        now: () => new Date("2026-10-02T00:00:00.000Z"),
        renderer: over.renderer === null ? undefined : (over.renderer || {
            shoot: async (request) => { shots.push(request); return { image: png, format: "png", title: "Storefront", status: 200, console: [] }; },
        }),
        viewers: over.viewers,
    });
    return { service, store, shots, asked };
}

describe("where it will point a browser", () => {
    test("a graph is served at its own url, and a node beside it", () => {
        const { service } = serviceWith();
        expect(service.address(graph, {})).toEqual({ url: `${BASE}/storefront` });
        expect(service.address(graph, { nodeUrl: "index" })).toEqual({ url: `${BASE}/storefront.index` });
    });

    test("a node that is not there is said so, rather than photographed blind", () => {
        const { service } = serviceWith();
        expect(service.address(graph, { nodeUrl: "nope" })).toMatchObject({ code: "NOT_FOUND" });
    });

    test("it photographs what this server serves, and refuses the rest", () => {
        const { service } = serviceWith();
        expect(service.address(graph, { url: `${BASE}/storefront?x=1` })).toEqual({ url: `${BASE}/storefront?x=1` });
        // the inside of a network is the thing a screenshot tool must never fetch
        expect(service.address(graph, { url: "http://169.254.169.254/latest/meta-data/" })).toMatchObject({ code: "REFUSED" });
        expect(service.address(graph, { url: "http://localhost:8080/graph-editor" })).toMatchObject({ code: "REFUSED" });
        expect(service.address(graph, { url: "https://example.com/" })).toMatchObject({ code: "REFUSED" });
        expect(service.address(graph, { url: "file:///etc/passwd" })).toMatchObject({ code: "REFUSED" });
        expect(service.address(graph, { url: "not a url" })).toMatchObject({ code: "SCHEMA_INVALID" });
    });

    test("an editor this deployment was told about may be photographed too", () => {
        const { service } = serviceWith({ origins: ["http://localhost:8080"] });
        expect(service.address(graph, { url: "http://localhost:8080/graph-editor/g1" })).toMatchObject({ url: expect.stringContaining("localhost:8080") });
    });
});

describe("taking the picture", () => {
    test("it photographs the graph's own page and keeps what it took", async () => {
        const { service, store, shots } = serviceWith();
        const r = await service.screenshot("g1", owner, { token: "a-token" });
        expect(r.error).toBeUndefined();
        expect(r.shot).toMatchObject({ url: `${BASE}/storefront`, from: "server", format: "png", title: "Storefront", status: 200, bytes: png.length });
        expect(r.shot.key).toMatch(/^screenshots\/g1\/[0-9A-HJKMNP-TV-Z]{26}\.png$/);
        expect([...store.objects.keys()]).toContain(r.shot.key);
        // the caller's own token renders the page, so a picture shows what that caller may see
        expect(shots[0].headers.authorization).toBe("Bearer a-token");
    });

    test("the viewport is bounded, whatever was asked for", async () => {
        const { service, shots } = serviceWith();
        await service.screenshot("g1", owner, { viewport: { width: 99999, height: 1 } });
        expect(shots[0].viewport).toEqual({ width: 2560, height: 240 });
        await service.screenshot("g1", owner, {});
        expect(shots[1].viewport).toEqual({ width: 1280, height: 800 });
    });

    test("what the page complained about comes back with the picture", async () => {
        const noisy = { shoot: async () => ({ image: png, title: "", console: [{ level: "error", text: "Cannot read properties of null" }] }) };
        const { service } = serviceWith({ renderer: noisy });
        const r = await service.screenshot("g1", owner, {});
        // a blank page with an error in the console is the common case, and the
        // error is the answer; it should not need a second round trip to find
        expect(r.shot.console).toEqual([{ level: "error", text: "Cannot read properties of null" }]);
        expect(r.shot.title).toBe("");
    });

    test("a picture too big to carry says so, and says what to do about it", async () => {
        const huge = { shoot: async () => ({ image: Buffer.alloc(MAX_BYTES + 1), format: "png" }) };
        const { service } = serviceWith({ renderer: huge });
        const r = await service.screenshot("g1", owner, { fullPage: true });
        expect(r.code).toBe("TOO_LARGE");
        expect(r.error).toMatch(/smaller viewport/);
    });

    test("a browser that fails is reported as a failure to photograph, not as an empty page", async () => {
        const broken = { shoot: async () => { throw new Error("net::ERR_CONNECTION_REFUSED"); } };
        const { service } = serviceWith({ renderer: broken });
        expect(await service.screenshot("g1", owner, {})).toMatchObject({ code: "CAPTURE_FAILED", error: expect.stringContaining("ERR_CONNECTION_REFUSED") });
    });

    test("a server with no browser says so plainly", async () => {
        const { service } = serviceWith({ renderer: null });
        expect(await service.screenshot("g1", owner, {})).toMatchObject({ code: "UNSUPPORTED", error: expect.stringContaining("no browser") });
    });

    test("a graph that is not there, and a caller who may not look", async () => {
        const { service } = serviceWith();
        expect(await service.screenshot("nope", owner, {})).toMatchObject({ code: "NOT_FOUND" });
        expect(await service.screenshot("g1", agent, {})).toMatchObject({ code: "ADMISSION_DENIED" });
    });
});

describe("asking a browser somebody already has open", () => {
    const viewerShot = { image: png, format: "png", title: "as the person sees it" };

    test("a watcher is asked first, and its picture is the one kept", async () => {
        const asked = [];
        const viewers = {
            watching: async () => 2,
            ask: async (graphId, request) => { asked.push({ graphId, request }); return viewerShot; },
        };
        const { service, shots } = serviceWith({ viewers });
        const r = await service.screenshot("g1", owner, {});
        expect(r.shot.from).toBe("viewer");
        expect(r.shot.title).toBe("as the person sees it");
        expect(asked[0].request.waitMs).toBe(3000);
        // and the server's own browser was never started
        expect(shots).toEqual([]);
    });

    test("nobody watching means the server takes it itself, without waiting", async () => {
        const viewers = { watching: async () => 0, ask: async () => { throw new Error("should not be asked"); } };
        const { service, shots } = serviceWith({ viewers });
        const r = await service.screenshot("g1", owner, {});
        expect(r.shot.from).toBe("server");
        expect(shots).toHaveLength(1);
    });

    test("a watcher that does not answer in time is not a failure", async () => {
        const viewers = { watching: async () => 1, ask: async () => undefined };
        const { service } = serviceWith({ viewers });
        expect((await service.screenshot("g1", owner, {})).shot.from).toBe("server");
    });

    test("a watcher that throws does not stop the picture being taken", async () => {
        const viewers = { watching: async () => 1, ask: async () => { throw new Error("the socket went away"); } };
        const { service } = serviceWith({ viewers });
        expect((await service.screenshot("g1", owner, {})).shot.from).toBe("server");
    });

    test("insisting on a viewer, when there is none, says so rather than quietly doing something else", async () => {
        const viewers = { watching: async () => 0, ask: async () => undefined };
        const { service, shots } = serviceWith({ viewers });
        expect(await service.screenshot("g1", owner, { from: "viewer" })).toMatchObject({ code: "UNAVAILABLE" });
        expect(shots).toEqual([]);
    });

    test("insisting on the server skips the viewer entirely", async () => {
        const viewers = { watching: async () => { throw new Error("should not be consulted"); }, ask: async () => undefined };
        const { service } = serviceWith({ viewers });
        expect((await service.screenshot("g1", owner, { from: "server" })).shot.from).toBe("server");
    });
});
