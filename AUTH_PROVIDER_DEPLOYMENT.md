# Authentication providers in CI/CD

Use GitHub Actions **Deploy configured environment** (`.github/workflows/deploy.yml`). All stack provisioning, Lambda layer builds, Serverless packaging, AWS deployment, and editor publishing run on the runner. There is no workstation stack-preparation step. Pull requests run source tests, provider bundle checks, and CloudFormation linting without AWS credentials.

Auth0 remains the default. `AUTH_PROVIDER=cognito` selects the Cognito verifier and Amplify editor plugin. Both variants are tested before releasing either one. A release uses the selected server revision and a full, immutable `graph-editor` commit SHA.

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
| `CreateProvider` | `false` if the account already has the GitHub OIDC provider; otherwise `true` |

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
| `EDITOR_REF` | `2d44dfc31a2dd13324fccc3df5a308935c5e54f4` (publish this editor commit before dispatch) |
| `OWNER_SUBS` | Optional comma-separated normalized subjects; see policy below |

The workflow's **Run workflow** form selects the environment and optionally overrides `EDITOR_REF` with a full commit SHA. A `v*` tag continues to target the `dev` environment. `dev` also needs `AWS_ACCOUNT_ID`, `AWS_DEPLOY_ROLE_ARN`, and a pinned `EDITOR_REF`; these inputs now fail closed when missing. Environment-based jobs need an environment-based OIDC subject, as documented by [GitHub](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).

For an Auth0 release, set `AUTH_PROVIDER=auth0` (or omit it). Existing server-only releases retain their service/stage defaults. Set `AUTH0_DOMAIN` and `AUTH0_AUDIENCE` as needed. `DEPLOY_EDITOR=true` additionally provisions editor hosting and requires `AUTH0_CLIENT_ID`. Register the resulting editor origin and `/graph-editor/auth-callback` URL in the existing Auth0 application through its configuration-management process. Omit `DEPLOY_EDITOR` to keep publishing the Auth0 editor through its existing Pages workflow.

## Release sequence

1. Validate the environment, target account, role ARN, and pinned editor SHA.
2. Install from lockfiles; run server/editor tests and type checks; build both providers and check that bundles exclude the unselected provider.
3. Lint infrastructure definitions and build Lambda layers on the runner, including the native layer inside the Lambda Node 22 image.
4. Assume the environment's OIDC role and independently confirm the AWS account before writes.
5. For Cognito or managed Auth0 editor hosting, deploy `infra/auth-environment.yaml`. The Cognito branch creates the user pool, public browser client, resource server, and login domain. Both branches create private S3 hosting behind CloudFront.
6. Feed stack outputs into the selected server configuration. Package once, inspect the actual archive's provider manifest, and deploy that package.
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

The editor applies deployment endpoints after stored preferences and remote registry configuration. Endpoint fields are read-only for a configured deployment. With no build endpoint overrides, the existing preferences and local-storage behavior remain available. Provider selection and Cognito SDK configuration always come from the build.

## Policy, sessions, and identity transitions

This change preserves application authorization. Authenticated humans retain the existing instance-owner policy unless `OWNER_SUBS` restricts them. Cognito groups and IAM roles grant no implicit graph authorities. The administrator-only test pool avoids allowing arbitrary self-registered users into that policy.

Auth0 subjects remain unchanged. Cognito subjects are `cognito:${encodeURIComponent(issuer)}:${sub}` on both client and server. Pool replacement changes identity. When migrating, explicitly review owner restrictions, agent delegations, per-user records, and attribution. Do not automatically link by email or rewrite historical audit records.

REST authorizer caching is disabled. WebSocket connections record verified expiry and selected provider; expired connections cannot submit requests or receive broadcasts. The editor refreshes tokens and reconnects before expiry, clears queued work on logout/session change, and obtains current credentials for HTTP calls. MCP streams close at token expiry. Local signature validation does not provide immediate provider-side revocation detection.

For external MCP clients, register compatible app clients and callback URLs and configure their permitted scopes. The provisioned editor client has only the editor callback. This implementation does not provide dynamic client registration. An external client must support preconfigured client IDs and Cognito's discovery/token flow; clients requiring additional resource binding need a matching `COGNITO_RESOURCE_AUDIENCE` and token request. Live interoperability must be verified separately for each supported client.

## Rollback and validation status

Use the Actions workflow at a previous known-good server revision and pin its matching editor SHA, keeping the same environment, provider, and identity resources. The release artifact contains the exact deployed server/editor files and a hash manifest for recovery. Keep previous hashed editor assets when publishing so existing tabs can finish loading. Do not delete/recreate the Cognito pool to roll back application code.

Server and editor deployments are sequential, not an atomic cross-service transaction. If publishing or smoke tests fail after the backend deploys, the workflow fails visibly; rerun the release or deploy the known-good matching revisions. Identity changes require their own migration, and old provider tokens/connections cannot be assumed compatible.

Deterministic verification covers provider validation, signature/claim rejection, lifecycle and transport boundaries, expiry, build isolation, configuration validation, and preference precedence. The workflow's deployed smoke tests do not establish successful browser login, graph editing, refresh/logout, or external MCP interoperability. Those live checks remain pending until the CI role and environment are connected and a workflow run succeeds. No AWS stack was created or deployed from this workstation during this change.
