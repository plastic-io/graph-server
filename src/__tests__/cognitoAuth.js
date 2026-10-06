const {generateKeyPair, exportJWK, createLocalJWKSet, SignJWT} = require('jose');
const {createAdapter, cognitoSubject} = require('../auth/providers/cognito');
const {authorize} = require('../auth/authorizer');
const {protectedResourceMetadata} = require('../auth/metadata');
const {makeMcpStreamHandler} = require('../mcp/stream');
const {principalForConnection, forgetConnection, principalFromAuthorizerContext} = require('../auth/principal');
const {providerName, cognitoConfig, validate} = require('../../build/auth-provider.cjs');
const {decide} = require('../policy/decide');
const issuer = 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_Test';
let privateKey, otherKey, config;
async function mint(over = {}, key = privateKey) {
    const claims = {iss: issuer, sub: 'user-1', exp: Math.floor(Date.now()/1000)+3600,
        token_use: 'access', client_id: 'browser', username: 'person', scope: 'graphs/access graphs/read', ...over};
    return new SignJWT(claims).setProtectedHeader({alg: 'RS256', kid: 'key'}).sign(key);
}
beforeAll(async () => {
    const pair = await generateKeyPair('RS256'); privateKey = pair.privateKey;
    otherKey = (await generateKeyPair('RS256')).privateKey;
    const jwk = await exportJWK(pair.publicKey); jwk.kid = 'key';
    config = {issuer, humanClientIds: ['browser'], machineClientIds: ['machine'], requiredScopes: ['graphs/access'],
        scopeMap: {'graphs/read': 'graph:read'}, keys: createLocalJWKSet({keys: [jwk]})};
});
afterEach(() => { jest.restoreAllMocks(); delete process.env.OWNER_SUBS; });

