# MCP application workflow — current platform review

Updated: 2026-10-08 UTC. This remains the single current review artifact for
**graph-server and its sibling graph-editor**. The lifecycle extension described
first is implemented and locally validated, **not deployed**. The subsequent
release record is historical evidence; its manual-recovery instructions are
superseded by this graph-native workflow once the platform release is installed.

## Current lifecycle extension

The workflow is proposal → graph acceptance → infrastructure review → human
deployment approval → deployment → diagnosis → recovery review → human recovery
approval → recovery → fresh infrastructure review. Each approval binds its own
immutable digest. Neither inspection, recovery, maintenance approval, nor a
successful readiness check authorizes application deployment.

Server discovery version **2.4.0** exposes `plastic://schema/1/lifecycle` and
the following tools alongside the existing proposal and IaC tools:

| Tool | Result and authority |
| --- | --- |
| `iac.inspect` | Current stack/resource ownership, retention, current role/trust/boundary checks, actual read/STS results, active workflow and blockers. Requires graph read and IaC status access. |
| `iac.recovery.plan` | A concrete, immutable recovery review using the current operation and a stable request key. Requires IaC proposal authority. It executes nothing. |
| `iac.maintenance.request` | A graph-visible request for named platform actions/resources, with a separate configured human platform-admin review and verification. It cannot edit shared IAM. |
| `iac.runtime.logs` | Bounded, redacted diagnostics for a logical Lambda belonging to the approved application stack. Also requires observation and payload-inspection authority. |
| `iac.readiness` | Runs one check declared in the approved deployment through graph invocation. Requires execution and observation authority and an idempotency key. |

Full input schemas and examples are available through
`server.discover({"schemaVersion":1,"topic":"lifecycle"})`. `iac.preflight`
reports whether the lifecycle worker is configured and distinguishes retained-only
recovery imports from arbitrary import. `iac.status` exposes `nextActions`,
`inspection`, `recoveryPlan`, `recoveryApproval`, `recoveryOutcomes`, `maintenance`
and `runtimeReadiness`. Capability absence, AWS permission prerequisites, active
work, and pending human approval have distinct codes/states.

### Current conditions versus historical evidence

This task rechecked the Chess operation through live MCP `iac.status`. The
returned historical events show the original `iam:GetRole`/`iam:GetRolePolicy`
guardrail creation failure, `iam:DeleteRolePolicy` cleanup denial, retained
boundary, and secondary `sts:AssumeRole` failure. They do **not** establish the
permissions or physical resource state now. No live recovery or application
mutation was performed.

The new inspector reads the application and guardrail stacks, ownership tags,
assigned roles, resource inventories and original templates. If an owned stack
has been deleted, its recorded stack ARN recovers retained-resource evidence.
The inspector separately reports:

- Static validation of the current graph template, including missing or invalid
  node configuration without losing diagnostics for the stored operation.
- Structural analysis of the current platform policy and expected guardrail
  policies, trust and boundary. **This is not IAM simulation or deployment proof.**
- Actual AWS read results and, where the worker definition matches, an STS
  assumption probe whose credentials are discarded. SCPs, session policies,
  service behavior and eventual consistency can still deny subsequent deployment.

Inspection has an 18-second collection budget. Incomplete inventories, unknown
ownership, extra role policies, foreign boundary consumers and failed verification
are explicit blockers. It never adopts a resource merely because its name has a
matching prefix.

### Bounded recovery and repeatability

| Observed state | Reviewed recovery behavior |
| --- | --- |
| Failed creation, `ROLLBACK_FAILED`, `ROLLBACK_COMPLETE`, `DELETE_FAILED`, or abandoned review stack | Delete only the owned failed stack, then import proven retained resources into the same namespace. Preserve data by default. |
| `DELETE_FAILED` with data lacking retention | Use the reviewed `RetainResources` list before import. This argument is not used in other states. |
| `UPDATE_ROLLBACK_FAILED` | Continue rollback without skipping resources. |
| `UPDATE_FAILED` | Roll back with explicit review of retention and possible data loss. |
| Partial or drifted platform guardrails | Restore only the platform's approved guardrail definition for this namespace, including actual IAM drift when CloudFormation reports no template changes. |
| Unproven orphan, unsupported import, unresolved import dependency, import rollback, or unsafe data deletion | Return precise prerequisites; preserve resources and request the appropriate template/preservation/platform review. |

