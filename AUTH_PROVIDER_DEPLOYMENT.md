# Authentication providers in CI/CD

Use GitHub Actions **Deploy configured environment** (`.github/workflows/deploy.yml`). All stack provisioning, Lambda layer builds, Serverless packaging, AWS deployment, and editor publishing run on the runner. There is no workstation stack-preparation step. Pull requests run source tests, provider bundle checks, and CloudFormation linting without AWS credentials.

The user subsequently authorized a direct deployment from this workstation using profile `230639770018_cr-AdminAccess`, without granting GitHub access. This is an explicit exception for the initial test rollout; the committed CI workflow remains available for later automation. Verify the AWS account before writes and use the same templates and output-to-build configuration mapping. GitHub credentials and a GitHub deployment role are not prerequisites for this direct rollout.

Auth0 remains the default. `AUTH_PROVIDER=cognito` selects the Cognito verifier and Amplify editor plugin. Both variants are tested before releasing either one. A release uses the selected server revision and a full, immutable `graph-editor` commit SHA.

## Deployed Cognito test environment

The initial deployment completed October 6, 2026 (October 7 UTC), using the authorized SSO profile in account `230639770018`, region `us-west-1`. The authentication stack is `CREATE_COMPLETE`; the server stack is `UPDATE_COMPLETE`.

| Resource | Value |
| --- | --- |
| Editor | <https://d2fqgid0yzbc85.cloudfront.net/graph-editor/> |
| REST API | <https://9pzgloz773.execute-api.us-west-1.amazonaws.com/test/> |
| WebSocket API | `wss://hwx4k4af87.execute-api.us-west-1.amazonaws.com/test` |
| MCP HTTP endpoint | <https://9pzgloz773.execute-api.us-west-1.amazonaws.com/test/mcp> |
| MCP streaming endpoint | <https://njp2jgk6whco24g3dv62funlny0iigge.lambda-url.us-west-1.on.aws/> |
| Authentication/hosting stack | `pio-auth-test-230639770018-auth` |
| Server stack / stage | `pio-auth-test-230639770018` / `test` |
| Cognito user pool | `us-west-1_yrWcLvFQD` |
| Public browser client | `4oad1er5hee1a67f3u4uq764ib` |
| Login domain | `graphs-230639770018-441eb7b91246.auth.us-west-1.amazoncognito.com` |
| CloudFront distribution | `E3COPJU0703FA1` |
| Editor bucket | `pio-auth-test-230639770018-auth-editorbucket-frcka3yk1ov2` |

This deployment includes all three logical services: Cognito authentication, the graph server, and the graph editor. They are managed by two CloudFormation stacks. `pio-auth-test-230639770018` owns the graph server's Lambda functions, REST/WebSocket APIs, and graph data bucket. `pio-auth-test-230639770018-auth` owns both Cognito and the editor's S3/CloudFront hosting; its `-auth` suffix does not mean it contains only authentication resources.

Account ownership and live routing were independently verified:

- The graph update function is `arn:aws:lambda:us-west-1:230639770018:function:pio-auth-test-230639770018-test-crdtUpdate`, using an execution role in the same account and `S3_BUCKET=pio-auth-test-230639770018`.
- Editor hosting is `arn:aws:cloudfront::230639770018:distribution/E3COPJU0703FA1`. Both the graph data bucket and editor bucket passed S3's `ExpectedBucketOwner=230639770018` check.
- An authenticated browser with the old REST endpoint deliberately saved in its preferences still used REST API `9pzgloz773` and WebSocket API `hwx4k4af87`. Both its active settings and actual network requests matched the deployed server outputs; no request was made to the saved old graph endpoint. The audit's temporary Cognito user was deleted afterward.

Use the CloudFront editor URL above to open this environment. Deployment here does not change an editor hosted at another URL or a separately configured local development build.

