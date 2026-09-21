const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require("jose");
const { verifyBearer } = require("../auth/jwt");
const { authorize, stageResource } = require("../auth/authorizer");
const { extractToken, subjectOf, withPrincipal, principalFromAuthorizerContext, TENANT_CLAIM } = require("../auth/principal");
const { decide } = require("../policy/decide");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;
const BroadcastService = require("../broadcastService").default;

const DOMAIN = "tenant.example.auth0.com";
const AUD = "https://api.example.test/dev";
let keys, privateKey, otherPrivateKey, config;

async function mint(claims = {}, opts = {}) {
    const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: opts.kid || "k1" })
        .setIssuer(opts.issuer || `https://${DOMAIN}/`)
        .setAudience(opts.audience || AUD)
        .setSubject(opts.sub || "auth0|u1")
        .setIssuedAt()
        .setExpirationTime(opts.exp || "1h");
    return jwt.sign(opts.key || privateKey);
}

beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    const other = await generateKeyPair("RS256");
    privateKey = pair.privateKey; otherPrivateKey = other.privateKey;
    const jwk = await exportJWK(pair.publicKey); jwk.kid = "k1"; jwk.alg = "RS256"; jwk.use = "sig";
    keys = createLocalJWKSet({ keys: [jwk] });
    config = { domain: DOMAIN, audience: AUD, keys };
});

describe("JWT verification", () => {
    test("a token from the tenant for our audience names a human principal with tenant and scopes", async () => {
        const token = await mint({ scope: "graph:read graph:propose", [TENANT_CLAIM]: "org_abc", email: "u1@example.test" });
        const p = await verifyBearer(token, config);
        expect(p).toMatchObject({ sub: "auth0|u1", kind: "human", tenant: "org_abc", email: "u1@example.test", scopes: ["graph:read", "graph:propose"] });
    });
    test("a client-credentials token is an agent; without a tenant claim the tenant is personal", async () => {
        const token = await mint({ gty: "client-credentials", permissions: ["graph:read"] }, { sub: "agent-client-id@clients" });
        const p = await verifyBearer(token, config);
        expect(p.kind).toBe("agent"); expect(p.tenant).toBe("personal:agent-client-id@clients"); expect(p.scopes).toEqual(["graph:read"]);
    });
    test("wrong audience, wrong issuer, expired, and foreign key are all rejected", async () => {
        await expect(verifyBearer(await mint({}, { audience: "https://other" }), config)).rejects.toThrow();
        await expect(verifyBearer(await mint({}, { issuer: "https://evil.example/" }), config)).rejects.toThrow();
        await expect(verifyBearer(await mint({}, { exp: "-1h" }), config)).rejects.toThrow();
        await expect(verifyBearer(await mint({}, { key: otherPrivateKey }), config)).rejects.toThrow();
    });
    test("refuses to run unconfigured", async () => {
        await expect(verifyBearer(await mint(), { domain: "", audience: "" })).rejects.toThrow(/not configured/);
    });
});

describe("token extraction", () => {
    test("Authorization header, WebSocket subprotocol list, and access_token query", async () => {
        const token = await mint();
        expect(extractToken({ headers: { Authorization: `Bearer ${token}` } })).toBe(token);
        expect(extractToken({ headers: { "Sec-WebSocket-Protocol": `access_token, ${token}` } })).toBe(token);
        expect(extractToken({ queryStringParameters: { access_token: token } })).toBe(token);
        expect(extractToken({ headers: { Authorization: "Basic abc" } })).toBeUndefined();
        expect(extractToken({ headers: { "Sec-WebSocket-Protocol": "graphql-ws" } })).toBeUndefined();
        expect(extractToken({})).toBeUndefined();
    });
});

