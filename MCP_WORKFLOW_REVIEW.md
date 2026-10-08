# MCP application workflow — current platform review

Updated: 2026-10-07. This is the current review artifact for the Chess regression
work in **graph-server and its sibling graph-editor**. The user authorized
committing, pushing and deploying these platform changes on 2026-10-07. The
platform release completed on 2026-10-07 PDT (2026-10-08 UTC): server
`c1ee6cea101e297b88e0bc6a77bca488727e1806`, paired editor
`5e01d0a5bc6cb199326a32a25ac105f21185a2ec`. Both commits are pushed. This release
does not deploy Chess or approve application infrastructure. No live graph
proposals or application resources were changed by this release.

The intended CI target remains account **230639770018**, region **us-west-1**.
A separate application AWS account is deferred. Review and release these shared
platform changes separately from any application proposal. Application work
then stays within MCP and the graph's human review interface.

## What changed

| Request | Implementation | Evidence and remaining limits |
| --- | --- | --- |
| MCP-only boundary | Server instructions and the versioned workflow contract forbid CLI, direct authenticated HTTP, browser credential extraction, frontend editing, and direct Lambda invocation as application fallbacks. Missing reviewed deployment returns a capability error. | Protocol regression uses MCP for agent application operations. An MCP server cannot prevent an independent client from using credentials outside the protocol; the contract explicitly disallows that behavior. Recovery needs separate authorization. |
| Complete discovery | `server.discover`, versioned schema resources, full schemas for 13 semantic operations, property schemas, and rename/add/connect/presentation/stack examples. Invalid operations and fields include a schema URI and path. | Protocol tests discover and use these schemas without guessed operations. Extensible application properties remain supported; protected fields use dedicated operations. |
| Actual runtime | Helper signatures, capability objects, domains, containment support, limits, identity semantics, and actual deployed containment/bridge configuration are discoverable. Static validation rejects unknown free identifiers and unsupported helper calls before a proposal validates. | Native isolate test verifies `host.identity()` and `host.now()`. Dynamic JavaScript still requires runtime tests. A server graph node schedules graph code; it does not provision a Lambda. |
| Authenticated identity | Browser components receive `session.current()` and `application.request()`. Server nodes receive `host.identity()`. The bridge stamps the verified caller into the application Lambda context. | Registration example keys records from the verified caller; client identity fields are ignored. Two principals are simulated locally. Real user sign-in and multiplayer remain unverified for this change. |
| Existing bus | Existing WSS graph channel carries authoritative application updates returned by the bridge. Addressing, subscribers, provenance, reconnect behavior, recipients, ordering and delivery limits are documented. | Two simulated browser consumers receive a server update. Existing graph subscriptions survive another listener unsubscribing. Autonomous Lambda push and recipient-private application delivery remain unsupported. |
| Application/platform separation | Graph templates own application code, records, IAM roles and deployment lifecycle. Shared code supplies only discovery, validation, isolated deployment, authenticated invocation and bus integration. | No Chess rules, moves, game tables, or player-registration rules were added to the shared runtime. The registration example is graph-owned application code. |
| Unified deployment preflight | `iac.preflight` reports template types versus deployable types, exact target, namespace, boundary, roles, prerequisites, operation support, and permission-verification evidence. Review and template persistence reuse the isolation rules. | Unsupported resources are rejected before implementing the example. `deployable` is a configuration/template result, not proof of effective AWS permissions. Without a template it is `null`. |
| Stack isolation | Deterministic server-assigned namespace per graph/stack node; per-stack worker, CloudFormation execution role and runtime boundary; strict template checks and AWS deny policies. | Adversarial templates and local policy evaluation cover cross-stack/server/guardrail access. AWS-effective permission and lifecycle verification remains pending. |
| Review accuracy | Infrastructure additions, removals and fragment wiring changes require infrastructure review. Resource/IAM changes, prerequisites, retention and affected stacks are included. Semantic proposal digests are stable when revalidated without edits. | Regression covers compute/IAM additions, unchanged rename/connection/full-example revalidation, and retention-aware destroy review. |
| MCP diagnostics | `observations.watch` uses durable arrival cursors. Server errors, deployment events and forwarded browser reports include available node/revision/proposal/execution/deployment correlation. | MCP regression reads backend and late browser errors without screenshots. Browser reports are labelled untrusted reports; pre-upgrade history remains in `observations.query`. |
| Invisible listeners | `runInBackground` preserves a component mount when presentation visibility hides its card. Editor exposes “Keep component running when hidden.” | Render test proves a hidden listener stays mounted only with this setting. This does not keep a closed browser tab running. |
| Precise status | Workflow contract distinguishes graph proposal, acceptance, plan, approval, deployment, runtime, and multiplayer milestones. `proposal.retire` links superseded proposals to their replacement. | Retired proposals cannot be approved or committed. No existing live proposal was silently retired. |

