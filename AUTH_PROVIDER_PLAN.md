# Modular Authentication Provider Implementation Plan

Add AWS Amplify Auth with Amazon Cognito as a selectable authentication provider across `graph-editor` and `graph-server`. Preserve Auth0 as the default provider for existing deployments. Select the provider during the build so each artifact includes its selected implementation and shared authentication code.

Status: implementation and initial Cognito deployment complete; CI workflow implemented, with account/GitHub activation prerequisites documented. Created October 5, 2026; updated October 7, 2026.

Latest authorization: the user requested deploying directly from this workstation into account `230639770018`, without GitHub access. This superseded the earlier CI-only restriction for the initial rollout. After the user refreshed the profile, the account identity was verified and both stacks were deployed successfully. Keep the committed CI/CD process for future releases.

## Current implementation and resume point

- Server adapters, selected build alias, discovery, authorizer, and MCP streaming verification are implemented. Auth0 remains the default and preserves its subject mapping. Cognito validates access tokens and namespaces subjects by issuer.
- The editor now has an Amplify workspace plugin, build-selected provider installation, shared session lifecycle and authenticated transports. HTTP requests use current credentials; WebSocket refresh/reconnect and logout prevent stale credentials or queued work crossing sessions.
- The follow-up lifecycle audit reproduced seven failures: late initialization after logout/disposal in both providers, lost Auth0 login/consent recovery, and callback secrets left in the URL after failure. The fixes passed all seven regression cases, the full integration suite, type checking, and both production provider builds. Initialization now carries the same cancellation generation as token refresh.
- Expiry is enforced on server requests, subscription streams, and outbound WebSocket broadcasts. REST authorizer caching is disabled. Scope mappings are validated against shared application authorities.
- Both production provider variants have passed bundle-isolation checks in both repositories. Server type checking passes. The existing server suite passed 501 tests with 21 skipped before the final focused expiry checks; the broad Jest process retains open handles, so CI uses explicit force-exit after completed tests. Focused authentication/subscription tests passed 56 tests and authentication/broadcast tests passed 37 tests. Editor CRDT/unit tests passed 125 tests. The latest editor integration suite passed 84 tests across 7 files, and its type-check ratchet reported zero errors. Both editor production variants were rebuilt with deployed endpoint fixtures and passed isolation checks. Five offline CI configuration tests, actionlint, and cfn-lint 1.57.1 passed. These checks do not substitute for a successful cloud release or live sign-in.
- The committed GitHub Actions release pipeline builds layers, provisions the optional authentication/hosting stack, packages the selected server, passes outputs into the editor build, publishes artifacts, and smoke-tests the deployment. The initial direct rollout is the explicit exception described above.
- The authorized Cognito test target is AWS account `230639770018` (local SSO profile `230639770018_cr-AdminAccess`) in the existing project default region `us-west-1`. The new authentication/hosting stack is `pio-auth-test-230639770018-auth`; the server stack is `pio-auth-test-230639770018` with stage `test`.
- The editor is live at <https://d2fqgid0yzbc85.cloudfront.net/graph-editor/>. The authentication stack reports `CREATE_COMPLETE`; the server reports `UPDATE_COMPLETE`. Deployed server source is `d2aefc54ab2a5f224c2d8e5d71d1f14eeea1ac40`; editor source is `c82d0b134ec909bcb0a48d160f153ed9f5ba7f6e`.
- The October 7 editor update hides the connection gear when build configuration pairs the editor with its server; unpaired GitHub Pages builds retain it. A **Connect MCP** dialog derives the correct stage-prefixed URL and supplies ChatGPT/Codex instructions and copy controls. It reads public discovery and explains separate external OAuth client registration. Native Cognito discovery lacks the advertised PKCE `S256` required by ChatGPT, so a compatible OAuth integration remains necessary; no external-client OAuth success is claimed.
- The editor update passed five focused URL/configuration tests, zero-error type checking, both provider builds and isolation checks, and browser checks for paired settings, retained Pages controls, clipboard actions, and desktop/mobile dialog layout. The published Cognito editor passed the complete sign-in, graph persistence, token refresh, MCP bearer-token, and logout flow again; release smoke checks passed.
- Live browser verification passed hosted sign-in/code+PKCE, normalized identity, authenticated REST and WebSockets, graph creation/edit/persistence/reload, forced token refresh and socket replacement, and hosted logout. A real MCP SDK client passed initialize, tools listing, graph summary, and server execution using the browser-issued access token. Missing/invalid credentials were rejected on REST, WebSocket, and streaming endpoints. The temporary user and graph were deleted; verification created no permanent users.
- The initial rollout exposed Serverless's cleanup of `.serverless` after `deploy --package`. CI now retains and deploys the package from the runner's temporary release directory (`d3d6c98`). The direct release recovered the exact archives from its deployment bucket and verified the server ZIP against Lambda's SHA-256. Updated workflow lint and all five CI configuration tests passed.
- Read-only CI access audit on October 6 confirmed that the target account already has the GitHub OIDC provider. Its only GitHub-trusting IAM role is limited to another repository; no role currently trusts `plastic-io/graph-server`. No CodePipeline pipelines were returned in `us-west-1`. Account bootstrap must add the graph deployment role while reusing the existing OIDC provider (`CreateProvider=false`).
- `infra/github-oidc-deploy-role.yaml` now trusts the exact GitHub environment used by the release job. The role must be managed by an account-bootstrap pipeline. The local SSO profile cannot authenticate a GitHub runner. The available GitHub CLI session is unauthenticated, so environment configuration and workflow dispatch have not been performed.
- Future CI releases require the bootstrap/deployment OIDC role, GitHub environment, and published matching source revisions. No GitHub access was used for the completed direct rollout. User onboarding and external-client OAuth registration remain account administration tasks. See [CI/CD deployment and rollback](AUTH_PROVIDER_DEPLOYMENT.md) for the live configuration, release steps, limitations, and identity migration.

