import { createRemoteJWKSet, jwtVerify, JWTVerifyGetKey } from "jose";
import type { AuthenticationAdapter } from "../types";
import { AUTHORITIES } from "../../policy/decide";
const { cognitoConfig } = require("../../../build/auth-provider.cjs");

export interface CognitoConfig {
    issuer: string;
    humanClientIds: string[];
    machineClientIds: string[];
    requiredScopes: string[];
    scopeMap: Record<string, string>;
    audience?: string;
    keys?: JWTVerifyGetKey;
}

const keySets = new Map<string, JWTVerifyGetKey>();
function keysFor(issuer: string) {
    if (!keySets.has(issuer)) keySets.set(issuer, createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)));
    return keySets.get(issuer)!;
}

/** Keep this encoding identical to the editor's normalized user subject. */
export function cognitoSubject(issuer: string, sub: string): string {
    return `cognito:${encodeURIComponent(issuer)}:${sub}`;
}

export function createAdapter(config?: CognitoConfig): AuthenticationAdapter {
    const configuration = (): CognitoConfig => {
        const c: CognitoConfig = config || cognitoConfig();
        if (Object.values(c.scopeMap).some((s) => !(AUTHORITIES as string[]).includes(s))) {
            throw new Error("COGNITO_SCOPE_MAP contains an unknown application authority");
        }
        return c;
    };
    return {
        name: "cognito",
        async verifyAccessToken(token) {
            const c = configuration();
            const { payload } = await jwtVerify(token, c.keys || keysFor(c.issuer), {
                issuer: c.issuer, algorithms: ["RS256"], requiredClaims: ["sub", "exp", "client_id", "token_use"],
                ...(c.audience ? { audience: c.audience } : {}),
            });
            if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Missing subject");
            if (payload.token_use !== "access") throw new Error("An access token is required");
            const clientId = payload.client_id;
            if (typeof clientId !== "string") throw new Error("Missing client ID");
            const machine = c.machineClientIds.includes(clientId);
            if (!machine && !c.humanClientIds.includes(clientId)) throw new Error("Unrecognized app client");
            // User-pool access tokens for people contain a username. Dedicated machine
            // clients are configured separately; an ambiguous identity never becomes an owner.
            if (!machine && (typeof payload.username !== "string" || !payload.username)) throw new Error("Not a human access token");
            const tokenScopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [];
            if (!c.requiredScopes.every((scope) => tokenScopes.includes(scope))) throw new Error("Missing API scope");
            const sub = cognitoSubject(c.issuer, payload.sub!);
            const scopes = [...new Set(tokenScopes.filter((scope) => Object.prototype.hasOwnProperty.call(c.scopeMap, scope)).map((scope) => c.scopeMap[scope]))];
            // An empty agent scope list means "delegation only" to the existing policy
            // resolver. Do not let unmapped OAuth scopes accidentally remove narrowing.
            if (machine && !scopes.length) throw new Error("Machine token has no mapped authority");
            return { expiresAt: payload.exp!, principal: {
                sub, kind: machine ? "agent" : "human", tenant: `personal:${sub}`, scopes,
                email: typeof payload.email === "string" ? payload.email : undefined,
                name: typeof payload.name === "string" ? payload.name : undefined,
            } };
        },
        discovery() {
            const c = configuration();
            return { authorizationServers: [c.issuer], scopes: [...new Set([...c.requiredScopes, ...Object.keys(c.scopeMap)])], audience: c.audience };
        },
    };
}

export default createAdapter();
