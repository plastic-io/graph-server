import { createRemoteJWKSet, jwtVerify, JWTVerifyGetKey } from "jose";
import { Principal, principalFromClaims } from "./principal";

export interface JwtConfig {
    domain: string;      // Auth0 tenant domain, e.g. dev-7q-g69up.us.auth0.com
    audience: string;    // the API identifier configured in Auth0 (RFC 8707 resource)
    keys?: JWTVerifyGetKey;   // injectable for tests; defaults to the tenant's JWKS
}

let remoteKeys: JWTVerifyGetKey | undefined;
let remoteKeysFor = "";

export function configFromEnv(): JwtConfig {
    return {
        domain: process.env.AUTH0_DOMAIN || "",
        audience: process.env.AUTH0_AUDIENCE || "",
    };
}

function keysFor(domain: string): JWTVerifyGetKey {
    if (!remoteKeys || remoteKeysFor !== domain) {
        remoteKeys = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`));
        remoteKeysFor = domain;
    }
    return remoteKeys;
}

/** Verify an Auth0 access token (RS256, issuer and audience bound) and return the principal it names. */
export async function verifyBearer(token: string, config: JwtConfig = configFromEnv()): Promise<Principal> {
    if (!config.domain || !config.audience) {
        throw new Error("Authentication is not configured (AUTH0_DOMAIN / AUTH0_AUDIENCE)");
    }
    const { payload } = await jwtVerify(token, config.keys || keysFor(config.domain), {
        issuer: `https://${config.domain}/`,
        audience: config.audience,
        algorithms: ["RS256"],
    });
    if (!payload.sub) {
        throw new Error("Token has no subject");
    }
    return principalFromClaims(payload);
}
