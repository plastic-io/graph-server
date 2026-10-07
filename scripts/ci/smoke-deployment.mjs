import assert from 'node:assert/strict';
import WebSocket from 'ws';
const {GRAPH_HTTP_SERVER, GRAPH_WSS_SERVER, MCP_STREAM_URL, AUTH_PROVIDER, COGNITO_ISSUER, EDITOR_URL} = process.env;
const request = (url, options = {}) => fetch(url, {...options, redirect:'error', signal:AbortSignal.timeout(30000)});
const metadata = await request(new URL('.well-known/oauth-protected-resource', GRAPH_HTTP_SERVER));
assert.equal(metadata.status, 200, 'Protected-resource metadata must be public');
const discovery = await metadata.json();
assert.equal(discovery.auth_provider, AUTH_PROVIDER);
if (AUTH_PROVIDER === 'cognito') {
  if (discovery.client_registration === 'dynamic') {
    const issuer = discovery.authorization_servers[0];
    assert.ok(/^https:\/\//.test(issuer));
    const oauth = await (await request(issuer+'/.well-known/oauth-authorization-server')).json();
    assert.equal(oauth.issuer, issuer);
    assert.ok(oauth.code_challenge_methods_supported.includes('S256'));
    assert.ok(oauth.token_endpoint_auth_methods_supported.includes('none'));
    assert.equal(oauth.registration_endpoint, issuer+'/oauth/register');
    const invalid = await request(oauth.registration_endpoint, {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({redirect_uris:['https://untrusted.example/callback']})});
    assert.equal(invalid.status, 400, 'Registration must reject untrusted redirects');
    const registration = await request(oauth.registration_endpoint, {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({redirect_uris:['http://127.0.0.1:8765/callback/graph-server-smoke'],
        token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
    assert.equal(registration.status, 201, 'Automatic registration must work without a supplied client ID');
    const registered = await registration.json();
    assert.ok(registered.client_id);assert.equal(registered.client_secret, undefined);
    const unlinked = await request(new URL('toc.json', GRAPH_HTTP_SERVER), {headers:{Authorization:'Bearer '+registered.client_id}});
    assert.ok([401,403].includes(unlinked.status), 'Registering a client does not authenticate a user');
  } else assert.deepEqual(discovery.authorization_servers, [COGNITO_ISSUER]);
}
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
