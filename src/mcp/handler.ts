import { createMcpHandler, isLegacyRequest, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Principal } from "../auth/principal";
import { buildServer, McpDeps } from "./server";

/**
 * POST /mcp on the REST API (plan D-3): the API Gateway event becomes a
 * web-standard Request, the SDK's per-request handler serves it with the
 * principal the authorizer established, and the Response goes back as the
 * Lambda result.  Responses are plain JSON (no streaming on this route).
 */
const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function allowedOrigin(origin: string | undefined): boolean {
    if (!origin) return true;   // non-browser clients send no Origin
    const allowed = (process.env.MCP_ALLOWED_ORIGINS || "http://localhost:8080,http://localhost:5173,https://plastic-io.github.io").split(",").map((s) => s.trim()).filter(Boolean);
    return allowed.includes(origin);
}

export function makeMcpHandler(deps: McpDeps) {
    /** Where a client goes to listen, so a read tool can say so (plan PB-085). */
    const streamUrl = () => process.env.MCP_STREAM_URL || undefined;
    const handler = createMcpHandler((ctx) => buildServer(deps, (ctx.authInfo && ctx.authInfo.extra && (ctx.authInfo.extra as any).principal) || undefined, { streamUrl: streamUrl() }), {
        responseMode: "json",
        legacy: "reject",   // 2025-era clients are served below, as JSON, one instance per request
        onerror: (err) => console.error("MCP handler error", err),
    });

    /** A 2025-era (sessionless, non-envelope) request: one server, one transport, one JSON answer. */
    async function serveLegacy(request: Request, principal: Principal | undefined): Promise<Response> {
        const server = buildServer(deps, principal, { streamUrl: streamUrl() });
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await server.connect(transport);
        try {
            return await transport.handleRequest(request, {
                authInfo: principal ? { token: "", clientId: principal.sub, scopes: principal.scopes || [], extra: { principal } } : undefined,
            } as any);
        } finally {
            transport.close().catch(() => undefined);
        }
    }

    /** Serve one request with a principal (the Lambda path and the tests share this). */
    async function serve(request: Request, principal: Principal | undefined): Promise<Response> {
        const origin = request.headers.get("origin") || undefined;
        if (!allowedOrigin(origin)) {
            return new Response(JSON.stringify({ error: "origin not allowed" }), { status: 403, headers: { "content-type": "application/json" } });
        }
        if (isLegacyRequest(request)) {
            return serveLegacy(request, principal);
        }
        return handler.fetch(request, {
            authInfo: principal ? { token: "", clientId: principal.sub, scopes: principal.scopes || [], extra: { principal } } : undefined,
        });
    }

    async function lambda(event: any, context: any, callback: (err: any, response: any) => void) {
        try {
            if (event.httpMethod === "OPTIONS") {
                return callback(null, { statusCode: 204, headers: corsHeaders, body: "" });
            }
            const principal: Principal | undefined = event.principal;
            if (!principal) {
                return callback(null, { statusCode: 401, headers: { ...corsHeaders, "WWW-Authenticate": 'Bearer resource_metadata="/.well-known/oauth-protected-resource"' }, body: JSON.stringify({ error: "unauthenticated" }) });
            }
            const ctx = event.requestContext || {};
            const host = (event.headers && (event.headers.Host || event.headers.host)) || ctx.domainName || "localhost";
            const url = `https://${host}${event.path || "/mcp"}`;
            const headers = new Headers();
            Object.keys(event.headers || {}).forEach((k) => { if (event.headers[k] !== undefined && event.headers[k] !== null) headers.set(k, String(event.headers[k])); });
            headers.delete("authorization");   // the principal is what matters downstream; never re-export the token
            const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : undefined;
            const request = new Request(url, { method: event.httpMethod || "POST", headers, body });
            const response = await serve(request, principal);
            const responseHeaders: Record<string, string> = { ...corsHeaders };
            response.headers.forEach((v, k) => { responseHeaders[k] = v; });
            const text = await response.text();
            callback(null, { statusCode: response.status, headers: responseHeaders, body: text });
        } catch (err: any) {
            console.error("MCP request failed", err);
            callback(null, { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "internal" }) });
        }
    }

    return { serve, lambda, handler };
}