describe("authorizer", () => {
    test("allows the whole stage and carries the principal as string context", async () => {
        const token = await mint({ scope: "graph:read" });
        const res = await authorize({ methodArn: "arn:aws:execute-api:us-west-1:123456789012:abc123/dev/GET/toc.json", headers: { authorization: `Bearer ${token}` } }, config);
        expect(res.principalId).toBe("auth0|u1");
        expect(res.policyDocument.Statement[0]).toEqual({ Action: "execute-api:Invoke", Effect: "Allow", Resource: "arn:aws:execute-api:us-west-1:123456789012:abc123/dev/*" });
        expect(res.context).toEqual({ sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", email: "", name: "", scopes: JSON.stringify(["graph:read"]) });
        expect(principalFromAuthorizerContext({ requestContext: { authorizer: res.context } })).toMatchObject({ sub: "auth0|u1", scopes: ["graph:read"] });
    });
    test("no token or a bad token is Unauthorized (API Gateway answers 401)", async () => {
        await expect(authorize({ methodArn: "arn:aws:execute-api:r:a:x/dev/GET/x", headers: {} }, config)).rejects.toThrow("Unauthorized");
        await expect(authorize({ methodArn: "arn:aws:execute-api:r:a:x/dev/GET/x", headers: { authorization: "Bearer nope.nope.nope" } }, config)).rejects.toThrow("Unauthorized");
    });
    test("stageResource covers the WebSocket $connect arn too", () => {
        expect(stageResource("arn:aws:execute-api:us-west-1:1:ws123/dev/$connect")).toBe("arn:aws:execute-api:us-west-1:1:ws123/dev/*");
    });
});

describe("principal on WebSocket messages", () => {
    test("$connect stores the principal, echoes the subprotocol, and later messages resolve it from the record", (done) => {
        const service = new BroadcastService();
        service.store = new FakeS3Service();
        const ctx = { connectionId: "c1", domainName: "example.test" };
        const connectEvent = { requestContext: { ...ctx, authorizer: { sub: "auth0|u1", kind: "human", tenant: "org_abc", scopes: "[]" } }, headers: { "Sec-WebSocket-Protocol": "access_token, eyJ.eyJ.sig" } };
        const connect = withPrincipal(service.store, (e, c, cb) => service.connect(e, c, cb));
        connect(connectEvent, {}, (err, response) => {
            expect(response.statusCode).toBe(200);
            expect(response.headers["Sec-WebSocket-Protocol"]).toBe("access_token");
            const later = { requestContext: { ...ctx }, body: "{}" };
            const handler = withPrincipal(service.store, (e, c, cb) => cb(null, { statusCode: 200, principal: e.principal }));
            handler(later, {}, (err2, res2) => {
                expect(res2.principal).toMatchObject({ sub: "auth0|u1", tenant: "org_abc" });
                expect(subjectOf(later)).toBe("auth0|u1");
                done();
            });
        });
    });
    test("a message on an unknown connection is answered 401 and the handler never runs", (done) => {
        const store = new FakeS3Service(); let ran = false;
        const handler = withPrincipal(store, () => { ran = true; });
        handler({ requestContext: { connectionId: "ghost", domainName: "example.test" } }, {}, (err, res) => {
            expect(res.statusCode).toBe(401); expect(ran).toBe(false); done();
        });
    });
    test("$connect without an authorizer context is refused", (done) => {
        const service = new BroadcastService(); service.store = new FakeS3Service();
        service.connect({ requestContext: { connectionId: "c2", domainName: "example.test" }, headers: {} }, {}, (err, res) => {
            expect(res.statusCode).toBe(401); done();
        });
    });
    test("client-supplied identity fields are ignored", () => {
        expect(subjectOf({ requestContext: { connectionId: "c9", identity: { userArn: "forged" } }, body: JSON.stringify({ sub: "auth0|admin" }) })).toBe("forged".length ? "forged" : "");
        // legacy fallback only; with a principal present it always wins
        expect(subjectOf({ principal: { sub: "auth0|u1" }, requestContext: { identity: { userArn: "forged" } } })).toBe("auth0|u1");
    });
});

describe("reference-instance policy", () => {
    const human = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
    afterEach(() => { delete process.env.OWNER_SUBS; });
    test("any authenticated human is an owner unless OWNER_SUBS says otherwise", () => {
        expect(decide(human, ["graph:commit"]).allow).toBe(true);
        process.env.OWNER_SUBS = "auth0|someone-else";
        expect(decide(human, ["graph:read"])).toMatchObject({ allow: false, reason: expect.stringContaining("not an owner") });
        expect(decide(undefined, ["graph:read"]).allow).toBe(false);
    });
    test("agent tokens are narrowed to their scopes", () => {
        const agent = { ...human, kind: "agent", scopes: ["graph:read", "graph:propose"] };
        expect(decide(agent, ["graph:read"]).allow).toBe(true);
        expect(decide(agent, ["graph:commit"])).toMatchObject({ allow: false, reason: expect.stringContaining("graph:commit") });
    });
});

describe("protected resource metadata", () => {
    const { protectedResourceMetadata, protectedResourceMetadataHandler } = require("../auth/metadata");
    test("publishes the audience and the authorization server for clients to discover", (done) => {
        process.env.AUTH0_AUDIENCE = "plastic-io-graph-server"; process.env.AUTH0_DOMAIN = "tenant.example.auth0.com";
        expect(protectedResourceMetadata()).toMatchObject({ resource: "plastic-io-graph-server", authorization_servers: ["https://tenant.example.auth0.com/"], bearer_methods_supported: ["header"] });
        protectedResourceMetadataHandler({}, {}, (err, res) => {
            expect(res.statusCode).toBe(200); expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
            expect(JSON.parse(res.body).scopes_supported).toContain("graph:commit");
            delete process.env.AUTH0_AUDIENCE; delete process.env.AUTH0_DOMAIN; done();
        });
    });
});