Import identifiers for the supported retained IAM policies/roles, buckets,
tables, queues, topics and log groups match the pinned CloudFormation resource
schemas used by offline lint. Import templates contain only reviewed survivors.
No general import or arbitrary AWS-command endpoint is exposed. A failed create
with unretained data remains blocked unless the human separately accepts the
listed loss; arranging a backup outside the supported subset remains explicit
platform maintenance.

The recovery digest binds the source operation, graph/node namespace, input,
resource IDs and states, retention, approved guardrail definition, prerequisites,
actions and data-loss choice. Observation timestamps do not affect freshness.
Plans expire after 15 minutes; a fresh plan may replace an unapproved plan and
invalidates it. Approved execution rechecks state/ownership and the digest before
the first mutation, rechecks inventory before deletion/rollback, and verifies
import results. Deployment and recovery share a conditional-write stack lock and
120-second worker leases, covering the 60-second worker and private repair call.
A stopped workflow does not allow overlap with a worker still holding its lease.
Deterministic AWS tokens and durable action outcomes handle duplicate delivery.

Recovery states are `recovery-blocked` → `recovery-ready` →
`recovery-requested` → `recovering` → `recovered`/`failed`. The original operation
and error remain linked in history. Recovery completion retires the failed
operation; it does not execute a new application template. Use `iac.review` with
`retryOf` equal to the current recovered operation, then obtain the new exact
human deployment approval. New readiness declarations require this approval even
when CloudFormation reports no resource changes.

### UI, socket and MCP parity

The CF node shows inspection evidence, affected resources, retention/data loss,
the recovery digest, execution outcomes, maintenance requests and readiness.
It restores current status/history after reload and reconnect. The existing
640 × 480 px maximum node content area and internal scrolling remain intact.
Human recovery approval and platform-admin maintenance review use authenticated
graph routes; MCP has no approval or arbitrary deployment-execution tool.

Structured `deployment.progress` lifecycle events use the existing durable
journal, outbox, graph socket, `iac.events` and `observations.watch`. All carry
the same sanitized envelope, including the original receipt timestamp. Large
reports use documented, hash-verified JSON fragments below WebSocket frame
limits; cursors retrieve missing parts after reconnect. UI status access has no
diagnostic information unavailable to an authorized MCP observer.

Application invocation events connect graph execution, invocation, correlation,
approved deployment, bridge request and Lambda request IDs. The private bridge
extracts the request ID from Lambda's returned log tail and discards that raw
tail. The separate log reader derives the log group from the approved binding
and rechecks current stack ownership/inventory. Callers cannot supply log-group
names, AWS tokens, ARNs or account selectors.

Log queries allow one logical function, at most one request/invocation/correlation
filter, a one-hour window within seven days, 100 raw records and 80 KB per page,
100 pages and a 24-hour cursor lifetime. Only Lambda system/runtime errors and
declared `graph.application.diagnostic` records are included. Arbitrary console
payloads are omitted; credential forms and known parameter/environment values
are redacted. Omission, truncation, unavailable logs and permission errors are
explicit. This cannot detect every encoded secret in arbitrary error prose.
Application logs require additional payload-inspection permission across status,
event pages, watch and outbound socket delivery; `logs:Unmask` is never granted.

Readiness checks invoke declared graph nodes, with stable request keys preventing
duplicate execution. A check must assert its own application invariants. The
platform records execution/revision references and verifies completed execution
with no errors or denied effects. Deployment completion, declared readiness and
real multiplayer verification remain separate evidence.

### Platform-admin bootstrap review — still required

Paired editor release pin: `f9ce6c1b8083659959d9a0acbcdbd775c1a08e40`.
The server revision for this review is the commit containing this document.

This change is a shared platform release. Application agents cannot bootstrap it
or edit these roles. Review the concrete changes in `serverless.yaml` and
`infra/github-oidc-deploy-role.yaml` for **230639770018 / us-west-1**:

