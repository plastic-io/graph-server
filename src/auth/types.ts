import type { Principal } from "./principal";

export interface VerifiedIdentity {
    principal: Principal;
    expiresAt: number;
}

export interface ProviderDiscovery {
    authorizationServers: string[];
    scopes: string[];
    audience?: string;
    resourceFallback?: string;
    clientRegistration?: 'dynamic';
}

export interface AuthenticationAdapter {
    readonly name: "auth0" | "cognito";
    verifyAccessToken(token: string): Promise<VerifiedIdentity>;
    discovery(): ProviderDiscovery;
    oauthRequest?(event: any): Promise<any>;
}
