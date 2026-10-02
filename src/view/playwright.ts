import { Renderer, ShotRequest, ShotResult } from "./capture";

/**
 * The browser the server starts for itself (PB-149).
 *
 * Chromium does not fit in a zip next to the code, so it rides in a layer the
 * way isolated-vm does, and is loaded by name at the moment it is needed —
 * which also means a deployment without the layer is a server that simply has
 * no browser, rather than one that fails to start.
 *
 * It is pointed only at URLs the capture service has already approved.  The
 * caller's token rides in a header so the page renders as that caller; it is
 * never written down, and the one thing this module logs on failure is the
 * URL, never the headers.
 */

/** What the layer provides.  Required lazily so the rest of the server runs without it. */
function browserPieces(): { chromium: any; playwright: any } | null {
    try {
        /* eslint-disable @typescript-eslint/no-var-requires */
        const chromium = require("@sparticuz/chromium");
        const playwright = require("playwright-core");
        return { chromium: chromium.default || chromium, playwright };
    } catch (err) {
        return null;
    }
}

export function browserAvailable(): boolean {
    return !!browserPieces();
}

export class PlaywrightRenderer implements Renderer {
    async shoot(request: ShotRequest): Promise<ShotResult> {
        const pieces = browserPieces();
        if (!pieces) {
            throw new Error("this server has no browser: the chromium layer is not on this function");
        }
        const { chromium, playwright } = pieces;
        const executablePath = typeof chromium.executablePath === "function" ? await chromium.executablePath() : chromium.executablePath;
        const browser = await playwright.chromium.launch({
            args: chromium.args,
            executablePath,
            headless: true,
        });
        const messages: { level: string; text: string }[] = [];
        try {
            const context = await browser.newContext({
                viewport: request.viewport,
                extraHTTPHeaders: request.headers,
                deviceScaleFactor: 1,
            });
            const page = await context.newPage();
            // what the page says on its way up is usually the answer to "why is
            // it blank", so it is kept and handed back with the picture
            page.on("console", (message: any) => {
                messages.push({ level: String(message.type()), text: String(message.text()).slice(0, 500) });
            });
            page.on("pageerror", (error: any) => {
                messages.push({ level: "error", text: String((error && error.message) || error).slice(0, 500) });
            });
            const response = await page.goto(request.url, { waitUntil: "networkidle", timeout: request.timeoutMs });
            if (request.waitFor) {
                await page.waitForSelector(request.waitFor, { timeout: request.timeoutMs });
            }
            const title = await page.title().catch(() => undefined);
            const image = await page.screenshot({ type: "png", fullPage: request.fullPage });
            return {
                image: Buffer.from(image),
                format: "png",
                title,
                status: response ? response.status() : undefined,
                console: messages,
            };
        } catch (err: any) {
            // the URL is safe to say; the headers carry the caller's token and are not
            console.error("Cannot photograph a page.", request.url, (err && err.message) || err);
            throw err;
        } finally {
            await browser.close().catch(() => undefined);
        }
    }
}