The latest editor implementation is committed as `c82d0b134ec909bcb0a48d160f153ed9f5ba7f6e`; use it as CI `EDITOR_REF`. It has not been pushed. Both builds used the actual repositories. `/private/tmp/graph-auth-deploy` contains disposable rollout logs, recovered release artifacts, and the live verification results; its public release manifest is also published with the editor. The earlier server-only restart checkpoint was commit `0579ed8`; its type-check and frontend-work notes are superseded by this status.

## Scope and decisions

- Target Amplify Auth with Cognito user-pool access tokens. Direct IAM credentials and SigV4 request signing are a separate extension.
- Keep authentication providers separate from application authorization. Providers establish a trusted identity; the existing policy, delegation, and admission layers decide what that identity may do.
- Use `AUTH_PROVIDER=auth0|cognito` as the proposed common build selector. An omitted selector resolves to `auth0` for compatibility; an unknown value fails the build.
- Build and deploy matching frontend and server configurations. A deployment accepts its selected provider. Simultaneous acceptance of both issuers is outside the initial scope.
- Preserve local browser storage and the existing unauthenticated development server. A production configuration error must never silently enable unauthenticated access.
- Continue using Serverless Framework, API Gateway, Lambda, and the existing storage and graph services. Amplify is the browser authentication library; adopting it does not require replacing the backend deployment system.
- Complete the implementation and validation in both repositories. The user has authorized an initial direct test deployment into account `230639770018`, with subsequent releases through CI/CD; identity migration remains a separate operation.

## Original architecture (analysis baseline)

The editor is a Vue and Pinia application assembled from workspace packages. Its orchestrator installs UI and service modules. Yjs documents hold graph state; the CRDT provider synchronizes changes over the existing WebSocket connection and uses HTTP for state, large updates, and service calls.

The server exposes REST and WebSocket routes through API Gateway and Lambda. Services persist CRDT updates, projections, artifacts, revisions, and application records in S3. Graph execution, proposals, admission checks, and MCP use a common server-side principal.

| Boundary | Current behavior | Implementation consequence |
| --- | --- | --- |
| Editor startup | `../graph-editor/src/main.ts` imports Auth0 and installs it in a fixed module array. | Replace the concrete import with a build-selected module. |
| Editor contract | `packages/AuthenticationProvider/main.ts` defines token, user, login, logout, and redirect methods, plus the Pinia session store. | Extend this shared contract rather than introducing a competing store. |
| Auth0 module | `packages/Auth0AuthenticationProvider/main.ts` owns SDK setup, redirects, session publication, and provider UI. | Preserve it as an independently selectable implementation. |
| Preferences | `packages/LocalUserPreferences/main.ts` loads stored preferences and overlays remote `appConfig`. | Keep provider selection outside runtime preference overrides. |
| WebSocket transport | `packages/WssDocumentProvider/main.ts` imports `authRequiredFor` from Auth0 and sends JWTs through `Sec-WebSocket-Protocol`. | Move shared behavior out of Auth0; preserve the bearer transport. |
| HTTP transport | Several helpers read cached token strings independently. | Centralize obtaining current credentials before requests. |
| JWT verification | `src/auth/jwt.ts` binds issuer, audience, and JWKS discovery to Auth0 configuration. | Extract verification into provider adapters. |
| Claim mapping | `src/auth/principal.ts` contains Auth0-specific `gty`, `org_id`, and `permissions` handling. | Move those conventions into the Auth0 adapter. |
| Authorizer | `src/auth/authorizer.ts` returns an API Gateway policy and serialized principal context. | Keep the wrapper and delegate authentication to the selected adapter. |
| WebSocket identity | `src/broadcastService.ts` stores the principal at connection; `withPrincipal()` retrieves it for later messages. | Preserve trusted identity propagation and add explicit expiry handling. |
| MCP streaming | `src/mcp/stream.ts` verifies a bearer itself for its Lambda Function URL. | Route verification through the same selected adapter. |
| Discovery | `src/auth/metadata.ts` publishes Auth0-specific authorization-server and audience metadata. | Delegate provider-specific discovery information to the adapter. |

