/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728), unauthenticated by design: it is how a
 * client learns which audience to request a token for and from which authorization server.
 * The editor reads `resource`; an MCP client that arrives with no token reads all of it.
 *
 * Two things here are the difference between "an MCP server exists" and "a client can
 * connect to it without being told anything":
 *
 *   - `resource` is a **URI**, because a client passes it back as the RFC 8707 resource
 *     indicator when it asks for a token.  A bare name cannot be a resource indicator, so
 *     a client that follows the spec asks for a token for nothing in particular and gets
 *     one this server will not accept.
 *   - `audience` is **not** `resource`, and conflating them locked the editor out.  A
 *     resource indicator has to be this server's own address or an MCP client refuses it;
 *     an Auth0 audience has to be an API identifier the tenant knows.  Those are two
 *     different strings for the same server, so the document carries both: MCP clients
 *     read `resource`, and a first-party client that asks its authorization server for a
 *     token reads `audience`.
 *   - the 401 that sends a client here must name this document at an **absolute** URL.
 *     That challenge is emitted by the API Gateway itself (the authorizer refuses before
 *     any handler runs), so it is configured beside the routes in `serverless.yaml`.
 */
import adapter from "@graph/auth-provider";
import type { AuthenticationAdapter } from "./types";

/** Where this deployment answers, as a client would have to address it. */
export function baseUrlOf(event: any): string {
    const headers = event && event.headers ? event.headers : {};
    const host = headers.Host || headers.host
        || (event && event.requestContext && (event.requestContext.domainName || (event.requestContext.http && event.requestContext.http.host)))
        || "localhost";
    const stage = event && event.requestContext && event.requestContext.stage;
    const proto = String(host).indexOf("localhost") === 0 ? "http" : "https";
    // A Function URL has no stage; the REST API carries one in the path.
    return stage && stage !== "$default" ? `${proto}://${host}/${stage}` : `${proto}://${host}`;
}

/**
 * The resource identifier clients ask for a token for.  `MCP_RESOURCE` is what the
 * authorization server knows this API as; where it is not set the canonical MCP endpoint
 * is used, which is what the identifier should be.
 */
export function resourceIdentifier(baseUrl: string, provider: AuthenticationAdapter = adapter): string {
    const configured = process.env.MCP_RESOURCE;
    if (configured) {
        return configured;
    }
    return provider.discovery().resourceFallback || `${baseUrl}/mcp`;
}

/**
 * The API identifier a first-party client asks its authorization server for.  This is what
 * the authorizer accepts, which is not necessarily what `resource` says: the resource
 * indicator names *this server*, while the audience names *the API the tenant knows*.
 */
export function audienceIdentifier(provider: AuthenticationAdapter = adapter): string {
    return provider.discovery().audience || "";
}

export function protectedResourceMetadata(baseUrl = "", provider: AuthenticationAdapter = adapter) {
    const resource = resourceIdentifier(baseUrl, provider);
    const audience = audienceIdentifier(provider);
    return {
        resource,
        ...(audience ? { audience } : {}),
        authorization_servers: provider.discovery().authorizationServers,
        auth_provider: provider.name,
        bearer_methods_supported: ["header"],
        scopes_supported: provider.discovery().scopes,
        resource_documentation: "https://github.com/plastic-io/graph-editor/tree/main/docs/polymorphic-application-plan",
    };
}

/** The challenge a 401 carries, naming this document where a client can fetch it. */
export function bearerChallenge(baseUrl: string): string {
    return `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`;
}

export function protectedResourceMetadataHandler(event: any, context: any, callback: (err: any, response: any) => void) {
    callback(null, {
        statusCode: 200,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=300",
            "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify(protectedResourceMetadata(baseUrlOf(event))),
    });
}
