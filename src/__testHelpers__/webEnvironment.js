/**
 * jest 26's node environment builds its sandbox from a fixed list of globals
 * that predates the fetch API.  The MCP SDK's web-standard handler needs
 * Request/Response/Headers/streams, so this environment copies them (and the
 * other web globals Node 18+ provides) from the real global into the sandbox.
 */
const NodeEnvironment = require("jest-environment-node");
const NAMES = ["fetch", "Request", "Response", "Headers", "FormData", "Blob", "File",
    "ReadableStream", "WritableStream", "TransformStream", "TextEncoder", "TextDecoder", "TextEncoderStream", "TextDecoderStream",
    "AbortController", "AbortSignal", "URL", "URLSearchParams", "structuredClone", "crypto", "performance", "queueMicrotask", "setImmediate", "clearImmediate",
    "BroadcastChannel", "MessageChannel", "MessagePort", "EventTarget", "Event", "DOMException", "CompressionStream", "DecompressionStream"];
class WebEnvironment extends NodeEnvironment {
    constructor(config, context) {
        super(config, context);
        for (const name of NAMES) {
            if (this.global[name] === undefined && global[name] !== undefined) {
                this.global[name] = global[name];
            }
        }
    }
}
module.exports = WebEnvironment;
