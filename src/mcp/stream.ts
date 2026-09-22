import { createMcpHandler } from "@modelcontextprotocol/server";
import { Principal } from "../auth/principal";
import { verifyBearer, JwtConfig, configFromEnv } from "../auth/jwt";
import { decide } from "../policy/decide";
import { buildServer, McpDeps } from "./server";
import { ChangeFeed, watchesFor, graphOfUri, FeedStore } from "./subscriptions";
import { allowedOrigin } from "./handler";

/**
 * The MCP endpoint that can hold a stream open (plan D-3, PB-085, spike S-3).
 *
 * `POST /mcp` lives on the REST API, where a request has 29 seconds and one
 * response.  A `subscriptions/listen` is neither: it stays open for as long as
 * the client wants to hear about changes, and says nothing most of the time.
 * So it is served by a Lambda **Function URL with response streaming**, which
 * is the one place on this substrate where a handler may write to the client
 * over minutes instead of returning a body.
 *
 * Three things follow from that, and all three are here rather than anywhere
 * else:
 *
 *   - **The token is verified in this handler.**  A Function URL is not behind
 *     the API Gateway authorizer, so nothing upstream has established who is
 *     calling; the same Auth0 verification the authorizer does is done here.
 *   - **The subscription is authorized before the SDK sees it.**  The listen
 *     router filters events by URI but knows nothing about who may read what,
 *     so a stream that names a graph its caller cannot read is refused the way
 *     a read of that graph is refused: as if it were not there.
 *   - **The stream ends before the Lambda does.**  An invocation is killed at
 *     its timeout with nothing written; this closes the subscription gracefully
 *     a little before that, which is the protocol's way of saying "listen
 *     again", and the client does.
 */

/** How long one stream may stay open before the client is asked to listen again. */
const DEFAULT_MAX_STREAM_MS = 840000;              // 14 minutes, inside the 15-minute ceiling
/** How much of the invocation is left when a stream is wound up early. */
const WIND_DOWN_MS = 20000;

export interface StreamOptions {
    jwt?: JwtConfig;
    /** The store the feed watches; defaults to the one the CRDT store holds. */
    store?: FeedStore;
    maxStreamMs?: number;
    pollMs?: number;
    keepAliveMs?: number;
}

const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** A JSON-RPC error as an HTTP 200 body, which is how in-band refusals travel. */
function jsonRpcError(id: any, code: number, message: string): Response {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } }), {
        status: 200, headers: { "content-type": "application/json", ...corsHeaders },
    });
}

