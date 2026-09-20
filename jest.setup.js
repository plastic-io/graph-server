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
