/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728), unauthenticated by design: it is how a
 * client learns which audience to request a token for and from which authorization server.
 * The editor reads `resource`; the MCP server (plan §5.0) requires this document.
 */
const AUTHORITIES = [
    "graph:read", "graph:inspect-internals", "graph:inspect-payloads", "graph:observe",
    "graph:propose", "graph:approve", "graph:commit", "graph:activate", "graph:rollback",
    "graph:execute", "graph:simulate", "graph:test", "graph:connect-privileged",
    "component:publish", "registry:read", "iac:propose", "iac:approve", "iac:read-status", "policy:admin",
];

export function protectedResourceMetadata() {
    return {
        resource: process.env.AUTH0_AUDIENCE || "",
        authorization_servers: process.env.AUTH0_DOMAIN ? [`https://${process.env.AUTH0_DOMAIN}/`] : [],
        bearer_methods_supported: ["header"],
        scopes_supported: AUTHORITIES,
        resource_documentation: "https://github.com/plastic-io/graph-editor/tree/main/docs/polymorphic-application-plan",
    };
}

export function protectedResourceMetadataHandler(event: any, context: any, callback: (err: any, response: any) => void) {
    callback(null, {
        statusCode: 200,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=300",
            "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify(protectedResourceMetadata()),
    });
}
