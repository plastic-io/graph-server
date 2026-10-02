/**
 * Jest's sandboxed node environment does not expose the web globals that lib0
 * (and therefore Yjs) expects, so they are bridged in from Node's own modules.
 */
const { webcrypto } = require("crypto");
const { TextEncoder, TextDecoder } = require("util");

if (!global.crypto) {
  global.crypto = webcrypto;
}
if (!global.TextEncoder) {
  global.TextEncoder = TextEncoder;
}
if (!global.TextDecoder) {
  global.TextDecoder = TextDecoder;
}

/**
 * jest 26's node environment predates `atob`/`btoa` as globals, and the MCP
 * SDK validates every base64 payload by trying `atob` on it — so without these
 * an image coming back from a tool is rejected as "Invalid Base64 string",
 * which says nothing about the image and everything about the environment.
 * The Lambda runtime (Node 22) has had both for years.
 */
if (typeof globalThis.atob !== "function") {
    globalThis.atob = (value) => Buffer.from(String(value), "base64").toString("binary");
}
if (typeof globalThis.btoa !== "function") {
    globalThis.btoa = (value) => Buffer.from(String(value), "binary").toString("base64");
}
