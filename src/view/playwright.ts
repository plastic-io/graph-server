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

/** Why the browser could not be loaded, when it could not be. */
let loadError = "";

/**
 * Load a module by name at the moment it is needed, without the bundler
 * following it.
 *
 * Two things make this necessary.  The packages live in a layer, so they are
 * not there to be bundled; and `@sparticuz/chromium` is an ES module, so
 * `require` of it fails outright — "require() of ES Module ... not supported",
 * which is what this said for its first deployment.  `import()` reads both
 * kinds, and building it through `Function` keeps webpack from rewriting it
 * into a chunk that does not exist.
 */
const importAtRuntime = new Function("specifier", "return import(specifier);") as (specifier: string) => Promise<any>;

/** What the layer provides, loaded lazily so a server without it still runs. */
async function browserPieces(): Promise<{ chromium: any; playwright: any } | null> {
    try {
        const chromiumModule = await importAtRuntime("@sparticuz/chromium");
        const playwrightModule = await importAtRuntime("playwright-core");
        const chromium = chromiumModule.default || chromiumModule;
        const playwright = playwrightModule.chromium ? playwrightModule : (playwrightModule.default || playwrightModule);
        return { chromium, playwright };
    } catch (err: any) {
        // Saying only "there is no browser" turns every cause — a layer that is
        // not attached, a module that will not load, a missing library — into
        // the same sentence, and none of them is actionable.
        loadError = (err && err.message) || String(err);
        return null;
    }
}

export async function browserAvailable(): Promise<boolean> {
    return !!(await browserPieces());
}

export class PlaywrightRenderer implements Renderer {
    async shoot(request: ShotRequest): Promise<ShotResult> {
        const pieces = await browserPieces();
        if (!pieces) {
            throw new Error(`this server has no browser: ${loadError || "the chromium layer is not on this function"}`);
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
