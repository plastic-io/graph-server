import { PlaywrightRenderer } from "./view/playwright";

/**
 * The browser, in a function of its own (PB-149).
 *
 * Its own entry point, not a route on the server: Chromium is a 67MB layer and
 * a second of cold start, and putting it on the function that answers every
 * protocol call would make every call pay for it.  This one is invoked when a
 * picture is wanted and is otherwise asleep.
 *
 * The request arrives already checked — the URL was approved by the capture
 * service against what this deployment serves — so there is nothing to decide
 * here beyond taking the picture and handing it back.  The headers carry the
 * caller's own bearer; they are not logged, here or anywhere.
 */
export async function handler(event: any): Promise<any> {
    const request = {
        url: String((event && event.url) || ""),
        viewport: (event && event.viewport) || { width: 1280, height: 800 },
        fullPage: !!(event && event.fullPage),
        headers: (event && event.headers) || {},
        waitFor: event && event.waitFor,
        timeoutMs: Math.min(60000, Math.max(1000, Number(event && event.timeoutMs) || 20000)),
    };
    if (!/^https?:\/\//.test(request.url)) {
        return { error: "a picture needs an http or https url" };
    }
    try {
        const shot = await new PlaywrightRenderer().shoot(request);
        return {
            image: shot.image.toString("base64"),
            format: shot.format || "png",
            title: shot.title,
            status: shot.status,
            console: shot.console,
        };
    } catch (err: any) {
        return { error: (err && err.message) || String(err) };
    }
}