| Platform component | Requested permission/change |
| --- | --- |
| `IacGuardrailRole` | Add `iam:DeleteRolePolicy` on **root-path `role/gapp-*`** for missing-role cleanup, in addition to existing read probes. This is a real cleanup permission requiring separate review. Creation/trust/policy grants remain under `/graph-deploy/gapp-*`; no root-role creation or policy grants are added. Add version management only for `/graph-guardrails/gapp-*` policies. |
| `IacWorkerRole` | Current stack/IAM reads, its workflow's execution status, Lambda log reads only under `/aws/lambda/gapp-*`, namespace recovery change sets, fixed guardrail-stack recovery actions and invocation of the exact private repair function. Application mutations continue through the assigned per-stack worker/execution role. |
| New `IacGuardrailRepairRole` / private function | Read only operation/index/lock records and owned guardrail inventory; restore only approved inline policies/trust under `/graph-deploy/gapp-*` and boundary versions under `/graph-guardrails/gapp-*`. No approval-store writes, role creation/deletion, role passing, shared-policy edits or public endpoint. The function independently verifies the human recovery digest, live lease, namespace, stack tags and physical resources. |
| Per-stack WorkerRole | Restrict change-set ARNs to this namespace and add only this stack's rollback/recovery operations. Existing stacks use reviewed guardrail reconciliation to acquire the approved definition. |
| Application runtime/execution roles | No broader application IAM authority. Existing boundary and isolation enforcement remain in force. |
| GitHub OIDC deployment role | Add the exact private repair role name to managed-role/pass-to-Lambda allowlists. A platform administrator must activate/update the approved CI role; it cannot bootstrap its own missing authority. |

Release prerequisites:

1. An administrator reviews the above policy/function changes and updates the
   CI bootstrap role through the existing approved platform administration path.
   GitHub OIDC deployment was not activated in the earlier release; it remains
   an explicit external bootstrap prerequisite, not an MCP fallback.
2. Set the GitHub deployment environment's `PLATFORM_ADMIN_SUBS` to explicitly
   authorized, verified **human subject IDs**. Those humans also need the
   existing `policy:admin` authority. Empty is deny-by-default; ordinary graph
   ownership or agent delegation alone cannot grant this maintenance role.
3. Release the reviewed server and a pinned full editor commit via the existing
   Deploy workflow. No local preparation commands, personal AWS credentials,
   browser tokens or application-specific server code are needed by the agent.
4. Refresh MCP discovery, run `iac.inspect`, and request platform maintenance if
   it finds remaining shared prerequisites. Maintenance states are `requested`,
   `approved-awaiting-platform-release`, `verification-blocked` or `verified`.
   Admin approval does not edit IAM; verification performs fresh AWS checks.
5. Prepare the Chess recovery from the **then-current** operation. Review its
   actual resources/digest in the CF node, approve recovery, and subsequently
   prepare and approve a separate fresh deployment review.

### Validation and remaining live gates

The real MCP-client regression discovers schemas, proposes connected nodes and
presentation, accepts the graph through the human service, inspects an induced
pre-application guardrail failure, prepares recovery, obtains graph-route human
approval, reconnects, prepares a fresh deployment review, obtains its distinct
approval, invokes through MCP and retrieves a correlated runtime failure/log.
AWS responses and application backend behavior in this test are **simulated**.

Other regressions cover retained data in `ROLLBACK_FAILED`/`DELETE_FAILED`,
state-specific rollback, namespace/ownership rejection, permission maintenance,
stale/expired/tampered approvals, duplicate requests, worker leases and concurrent
operations, changed inventories, large report fragmentation, log pagination and
redaction, readiness and separate approval of metadata-only changes. Browser
tests use the local test server and mocked infrastructure routes, including real
reload and scrolling; they do not authenticate to the deployed AWS application.

Current results: **698 server tests in 43 suites**, **114 editor integration
tests in 13 files**, both TypeScript checks, **5 CI configuration tests**, both
Auth0/Cognito server and editor bundles, and offline CloudFormation lint pass.
The recovery browser test and existing deployment-review browser test pass.
The server test run uses the repository's established `--forceExit` workaround
for its lingering test-harness handle; this is separate from runtime evidence.

**Pending:** administrator bootstrap/release, live current-AWS inspection,
graph-side recovery/deployment approvals, live create/failure/recovery/redeploy
and rollback, live cross-stack denial, runtime readiness and two authenticated
browser users receiving authoritative updates. None of those live outcomes is
claimed by the local tests. No new live proposal or AWS mutation was made in
this task.

