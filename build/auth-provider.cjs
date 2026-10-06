const path = require('path');
const authorities = require('../src/policy/authorities.json');

function providerName(env = process.env) {
  const name = env.AUTH_PROVIDER === undefined ? 'auth0' : env.AUTH_PROVIDER;
  if (!['auth0', 'cognito'].includes(name)) throw new Error('AUTH_PROVIDER must be auth0 or cognito');
  return name;
}

const list = (value) => String(value || '').split(/[\s,]+/).filter(Boolean);
function cognitoConfig(env = process.env) {
  const issuer = String(env.COGNITO_ISSUER || '');
  if (!/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9-]+_[A-Za-z0-9]+$/.test(issuer)) {
    throw new Error('COGNITO_ISSUER must be the exact Cognito user-pool issuer URL (without a trailing slash)');
  }
  const humanClientIds = list(env.COGNITO_CLIENT_IDS);
  const machineClientIds = list(env.COGNITO_MACHINE_CLIENT_IDS);
  if (!humanClientIds.length && !machineClientIds.length) throw new Error('Configure COGNITO_CLIENT_IDS or COGNITO_MACHINE_CLIENT_IDS');
  if (humanClientIds.some((id) => machineClientIds.includes(id))) throw new Error('Human and machine Cognito app clients must be distinct');
  const requiredScopes = list(env.COGNITO_REQUIRED_SCOPES);
  if (!requiredScopes.length) throw new Error('COGNITO_REQUIRED_SCOPES must identify this API');
  let scopeMap;
  try { scopeMap = JSON.parse(env.COGNITO_SCOPE_MAP || '{}'); }
  catch (_) { throw new Error('COGNITO_SCOPE_MAP must be a JSON object mapping OAuth scopes to application authorities'); }
  if (!scopeMap || Array.isArray(scopeMap) || typeof scopeMap !== 'object' || Object.values(scopeMap).some((s) => typeof s !== 'string')) {
    throw new Error('COGNITO_SCOPE_MAP must map scope strings to authority strings');
  }
  if (Object.values(scopeMap).some((s) => !authorities.includes(s))) throw new Error('COGNITO_SCOPE_MAP contains an unknown application authority');
  const audience = env.COGNITO_RESOURCE_AUDIENCE || undefined;
  if (audience && !/^https:\/\//.test(audience)) throw new Error('COGNITO_RESOURCE_AUDIENCE must be an HTTPS resource URL');
  return { issuer, humanClientIds, machineClientIds, requiredScopes, scopeMap, audience };
}

function validate(env = process.env) {
  const name = providerName(env);
  if (name === 'cognito') cognitoConfig(env);
  else if (!env.AUTH0_DOMAIN || !env.AUTH0_AUDIENCE) throw new Error('Authentication is not configured (AUTH0_DOMAIN / AUTH0_AUDIENCE)');
  return name;
}

module.exports = { providerName, cognitoConfig, validate,
  modulePath: (env = process.env) => path.resolve(__dirname, '../src/auth/providers', providerName(env) + '.ts') };