The [public release manifest](https://d2fqgid0yzbc85.cloudfront.net/graph-editor/release.json) records the configuration and file hashes. Deployed server source is `d2aefc54ab2a5f224c2d8e5d71d1f14eeea1ac40`; editor source is `c82d0b134ec909bcb0a48d160f153ed9f5ba7f6e`. The October 7 editor update hides paired-server connection settings and adds MCP connection instructions. Its manifest preserves the unchanged backend's revision and artifact hashes. The server ZIP recovered from the deployment bucket matches the deployed Lambda's SHA-256. The later CI-only artifact-retention fix is commit `d3d6c98`.

Live checks passed:

- Provider discovery and rejection of missing/invalid tokens on REST, WebSocket handshakes, and the streaming Function URL.
- Cognito hosted sign-in with authorization code/PKCE, callback cleanup, and normalized Amplify session identity.
- Authenticated REST and browser WebSocket access; editor graph creation, editing, persistence, and reload.
- Forced Amplify token refresh, WebSocket replacement with the new token, and hosted logout back to an unauthenticated editor.
- MCP SDK initialization, tool discovery, `graph.summary`, and `graph.invoke` completing server execution with a browser-issued access token.
- After the October 7 editor publication, the complete browser flow above passed again, including logout. The paired deployment hides the connection gear; the MCP dialog copies the correct URL and Codex command. The unpaired Auth0/Pages build retains working connection controls. Both provider builds passed isolation checks, the editor type check reported zero errors, and all five focused URL/configuration tests passed.

The temporary verification user and graph were removed. Verification sends no invitations and creates no permanent login. Create intended users through the Cognito administration process. External MCP clients' own OAuth registration/login flows, machine clients, and resource binding were not exercised by the SDK bearer-token check.

The direct release used no GitHub access. The workflow below is implemented and linted, but its AWS role/environment still need to be connected and the source commits published before CI can run it.

## Account and GitHub setup

The requested test target is account **230639770018**, using **us-west-1** (the project's existing default region). The local profile `230639770018_cr-AdminAccess` identifies that account; it is not a credential a GitHub runner can use.

The account's bootstrap pipeline must manage `infra/github-oidc-deploy-role.yaml`. For the test environment, supply these template parameters:

| Parameter | Value |
| --- | --- |
| `GitHubOrg` | `plastic-io` |
| `GitHubRepo` | `graph-server` |
| `GitHubEnvironment` | `cognito-test` |
| `ServiceName` | `pio-auth-test-230639770018` |
| `Stage` | `test` |
| `LayerPrefix` | `pio-auth-test` |
| `CreateProvider` | `false` (the GitHub OIDC provider was verified present in account `230639770018`) |

Read-only IAM inspection on October 6 found an existing GitHub OIDC provider, but the only GitHub-trusting role is restricted to another repository. A role for `plastic-io/graph-server` still needs to be provisioned by the account bootstrap process.

The application workflow cannot establish its own initial AWS trust. An existing account-bootstrap pipeline or OIDC role is a prerequisite; do not substitute local SSO credentials or long-lived AWS keys in GitHub secrets. This template grants deployment permissions for the service's two CloudFormation stacks, buckets, Lambda functions/layers, and execution role, plus API Gateway, Cognito, and CloudFront operations. Some creation and discovery permissions require wildcard resources. It does not authorize administering the deployment role itself.

Create the GitHub environment `cognito-test`, restrict its deployment branches/tags, and set:

| GitHub environment variable | Value |
| --- | --- |
| `AWS_ACCOUNT_ID` | `230639770018` |
| `AWS_DEPLOY_ROLE_ARN` | The bootstrap stack's `RoleArn` output |
| `AWS_REGION` | `us-west-1` |
| `AUTH_PROVIDER` | `cognito` |
| `SERVICE_NAME` | `pio-auth-test-230639770018` |
| `STAGE` | `test` |
| `API_PREFIX` | `pio-auth-test` |
| `EDITOR_REF` | `c82d0b134ec909bcb0a48d160f153ed9f5ba7f6e` (publish this editor commit before dispatch) |
| `OWNER_SUBS` | Optional comma-separated normalized subjects; see policy below |

The workflow's **Run workflow** form selects the environment and optionally overrides `EDITOR_REF` with a full commit SHA. A `v*` tag continues to target the `dev` environment. `dev` also needs `AWS_ACCOUNT_ID`, `AWS_DEPLOY_ROLE_ARN`, and a pinned `EDITOR_REF`; these inputs now fail closed when missing. Environment-based jobs need an environment-based OIDC subject, as documented by [GitHub](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).

For an Auth0 release, set `AUTH_PROVIDER=auth0` (or omit it). Existing server-only releases retain their service/stage defaults. Set `AUTH0_DOMAIN` and `AUTH0_AUDIENCE` as needed. `DEPLOY_EDITOR=true` additionally provisions editor hosting and requires `AUTH0_CLIENT_ID`. Register the resulting editor origin and `/graph-editor/auth-callback` URL in the existing Auth0 application through its configuration-management process. Omit `DEPLOY_EDITOR` to keep publishing the Auth0 editor through its existing Pages workflow.

## Release sequence

1. Validate the environment, target account, role ARN, and pinned editor SHA.
2. Install from lockfiles; run server/editor tests and type checks; build both providers and check that bundles exclude the unselected provider.
3. Lint infrastructure definitions and build Lambda layers on the runner, including the native layer inside the Lambda Node 22 image.
4. Assume the environment's OIDC role and independently confirm the AWS account before writes.
5. For Cognito or managed Auth0 editor hosting, deploy `infra/auth-environment.yaml`. The Cognito branch creates the user pool, public browser client, resource server, and login domain. Both branches create private S3 hosting behind CloudFront.
6. Feed stack outputs into the selected server configuration. Package once, inspect the actual archive's provider manifest, and retain/deploy that package from `$RUNNER_TEMP/server-package`. Serverless deletes `.serverless` after `deploy --package`; the retained directory avoids losing the release inputs. `SERVER_PACKAGE_DIR` points the manifest generator to that directory.
7. Read REST, WebSocket, and streaming endpoints from the deployed stack, refresh API stage snapshots, and build the editor with those endpoints and matching authentication settings.
8. Archive the server package, editor build, source revisions, public configuration, and file hashes. Upload editor assets followed by the entry point and wait for CloudFront invalidation.
9. Smoke-test discovery, selected provider, and rejection of missing/invalid credentials on REST, WebSocket handshakes, and the streaming Function URL. Record URLs in the Actions run summary.

Runs are serialized per environment. The pipeline rejects changing an existing authentication stack's provider. Use a separate environment for an identity migration. The stack retains the user pool and versioned editor bucket if deleted; removing an environment's retained resources is a separate deliberate operation.

The Cognito login domain is derived deterministically from the service and account. It avoids AWS's reserved prefix-domain words. The browser uses authorization code with PKCE, without a client secret. Only the deployed HTTPS callback/logout URLs are registered. The test pool permits administrator-created users and does not enable public signup. User onboarding belongs in the account's identity-management process.

## Build configuration contract

The managed test pipeline derives these public Cognito values from CloudFormation. Deployments using existing Cognito infrastructure can supply the same contract from their own CI/CD outputs; the runtime plugins do not provision AWS resources.

| Consumer | Variables |
| --- | --- |
| Both builds | `AUTH_PROVIDER=auth0\|cognito` |
| Cognito server | `COGNITO_ISSUER`, `COGNITO_CLIENT_IDS`, `COGNITO_MACHINE_CLIENT_IDS`, `COGNITO_REQUIRED_SCOPES`, `COGNITO_SCOPE_MAP`, optional `COGNITO_RESOURCE_AUDIENCE` |
| Cognito editor | `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_LOGIN_DOMAIN`, `COGNITO_SCOPES`, `COGNITO_REDIRECT_SIGN_IN`, `COGNITO_REDIRECT_SIGN_OUT`, optional `COGNITO_RESOURCE_AUDIENCE` |
| Auth0 server | `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`; existing MCP audience/resource settings remain supported |
| Auth0 editor | `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_AUDIENCE`, `AUTH0_REDIRECT_URI` |
| Deployed editor | `GRAPH_HTTP_SERVER` and `GRAPH_WSS_SERVER`, supplied together |

The managed Cognito release requires `graphs/access` and maps `graphs/read` to `graph:read` and `graphs/propose` to `graph:propose`. It creates a browser client only. Machine clients must be separately registered, listed in `COGNITO_MACHINE_CLIENT_IDS`, and given explicit scope mappings and application delegations. Human and machine client allow-lists cannot overlap.

The editor applies deployment endpoints after stored preferences and remote registry configuration and forces authenticated server storage. When build endpoints are configured, the storage/connection gear is not registered, so users cannot switch the paired deployment to local storage or another server through that UI. GitHub Pages and local builds without endpoint overrides retain the connection controls. This behavior follows the build configuration rather than guessing from the hostname. Provider selection and Cognito SDK configuration always come from the build.

## Connecting ChatGPT or Codex

The editor's **Connect MCP** button appears in the graph manager and as a connection icon in the graph toolbar when server storage is active. It derives the MCP URL from the effective graph HTTP endpoint, preserving the API stage. For this environment, use `https://9pzgloz773.execute-api.us-west-1.amazonaws.com/test/mcp`, not the streaming Function URL. The dialog provides Copy URL, a link to ChatGPT Plugins, ChatGPT setup steps, and a copyable Codex CLI command. It does not copy the editor's access token or store client secrets.

The dialog reads public protected-resource metadata to show the provider, authorization server, scopes, and administrator setup requirements. A Cognito deployment requires a separately registered external OAuth client; the browser client above allows only the editor's callback. Register each client's exact callback and permitted scopes, and include its human client ID in the server's `COGNITO_CLIENT_IDS`. Use a public client for local Codex. Manage additional app clients and server allow-lists through deployment configuration; the current managed test template provisions only the browser client.

The native Cognito issuer's discovery document was inspected on October 7. It does not advertise `code_challenge_methods_supported` with `S256`, which [OpenAI's OAuth requirements](https://developers.openai.com/plugins/build/auth) require for ChatGPT. Its advertised token authentication methods also need to match the external client. A compatible OAuth adapter or other discovery integration is required before claiming ChatGPT interoperability. The UI documents this prerequisite; it does not provision that integration. Client-specific OAuth login remains unverified. Follow the current [ChatGPT MCP instructions](https://developers.openai.com/api/docs/guides/custom-mcp-server) and [Codex MCP instructions](https://learn.chatgpt.com/docs/extend/mcp) for registration and callbacks.

## Policy, sessions, and identity transitions

This change preserves application authorization. Authenticated humans retain the existing instance-owner policy unless `OWNER_SUBS` restricts them. Cognito groups and IAM roles grant no implicit graph authorities. The administrator-only test pool avoids allowing arbitrary self-registered users into that policy.

Auth0 subjects remain unchanged. Cognito subjects are `cognito:${encodeURIComponent(issuer)}:${sub}` on both client and server. Pool replacement changes identity. When migrating, explicitly review owner restrictions, agent delegations, per-user records, and attribution. Do not automatically link by email or rewrite historical audit records.

REST authorizer caching is disabled. WebSocket connections record verified expiry and selected provider; expired connections cannot submit requests or receive broadcasts. The editor refreshes tokens and reconnects before expiry, clears queued work on logout/session change, and obtains current credentials for HTTP calls. MCP streams close at token expiry. Local signature validation does not provide immediate provider-side revocation detection.

For external MCP clients, register compatible app clients and callback URLs and configure their permitted scopes. The provisioned editor client has only the editor callback. This implementation does not provide dynamic client registration. An external client must support preconfigured client IDs and Cognito's discovery/token flow; clients requiring additional resource binding need a matching `COGNITO_RESOURCE_AUDIENCE` and token request. Live interoperability must be verified separately for each supported client.

## Rollback and validation status

Use the Actions workflow at a previous known-good server revision and pin its matching editor SHA, keeping the same environment, provider, and identity resources. The release artifact contains the exact deployed server/editor files and a hash manifest for recovery. Keep previous hashed editor assets when publishing so existing tabs can finish loading. Do not delete/recreate the Cognito pool to roll back application code.

Server and editor deployments are sequential, not an atomic cross-service transaction. If publishing or smoke tests fail after the backend deploys, the workflow fails visibly; rerun the release or deploy the known-good matching revisions. Identity changes require their own migration, and old provider tokens/connections cannot be assumed compatible.

Deterministic verification covers provider validation, signature/claim rejection, lifecycle and transport boundaries, expiry, build isolation, configuration validation, and preference precedence. The workflow's smoke tests check discovery and credential rejection. Successful browser login, graph operations, refresh/logout, and MCP bearer-token interoperability were additionally verified during the initial direct rollout as recorded above; these browser checks are not yet part of the CI smoke script. CI activation and client-specific OAuth onboarding remain separate from the completed deployment.