## Previous release record — historical

The user authorized
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

## Deployment observability extension

Implemented, committed, pushed and deployed to **230639770018 / us-west-1**:
server `71bb9e3ac1e5601acf0054e1a5d4f3e5df72d020`, editor
`d4c03cbbca591ff4600f4dacbc0769e7aceb0bdc`. The server stack is
**UPDATE_COMPLETE** and the editor's CloudFront invalidation completed.
No Chess application
deployment, retry, deletion or guardrail recovery is part of this platform change.

### Confirmed failure and narrow correction

Operation `01M4CSD7D7H7YM2HKY2Z5AJRHZ`, graph
`f1963a3b-7e9a-43b3-87ee-068d56431374`, node `node-chess-storage-stack`, failed
before application stack `gapp-15688bf738201d31d8fb7d29-stack` existed. The user
identified accepted revision `rev_01M4CS9QTFQWS4GVV07CYN4Y0H`. The legacy operation
did not record a revision; diagnostic events use `unknown` for that historical
field and retain its actual input digest instead of guessing an association.

Read-only platform investigation in account **230639770018**, **us-west-1**, found:

- At approximately **2026-10-08 03:37:49–50 UTC**, the guardrail stack
  `graph-guardrails-15688bf738201d31d8fb7d29` failed to create WorkerRole and
  ExecutionRole because its platform CloudFormation role lacked effective
  `iam:GetRole`. CloudFormation also reported missing `iam:GetRolePolicy`.
- At approximately **03:37:52–54**, rollback failed on `iam:DeleteRolePolicy`.
  The guardrail stack ended **ROLLBACK_FAILED**; its boundary was retained
  (`DELETE_SKIPPED`). No application change set was recorded.
- The worker retried `Platform guardrail provisioning failed: ROLLBACK_FAILED`.
  Failure recording replaced that reason with a generic instruction to check
  AWS, then unnecessarily attempted change-set cleanup without a change set.
  Cleanup assumed an absent worker role and generated a secondary
  `sts:AssumeRole` AccessDenied. Step Functions ultimately failed at about
  **03:39:08**, obscuring the earlier guardrail failure.

The guardrail template specifies `/graph-deploy/`; its deployed IAM policy
already allowed lifecycle actions only on `role/graph-deploy/gapp-*`. A privileged
read confirmed the worker role did not exist. The likely mismatch is IAM's
pathless existence/read probe for an absent role. This is an inference from
events and policies, not a completed live lifecycle test. The platform policy
adds only `GetRole` and `GetRolePolicy` on `role/gapp-*` for those probes. Role and
policy mutations remain constrained to `/graph-deploy/gapp-*`; application roles
and stack isolation are unchanged. The failed stack still needs explicitly
reviewed platform recovery; this release does not broaden root-path delete
permissions to work around that failure.

### One diagnostic stream for the node and MCP

- Review/worker state, guardrail setup, change sets, resource events, rollback,
  cleanup, exceptions and orchestration outcomes become `deployment.progress`
  records in a per-operation immutable journal with a conditional-write head.
  Each includes graph/node/operation IDs, input and available review digests,
  recorded revision, occurrence/receipt timestamps, source, phase and sequence.
- A durable publication outbox appends those records to `observations.watch`
  and sends the **same published records** to `graph-notify-<graphId>` on the
  existing WSS bus. Delivery is at least once/best effort; deduplicate by `id`.
  Arrival cursors preserve late AWS events independently of occurrence time.
- A private collector uses a separate read-only AWS role. It reads only the
  stored operation's derived application/guardrail stacks, exact Step Functions
  execution and operation-correlated platform worker log lines. A broken or
  absent per-stack worker role therefore cannot hide its own diagnostics.
  Worker/status refreshes collect progress; terminal workflow events also
  trigger collection through a narrowly filtered EventBridge rule.
- The CloudFormation node and infrastructure review dialog display phases,
  resource rows, failure/recovery reasons, timestamps, history and expandable
  logs. Reopening, polling and socket reconnect recover from the durable cursor.
  Selecting history does not change the current review or approve anything.
