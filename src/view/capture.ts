import { ulid } from "ulid";
import { Principal } from "../auth/principal";
import { decide } from "../policy/decide";

/**
 * Seeing what was built (PB-149).
 *
 * An agent can change a graph, be told the change was accepted, and have no
 * idea whether the page it describes draws anything at all.  That gap cost
 * somebody most of an afternoon: the proposals were valid, the property names
 * were right in the end, and the site was blank — and nothing in the protocol
 * could tell those two states apart.
 *
 * So: a picture, taken by a browser the server starts for itself and points at
 * the page.  Not by whatever browser somebody happens to have open: that was
 * the first design, and it makes the answer depend on who is watching, which
 * is the opposite of what a check is for.
 *
 * Two things this deliberately will not do:
 *
 *   - photograph anything but this instance.  The URL is built from the graph,
 *     or checked against the origins this deployment serves, because a server
 *     that will photograph any URL you name is a server that will read the
 *     inside of its own network for you.
 *   - carry a credential of its own.  The page is fetched with the caller's
 *     own token, so what comes back is what that caller is allowed to see, and
 *     there is no stored secret to end up in an image.
 */

export interface Viewport {
    width: number;
    height: number;
}

export interface ShotRequest {
    url: string;
    viewport: Viewport;
    fullPage: boolean;
    /** Sent with every request the page makes, so it renders as the caller. */
    headers: Record<string, string>;
    /** A selector to wait for, for a page that draws after it has loaded. */
    waitFor?: string;
    timeoutMs: number;
}

export interface ShotResult {
    image: Buffer;
    format?: "png" | "jpeg";
    title?: string;
    status?: number;
    /** What the page complained about on the way up, which is usually the answer. */
    console?: { level: string; text: string }[];
}

/** Something that can photograph a page: a browser here, or one somewhere else. */
export interface Renderer {
    shoot(request: ShotRequest): Promise<ShotResult>;
}

interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
}

export interface CaptureDeps {
    projection: (graphId: string) => Promise<any | null>;
    /** Where this deployment answers. */
    baseUrl: () => string;
    /** Origins a picture may be taken of, beyond this deployment's own. */
    origins?: () => string[];
    renderer?: Renderer;
    now?: () => Date;
}

export const MAX_VIEWPORT: Viewport = { width: 2560, height: 2000 };
export const MIN_VIEWPORT: Viewport = { width: 320, height: 240 };
export const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800 };
/** Big enough for a page, small enough to put in an answer. */
export const MAX_BYTES = 4 * 1024 * 1024;

export interface Shot {
    key: string;
    url: string;
    viewport: Viewport;
    fullPage: boolean;
    format: "png" | "jpeg";
    bytes: number;
    takenAt: string;
    by: { sub: string; kind: string } | null;
    title?: string;
    status?: number;
    console?: { level: string; text: string }[];
}

export class CaptureService {
    constructor(private store: Store, private deps: CaptureDeps) {}

    static key(graphId: string, id: string, format: string) {
        return `screenshots/${graphId}/${id}.${format}`;
    }

    private now(): Date {
        return this.deps.now ? this.deps.now() : new Date();
    }

    private allowed(): string[] {
        const own = String(this.deps.baseUrl() || "");
        const extra = this.deps.origins ? this.deps.origins() : [];
        return [own, ...extra].map((o) => String(o || "").trim()).filter(Boolean);
    }