Editor package paths in this table are relative to `../graph-editor`; server paths are relative to this repository.

## Provider boundaries

### Editor module

Keep the existing `AuthenticationProvider` and Pinia store as the shared integration points. Retain `login`, `logoff`, `getUser`, `getToken`, and callback compatibility while introducing an explicit, awaitable initialization lifecycle. Initialization must be safe when invoked repeatedly by navigation guards.

Each implementation must register itself with the orchestrator, publish a normalized session, obtain current access tokens, handle redirects, and release provider listeners when disposed. Define authenticated, unauthenticated, initializing, and failed states so transports can distinguish a pending login from a completed logout.

Normalize the user shape to include `sub` and optional display attributes such as `name`, `email`, and `picture`. The orchestrator currently reads `identity.user.sub` when attributing local execution. Provider-native user objects must not silently break that behavior. Client identity remains display and local attribution data; the server independently establishes trusted identity.

Keep SDK objects internal to the concrete provider. Shared networking and UI code must not import Auth0 or Amplify. Each provider registers its own settings panel through the existing plugin system; shared login controls invoke the shared store actions.

### Server adapter

Introduce a small server contract, with final type names chosen during implementation:

```ts
interface VerifiedIdentity {
  principal: Principal;
  expiresAt: number; // Unix seconds, derived from the verified token
}

interface AuthenticationAdapter {
  verifyAccessToken(token: string): Promise<VerifiedIdentity>;
  discovery(): ProviderDiscovery;
}
```

`ProviderDiscovery` describes the selected provider's authorization server, advertised scopes, and any provider-specific audience information. The shared metadata handler retains responsibility for this deployment's resource URL and response format. Do not equate an OAuth resource URL, an Auth0 audience, and a Cognito app-client ID.

The adapter must verify a token before mapping claims. Keep `Principal`, authorizer-context serialization, connection lookup, and application policy provider-neutral. Inject adapters or verification dependencies in tests so they do not require live identity services.

Both the API Gateway authorizer and MCP Function URL must use this contract. Other services continue consuming `event.principal` without learning which provider issued the token.

## Build and deployment configuration

Use a stable editor import such as `@graph/auth-provider`, resolved by Vite to the selected module. Use a corresponding webpack alias for the server adapter. Match resolution in TypeScript and the test runners; avoid an alias that works in bundles but fails type checking or tests.

Resolve the provider before bundling. Do not import both providers and choose between them at runtime. Confirm the resulting module graphs contain no unselected provider implementation or SDK. Place SDK dependencies with the provider packages where the workspace packaging model permits; distinguish dependencies installed in a development workspace from code shipped in an artifact.

Illustrative configuration, to be implemented:

```sh
# Backward-compatible selection
AUTH_PROVIDER=auth0

# AWS selection
AUTH_PROVIDER=cognito
```