- `iac.status` returns the current meaningful phase, resource summary, terminal
  cause, original exception, collection warnings, recovery guidance, and
  `progress.history` / `progress.watch` references. `iac.events` pages the journal;
  `iac.history` follows prior operations. `iac.status({operationId})` opens a
  known historical operation. Pre-upgrade operations remain readable by ID;
  earlier records without previous-operation links are not invented by history.

Read `plastic://schema/1/progress` or
`server.discover({schemaVersion:1,topic:"progress"})` for the actual event/page
schemas and examples. Existing MCP clients may need to refresh their tool list.

```json
{"schemaVersion":1,"graphId":"f1963a3b-7e9a-43b3-87ee-068d56431374","nodeId":"node-chess-storage-stack"}
```

Use that request with `iac.status`. Then call `observations.watch` with the
same graph and `filter:{"operationId":"01M4CSD7D7H7YM2HKY2Z5AJRHZ"}`, preserving
`nextCursor` across polls. Use the arguments returned in `progress.history` with
`iac.events` for longer output or recovery after watch's replay window expires.
Call status while `progress.collectionPending` is true to collect older AWS pages.
Monitoring never approves, retries, applies or repairs application infrastructure.

### Safety, bounds and recovery

All UI/MCP diagnostic reads require the graph's resolved `graph:read` and
`iac:read-status` authority; watch additionally requires `graph:observe`.
Subscriptions are reauthorized on outbound delivery. Node/graph/operation-bound
cursors do not grant access. The reference deployment's existing policy allows
authenticated human instance owners to read its graphs; agent delegation is
resolved per graph. No new public data route or Function URL is introduced.

The collector has no IAM writes, role assumption, deployment operations,
application invocation, application log access or `logs:Unmask`. Its storage
writes are confined to deployment progress and observation journals. Worker and
collector socket grants use the existing API/stage and connection path. The
GitHub OIDC role template includes the new platform role and exact EventBridge
rule; CI activation remains a separate prerequisite.

Per refresh: up to four CloudFormation pages per stack, 300 orchestration
events, and an 18-second AWS collection budget. Newest pages are always checked;
older-page continuations resume on later refreshes. Logs expose at most 20
correlated structured entries from at most 100 matches in a five-minute operation
window. Legacy uncorrelated logs are excluded. Collection failures, continuation
backlogs and truncation are explicit warnings and never replace the original
deployment error. Event pages and status resource summaries are bounded to
120 KB; individual diagnostic text/trace fields are truncated. Full operation
pages remain available through cursors. ResourceProperties, workflow input/output,
application request bodies and raw log records are not copied. Known parameter,
NoEcho default and environment values plus common credential forms are redacted.
As elsewhere in the platform, this does not claim universal detection of arbitrary
encoded secrets in free-form AWS error text.

Recovery distinguishes template correction, transient planning retry, and
platform intervention. Permission failures, uncertain outcomes and failed
rollback/cleanup block an unsafe new review. The original cause, secondary
failures and retained/skipped cleanup resources remain visible together.
Exact-digest human deployment approval is unchanged. Graph acceptance, approval
and completed deployment remain separate milestones.

### Validation for this extension

Server regression coverage uses a real MCP protocol client and simulated AWS
responses: successful reviewed deployment, change-set planning failure, resource
creation/update/delete failure, permission denial, rollback, workflow timeout,
diagnostic-store failure, collection denial, redaction, pagination, late events,
outbox retry/deduplication, history and cross-graph/agent access denial. The Chess
regression reproduces the observed pre-application guardrail IAM failure and
secondary AssumeRole error. It asserts that status keeps the root cause and that
socket records equal the MCP observation journal. A missing change set never
triggers cleanup/role assumption.

Editor render tests consume the same published event shape and exercise live
failure display, logs, phase milestones, duplicate frames, reconnect, reload,
resource timestamp ordering, old-operation selection and navigation races.
Both Auth0 and Cognito builds pass. These are local/simulated deployment tests,
not a claim of live successful application provisioning or recovered guardrails.
Current local results: **670 server tests in 41 suites**, **109 editor integration
tests in 12 files**, **125 CRDT tests**, and **2 Playwright browser tests** passed. Both TypeScript
checks pass with the editor's zero-error baseline. All **5 CI configuration
tests** pass. Both provider builds pass; the CI-role CloudFormation source passes
offline lint; the packaged platform template also passes lint without errors.
The production dependency audit reports zero vulnerabilities. The existing Jest harness still uses its established `--forceExit`
setting.