## Fresh-agent workflow

1. Call `server.discover({schemaVersion:1})`. Read `plastic://graphs`, then
   `graph.summary` for the chosen graph and its base revision. Read
   `plastic://me` for effective authorization/delegations. Discovery resources
   are `plastic://schema/1/operations`, `/runtime`, `/identity`, `/bus`, and
   `/workflow` under that same schema prefix.
2. Before writing backend code, call
   `iac.preflight({schemaVersion:1,graphId,nodeId:"stack"})`. Use its assigned
   target, namespace, execution role and permissions boundary. Do not invent a
   name under the old shared `pio-dev-*` prefix. An unavailable tool or
   prerequisite is a platform gap, not permission to deploy another way.
3. Get the supported example with
   `server.discover({schemaVersion:1,topic:"example",graphId,nodeId:"stack"})`.
   Preflight its returned `configuration`. It contains the actual application
   Lambda, retained DynamoDB table, bounded role, logs, graph nodes, presentation
   settings and connection operations. Its IDs must be unused in the graph.
4. Join graph chat, announce intent/work, listen and acknowledge interruptions
   using the advertised chat tools. Include `agentSessionId` on graph writes.
   Submit `proposal.create` against the returned base revision with the example
   operations and a new idempotency key. A rename is
   `{"op":"set-graph-props","patch":{"name":"Chess"}}`.
5. Inspect validation, privilege delta and infrastructure impact. A validated
   proposal is **not** a deployed application. The user reviews and accepts the
   graph changes. Human graph acceptance is separate from deployment approval.
6. Call `iac.review({schemaVersion:1,graphId,nodeId:"stack",agentSessionId})`.
   It prepares platform guardrails and the application change set, then waits
   for a human to approve the exact digest in the graph. Poll `iac.status`.
   The protocol exposes no agent operation to approve/apply infrastructure.
7. After status confirms successful deployment, invoke the graph backend with
   `graph.invoke` and inspect results and observations. Application functions
   resolve from the last completed approved deployment, not a client-supplied
   Lambda ARN. A new pending review does not invalidate a working deployment;
   an apply/destroy in progress or unresolved recovery blocks invocation.
8. Verify the application with **two different authenticated users**. Both open
   the graph, register their own signed-in session, and should see the same
   two-player list. Repeat in presentation mode. Refresh after reconnect and
   confirm the versioned authoritative state converges. An agent's refresh,
   local simulated principals, or a rejected anonymous request cannot establish
   this milestone.
9. If work is replaced, use `proposal.retire` with `replacementProposalId` and
   keep only the replacement's review instructions current. Destruction is a
   separate `iac.review` request with `action:"destroy"`, human approval and
   explicit destructive confirmation. Removing a graph node does not delete AWS
   resources.

## Identity, invocation and bus

The normal path is:

```text
signed-in browser → application.request → authenticated graph server node
                 → host.application.invoke → graph-owned Lambda validates caller
                 → durable application write → returned authoritative updates
                 → existing WSS graph channel → both subscribed browsers
```