| Provider | Browser configuration | Server configuration |
| --- | --- | --- |
| Auth0 | Existing domain, client ID, audience, and callback settings | Existing `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, and supported MCP settings |
| Cognito | User-pool ID, app-client ID, login domain, allowed scopes, sign-in and sign-out redirect URLs | User-pool issuer and JWKS configuration, allowed app-client IDs, accepted API scopes, optional resource audience, and trusted identity mapping |

Use a public browser app client without a client secret. Any machine-client secret belongs in server-side secret management, never the frontend build or preferences. Cognito's login domain and token issuer are distinct configuration concepts.

Validate the selected configuration during production build or packaging. Validate it again when initializing the provider. Preserve the existing Auth0 defaults and preference shape during extraction. Provider choice cannot be overridden by local storage or remotely fetched `appConfig`; define and test precedence for permitted settings within the selected provider.

Record the provider name with deployment artifacts so mismatched frontend and backend builds can be diagnosed. The local development-server build must continue working without production identity configuration.

## Implementation phases

### Phase 1 Extract Auth0 without changing its behavior

1. Add the shared server adapter contract and extract Auth0 verification, configuration, and claim mapping into its implementation.
2. Route the authorizer and MCP streaming verification through that adapter.
3. Extract provider-specific discovery from `src/auth/metadata.ts`, preserving existing Auth0 audience and resource behavior.
4. Move `authRequiredFor` out of the Auth0 editor package. Preserve its existing behavior initially and make shared transport authentication requirements explicit.
5. Remove Auth0 fields from the shared `ProviderSettings.vue`; retain them in the Auth0 plugin's settings panel.
6. Preserve Auth0 redirect, refresh, session-store, and plugin-registration behavior through the extraction.

Completion requires the existing Auth0 authentication and discovery tests to pass, plus regression coverage for the adapter wiring in both server entry points. Keep lifecycle changes separate from the initial extraction so regressions are attributable.

### Phase 2 Add build selection

1. Add `AUTH_PROVIDER` resolution to Vite, webpack, and deployment configuration.
2. Replace direct application imports with the selected-provider aliases.
3. Align type checking, unit tests, integration tests, and the local server build with the selection mechanism.
4. Validate unknown providers and missing selected-provider configuration with actionable errors.
5. Inspect build outputs to prove the unselected provider is excluded.

Completion requires a working default Auth0 build and a tested mechanism for substituting the Cognito module as it is added. No shared package may import a concrete provider.

### Phase 3 Add the Cognito implementations

1. Add an `AmplifyAuthenticationProvider` editor workspace package using the current modular Amplify Auth APIs.
2. Configure the SDK for an existing user pool and browser app client. Support the managed-login authorization-code flow with PKCE and the editor callback route.
3. Implement session restoration, login, callback completion, sign-out, user normalization, and access-token retrieval through `fetchAuthSession()`.
4. Register Cognito-specific settings and use shared login/logout actions.
5. Add the Cognito server adapter using the existing JWT library where practical, or a Cognito-specific verifier if it simplifies correctly enforcing the contract.
6. Supply provider-aware discovery for REST and MCP streaming endpoints.
7. Document required Cognito resources, callback URLs, app-client settings, API scopes, and optional resource binding. Reuse existing resources by default; define optional provisioning separately from the provider's runtime implementation.

The Cognito verifier must validate the signature, algorithm, exact user-pool issuer, expiration, `token_use=access`, and allowed `client_id`. Enforce configured API scopes and any required resource audience. Reject ID tokens. Cognito access tokens do not always have an `aud` claim, so do not reuse Auth0 audience validation unchanged. See [AWS token verification](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html).

Map provider scopes explicitly to the application's authority names. Unknown scopes confer no additional application authority. Identify machine clients using trusted configuration and verified claims; do not infer human status from the absence of Auth0's `gty`. Reject unsupported machine identities rather than granting them human privileges.

### Phase 4 Unify session and transport behavior

1. Make shared authenticated HTTP helpers obtain a current token from the provider before sending a protected request. Cover CRDT state/history/update calls, artifacts, publishing, and other existing HTTP helpers.
2. Decide whether credentials belong on a URL using parsed origin equality and path boundaries. A matching string prefix is insufficient.
3. Clear authentication state and close authenticated sockets on logout or loss of session. Prevent reconnect with a stale cached token and prevent queued work from silently crossing into another user's session.
4. Persist verified token expiry with the WebSocket connection. Refuse later messages after expiry and have the client refresh and reconnect. Ensure the connection cache cannot extend validity past that expiry.
5. Account for API Gateway's current 300-second authorizer cache. Either disable caching or enforce verified expiry downstream on every authenticated request so a cached authorization decision cannot extend token validity.
6. Define stream lifetime against token expiry for MCP, requiring reconnection with a current token when needed. Document that local JWT verification alone does not provide immediate provider-side revocation detection.
7. Keep local storage and unauthenticated development behavior explicit and covered by tests.

Completion requires expired sessions to fail closed consistently and both providers to pass the same lifecycle tests. Do not add automatic retries of mutations unless existing idempotency guarantees make them safe.

### Phase 5 Validate and prepare rollout

1. Run the provider and transport matrix below for Auth0 and Cognito builds.
2. Verify existing graph behavior through focused read, edit, persistence, reconnect, and execution checks.
3. Build-check each provider variant in CI; package the selected release on the CI runner and inspect its provider manifest and infrastructure configuration.
4. Validate browser sign-in and protected calls against a configured Cognito test deployment when deployment access is available.
5. Exercise supported external MCP clients separately from the editor. Record any client-registration, discovery, scope, or resource-binding requirements.
6. Document deployment inputs, rollback, and identity-migration choices before switching an existing instance.

## Authorization and identity compatibility

The current `src/policy/decide.ts` grants authenticated humans instance-owner authority unless `OWNER_SUBS` restricts them. Agent authority is narrowed by scopes and delegation. Preserve this policy deliberately; Cognito groups and IAM roles must not silently become application permissions.

The `tenant` field is identity metadata, not proof of tenant isolation. This provider change does not introduce tenant-partitioned storage or a new role system.

Preserve existing Auth0 subject values. For Cognito, define a stable subject mapping that distinguishes issuers and is applied consistently on the server and in the editor's normalized session. Do not use email as an automatic identity-linking key.

An existing instance moving providers must account for `OWNER_SUBS`, agent delegations, per-user policy, and stored attribution. Choose either an explicit identity mapping or a documented transition to new subjects before rollout. Preserve historical audit records; do not rewrite them merely to make a new login look like an old identity. Switching providers also requires retiring old connections and allowing authorization caches to expire or invalidating them.

## Validation matrix

| Area | Required checks |
| --- | --- |
| Auth0 compatibility | Existing issuer/audience rules, claim mapping, redirects, preference settings, metadata, and default builds continue to work. |
| Cognito verification | Valid access token; rejected wrong issuer/pool/client, expired or missing required expiry, bad signature, ID token, missing required scope, and incorrect required resource audience. |
| Identity mapping | Stable subjects, optional profile fields, trusted tenant mapping, machine classification, scope mapping, and no accidental human-owner grants to machine clients. |
| HTTP | Current token retrieval on protected paths, no credential leakage to other origins or sibling path prefixes, and consistent failure on expired or absent sessions. |
| WebSocket | Authenticated handshake, principal storage, subsequent message attribution, reconnect refresh, expiry enforcement, logout, and rejection of unknown connections. |
| MCP | REST authorizer and Function URL use the selected adapter; metadata and challenges agree with provider configuration; stream expiry and external-client OAuth are exercised. |
| Application policy | Owner restrictions, delegation narrowing, admission decisions, and server-owned fields behave consistently for equivalent principals from either provider. |
| Build isolation | Both production variants build; default selects Auth0; invalid selections fail; artifacts exclude the unselected provider; type checking and test resolution match bundling. |
| Development | Local browser storage and the unauthenticated local server remain usable without production credentials. |
| Identity transition | Old and new subject handling is explicit; owner and delegation records remain understandable; rollback does not assume identities are interchangeable. |

Use generated signing keys and mocked SDK boundaries for deterministic tests. Keep live Cognito and MCP interoperability checks separate from unit tests. Existing analysis baseline: `npm test -- --runInBand --watchman=false src/__tests__/auth.js` passed all 22 tests on October 5, 2026. This baseline does not validate the new provider.

## Direct IAM extension

If direct IAM authentication is subsequently required, extend the shared transport contract to prepare signed HTTP requests and authenticated WebSocket connection parameters. Add API Gateway IAM configuration and map verified AWS identity into `Principal`. Lambda Function URL and MCP authentication must also be addressed explicitly.

IAM WebSocket authorization requires SigV4, so it cannot be implemented by returning an AWS credential string from `getToken()`. See [AWS IAM WebSocket authorization](https://docs.aws.amazon.com/en_en/apigateway/latest/developerguide/apigateway-websocket-control-access-iam.html). Keep this extension separate from the initial Cognito bearer-token provider.

## Completion criteria

- Auth0 users can continue building and using the application with the existing provider configuration.
- Cognito users can select the new provider at build time and complete login, graph operations, reconnect, refresh, and logout.
- Shared graph and networking code contains no imports of concrete authentication providers.
- Both server authentication entry points and OAuth discovery use the selected adapter.
- Only the selected provider implementation is bundled in each artifact.
- Existing authorization semantics are preserved and machine identities cannot inherit human privileges accidentally.
- Automated validation passes, live interoperability results are recorded when available, and any remaining deployment prerequisites are explicit.
- Setup, identity transition, and rollback instructions are sufficient to operate either deployment without changing application source code.

## SDK references

Amplify supports configuring existing Cognito resources through its client library; see [Amplify Auth setup](https://docs.amplify.aws/gen1/javascript/build-a-backend/auth/set-up-auth/). Its session API exposes access tokens and refreshes an expired session when a valid refresh token is available; see [Amplify session management](https://docs.amplify.aws/javascript/frontend/auth/manage-user-sessions/). Pin compatible dependency versions during implementation and verify the APIs against those installed versions.
