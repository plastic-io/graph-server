import assert from 'node:assert/strict';
import WebSocket from 'ws';
const {GRAPH_HTTP_SERVER, GRAPH_WSS_SERVER, MCP_STREAM_URL, AUTH_PROVIDER, COGNITO_ISSUER, EDITOR_URL} = process.env;
const request = (url, options = {}) => fetch(url, {...options, redirect:'error', signal:AbortSignal.timeout(30000)});
const metadata = await request(new URL('.well-known/oauth-protected-resource', GRAPH_HTTP_SERVER));
assert.equal(metadata.status, 200, 'Protected-resource metadata must be public');
const discovery = await metadata.json();
assert.equal(discovery.auth_provider, AUTH_PROVIDER);
if (AUTH_PROVIDER === 'cognito') assert.deepEqual(discovery.authorization_servers, [COGNITO_ISSUER]);
for (const token of ['', 'Bearer invalid-token']) {
  const result = await request(new URL('toc.json', GRAPH_HTTP_SERVER), {headers: token ? {Authorization:token} : {}});
  assert.ok([401,403].includes(result.status), 'REST must reject missing/invalid credentials');
  const stream = await request(MCP_STREAM_URL, {method:'POST', headers:{'Content-Type':'application/json', ...(token ? {Authorization:token} : {})}, body:'{}'});
  assert.ok([401,403].includes(stream.status), 'Function URL must reject missing/invalid credentials');
}
for (const protocols of [[], ['access_token', 'invalid-token']]) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(GRAPH_WSS_SERVER, protocols);
    let settled = false;
    const timer = setTimeout(() => finish(new Error('WebSocket handshake timed out')), 30000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      error ? reject(error) : resolve();
    }
    socket.on('open', () => finish(new Error('WebSocket accepted missing/invalid credentials')));
    socket.on('error', finish);
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      finish([401,403].includes(response.statusCode) ? undefined : new Error(`Unexpected WebSocket status ${response.statusCode}`));
    });
  });
}
if (EDITOR_URL) {
  const manifest = await request(new URL('auth-provider.json', EDITOR_URL));
  assert.equal(manifest.status, 200);
  assert.equal((await manifest.json()).provider, AUTH_PROVIDER);
}
console.log('Deployment discovery, provider selection, and unauthenticated rejection checks passed.');
