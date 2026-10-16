# Current review: scoped Lambda environment decryption

October 16, 2026. Server **2.8.2**, lifecycle contract **1.6.0**, progress contract
**1.2.0**. Implementation and artifact verification are complete. Platform release,
separately approved boundary migrations, and real application readiness are still
pending. This section supersedes earlier release instructions below.

## Evidence and cause

Read-only AWS inspection confirmed that Damp Robin and Plump Fox's EventWriter
functions are Python 3.12, have two environment variables each, omit `KMSKeyArn`,
and use AWS-managed key
`arn:aws:kms:us-west-1:230639770018:key/c97a1b2d-4dfe-401c-829d-d7d918647a56`
with reserved alias `alias/aws/lambda`. Neither role has a separate KMS grant.
The actual key policy includes a Decrypt grant conditioned on caller account and
`kms:EncryptionContext:aws:lambda:FunctionArn`. The bounded CloudTrail inspection
found 19 Damp Robin Decrypt denials by the permissions boundary; those events
omit request parameters, so they do not independently establish the request's
context. The existing application and guardrail stacks are CREATE_COMPLETE.

The old boundary denies Decrypt twice: its action ceiling omits `kms:Decrypt`,
and its resource ceiling excludes KMS keys. Installed policies matching those
old definitions does not establish runtime compatibility. Both ceilings are
corrected together. A conditional allow and explicit negative conditions permit
only Decrypt on keys in the assigned account/region with `alias/aws/lambda`, the
assigned caller account, and this stack's function ARN encryption context. Missing
context/alias/account is denied. KMS administration, grants, encryption and other
graphs' ciphertext remain denied. No application identity policy is expanded.

