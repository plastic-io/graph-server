/** MCP client registration delegates sign-in, PKCE and token issuance to Cognito.
 * No passwords, authorization codes, refresh tokens or signing keys are stored here.
 */
import {createHash} from 'crypto';
import {CognitoIdentityServiceProvider, DynamoDB} from 'aws-sdk';

export interface RegistrationConfig {
    issuer: string;
    userPoolId: string;
    loginDomain: string;
    baseUrl: string;
    authorizationIssuer?: string;
    table: string;
    scopes: string[];
}
export interface RegisteredClient {
    client_id: string;
    client_id_issued_at: number;
    redirect_uris: string[];
    scope: string;
    issuer: string;
    resource: string;
}
export interface RegistrationStore {
    get(key: string): Promise<any>;
    reserve(key: string): Promise<boolean>;
    complete(key: string, client: RegisteredClient): Promise<void>;
}

export function registrationConfig(): RegistrationConfig | undefined {
    if (process.env.COGNITO_MCP_REGISTRATION !== 'true') return undefined;
    const issuer = process.env.COGNITO_ISSUER || '';
    const userPoolId = issuer.split('/').pop()!;
    const loginDomain = process.env.COGNITO_LOGIN_DOMAIN || '';
    const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const table = process.env.COGNITO_MCP_CLIENT_TABLE || '';
    if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9-]+_[A-Za-z0-9]+$/.test(issuer)
        || !/^[a-z0-9-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com$/.test(loginDomain)
        || !/^https:\/\/[^?#]+$/.test(baseUrl) || !table) throw new Error('Incomplete Cognito MCP registration configuration');
    const scopes = [...new Set([
        ...(process.env.COGNITO_REQUIRED_SCOPES || '').split(/[\s,]+/).filter(Boolean),
        ...Object.keys(JSON.parse(process.env.COGNITO_SCOPE_MAP || '{}')),
    ])];
    if (!scopes.length) throw new Error('MCP registration requires API scopes');
    const authorizationIssuer = (process.env.COGNITO_MCP_OAUTH_ISSUER || '').replace(/\/$/, '') || undefined;
    return {issuer, userPoolId, loginDomain, baseUrl, table, scopes, authorizationIssuer};
}

/** Exact OpenAI web callbacks and native loopback callbacks are public identifiers.
 * Registration never enables arbitrary web origins, wildcard redirects, implicit
 * grants, password authentication, machine grants, or self-registration of users.
 */
export function permittedRedirect(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 1024) return false;
    try {
        const u = new URL(value);
        if (u.username || u.password || u.hash || u.search || u.href !== value) return false;
        if (u.protocol === 'https:' && u.hostname === 'chatgpt.com' && !u.port) {
            return u.pathname === '/connector_platform_oauth_redirect'
                || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname)
                || /^\/oauth\/codex\/callback(?:\/[A-Za-z0-9_-]+)?$/.test(u.pathname);
        }
        return u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname)
            && /^\/callback(?:\/[A-Za-z0-9_-]+)?$/.test(u.pathname);
    } catch { return false; }
}

export class DynamoRegistrationStore implements RegistrationStore {
    private db = new DynamoDB.DocumentClient();
    constructor(private table: string) {}
    async get(key: string) {
        return (await this.db.get({TableName:this.table, Key:{id:key}, ConsistentRead:true}).promise()).Item;
    }
    async reserve(key: string) {
        try {
            await this.db.transactWrite({TransactItems:[
                {Put:{TableName:this.table, Item:{id:key, status:'pending'}, ConditionExpression:'attribute_not_exists(id)'}},
                // Bound anonymous registration even if a caller supplies thousands
                // of different callback IDs. Existing registrations keep working.
                {Update:{TableName:this.table, Key:{id:'quota'}, UpdateExpression:'ADD registrations :one',
                    ConditionExpression:'attribute_not_exists(registrations) OR registrations < :limit',
                    ExpressionAttributeValues:{':one':1, ':limit':200}}},
            ]}).promise();
            return true;
        } catch (e) {
            if (e.code === 'TransactionCanceledException') return false;
            throw e;
        }
    }
    async complete(key: string, client: RegisteredClient) {
        await this.db.transactWrite({TransactItems:[
            {Put:{TableName:this.table, Item:{id:key, status:'active', client}, ConditionExpression:'#s = :pending',
                ExpressionAttributeNames:{'#s':'status'}, ExpressionAttributeValues:{':pending':'pending'}}},
            {Put:{TableName:this.table, Item:{id:'client#'+client.client_id, status:'active', client}, ConditionExpression:'attribute_not_exists(id)'}},
        ]}).promise();
    }
}

export async function registeredMcpClient(clientId: string, config = registrationConfig(), store?: RegistrationStore): Promise<RegisteredClient | undefined> {
    if (!config || !/^[a-z0-9]{1,128}$/.test(clientId)) return undefined;
    const row = await (store || new DynamoRegistrationStore(config.table)).get('client#'+clientId);
    const c = row?.client;
    return row?.status === 'active' && c?.client_id === clientId && c.issuer === config.issuer
        && c.resource === config.baseUrl+'/mcp' ? c : undefined;
}