The first live MCP read exposed an absent-journal edge case: the collector's
restricted S3 role received AccessDenied instead of NoSuchKey for a missing head.
This follows S3's documented
[GetObject permission behavior](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).
The correction checks only the exact missing head key using prefix-limited
listing under the two journal prefixes. It never treats an existing denied object
as absent or grants unrestricted bucket listing. Collector startup errors now
preserve Lambda's bounded error message in the graph, and legacy opaque errors
require diagnostic recovery rather than incorrectly prescribing a template edit.
The regression tests cover cold initialization and genuine denied reads.

Authenticated **live MCP `iac.status`** recovered 36 records for the reported
operation, including the original `iam:GetRole` failure, both rollback
`iam:DeleteRolePolicy` failures, retained boundary, absent application stack and
secondary AssumeRole failure. The response classifies recovery as platform
intervention. Legacy worker logs without an operation ID remain intentionally
unavailable; CloudFormation and orchestration history supply the actionable
evidence. The operation was inspected, not retried or approved.

Final release verification:

- The deployed collector, worker, review endpoint, MCP route and MCP stream are
  active; all five code hashes match the retained final package.
- The collector's deployed S3 listing permission is limited to graph-notification
  subscriptions and the two journal prefixes. Its workflow event rule is enabled
  and filters the exact platform state machine.
- Both new API routes have the deployed JWT authorizer. Events, operation history
  and review endpoints return **401** for missing and invalid credentials.
  The standard release checks also passed for OAuth/PKCE discovery, constrained
  public-client registration, WSS and the MCP Function URL.
- Repeated authenticated MCP reads return the original IAM failure and the same
  **36** diagnostic event sequence, demonstrating collection deduplication. The
  application stack is explicitly `NOT_CREATED`; the guardrail resources show
  rollback failure and the retained boundary. The new versioned progress schema
  is listed and readable through MCP.
- The public editor release manifest and entry point match the retained pinned
  artifacts. UI rendering/reconnect evidence comes from local integration and
  browser tests; an authenticated live-browser session was not independently
  exercised during this release. The current connector session cached the old
  tool list, so live diagnosis used `iac.status`; the real MCP client regression
  exercises `observations.watch`, `iac.events` and `iac.history` as well.

Remaining application prerequisites: separately authorized recovery of the
failed guardrail stack and reconciliation of the failed review/lock, followed
by a fresh graph-side plan and exact-digest human approval. Successful live AWS
application create/update/delete, rollback and multiplayer remain separate
acceptance gates. Local success/failure scenarios use simulated AWS responses.
GitHub OIDC deployment access remains unactivated; this release used the existing
authorized account-specific platform-release exception. Both repositories are
pushed. Reload the editor; reconnect clients that cache the MCP tool catalogue.

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

Recorded results for the preceding `c1ee6ce` release (the extension's current
results and rollout evidence are above):

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
| User accepted graph changes | Simulated human acceptance tested. The user reports accepted Chess revision `rev_01M4CS9QTFQWS4GVV07CYN4Y0H`; its legacy deployment record carries the input digest but no revision field. |
| Infrastructure plan generated | Simulated successful plan tested. The reported live Chess plan failed during guardrail provisioning, before application stack creation; its cause is now retrievable through MCP. |
| User approved deployment | Separate human approval tested locally; the failed Chess operation has no deployment approval. |
| Deployment completed | Current platform release completed in the target account; Chess still requires guardrail recovery, a new plan and graph-side approval. |
| Runtime readiness verified | Native isolate, application example and diagnostic tests pass locally. Deployed platform discovery and authentication checks pass; live application execution remains pending. |
| Live multiplayer verified | Pending two real authenticated users, reconnect/presentation checks and authoritative updates. |

After platform release, the live acceptance gate must also demonstrate permitted
create/update/delete and actual rejection of cross-stack/server/guardrail access
through the reviewed graph workflow. If that gate reveals missing permissions,
report the exact action/resource and propose a platform fix. Do not switch to
personal AWS credentials, direct Lambda verification or frontend modification.