Lambda's automatic environment-decryption calls do not carry
`lambda:SourceFunctionArn`; the implementation uses the key policy's supported
function encryption context instead. References:
[AWS Lambda environment encryption](https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars-encryption.html),
[source-function condition limitations](https://docs.aws.amazon.com/lambda/latest/dg/permissions-source-function-arn.html),
[KMS alias/context conditions](https://docs.aws.amazon.com/kms/latest/developerguide/conditions-kms.html),
[boundary explicit denies](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html).

## Migration and contract

New guardrails receive the new definition. Existing boundaries require
`iac.inspect` → `iac.recovery.plan` with `preservation: "strict"` → human
approval of the exact recovery digest in the graph → status/events/watch →
`iac.readiness`. Releasing source does not update existing policy versions.
The reviewed action lists RuntimeBoundary as an in-place policy update, preserving
its ARN, path, attachments, retention, application stacks and records. Approval
binds the current ownership, document, version inventory and approved platform
definition. Execution rechecks them. Strict repair never prunes policy versions;
a full or incomplete inventory returns `BOUNDARY_VERSION_CAPACITY` for separate
platform maintenance. PolicyDocument updates are
[CloudFormation No interruption updates](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-iam-managedpolicy.html).

Preflight and inspection expose `lambdaEnvironmentEncryption` and distinguish
static compatibility, installed policy analysis, actual read/STS calls and runtime
readiness. Customer KMS keys remain an explicitly unsupported isolated capability.
The template is never rewritten. Existing graph ownership, authentication,
namespace checks and exact-digest approval still apply. Recovery does not approve
or redeploy an application template.

DescribeExecution can race dispatch because initial graph progress is published
before StartExecution. Initial absence now reports STARTING for at most 60 seconds;
unapproved recovery reports NOT_STARTED. Absence after observation or outside
that window, AccessDenied and dispatch failures remain errors. A later confirmed
execution clears the current stale warning while retaining historical events.
Worker steps now log allowlisted operation/request/phase/status metadata on success
as well as failure. The collector publishes the same redacted records through
MCP and the graph bus, with explicit pending/unavailable log states.

## Verification before release

- Full server suite: **887 passed**, 1 opt-in Bedrock test skipped, 57 suites.
  TypeScript passed. Jest's existing open handles required process cleanup after
  the completed run; no test failed.
- Regression tests cover each independent deny, allowed default-key context,
  foreign/missing aliases/context/account, unrelated resources and KMS actions,
  strict in-place updates, full/unreadable version inventories, stale approvals,
  foreign consumers, workflow visibility timing, redaction and bus/MCP parity.
- AWS SimulateCustomPolicy: own default-key context allowed; customer alias,
  foreign function, absent context, foreign account and absent alias explicitly
  denied. This is simulation with supplied context, **not Lambda execution**.
- Packaged native layer loads in Linux x86_64 Node 22 (ABI 127); all 70 shared
  runtime functions have the layer. Paired editor production build passed.
- Reviewed platform IAM diff: only `iam:ListPolicyVersions` added to the worker's
  existing graph-guardrails policy ARN scope. Platform data resources unchanged.
  No new application-role or platform KMS grants are added.

Live migration targets: Damp Robin `nuclear-usage-stack` and Plump Fox
`piano-analytics-stack`. Their application code/templates are unchanged. Real
initialization, authenticated write/consistent-read checks, and retained-record
verification remain pending their separately approved boundary updates.

---

# Previous verification: consistent native containment across execution routes

October 16, 2026. Server **2.8.1** is released to account `230639770018`,
region `us-west-1`. Server commit `ceaea450c259cdbbc422ae925d72602f63ce88dc`
and unchanged editor commit `ec5735661fdf1f3284c5f578275ddb454724d840` are
pushed and deployed. Authenticated editor and MCP verification passed.

Agreeable Dove's failed readiness run `01M51XS0PDJARWC0BB8FG5F8AD`, execution
`01M51XS1M8QHYGQKQ3V2WAJR1B`, reached the editor's
`POST /crdt/{id}/iac/{nodeId}/readiness` route. API Gateway maps it directly to
`pio-auth-test-230639770018-test-iacReview`, handler `src/handler.iacReview`.
The deployed function had **no layers**. MCP's `/mcp` route reaches
`pio-auth-test-230639770018-test-mcpRoute`, which had the native layer
`pio-auth-test-test-isolated-vm:1`. Both functions were on `$LATEST`, had no
aliases and shared code SHA-256 `2INeiMSPm5Lk16sFj/Ylq8aAaBmt1P2ZGVl5rTnY2fU=`.
This was a deterministic route configuration difference, not evidence of an
intermittent native binary or differing code artifacts.

The failed execution at `08:38:08.267Z` falls inside the iacReview invocation
`cf6f93a2-3448-4be3-91e0-2067784b857f` (08:38:06.796–08:38:09.410 UTC), in
log stream `2026/10/16/[$LATEST]1ffdc1fe61584a7d87a31e632a29904d`. This request
association is time-correlated: historical graph observations did not include
Lambda provenance. The later successful MCP execution falls within mcpRoute
request `58b040fe-15df-4b8c-be72-cde5e22a362b`. The intentional application
identifier-conflict test at 08:38:44 UTC is unrelated.

## Platform correction

- The Node 22 / x86_64 platform now inherits `IsolatedVmLambdaLayer` centrally.
  Existing function-specific layer lists are checked during normal packaging;
  every route sharing `src/handler` must have the native layer. The check runs
  before the assistant bridge moves into its retained nested stack.
- CI verifies the actual packaged root/nested templates and native layer ZIP,
  then loads the binary in the Linux x86_64 Node 22 Lambda image. It checks ABI
  127, creates an isolate and proves guest code cannot access require, process
  or fetch. File layout checks alone are not treated as native execution proof.
- Execution summaries, durable `exec.begin` observations and their existing bus
  events include an allowlisted runtime record. Readiness also persists it in
  `iac.status.runtimeReadiness.checks[checkId].runtime`: function/version, log
  stream, initialized instance identity/time, graph-execution count, Node ABI,
  platform/architecture and native module availability/path/version. No tokens,
  identity claims or environment dump are included. A first graph execution is
  explicitly distinct from a cold Lambda request.
- A late result from an older readiness run remains in history without
  replacing the latest-started run's current status. Containment stays enforced;
  authentication, approval and application IAM are unchanged.

The layer layout and compatibility requirements follow
[AWS Node.js layer guidance](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-layers.html)
and the [Node 22 Lambda runtime](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html).
The application code and CloudFormation template are outside this fix.

## Verification and release status

The 25 focused tests and the full **859-test, 56-suite** server run passed;
one unrelated opt-in paid Bedrock test was skipped. TypeScript and the paired
editor production build passed. Packaged root/assistant CloudFormation lint
passed with warnings only. All 10 IAM definitions and platform data resources
match the deployed baseline; only an obsolete API deployment snapshot rotates.

The actual packaged layer ZIP passed in the official Lambda image: Node
`v22.23.3`, ABI `127`, Linux `x64`, isolated-vm `6.2.0` loaded from
`/opt/nodejs/node_modules/isolated-vm/isolated-vm.js`. Its isolate executed and
could not access require, process or fetch. Both packaged templates together
passed layer attachment verification for **70 shared-runtime functions**.

The platform stack is `UPDATE_COMPLETE`. Read-only inspection of all 70 deployed
shared-runtime functions confirmed the native layer, Node 22, x86_64, active
state, successful updates and the exact released code SHA-256
`0rcvN+SpzHxoaYiz2wbfPj/JM0J3aZFikobW8GoO/DU=`. The published editor manifest
and entry point match the paired artifacts; CloudFront invalidation completed.
Discovery/provider selection and unauthenticated REST, WebSocket and MCP
rejection checks passed. No application stack was updated by this release.

## Authenticated acceptance evidence

Agreeable Dove graph `50dcee50-1b0b-42b6-80a0-6b64881a5cb5`, stack node
`lens-event-storage`, server node `lens-event-logger`, check `write-lens-event`.
Its existing successful deployment remains operation
`01M51XMTDPZ4EZXWF4WSJY0W7C`. The checks ran graph revision
`01M51Y6Y3FPE53001XP4G5ZJNV` without modifying graph content or its template.

| Entry point | Readiness run | Execution | Result |
| --- | --- | --- | --- |
| Actual editor readiness button, 09:10 UTC | `01M51ZKPDRCER44SHR7114FYTP` | `01M51ZKQE78TC5ZXDXCZBNHCW7` | Verified, zero errors/denials |
| MCP `iac.readiness`, 09:13 UTC | `01M51ZSGR6YA53SFMVNYGAC8B3` | `01M51ZSHP0EK40BYER8HY991JM` | Verified, zero errors/denials |
| MCP authenticated fresh event, 09:15 UTC | — | `01M51ZXABNST0FW444RR3ZYR89` | Completed, zero errors/denials |
| MCP exact duplicate, 09:19 UTC | — | `01M5203TEC8XK9MQQHM4E6JTSC` | Completed, zero errors/denials |

Each execution has a successful, correlated `deployment.runtime-invocation`
for `EventWriter` in `iac.events` and the existing observation bus. The editor
and MCP readiness calls reached application request IDs
`84f962c0-673b-41b3-b5c6-259ee1324bc7` and
`57347a14-c216-45c7-9931-45f4171d80e2`, respectively. Their graph node explicitly
asserts the returned storage confirmation and matching event ID; readiness
errors propagate rather than becoming a successful false receipt.

Fresh event `c9609cdd-807e-4dcd-889e-0eb78a5afb6f` and its exact retry used the
application's authenticated path, reaching EventWriter requests
`6afe4fe8-4dc0-4ee3-9460-746567bde932` and
`559f5d3c-c4e8-4e85-bbd2-ddd69dcc5883`. S3 persistence evidence comes from the
unchanged application's conditional `PutObject` followed on duplicate by
`HeadObject` and comparison with the stored digest metadata. A mismatch would
throw and fail these checks. This is application-path verification, not an
independent object-body dump; graph observations intentionally capture receipt
metadata rather than its payload. MCP runtime logs also expose the correlated
duplicate Lambda START/END/REPORT records. One diagnostic event was written;
no stored data was deleted or replaced.

Both readiness paths used their first graph execution in newly initialized
post-release instances. `iacReview` instance
`cd90afae-4cac-482f-bc66-9a8467f683ed` initialized at `09:08:00.066Z`;
`mcpRoute` instance `65ae513d-2d74-4603-90d9-4665e4839d37` initialized at
`09:10:30.540Z`. Both reported Node `v22.23.2`, ABI 127, Linux x64 and
isolated-vm 6.2.0 loaded from `/opt/nodejs/node_modules/isolated-vm/isolated-vm.js`.
Their CloudWatch streams independently include INIT_START and cold-init REPORT
records. Status/discovery requests initialized the functions before the graph
checks: these are fresh-instance checks, not claims that each readiness request
itself was a cold Lambda invocation. The Docker probe used Node `v22.23.3` with
the same ABI; the managed-runtime patch version was verified separately live.

After a full browser reload and reopening the CF readiness panel, the editor
displayed `Deployment completed. Runtime readiness: verified.` and the
`write-lens-event` check as verified. A fresh MCP status read identifies the
latest run as `01M51ZSGR6YA53SFMVNYGAC8B3`. The historical containment failure
is still retrievable in `iac.events`; it does not replace the current readiness
result. The intentional 08:38:44 UTC identifier-conflict test was not rerun.

Application invocations and application diagnostics used the editor/MCP only.
AWS profile access was limited to the authorized platform release and read-only
platform route, configuration and initialization diagnostics. Containment and
graph isolation remain enabled. No application code, template, IAM authority,
stack, bucket or surviving resource was deleted or recreated.

---

# Previous release: graph-authored CloudFormation templates

October 16, 2026. Source server **2.8.0**, lifecycle contract **1.5.0**,
assistant contract **1.1.0**, template contract **author-template-v1**.
Server `11db793ed91f0cbb318a774073e3f038a887097f` and editor
`ec5735661fdf1f3284c5f578275ddb454724d840` are pushed and deployed to account
`230639770018`, region `us-west-1`. The platform stack completed its update;
the paired editor is published at https://d2fqgid0yzbc85.cloudfront.net/graph-editor/.

The Agreeable Dove report (`50dcee50-1b0b-42b6-80a0-6b64881a5cb5`,
`lens-event-storage`) exposed contradictory platform checks. Early strict
validation ran without the deployed template, treating unchanged finite log
retention as newly introduced data removal. Omitting retention then hit
`COST_UNBOUNDED`. Both application-template vetoes have been removed.
No live application was edited, deployed or diagnosed as part of this change.

## Template and approval contract

- Inline YAML/JSON bytes, including whitespace and omitted properties, go to
  `CreateChangeSet` unchanged. An explicit inline template takes precedence over
  connected resource fragments; assembly is selected only when it is absent.
  Graph resource fragments preserve their authored
  properties, `DeletionPolicy` and `UpdateReplacePolicy`; assembly does not add
  even an empty `Properties` object when it was omitted.
- Finite/omitted log retention, S3 lifecycle expiration, TTL, queue retention,
  backup/index changes, billing/capacity, Lambda sizing and concurrency settings
  are author choices. They no longer trigger cost or application-preservation
  policy rejection. No execution-role permissions were expanded. Known Lambda
  concurrency permission dependencies are reported separately in preflight;
  passing static validation is not proof of effective AWS authorization.
- `preservation: "strict"` is retained for compatibility, with explicit narrowed
  semantics: it constrains separate stack deletion, destructive recovery fallback
  and platform guardrail changes. It does not promise that authored application
  settings preserve data or prevent resource removal/replacement. Application
  execution no longer adds rollback flags overriding AWS defaults.
- Review compares the proposed template with the actual current AWS template.
  `plan.consequences` reports explicit versus omitted values, retention/lifecycle
  changes, removals, replacements and their consequences, including ongoing
  unchanged expiry settings. Consequential changes require human confirmation;
  automatic modes defer them to manual review. The same report is available in
  the CF node, deployment modal, MCP status and durable observation bus.
- The input digest binds template bytes, parameters, capabilities, target and
  contract version. The review digest additionally binds the graph revision and
  reviewed consequences. Approval checks the current graph content/revision.
  The worker revalidates immutable approved input, checks the change-set summary,
  and compares AWS's original change-set template with the approved definition
  before execution. Existing approvals from the old contract cannot execute under
  the new semantics; cancel pending reviews and prepare fresh ones.
- Recovery imports no longer inject `Retain` policies. They preserve each
  authored resource definition. Where CloudFormation requires an explicit
  `DeletionPolicy` for import, absence produces `IMPORT_DELETION_POLICY_REQUIRED`
  rather than changing the template. Recovery still has a separate approval.

Parsing, structural resource/policy validation, configured deployment capabilities,
authentication, graph authority, account/namespace isolation, immutable IAM
boundaries and restricted role passing remain enforced. The default resource
count now follows CloudFormation's 500-resource structural limit, not a budget
policy. AWS permission denials and change-set validation errors retain their
service-specific details. The platform never empties a bucket to force deletion.

AWS documents the defaults and effects for
[DeletionPolicy](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html),
[UpdateReplacePolicy](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-updatereplacepolicy.html),
and [log retention](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-logs-loggroup.html).
An explicit policy remains subject to AWS validation; `UpdateReplacePolicy:
Snapshot` on a resource without snapshot support can fall back to deletion.

## Verification and release status

Regression coverage uses disposable in-memory graphs and mocked AWS SDK calls.
It verifies the exact submitted body and approved change-set identity, unchanged
30-day WriterLogs settings, omitted retention/policies, S3 lifecycle settings,
resource removals/replacements reaching human review, import policy fidelity,
old-contract/stale approvals, tampered templates/change sets, authentication,
cross-graph and namespace rejection, observation parity and AWS error attribution.
The editor tests cover the current/reviewed settings and omitted-default labels.

Validation: **852 server tests passed across 54 suites**; the unrelated opt-in
paid Bedrock test was skipped. All **40 infrastructure editor integration tests**
passed, both server/editor type checks passed (zero editor errors), and the final
production editor build passed. A source-template comparison confirmed that all
platform CloudFormation resource definitions and IAM configuration are unchanged.
Whitespace/diff checks pass in both repositories.

The deployment fidelity regression is in
[`templateSubmission.js`](src/__tests__/templateSubmission.js); its SDK calls
are mocked. No application deployment or application logging test has been run
for this change. Agreeable Dove's Lambda execution and S3 logging remain
unverified. Pending pre-release reviews need cancellation and fresh preparation
under the new contract, followed by separate human approval.

The paired release used the normal Serverless package/deploy lifecycle and the
editor publishing steps defined by CI, with the approved platform profile. Packaged parent
(499 resources) and assistant (9 resources) templates passed CloudFormation lint
with warnings only. Comparison against the deployed templates confirmed all
10 IAM definitions and all platform data resources were unchanged. Only the old
API Gateway deployment snapshot was retired. No application stack, bucket,
role, graph content or stored application data was changed.

Live verification completed at `2026-10-16T08:24:09Z`: platform status
`UPDATE_COMPLETE`; packaged code hashes matched the active MCP, infrastructure
review/worker and both assistant functions; editor release manifest and entry
point matched the paired artifacts; CloudFront invalidation completed. Cognito,
paired API endpoints and the enabled Opus agent were preserved. The normal
discovery/provider checks and unauthenticated HTTP, WSS and MCP rejection checks
passed.

Read-only MCP preflight on disposable graph
`e76298c1-3d45-47ed-be95-19e1104ebab2` advertised `author-template-v1` and accepted
otherwise valid fixtures with explicit 30-day retention, S3 lifecycle and
deletion/replacement policies, and fixtures omitting those settings. Negative
fixtures outside the assigned namespace or missing the required S3 public-access
blocks were rejected. These are live static-preflight results; effective AWS
permissions remain explicitly unverified, and no review or deployment was
created. Future CI releases should pin the full editor revision above through
`EDITOR_REF` (or the workflow's `editor_ref` input) and preserve this environment's
existing Cognito, API-prefix and enabled Bedrock configuration.

---

# Previous release: Bedrock Opus and AI Permissions

October 15, 2026 (release checks completed October 16 UTC). Server **2.7.0**,
assistant contract **1.0.0**, lifecycle contract **1.4.0**. Server `22376da` and
editor `c6471eb` are pushed and deployed to account `230639770018`, region
`us-west-1`. The platform stack completed its update; the paired editor is
published at https://d2fqgid0yzbc85.cloudfront.net/graph-editor/.

The [Opus contract](BEDROCK_AGENT.md) documents private `@opus` conversations,
real MCP tool schemas, graph-scoped delegation, approval separation, strict
preservation, usage limits, interruption behavior and CI configuration.

Release scope includes the previously completed AI Permissions feature below.
New infrastructure is one retained assistant nested stack containing the private
worker and bridge, queue, retained dead-letter queue, alarm and dedicated worker
role. This keeps the existing 498-resource platform below the 500-resource limit.
Packaging/upload happen in the standard Serverless lifecycle and CI.
The shared server role gains only SendMessage to that queue. Existing application
roles, stacks, buckets and stored application data are outside this release.
API Gateway deployment snapshots rotate as part of the existing release process.

The final full server suite passed **836 tests** across 53 suites, with one
opt-in paid test skipped in that run and passed separately. After upgrading
the production MCP client to 2.3.1, all 56 affected MCP and assistant tests also
passed. Editor chat integration (8), local browser chat/AI Permissions (2),
TypeScript checks, production build and CI configuration (6) passed.
Actual Opus 5.5 inference created an uncommitted rename proposal on a synthetic
in-memory graph (37,508 input / 473 output tokens), leaving the graph unchanged.

Live deployment verification used MCP on disposable graph
`e76298c1-3d45-47ed-be95-19e1104ebab2`. An authenticated `@opus` message produced
durable private thinking/tool/done messages. The deployed worker used
`server.discover` and `graph.summary`, then correctly reported
“Disposable platform recovery acceptance” and two nodes. Independent MCP
inspection confirmed revision `rev_01M4GND8AQC9N2CDBJ12Z7ATMF` was unchanged.
This verifies deployed worker IAM, Bedrock inference, the private bridge and
durable chat delivery. It does not claim a live signed-in browser test or an
application deployment. The standard deployed discovery, provider-selection
and unauthenticated HTTP/WSS/MCP rejection smoke checks passed.
Both deployed assistant Lambda code hashes match the reviewed package and both
functions are active. The editor's public release manifest and index match the
paired artifacts; CloudFront invalidation completed.

The production dependency audit now reports **zero vulnerabilities**. A writable
cache resolved the audit failures; the MCP client was upgraded for its published
OAuth security fix. Current platform configuration was read without modification.
CloudFormation validation passes for the 499-resource parent and 9-resource
assistant child. Both authentication-provider bundle checks pass. The child
template is digest-bound and uploaded by the normal deployment hook; packaging
regressions reject dangling references and modified artifacts.
No application or data resource has been changed. For subsequent CI releases,
set environment variable `BEDROCK_AGENT_ENABLED=true` and pin `EDITOR_REF` to
`c6471eba2d505ed823d01da58d3bd3b7dc22c367` or a reviewed successor. Opus is enabled
in the deployed release; GitHub environment settings were not changed here.

---

## Included feature: AI Permissions

The following implementation notes were recorded October 9 and are included in
the current 2.7.0 paired release. They are not a separate active release review.

The lower system bar replaces infrastructure Auto-approve with **AI Permissions**:
Manual, Safe Actions and Fully Automatic. Both automatic modes require a warning
confirmation and are scoped to the current graph/editor session. Reload, graph
change or an approval refusal returns the editor to Manual. Mode changes fence
pending reads; duplicate digest attempts are suppressed. Existing agent
permissions and autonomy settings are unchanged.

Safe Actions accepts names, descriptions and layout. It approves only retained
S3 bucket, DynamoDB table, SQS queue and log group additions without application
access-policy changes; resource-changing recovery stays manual. Fully Automatic
also accepts validated code/wiring/infrastructure proposals and eligible
non-destructive deployments and bounded recovery. Neither mode auto-approves
stack deletion, resource removal/replacement, rollback/data loss, node removal,
approval-policy changes or budget changes. Graph acceptance and deployment
approval remain distinct audited operations with their own exact digests.

The server advertises mode-specific `{allowed,reason}` decisions and repeats
eligibility at approval. Human sessions are required; MCP cannot select a mode
or gain approval authority. Editor requests carry `aiPermissionMode` and the
current digest. Durable infrastructure approvals and proposal commit records /
bus events record the selected mode. New editors fail closed on older servers.
Legacy `approvalMode=automatic` retains its existing non-destructive limits.

Validation: the full 823-test server suite passed; the changed approval/discovery
suites passed again after final edits. All 27 focused editor integration tests,
server/editor TypeScript checks, production editor build and both local Playwright
tests passed. The browser tests cover mode selection, the warning, exact proposal
and deployment request bodies, Safe/Full separation, Manual switching and reload
reset. Final menu appearance was inspected. These are local/mocked checks, not AWS
deployment evidence. No application templates, resources or data were changed.

This feature is included in the deployed paired release above. AI Permissions
itself adds no IAM grants. Modes remain Manual until a person explicitly enables
one in the editor.

---

# Application-role deployment permissions — released baseline

Updated October 9, 2026. Server **2.5.2** deployed at `fcb0326`, lifecycle contract
**1.3.0**. Live retained-role creation verification completed through MCP and
human graph approvals; no application stack or stored data was deleted.
This replaces the previous current review; cancellation/preservation release
history remains in commit `040f2c3`. Jolly Fish application code and its template,
Chess, and GLM-5/Nova integration are outside this platform change.

## Incident and evidence

Graph `3fe65c37-01f3-43fd-b87b-4cab45c002cb`, node `npc-room-stack`, deployment
`01M4FR3PG8QYHTEFQVYACNJ6TB`, assessment `01M4FRB7CSMGVRDDPV11A267V1`, account
`230639770018`, region `us-west-1`.

MCP events and a read-only platform CloudTrail audit identify these calls by
`arn:aws:iam::230639770018:role/graph-deploy/gapp-d6e18e224997c1afa946d739-execution`:

| UTC time, October 9 | Action | AWS request ID |
| --- | --- | --- |
| 07:14:28 | `iam:GetRolePolicy` | `11af2fdf-9042-4c4b-8f1e-bdc0d2e129df` |
| 07:14:29 | `iam:GetRole` | `3058ca0d-2215-4d53-ae96-796c92257e07` |
| 07:14:32 | `iam:ListRolePolicies` | `42459f34-7929-4ced-9a52-c3427a9f1ec2` |
| 07:14:32 | `iam:DeleteRolePolicy` | `9daf01b4-68a0-4305-8413-9a5b04d07364` |

All four report an explicit identity-policy deny on role
`gapp-d6e18e224997c1afa946d739-memory-role`. No `CreateRole` call by this execution
role appears in the incident window. The installed role has only the inline
`isolated-stack` policy and no attached managed policies. Its only deny matching
these actions is `Deny iam:* NotResource role/graph-app/<namespace>*`.

AWS IAM simulation at **07:35:59Z** identifies that statement in
`role_gapp-d6e18e224997c1afa946d739-execution_isolated-stack`, document columns
4254–4382. For each of the four actions it reports:

- `arn:aws:iam::230639770018:role/gapp-d6e18e224997c1afa946d739-memory-role`:
  **explicitDeny**.
- `arn:aws:iam::230639770018:role/graph-app/gapp-d6e18e224997c1afa946d739-memory-role`:
  **allowed** by the existing lifecycle statement, columns 2013–2436.

This establishes the generated-policy defect for name-only existence probes.
The historical denied CloudTrail entries omit request parameters and full
resource ARNs; the root-name ARN is reconstructed from the named resource and
verified in IAM simulation, not falsely presented as a CloudTrail ARN field.
Simulation is policy evidence, not proof of successful CloudFormation execution.

A fresh IAM `GetRole` at **07:31:19Z** returned `NoSuchEntity` for the memory role.
CloudFormation's `DELETE_FAILED` record therefore does **not** establish that a
physical role survived. MCP still reports the application `ROLLBACK_FAILED`,
guardrails `CREATE_COMPLETE`, memory bucket `DELETE_SKIPPED`, and log group
`DELETE_COMPLETE`. No stack/resource deletion, data access, application repair,
or Jolly Fish recovery execution occurred during this investigation.

## Correction and security boundary

`executionPolicy` permits only `GetRole` and `GetRolePolicy` on the assigned
namespace's name-only ARN for pre-creation reads. The explicit isolation deny
is retained, split into named statements:

- `DenyIamOutsideAssignedRoles`: deny IAM outside the assigned application path
  and the assigned name-probe namespace.
- `DenyNameOnlyRoleMutation`: deny every action except the two existence reads
  on name-only role resources, including `CreateRole`, `PutRolePolicy`,
  `DeleteRolePolicy`, `DeleteRole`, boundary changes and `PassRole`.

Normal creation, inline-policy management/cleanup and role deletion remain
limited to `/graph-app/<assigned namespace>*`. Required immutable permissions
boundary and Lambda-only role passing are unchanged. Another graph, another
path, platform deployment roles and guardrail policies remain protected.
No shared platform IAM grant is added.

The cleanup denial was downstream of the pre-creation failure. This correction
prevents that initial failure; it does **not** grant root-path inline-policy
deletion as a shortcut. IAM authorization cannot prove that a role is absent
from its name alone. Granting that write would also permit modifying an existing
root-path role. Cleanup of never-created role records remains a disclosed
limitation, especially when another independent policy prevents creation.

## MCP contract and diagnostics

Existing `iac.inspect` now includes `applicationRoleLifecycle`:

```json
{
  "kind": "document-analysis-and-physical-role-reads",
  "executionRoleArn": "arn:aws:iam::<account>:role/graph-deploy/<namespace>execution",
  "deploymentTested": false,
  "roles": [{
    "logicalId": "Role", "name": "<namespace>runtime",
    "expectedArn": "arn:aws:iam::<account>:role/graph-app/<namespace>runtime",
    "actualArn": null, "exists": false, "cloudFormationStatus": "DELETE_FAILED",
    "checks": [{"phase":"before-creation","action":"iam:GetRole",
      "resource":"arn:aws:iam::<account>:role/<namespace>runtime",
      "result":"explicit-deny"}]
  }]
}
```

The example describes the **old installed policy**. A corrected installed policy
reports `allowed-by-document` for that read. `checks` analyze the installed
execution policy, now including `NotResource` and `NotAction` denies. Conditions
remain `conditional-or-unknown`; SCPs and session policies are not evaluated.
`exists` can be true, false or `unknown`. Access denial is never absence. Actual
application-role reads run under the platform inspector; they are not claims of
successful execution under the CloudFormation role. Foreign role path/boundary
or unverified inventory blocks recovery.

`iac.preflight.effectivePermissions` explicitly reports `status:unverified`,
explains that static `deployable:true` is not effective AWS authorization, and
points to inspection and separately approved deployment verification.
`server.discover` publishes these schemas and explanations. Inspection continues
through the existing durable events/bus, `iac.events` and `observations.watch`;
no private UI-only diagnostics are introduced.

## Preservation and safe next step

A platform release changes the **definition for future guardrails**. It does not
rewrite Jolly Fish's installed execution policy or authorize recovery/deployment.
Existing guardrails require a fresh, exact-digest human recovery approval.

The post-release recovery assessment is recorded below. A fresh MCP inspection
at **16:05:05Z** confirms Jolly Fish remains `ROLLBACK_FAILED`, its bucket remains
`DELETE_SKIPPED`, and IAM still reports the role absent. The installed per-stack
guardrail policy has not been reconciled. Ordinary CloudFormation updates are
unsupported in this failed-create state. The strict recovery path remains
blocked, with **no stack
deletion, replacement, import, bucket emptying or destructive fallback**.

If that state persists, leave the original stack and retained bucket intact.
A platform administrator can ask AWS Support whether a non-destructive
service-side repair exists. Alternatively the application owner can separately
review a new stack node/namespace; adopting or migrating the retained bucket is
not currently supported by the isolated application subset and requires its own
preservation design and approval. Neither alternative is executed here.

References: [IAM GetRole](https://docs.aws.amazon.com/IAM/latest/APIReference/API_GetRole.html),
[IAM paths and account-unique role names](https://aws.amazon.com/blogs/security/optimize-aws-administration-with-iam-paths/),
[CloudFormation stack states](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/view-stack-events.html).

## Verification and release state

- **819 tests / 51 suites pass**, including policy-deny precedence, pre-creation
  existence probes, legitimate path-scoped lifecycle operations, foreign paths,
  cross-graph resources, boundary enforcement, PassRole, absent versus denied
  physical-role inspection, ownership mismatches, cancellation and preservation.
- TypeScript passes; five release-configuration tests pass; both Auth0 and
  Cognito production Lambda bundles build.
- Policy matrix and lifecycle fixtures are **local/simulated evidence**. AWS
  CloudTrail/IAM reads and IAM simulation above are separate evidence.
- Initial IAM platform release **completed**: commit `b6dbb00b7ebb3a3a5a7e8483466366ee13d9c727`
  is pushed and deployed. Platform stack `pio-auth-test-230639770018` reached
  `UPDATE_COMPLETE`. The reviewed diff changed 75 Lambda code references and the
  API deployment snapshot; no shared IAM, environment or persistent-resource
  changes. Verification at **07:43:55Z** matched eight critical function package
  hashes, 72 protected REST methods, authenticated WebSocket connection handling,
  and 30 anonymous/invalid-token rejection checks. Standard deployment smoke
  checks passed. Editor build and assets remain unchanged.
- Post-release MCP inspection confirms MemoryRole `exists:false`, its historical
  `DELETE_FAILED` record, and the old installed execution policy's probe denies.
  New strict recovery assessment **`01M4FSY6WXT10FX54VJB9J19HB`**, digest
  `10a2026a60d8ff3e3fef2edfa13e54388c54cfe33c6734feca7a33ddb52cb9ac`,
  is **recovery-blocked** by application `ROLLBACK_FAILED`. It proposes only fixed
  guardrail reconciliation and operation release, with no destructive actions.
  Nothing was approved or executed. Its review is durable in `iac.events` and
  `observations.watch` with the same event ID and digest.
- Follow-up **`fcb03260f5c87f6e2ec69f9cfc4695a411f664cd` is pushed and deployed**.
  Platform stack reached `UPDATE_COMPLETE`; its update began at **15:57:47Z**.
  The reviewed diff added only the scoped `DescribeChangeSet` read below,
  changed 75 Lambda code references and replaced the API deployment snapshot.
  Verification at **16:01:42Z** passed eight function hashes, 72 protected REST
  methods, WebSocket authentication, 30 anonymous/invalid-token rejection
  probes, private worker checks, and the new installed read grant. Standard
  discovery/authentication smoke passed; editor assets/configuration stayed
  unchanged. The release used the established reviewed, pinned package process
  with the authorized platform profile; it was not a GitHub Actions run.
- Disposable graph acceptance, manual exact-digest deployment approval, and
  actual CloudFormation role creation **completed**. Details follow.
- Jolly Fish: inspection only; no recovery or application deployment approved or
  executed by this change. Successful runtime operation is not claimed.

## Resumed live verification — empty creation review regression

Disposable graph `e76298c1-3d45-47ed-be95-19e1104ebab2`:

- Proposal **`01M4FSQB86BE20KCPBXJ5JT20E`**:
  “Platform IAM regression: retained role creation and inline policy”.
- New node `platform-role-path-test`, assigned stack
  `gapp-c2f4ae64f32eb41ea695c9f1-stack` and separate guardrails
  `graph-guardrails-c2f4ae64f32eb41ea695c9f1`.
- One retained `/graph-app/` role with the assigned boundary and an inline
  `s3:ListBucket` policy limited to its own unused bucket name. No Lambda,
  application code, bucket, data or deletion is part of the fixture.
- Human graph acceptance produced revision
  `rev_01M4GND8AQC9N2CDBJ12Z7ATMF`. MCP `iac.review` with
  `preservation:"strict"` created operation **`01M4GNEFBDM5T3NCDDBRF490ZN`**.
- Its guardrail stack reached `CREATE_COMPLETE` at **15:45:54Z**. MCP inspection
  verified matching installed roles/boundary and actual successful worker-role
  assumption. At that point only the application change set existed; the
  application role and deployment approval were still pending. Auto-approve
  stayed off throughout this test.
- At **15:46:08Z**, the next planning step rejected `OWNERSHIP_UNVERIFIED`:
  CloudFormation's empty `REVIEW_IN_PROGRESS` stack had the expected ARN and
  service role but no stack tags. Ownership tags reside on the CREATE change
  set until execution. MCP and the CF node exposed this failure.

The generic follow-up verifies that exceptional state using the **server-recorded
operation and exact change-set/stack IDs**, change-set graph/node/namespace tags,
assigned role, and a complete empty resource inventory. It never infers ownership
from a name alone. Denied or partial reads, conflicting tags, changed IDs, an
executing change set, and existing resources fail closed. The empty record has no
deployed template, so inspection does not try to read one. Verified evidence is
carried into fresh reviews/recovery records and rechecked against AWS; old
deployment approvals are never carried over. A verified empty review requires no
stack deletion or import.

`iac.inspect.application.reviewStackProof` exposes
`{graphId,nodeId,operationId,stackId,changeSetId}`. Discovery describes this evidence
and its limits. The platform worker needs only the additional read
`cloudformation:DescribeChangeSet` on `stack/gapp-*/*` and
`changeSet/review-gapp-*/*` in the configured account and region. Application
roles, boundaries and role-passing grants are unchanged.

**819 tests / 51 suites pass**, including 18 new empty-review ownership and
preservation cases. TypeScript, five release configuration checks, and both
Auth0/Cognito Lambda bundles pass. Deletion/cleanup has local policy/fixture
coverage only; it was not executed in AWS under the preservation restriction.

References: [CREATE change-set empty stack behavior](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_CreateChangeSet.html),
[change-set tags before execution](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_DescribeChangeSet.html).

## Live outcome and evidence limits

The same review passed the new ownership checks without deleting or recreating
its stack record. It reached `awaiting-review` at **16:00:28Z**. The user approved
it manually in the graph at **16:02:25Z**, digest
`758516fad51e8215d0cba9f723c204561127bbf8058eb1427820aca1eb32badc`.

- `ProbeRole` reached `CREATE_COMPLETE` at **16:02:55Z**; its stack completed at
  **16:02:58Z**. MCP reported `succeeded` at **16:03:03Z** and orchestration
  `SUCCEEDED` at **16:03:04Z**.
- `iac.inspect` at **16:03:58Z** verified actual role ARN
  `arn:aws:iam::230639770018:role/graph-app/gapp-c2f4ae64f32eb41ea695c9f1-probe`,
  assigned boundary, stack ownership, matching guardrails, successful worker
  assumption, and **no current blockers**. The reviewed template includes the
  namespace-limited inline policy. Successful CloudFormation creation is live
  execution evidence; its separate policy-document fields remain analysis,
  including `conditional-or-unknown` for conditional grants.
- The CF node and review modal displayed **Deployment complete**, **Approved**,
  and **Execution: Complete**, with the expected role ARN output.
- `iac.events` recovered durable history in two pages. Resuming
  `observations.watch` from its saved cursor recovered approval and terminal
  events. All **six** approval/terminal events had identical IDs, digests and
  payloads (excluding the watch arrival cursor). Duplicate deliveries were
  deduplicated by event ID. Earlier ownership exceptions remain historical;
  they are not current permission failures.
- This is a role deployment fixture, with no application code or runtime. It
  establishes actual role creation and inline-policy provisioning through the
  constrained CloudFormation execution role. It does not establish application
  runtime readiness, multiplayer behavior, AWS cleanup success, or live
  cross-graph denial. Negative isolation and cleanup coverage is local/simulated.
- Jolly Fish assessment `01M4FSY6WXT10FX54VJB9J19HB` remains unapproved and
  `recovery-blocked`, with the unchanged strict digest above. The exact safe
  next step is to **leave the failed stack and retained bucket intact**. A
  platform administrator can request AWS Support assessment of non-destructive
  repair. A separately approved new namespace and retained-data migration
  design is an alternative, not an automatic or currently implemented adoption
  path. Jolly Fish application shipping belongs to its application agent.

- Do not execute the Jolly Fish recovery assessment or change its application.
  No stack deletion or data removal is authorized, including test stacks.

Release package, diff, smoke results, verification and scoped MCP evidence:
`/private/tmp/graph-role-permissions-release-b6dbb00/`. Incident audit and IAM
simulation: `/private/tmp/jolly-platform-incident-evidence.json` and
`/private/tmp/jolly-policy-simulation.json`. These are verification artifacts;
the source and this durable review are in the repository.

Follow-up package and final verification:
`/private/tmp/graph-review-stack-release-fcb0326/`, including
`package-review.json`, `platform-template-diff.json`, `verification.json`,
`fixture-before-release.json`, and `fixture-live-verification.json`. Full test
and provider-bundle logs are `/private/tmp/graph-review-stack-tests.log` and
`/private/tmp/graph-review-stack-auth-builds.log`. No release process remains
running. Disposable stacks/roles are retained; no cleanup is authorized.