export function makeMcpStreamHandler(deps: McpDeps, options: StreamOptions = {}) {
    const maxStreamMs = options.maxStreamMs || Number(process.env.MCP_STREAM_MAX_MS || DEFAULT_MAX_STREAM_MS);
    const store: FeedStore = options.store || ((deps.crdtStore as any).store as FeedStore);

    /** What this principal may read, as the resource handlers decide it. */
    const mayRead = async (principal: Principal | undefined, graphId: string): Promise<boolean> => {
        const resolved = await deps.delegations.resolve(principal, graphId);
        return decide(resolved, ["graph:read"]).allow;
    };

    /**
     * Serve one request.  A listen gets a feed of its own, watching only what
     * it asked for; everything else is answered the way the REST route answers
     * it, so this endpoint is a complete MCP server and not only a side door.
     */
    async function serve(request: Request, principal: Principal | undefined, deadlineMs?: number): Promise<Response> {
        const origin = request.headers.get("origin") || undefined;
        if (!allowedOrigin(origin)) {
            return new Response(JSON.stringify({ error: "origin not allowed" }), { status: 403, headers: { "content-type": "application/json", ...corsHeaders } });
        }
        const text = await request.text();
        let message: any;
        try {
            message = text ? JSON.parse(text) : undefined;
        } catch (err) {
            return jsonRpcError(null, -32700, "Parse error");
        }
        const listening = message && message.method === "subscriptions/listen";
        const filter = (listening && message.params && message.params.notifications) || {};
        const uris: string[] = Array.isArray(filter.resourceSubscriptions) ? filter.resourceSubscriptions : [];

        if (listening) {
            // Refused the way a read is refused: naming what it is not, not who it is for.
            for (const uri of uris) {
                const graphId = graphOfUri(uri);
                if (graphId && !(await mayRead(principal, graphId))) {
                    return jsonRpcError(message.id, -32002, `not found: ${uri}`);
                }
            }
        }

        const watches = watchesFor(uris);
        const feed = new ChangeFeed(store, watches, {
            pollMs: options.pollMs || Number(process.env.MCP_STREAM_POLL_MS || 2000),
            graphList: filter.resourcesListChanged === true ? async () => {
                const toc: any = await deps.tocStore.project();
                return Object.keys(toc).map((k) => toc[k]).filter((e: any) => e && e.type === "graph" && !e.deleted).map((e: any) => String(e.id)).sort();
            } : undefined,
            onerror: (err) => console.error("A change feed could not read the store.", err),
        });
        const handler = createMcpHandler(
            () => buildServer(deps, principal, { subscriptions: true }),
            { bus: feed, legacy: "reject", keepAliveMs: options.keepAliveMs || 15000, onerror: (err) => console.error("MCP stream handler error", err) },
        );
        const authInfo = principal ? { token: "", clientId: principal.sub, scopes: principal.scopes || [], extra: { principal } } : undefined;
        // The signal comes with it: a client that closes the stream is how a
        // subscription is cancelled, and a request rebuilt without its signal
        // can never be told.
        const response = await handler.fetch(new Request(request.url, { method: request.method, headers: request.headers, body: text || undefined, signal: request.signal }), { authInfo } as any);
        if (!listening) {
            await handler.close();
            feed.stop();
            return response;
        }
        // Nothing that happened before the stream opened is announced: the
        // client has just read what it cares about, and re-reading it because
        // of an event from before it asked would be noise.
        await feed.prime();
        feed.start();
        const ends = Math.max(1000, deadlineMs === undefined ? maxStreamMs : Math.min(maxStreamMs, deadlineMs - WIND_DOWN_MS));
        let over = false;
        /**
         * Everything this stream was holding, let go of exactly once.  It
         * matters more here than it looks: a Lambda container is reused, and a
         * feed left polling after its stream ended would go on reading the
         * store on the next request's time, for a client that is no longer
         * there.
         */
        const cleanup = () => {
            if (over) {
                return;
            }
            over = true;
            clearTimeout(timer);
            feed.stop();
            handler.close().catch((err) => console.error("Cannot close the stream", err));
        };
        const timer = setTimeout(() => {
            // A graceful end is the protocol's "listen again"; an invocation
            // that simply stops looks to the client like a dropped connection.
            // close() writes that ending, so the feed stops after it.
            handler.close().catch((err) => console.error("Cannot close the stream", err));
            over = true;
            feed.stop();
        }, ends);
        if ((timer as any).unref) {
            (timer as any).unref();
        }
        const headers = new Headers(response.headers);
        Object.keys(corsHeaders).forEach((k) => headers.set(k, corsHeaders[k]));
        const source = (response.body as any).getReader();
        const body = new ReadableStream({
            async pull(controller) {
                const { done, value } = await source.read();
                if (done) {
                    controller.close();
                    return cleanup();
                }
                controller.enqueue(value);
            },
            cancel(reason: any) {
                source.cancel(reason).catch(() => undefined);
                cleanup();
            },
        });
        return new Response(body, { status: response.status, headers });
    }

    /** The Function URL event, served and written to the response stream. */
    async function stream(event: any, responseStream: any, context: any): Promise<void> {
        const aws = (globalThis as any).awslambda;
        const finish = (statusCode: number, headers: Record<string, string>, body: string) => {
            const out = aws && aws.HttpResponseStream ? aws.HttpResponseStream.from(responseStream, { statusCode, headers }) : responseStream;
            out.write(body);
            out.end();
        };
        try {
            const http = (event.requestContext && event.requestContext.http) || {};
            const method = http.method || "POST";
            if (method === "OPTIONS") {
                return finish(204, corsHeaders, "");
            }
            const headers = new Headers();
            Object.keys(event.headers || {}).forEach((k) => {
                if (event.headers[k] !== undefined && event.headers[k] !== null) {
                    headers.set(k, String(event.headers[k]));
                }
            });
            let principal: Principal | undefined;
            const auth = headers.get("authorization") || "";
            const token = /^Bearer\s+(\S+)$/i.exec(auth.trim());
            if (token) {
                try {
                    principal = await verifyBearer(token[1], options.jwt || configFromEnv());
                } catch (err: any) {
                    console.error("Rejected token:", (err && err.message) || err);
                }
            }
            if (!principal) {
                return finish(401, { ...corsHeaders, "content-type": "application/json", "WWW-Authenticate": 'Bearer resource_metadata="/.well-known/oauth-protected-resource"' }, JSON.stringify({ error: "unauthenticated" }));
            }
            headers.delete("authorization");        // the principal is what matters downstream
            const url = `https://${headers.get("host") || (event.requestContext && event.requestContext.domainName) || "localhost"}${http.path || "/mcp"}`;
            const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : undefined;
            const remaining = context && typeof context.getRemainingTimeInMillis === "function" ? context.getRemainingTimeInMillis() : undefined;
            const response = await serve(new Request(url, { method, headers, body }), principal, remaining);
            const responseHeaders: Record<string, string> = { ...corsHeaders };
            response.headers.forEach((v, k) => { responseHeaders[k] = v; });
            const out = aws && aws.HttpResponseStream ? aws.HttpResponseStream.from(responseStream, { statusCode: response.status, headers: responseHeaders }) : responseStream;
            if (!response.body) {
                out.write(await response.text());
                return out.end();
            }
            const reader = (response.body as any).getReader();
            // Written as it arrives: a stream that is buffered until it ends is
            // not a stream, and the point of this endpoint is the frames.
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                out.write(Buffer.from(value));
            }
            out.end();
        } catch (err: any) {
            console.error("MCP stream request failed", err);
            try {
                finish(500, { ...corsHeaders, "content-type": "application/json" }, JSON.stringify({ error: "internal" }));
            } catch (writeErr) {
                console.error("Cannot report the failure to the client", writeErr);
            }
        }
    }

    /** What Lambda expects: the streaming entry, or the plain function under a test. */
    const aws = (globalThis as any).awslambda;
    const lambda = aws && aws.streamifyResponse ? aws.streamifyResponse(stream) : stream;
    return { serve, stream, lambda };
}
