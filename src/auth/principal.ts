/**
 * Who is acting.  Every request that reaches a service carries `event.principal`,
 * derived on the server side only: from the API Gateway authorizer context for HTTP
 * requests and the `$connect` handshake, and from the stored connection record for
 * every later WebSocket message.  Nothing a client puts in a message body is trusted
 * for identity (plan §4.4.3).
 */
export interface Principal {
    sub: string;
    kind: "human" | "agent" | "system" | "synthetic";
    tenant: string;
    email?: string;
    name?: string;
    scopes: string[];
}

export const TENANT_CLAIM = "https://plastic-io/tenant";
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CONNECTION_CACHE_MS = 60000;

export function principalFromClaims(payload: any): Principal {
    const sub = String(payload.sub);
    const scopes = String(payload.scope || "")
        .split(" ")
        .filter(Boolean)
        .concat(Array.isArray(payload.permissions) ? payload.permissions : []);
    return {
        sub,
        kind: payload.gty === "client-credentials" ? "agent" : "human",
        tenant: payload[TENANT_CLAIM] || payload.org_id || `personal:${sub}`,
        email: payload.email,
        name: payload.name,
        scopes: Array.from(new Set(scopes)),
    };
}

function lowerHeaders(event: any): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(event.headers || {})) {
        out[k.toLowerCase()] = String(v);
    }
    return out;
}

/** The bearer token of a request: Authorization header, a WebSocket subprotocol entry, or ?access_token. */
export function extractToken(event: any): string | undefined {
    const headers = lowerHeaders(event);
    const auth = headers.authorization;
    if (auth) {
        const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
        if (m) {
            return m[1];
        }
    }
    const proto = headers["sec-websocket-protocol"];
    if (proto) {
        for (const part of proto.split(",").map((s) => s.trim())) {
            if (JWT_SHAPE.test(part)) {
                return part;
            }
        }
    }
    const query = event.queryStringParameters || {};
    if (query.access_token && JWT_SHAPE.test(query.access_token)) {
        return query.access_token;
    }
    return undefined;
}

/** HTTP requests and the $connect handshake carry the authorizer's context. */
export function principalFromAuthorizerContext(event: any): Principal | undefined {
    const ctx = event && event.requestContext && event.requestContext.authorizer;
    if (!ctx || !ctx.sub) {
        return undefined;
    }
    let scopes: string[] = [];
    try {
        scopes = ctx.scopes ? JSON.parse(ctx.scopes) : [];
    } catch (err) {
        scopes = [];
    }
    return {
        sub: ctx.sub,
        kind: ctx.kind || "human",
        tenant: ctx.tenant || `personal:${ctx.sub}`,
        email: ctx.email || undefined,
        name: ctx.name || undefined,
        scopes,
    };
}

/** The subject to record on writes.  Falls back to the legacy label so old fixtures keep working. */
export function subjectOf(event: any): string {
    if (event && event.principal && event.principal.sub) {
        return event.principal.sub;
    }
    const fromContext = principalFromAuthorizerContext(event);
    if (fromContext) {
        return fromContext.sub;
    }
    const ctx = event && event.requestContext;
    return (ctx && ctx.identity && ctx.identity.userArn) || (ctx && ctx.connectionId) || "Unknown";
}

export function connectionKey(ctx: any): string {
    return `connections/${ctx.connectionId}/${ctx.domainName}`;
}

const connectionCache: Map<string, { principal: Principal; at: number }> = new Map();

/** The principal recorded for a WebSocket connection at $connect (stored by BroadcastService.connect). */
export function principalForConnection(store: any, event: any): Promise<Principal | undefined> {
    const ctx = event.requestContext || {};
    const key = connectionKey(ctx);
    const cached = connectionCache.get(key);
    if (cached && Date.now() - cached.at < CONNECTION_CACHE_MS) {
        return Promise.resolve(cached.principal);
    }
    return new Promise((resolve) => {
        store.get(key, (err: any, record: any) => {
            if (err || !record || !record.principal) {
                return resolve(undefined);
            }
            connectionCache.set(key, { principal: record.principal, at: Date.now() });
            resolve(record.principal);
        });
    });
}

export function forgetConnection(ctx: any) {
    connectionCache.delete(connectionKey(ctx));
}

type Handler = (event: any, context: any, callback: (err: any, response: any) => void) => void;

/**
 * Attach `event.principal` before a handler runs.  With `required` (the default) a request
 * whose principal cannot be established is answered 401 and the handler never runs.
 */
export function withPrincipal(store: any, handler: Handler, options: { required?: boolean } = {}): Handler {
    const required = options.required !== false;
    return (event, context, callback) => {
        if (event.principal) {
            return handler(event, context, callback);
        }
        const fromContext = principalFromAuthorizerContext(event);
        if (fromContext) {
            event.principal = fromContext;
            return handler(event, context, callback);
        }
        const ctx = event.requestContext;
        if (!ctx || !ctx.connectionId) {
            if (required) {
                return callback(null, { statusCode: 401, body: "unauthenticated" });
            }
            return handler(event, context, callback);
        }
        principalForConnection(store, event).then((principal) => {
            if (!principal && required) {
                console.error("No principal recorded for connection", ctx.connectionId);
                return callback(null, { statusCode: 401, body: "unauthenticated" });
            }
            if (principal) {
                event.principal = principal;
            }
            handler(event, context, callback);
        }).catch((err) => {
            console.error("Cannot resolve the connection's principal", err);
            callback(null, { statusCode: 500, body: "internal server error" });
        });
    };
}