Browser `session.current()` is display information, not backend identity proof.
The server derives `sub`, `kind` and `tenant` from its verified transport
principal. The private application bridge resolves the approved function and
supplies `event.context.caller`; application code does not accept a user ID from
`event.input`. A directly exposed API Gateway backend is a different entry
point and must use its verified IAM/Cognito authorizer context. It must not
trust a request body's purported bridge context.

The example uses an atomic DynamoDB update to register each verified subject and
increment a revision. The hidden listener ignores older/duplicate revisions.
Registration and refresh return the current player list; the shared platform
knows nothing about its meaning. Credentials are excluded from public identity
objects, graph request values and generated examples. Input rejection and
observation redaction cover common credential keys and token forms; they are
defense in depth, not a claim to recognize every possible encoded secret.

The bus already broadcasts. Application updates go to all authenticated readers
subscribed to `graph-notify-<graphId>` and carry server provenance, message ID,
graph/node/function/deployment context and correlation ID. Do not publish private
records there. Unsubscribe removes only that listener; reconnect resubscribes.
Delivery is best effort: no global ordering, exactly-once promise or durable
application replay. Publish follows a durable write; a publish failure cannot
roll back the write. Use versions, idempotent commands, and authoritative refresh.

The exact remaining integration gap is **unsolicited pushes from an independently
running application Lambda**. This release supports updates returned through an
authenticated bridge invocation. It does not provide a general application bus
publisher or private application channels.

Server isolation defaults to 10 seconds and 128 MB. Bridge responses are limited
to 24000 bytes and 16 updates. Application functions are restricted to 30 seconds
and 512 MB; synchronous operations must finish within the graph node deadline.
A graph timeout does not cancel an in-flight Lambda or undo its writes.

## Isolation and lifecycle review

`stack-namespace-v1` hashes the configured service, stage, account, region, graph ID and
stack node ID into `gapp-<24 hex digits>-`. Stack names must be exactly that
namespace plus `stack`. Renaming the graph's display name does not change it.
Only the configured target is supported; adding a second allowlisted account
does not silently grant cross-account deployment.

The trusted platform creates a guardrail stack containing:

- A worker role allowed to operate on this stack and pass this stack's fixed
  CloudFormation execution role.
- A CloudFormation execution role with namespaced resource lifecycle grants.
  It creates application roles only under `/graph-app/` with the exact assigned
  boundary, and passes them only to Lambda. It cannot edit deployment roles,
  attach managed policies, change guardrail policies, or remove the boundary.
- A runtime boundary allowing enumerated data actions on this namespace's data
  resources, with explicit denies for other actions and foreign resources.
  Application IAM policies must independently meet the same restrictions.

Names alone are insufficient: policies, resource grants, trust, role passing,
local references and external integrations are validated. Application role trust
is Lambda-only. Resource policies may grant only roles declared in the same
template. Application templates cannot contain nested stacks, macros, imported
resources, unresolved external expressions, dynamic secret references, managed
policy attachments, external code artifacts, or public function URLs. Private
S3 access and authenticated API methods are required.

The permitted subset adds Lambda Function/Permission/Version/Alias, IAM
Role/Policy and REST API Gateway RestApi/Resource/Method/Deployment/Stage/Authorizer
to the existing S3/DynamoDB/SQS/SNS/Logs resources. Preflight returns the precise
intersection with the configured validator policy. REST integrations must target
local Lambda functions and use AWS_IAM or the configured Cognito pool.
API Gateway V2, embedded stages, API account settings, API execution/access
logging through the platform's account role, tracing, canaries, VPC, external KMS,
layers and reserved/provisioned concurrency are outside this subset.

REST API IDs are allocated by AWS. Creation therefore requires a matching
`GraphStack` request tag and API name. Child operations require inherited
ownership; ownership-tag mutation is denied. Tagging requires both endpoint
permission and permission on the owned API resource. These checks follow AWS's
[REST tag inheritance](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-tagging-supported-resources.html)
and [tag authorization model](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-tagging-iam-policy.html).
They still require live lifecycle verification against the deployed AWS policy.