    /**
     * Where to point the browser.  A graph and a node name one; a URL given
     * outright has to be somewhere this deployment serves.
     */
    address(graph: any, options: { url?: string; nodeUrl?: string }): { url: string } | { error: string; code: string } {
        if (options.url) {
            try {
                const parsed = new URL(options.url);
                if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                    return { error: "a picture can be taken of http and https pages only", code: "REFUSED" };
                }
            } catch (err) {
                return { error: `${options.url} is not a URL`, code: "SCHEMA_INVALID" };
            }
            const allowed = this.allowed();
            if (!allowed.some((origin) => options.url!.startsWith(origin))) {
                return { error: `this server photographs what it serves: ${allowed.join(", ") || "nothing is configured"}`, code: "REFUSED" };
            }
            return { url: options.url };
        }
        const base = String(this.deps.baseUrl() || "").replace(/\/+$/, "");
        if (!base) {
            return { error: "this server does not know its own address", code: "UNSUPPORTED" };
        }
        const graphUrl = (graph && graph.url) || (graph && graph.id);
        if (!graphUrl) {
            return { error: "the graph has no url to serve", code: "NOT_FOUND" };
        }
        if (!options.nodeUrl) {
            return { url: `${base}/${graphUrl}` };
        }
        const node = ((graph && graph.nodes) || []).find((n: any) => n.url === options.nodeUrl || n.id === options.nodeUrl);
        if (!node) {
            return { error: `no node ${options.nodeUrl} in this graph`, code: "NOT_FOUND" };
        }
        return { url: `${base}/${graphUrl}.${node.url || node.id}` };
    }

    private bounded(viewport?: Partial<Viewport>): Viewport {
        const within = (value: any, fallback: number, min: number, max: number) =>
            Math.min(max, Math.max(min, Math.round(Number(value) || fallback)));
        return {
            width: within(viewport && viewport.width, DEFAULT_VIEWPORT.width, MIN_VIEWPORT.width, MAX_VIEWPORT.width),
            height: within(viewport && viewport.height, DEFAULT_VIEWPORT.height, MIN_VIEWPORT.height, MAX_VIEWPORT.height),
        };
    }

    async screenshot(graphId: string, principal: Principal | undefined, options: {
        url?: string; nodeUrl?: string; viewport?: Partial<Viewport>; fullPage?: boolean;
        waitFor?: string; timeoutMs?: number; token?: string;
    } = {}): Promise<{ shot: Shot; image: Buffer } | { error: string; code: string; details?: any }> {
        const allowed = decide(principal, ["graph:read"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const graph = await this.deps.projection(graphId);
        if (!graph) {
            return { error: `no graph ${graphId}`, code: "NOT_FOUND" };
        }
        const where = this.address(graph, options);
        if ("error" in where) {
            return where;
        }
        const viewport = this.bounded(options.viewport);
        const fullPage = !!options.fullPage;
        if (!this.deps.renderer) {
            return { error: "this server has no browser to take a picture with", code: "UNSUPPORTED" };
        }
        let result: ShotResult | undefined;
        try {
            result = await this.deps.renderer.shoot({
                url: where.url,
                viewport,
                fullPage,
                waitFor: options.waitFor,
                timeoutMs: Math.min(60000, Math.max(1000, Number(options.timeoutMs) || 20000)),
                headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
            });
        } catch (err: any) {
            return { error: (err && err.message) || String(err), code: "CAPTURE_FAILED" };
        }
        if (!result || !result.image || !result.image.length) {
            return { error: "the browser gave back no picture", code: "CAPTURE_FAILED" };
        }
        if (result.image.length > MAX_BYTES) {
            return {
                error: `the picture is ${Math.round(result.image.length / 1024)}KB, more than the ${Math.round(MAX_BYTES / 1024)}KB an answer may carry; ask for a smaller viewport, or drop fullPage`,
                code: "TOO_LARGE",
            };
        }

        const format = result.format || "png";
        const key = CaptureService.key(graphId, ulid(), format);
        await new Promise<void>((resolve) => this.store.set(key, result!.image, { ContentType: format === "png" ? "image/png" : "image/jpeg" }, () => resolve()));
        const shot: Shot = {
            key, url: where.url, viewport, fullPage, format,
            bytes: result.image.length,
            takenAt: this.now().toISOString(),
            by: principal ? { sub: principal.sub, kind: principal.kind } : null,
            title: result.title,
            status: result.status,
            console: (result.console || []).slice(0, 50),
        };
        return { shot, image: result.image };
    }

}
