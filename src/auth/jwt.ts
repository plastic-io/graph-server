import { createRemoteJWKSet, jwtVerify, JWTVerifyGetKey } from "jose";
import { Principal, principalFromClaims } from "./principal";

export interface JwtConfig {
    domain: string;      // Auth0 tenant domain, e.g. dev-7q-g69up.us.auth0.com
    /**
     * What a token must be for.  More than one is allowed on purpose: a client
     * that discovers this server asks for a token for the **resource
     * identifier** it was given (RFC 8707), while the editor has always asked
     * for the API's name.  Accepting both lets one migrate without the other
     * stopping, and either can be retired by removing it here.
     */
    audience: string | string[];
    keys?: JWTVerifyGetKey;   // injectable for tests; defaults to the tenant's JWKS
}

let remoteKeys: JWTVerifyGetKey | undefined;
let remoteKeysFor = "";

export function configFromEnv(): JwtConfig {
    const audience = [process.env.AUTH0_AUDIENCE, process.env.MCP_RESOURCE]
        .filter((value): value is string => !!value);
    return {
        domain: process.env.AUTH0_DOMAIN || "",
        audience: audience.length === 1 ? audience[0] : audience,
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
    const audiences = Array.isArray(config.audience) ? config.audience : [config.audience];
    if (!config.domain || !audiences.length || !audiences[0]) {
        throw new Error("Authentication is not configured (AUTH0_DOMAIN / AUTH0_AUDIENCE)");
    }
    const { payload } = await jwtVerify(token, config.keys || keysFor(config.domain), {
        issuer: `https://${config.domain}/`,
        audience: audiences,
        algorithms: ["RS256"],
    });
    if (!payload.sub) {
        throw new Error("Token has no subject");
    }
    return principalFromClaims(payload);
}