Application roles receive no unscoped AWS actions. The execution role's one
documented account-wide read is `logs:DescribeLogGroups`, because the action does
not support a resource ARN; it reveals metadata, not log contents. Other writes
stay within the namespace. Explicit denies also cover foreign resource policies
granting directly to a role session; an implicit boundary deny alone is
insufficient in that case. See AWS's
[permissions-boundary evaluation](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html).

Create/update/destroy use the same assigned roles. Expiring worker credentials
refresh across a long human review. Delete uses the **last deployed template's**
retention policies, lists physical resources, and checks the list again before
deletion. An unapplied edit cannot change a destroy review's retention promises.
Retry tests cover AWS acceptance followed by a failed storage write, and repair
deployment-binding finalization without executing twice. Rollback failures and
partial deletion failures require explicit recovery rather than exposing a
possibly inconsistent deployment. Preflight explicitly marks import, rollback
continuation and retained-resource cleanup as unsupported operations.

Retained data and its retained boundary are intentional. Destroying the example
retains its table; the same physical name can then block recreation. Cleanup or
import needs a separately reviewed operation. Platform guardrail stacks are not
deleted by graph code. Guardrail-version migration also requires platform review.
Existing `pio-dev-*` stacks are not automatically adopted into the new namespace.

Destroy treats `RetainExceptOnCreate` as retained after a successful creation.
Snapshot retention is rejected because the supported resource subset has no
snapshot-capable types. These distinctions follow AWS's
[deletion-policy contract](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html).

## Review digests and diagnostics

Proposal digest version 2 hashes canonical JSON containing the contract/policy
versions, graph/base revision, operations, complete resulting projection,
reviewed impact, description and rationale. Timestamps recording validation and
approval are excluded. The exact stored Yjs update has a separate integrity hash.
Unchanged revalidation stages those same bytes, retaining the same touched-node
set and digest. Rebase/content/policy changes can invalidate approval.

Deployment approval separately binds the input digest, deployment policy digest
and generated plan. The UI shows resource changes, IAM changes, replacements,
retention and prerequisites. It distinguishes apply from destroy; a graph
proposal approval cannot authorize a deployment.

For live diagnostics, start with:

```json
{"schemaVersion":1,"graphId":"<graphId>","from":"latest","filter":{"kind":"exec.error"}}
```

Call `observations.watch`, retain `nextCursor`, and repeat using the **same graph
and filters**. Respect `pollAfterMs`. A cursor follows server arrival order, so a
late browser report with an older event ID is not skipped. Ingestion recovery is
at least once; deduplicate observation IDs. Replay is bounded to 2000 batches;
`CURSOR_EXPIRED` directs the caller to archived `observations.query`, then a new
latest cursor. The advertised MCP stream provides notifications to prompt a poll;
it is not a substitute for cursor recovery.

Server execution errors link to the node and actual matching revision; the
proposal that committed that revision is indexed for correlation. Uncommitted
editor state is labelled `live`. Browser reports carry `browser-report`
provenance and the authenticated reporter, not server authority. Deployment
events and application failures include `operationId`. Kind filters are prefixes:
use `exec.error`, not `error`.

## Validation and release gates

Local evidence includes server and editor tests, both TypeScript checks, both
Auth0/Cognito builds, CI configuration tests, production dependency audit and
offline CloudFormation lint. The protocol regression uses the real MCP client,
real schemas, proposal admission and native isolation, with simulated AWS and
application services. Policy tests evaluate the generated policy subset locally;
they are **not AWS IAM simulator or live AWS evidence**. Editor tests simulate two
bus consumers; they are **not two authenticated browser accounts**.

Recorded local results:

- Server: 40 suites, **652 tests passed** using the release workflow's existing
  `jest --ci --runInBand --forceExit` command. A run without `--forceExit` completes
  its assertions but leaves the process alive; `--detectOpenHandles` did not
  identify the outstanding handle. This test-harness teardown issue is still
  unresolved, and is not runtime/deployment verification.
- Editor: 11 integration files, **104 tests passed**, including actual component
  renders for hidden execution and infrastructure review details.
- Editor release checks: **125 CRDT tests and 2 Playwright tests passed** for
  chat and infrastructure review. The browser tests use the local development
  server; they do not establish two authenticated users in the deployed service.