const response = (statusCode: number, value: any) => ({statusCode, headers:{
    'Content-Type':'application/json', 'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
}, body:JSON.stringify(value)});

export function createRegistrationHandler(config: RegistrationConfig, store: RegistrationStore = new DynamoRegistrationStore(config.table),
    cognito = new CognitoIdentityServiceProvider()) {
    return async (event: any) => {
        const method = event.httpMethod || event.requestContext?.http?.method;
        const path = event.resource || event.rawPath || event.path;
        const authorizationIssuer = config.authorizationIssuer || config.baseUrl;
        if (method === 'GET' && ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'].includes(path)) {
            // This is OAuth metadata, not an OIDC identity service. The MCP client
            // requests graph scopes; the editor retains its existing OIDC login.
            return response(200, {
                issuer:authorizationIssuer,
                authorization_endpoint:`https://${config.loginDomain}/oauth2/authorize`,
                token_endpoint:`https://${config.loginDomain}/oauth2/token`,
                revocation_endpoint:`https://${config.loginDomain}/oauth2/revoke`,
                registration_endpoint:authorizationIssuer+'/oauth/register',
                response_types_supported:['code'], grant_types_supported:['authorization_code','refresh_token'],
                token_endpoint_auth_methods_supported:['none'], code_challenge_methods_supported:['S256'],
                scopes_supported:config.scopes,
                authorization_response_iss_parameter_supported:false,
            });
        }
        if (method !== 'POST' || path !== '/oauth/register') return response(404, {error:'not_found'});
        try {
            const body = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
            if (body.length > 8192) return response(413, {error:'invalid_client_metadata'});
            let input;
            try { input = JSON.parse(body); } catch { return response(400, {error:'invalid_client_metadata'}); }
            if (!input || !Array.isArray(input.redirect_uris) || !input.redirect_uris.length || input.redirect_uris.length > 8
                || !input.redirect_uris.every(permittedRedirect)) return response(400, {error:'invalid_redirect_uri'});
            if ((input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none')
                || (input.grant_types && (!Array.isArray(input.grant_types) || !input.grant_types.every((g:any)=>['authorization_code','refresh_token'].includes(g))))
                || (input.response_types && (!Array.isArray(input.response_types) || input.response_types.length !== 1 || input.response_types[0] !== 'code'))
                || (input.scope !== undefined && typeof input.scope !== 'string')) return response(400, {error:'invalid_client_metadata'});
            const scopes = input.scope ? [...new Set<string>(input.scope.split(/\s+/).filter(Boolean))].sort() : [...config.scopes].sort();
            if (!scopes.length || !scopes.every(s=>config.scopes.includes(s))) return response(400, {error:'invalid_client_metadata',error_description:'Request the graph API scopes advertised in discovery.'});
            const redirects = [...new Set<string>(input.redirect_uris)].sort();
            const key = 'registration#'+createHash('sha256').update(JSON.stringify({redirects,scopes,issuer:config.issuer,resource:config.baseUrl+'/mcp'})).digest('hex');
            let row = await store.get(key);
            if (!row) {
                if (!await store.reserve(key)) {
                    row = await store.get(key);
                    if (row?.status !== 'active') return response(429, {error:'temporarily_unavailable',error_description:'Registration is busy or the instance client limit has been reached.'});
                } else {
                    const created = await cognito.createUserPoolClient({
                        UserPoolId:config.userPoolId, ClientName:'graph-mcp-'+key.slice(-40), GenerateSecret:false,
                        AllowedOAuthFlowsUserPoolClient:true, AllowedOAuthFlows:['code'], AllowedOAuthScopes:scopes,
                        CallbackURLs:redirects, SupportedIdentityProviders:['COGNITO'], ExplicitAuthFlows:['ALLOW_REFRESH_TOKEN_AUTH'],
                        EnableTokenRevocation:true, PreventUserExistenceErrors:'ENABLED',
                        AccessTokenValidity:60, IdTokenValidity:60, RefreshTokenValidity:1,
                        TokenValidityUnits:{AccessToken:'minutes',IdToken:'minutes',RefreshToken:'days'},
                    }).promise();
                    const id = created.UserPoolClient?.ClientId;
                    if (!id) throw new Error('Registration returned no client ID');
                    const client: RegisteredClient = {client_id:id, client_id_issued_at:Math.floor(Date.now()/1000),
                        redirect_uris:redirects, scope:scopes.join(' '), issuer:config.issuer, resource:config.baseUrl+'/mcp'};
                    await store.complete(key, client);
                    row = {status:'active',client};
                }
            }
            if (row.status !== 'active') return response(503, {error:'temporarily_unavailable'});
            const {issuer,resource,...client} = row.client;
            return response(201, {...client, token_endpoint_auth_method:'none', grant_types:['authorization_code','refresh_token'], response_types:['code']});
        } catch {
            // Never log request bodies, AWS responses, or credentials at this boundary.
            return response(503, {error:'temporarily_unavailable'});
        }
    };
}