test('accepts a scoped access token without aud and normalizes its subject', async () => {
    const identity = await createAdapter(config).verifyAccessToken(await mint());
    expect(identity.principal).toMatchObject({sub: cognitoSubject(issuer, 'user-1'), kind: 'human', scopes: ['graph:read']});
    expect(identity.expiresAt).toBeGreaterThan(Date.now()/1000);
    expect(decide(identity.principal, ['graph:commit']).allow).toBe(true);
    process.env.OWNER_SUBS = 'someone-else';
    expect(decide(identity.principal, ['graph:read']).allow).toBe(false);
});
test.each([
    ['issuer', {iss: issuer+'other'}], ['client', {client_id: 'other'}], ['expiry', {exp: 1}],
    ['missing expiry', {exp: undefined}], ['ID token', {token_use: 'id', aud: 'browser'}],
    ['missing scope', {scope: 'openid'}], ['empty subject', {sub: ''}], ['nonhuman browser token', {username: undefined}],
])('rejects incorrect %s', async (_, claims) => {
    await expect(createAdapter(config).verifyAccessToken(await mint(claims))).rejects.toThrow();
});
test('rejects a foreign signature', async () => {
    await expect(createAdapter(config).verifyAccessToken(await mint({}, otherKey))).rejects.toThrow();
});
test('enforces configured resource binding independently of client_id', async () => {
    const adapter = createAdapter({...config, audience: 'https://graphs.example/api'});
    await expect(adapter.verifyAccessToken(await mint())).rejects.toThrow();
    await expect(adapter.verifyAccessToken(await mint({aud: 'browser'}))).rejects.toThrow();
    expect((await adapter.verifyAccessToken(await mint({aud: 'https://graphs.example/api'}))).principal.kind).toBe('human');
});
test('machine identities remain agents and unmapped scopes cannot widen delegation', async () => {
    const adapter = createAdapter(config);
    const token = await mint({sub: 'machine', client_id: 'machine', username: undefined});
    const {principal} = await adapter.verifyAccessToken(token);
    expect(principal.kind).toBe('agent');
    expect(decide(principal, ['graph:commit']).allow).toBe(false);
    await expect(adapter.verifyAccessToken(await mint({client_id: 'machine', scope: 'graphs/access unknown'}))).rejects.toThrow(/mapped/);
});
test('metadata names Cognito scopes and issuer without inheriting Auth0 audience', () => {
    const metadata = protectedResourceMetadata('https://graphs.example', createAdapter(config));
    expect(metadata).toMatchObject({auth_provider: 'cognito', authorization_servers: [issuer], scopes_supported: ['graphs/access', 'graphs/read']});
    expect(metadata.audience).toBeUndefined();
});
test('REST and socket handshakes use the injected adapter and carry verified expiry', async () => {
    const token = await mint();
    for (const headers of [{Authorization: `Bearer ${token}`}, {'Sec-WebSocket-Protocol': `access_token, ${token}`}]) {
        const result = await authorize({headers, methodArn: 'arn:aws:execute-api:us-west-2:123:api/dev/$connect'}, createAdapter(config));
        expect(result.context).toMatchObject({sub: cognitoSubject(issuer, 'user-1'), authProvider: 'cognito', expiresAt: expect.any(Number)});
    }
});
test('Function URL uses the same verifier and its own provider metadata', async () => {
    const mcp = makeMcpStreamHandler({crdtStore: {store: {}}, delegations: {}}, {auth: createAdapter(config)});
    const statuses = [];
    const previous = global.awslambda;
    global.awslambda = {HttpResponseStream: {from: (out, meta) => { statuses.push(meta.statusCode); return out; }}};
    try {
        for (const [path, token, expected] of [
            ['/mcp', await mint(), 200], ['/mcp', await mint({token_use: 'id'}), 401],
            ['/.well-known/oauth-protected-resource', '', 200],
        ]) {
            const output = [];
            await mcp.stream({requestContext: {http: {method: 'POST', path}}, headers: {authorization: `Bearer ${token}`}, body: '{'},
                {write: (v) => output.push(String(v)), end: () => {}}, {});
            expect(statuses.pop()).toBe(expected);
            if (path.includes('well-known')) expect(JSON.parse(output.join('')).auth_provider).toBe('cognito');
        }
    } finally { global.awslambda = previous; }
});
test('cached connection principals expire and old provider records are refused', async () => {
    const selected = require('@graph/auth-provider').default.name;
    const event = {requestContext: {connectionId: 'expiry-test', domainName: 'example'}};
    let now = 1000000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const principal = {sub: 'person', kind: 'human', scopes: [], tenant: 'personal:person', expiresAt: 1001, authProvider: selected};
    const store = {get: jest.fn((key, callback) => callback(null, {principal}))};
    expect(await principalForConnection(store, event)).toEqual(principal);
    now = 1001000;
    expect(await principalForConnection(store, event)).toBeUndefined();
    expect(store.get).toHaveBeenCalledTimes(1);
    forgetConnection(event.requestContext);
    principal.expiresAt = 2000; principal.authProvider = 'old-provider';
    expect(await principalForConnection(store, event)).toBeUndefined();
    delete principal.expiresAt; principal.authProvider = selected;
    expect(await principalForConnection(store, event)).toBeUndefined();
    expect(principalFromAuthorizerContext({requestContext: {authorizer: {...principal, expiresAt: 1001}}})).toBeUndefined();
});
test('build selection and production configuration fail closed', () => {
    expect(providerName({})).toBe('auth0');
    expect(() => providerName({AUTH_PROVIDER: 'other'})).toThrow();
    expect(() => validate({AUTH_PROVIDER: 'cognito'})).toThrow();
    const env = {COGNITO_ISSUER: issuer, COGNITO_CLIENT_IDS: 'browser', COGNITO_REQUIRED_SCOPES: 'graphs/access'};
    expect(cognitoConfig(env).humanClientIds).toEqual(['browser']);
    expect(() => cognitoConfig({...env, COGNITO_MACHINE_CLIENT_IDS: 'browser'})).toThrow();
    expect(() => cognitoConfig({...env, COGNITO_SCOPE_MAP: '[]'})).toThrow();
});