- Server TypeScript and editor `vue-tsc`: passed; editor baseline remains zero
  type errors. CI configuration: **5 tests passed**.
- Native isolation suite: **9 tests passed**, including identity/clock and
  timeout containment; that suite exits normally on its own.
- Both authentication provider bundles build for server and editor. Production
  dependency audit reports **zero vulnerabilities**. Offline generated guardrail,
  application and CI-role CloudFormation lint passes.

The repeatable release path is the existing GitHub Actions workflow with OIDC,
an approved target account and a pinned editor commit. Its deployment role and
environment have not been activated for this account. The user previously
authorized direct platform releases using the account-specific AWS profile;
that exception remains separate from MCP-only application work. The added CI
fixture generation and CloudFormation lint are offline tests. The CI deployment
role update must be reviewed with the platform infrastructure before activation.
Release both repositories together: the example depends on the new editor helpers.
Forced server containment can reject legacy code using ambient Node/AWS access;
migrate such code to declared host capabilities instead of disabling containment.

### Deployed platform evidence

The authorized account-specific release used the same pinned source, provider
mapping, package checks and smoke script as the CI workflow. GitHub Actions
deployment access remains unactivated; this was a direct platform release.

- Account **230639770018**, region **us-west-1**, stack
  `pio-auth-test-230639770018`: **UPDATE_COMPLETE**. The change preserved the
  Cognito pool/client and stored-data resources, and added the private application
  bridge and guardrail roles. No application stack was created or updated.
- The deployed MCP route, MCP stream, edge delivery, infrastructure worker and
  application bridge code hashes match the retained server package. The
  functions are active with successful updates, forced containment and stack
  isolation enabled. Execution entry points checked have the native isolate
  layer. The application bridge has no public Function URL.
- The [deployed editor](https://d2fqgid0yzbc85.cloudfront.net/graph-editor/)
  and its [release manifest](https://d2fqgid0yzbc85.cloudfront.net/graph-editor/release.json)
  match the pinned revisions and paired account endpoints. Assets were published
  before the entry point and CloudFront invalidation completed.
- The deployed REST stage requires the JWT authorizer on every non-OPTIONS
  method except public OAuth discovery. WebSocket connection authorization is
  enabled. Graph, artifact, CRDT, stack, observation, execution-delivery, MCP and
  catch-all requests rejected missing and invalid credentials with HTTP 401.
  The standard release smoke checks also passed for WSS, the MCP Function URL,
  provider selection, PKCE discovery and constrained public-client registration.
- Through the authenticated MCP connection, all five version **1.0.0** schema
  resources were listed and read. The operation catalogue exposes all 13
  operations; runtime, identity, bus and workflow contracts are live. Existing
  clients may need to refresh their tool catalogue to see the newly added tools.

These checks establish platform rollout and authentication-boundary behavior,
not live application readiness, effective cross-stack denial or multiplayer.

| Milestone for the fresh-agent acceptance case | Current evidence |
| --- | --- |
| Proposal created and validated | Passed through local MCP regression; no new live proposal submitted. |
| User accepted graph changes | Simulated human acceptance tested; live acceptance pending. |
| Infrastructure plan generated | Simulated CloudFormation plan tested; live plan pending. |
| User approved deployment | Separate human approval tested locally; no live approval requested/executed. |
| Deployment completed | Platform release completed in the target account; real application deployment remains pending graph-side approval. |
| Runtime readiness verified | Native isolate, application example and diagnostic tests pass locally. Deployed platform discovery and authentication checks pass; live application execution remains pending. |
| Live multiplayer verified | Pending two real authenticated users, reconnect/presentation checks and authoritative updates. |

After platform release, the live acceptance gate must also demonstrate permitted
create/update/delete and actual rejection of cross-stack/server/guardrail access
through the reviewed graph workflow. If that gate reveals missing permissions,
report the exact action/resource and propose a platform fix. Do not switch to
personal AWS credentials, direct Lambda verification or frontend modification.
