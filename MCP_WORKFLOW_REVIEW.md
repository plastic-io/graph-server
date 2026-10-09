# Graph MCP lifecycle — current platform review

Updated October 8, 2026 (PDT). This is the current review artifact for server
**2.5.0**, lifecycle contract **1.3.0**. It supersedes the previous recovery
instructions. The application agent owns Chess. This change does not edit its
code/template, approve or cancel its recovery, deploy it, delete stacks, empty
buckets, or delete application data.

## Confirmed state and evidence

Read-only MCP inspection at **2026-10-09T05:32:26.961Z** checked graph
`f1963a3b-7e9a-43b3-87ee-068d56431374`, node `node-chess-storage-stack`, pending
recovery `01M4FHYTX8V4JNANJC61P6BK68`:

- Recovery was unapproved; its workflow had **not started**. The pending review
  held the fence that prevented an ordinary deployment review.
- Guardrail `graph-guardrails-15688bf738201d31d8fb7d29` was `ROLLBACK_FAILED`.
  The application was `NOT_CREATED`. Both assigned roles were absent, with actual
  IAM `NoSuchEntity` results, rather than access-denied/unknown results.
- The retained runtime boundary existed and matched its approved definition.
- The 20 then-published policy-document checks allowed the checked operations.
  Actual role assumption was **not tested**, because the role was absent.
- Historical `GetRole`, `GetRolePolicy` and `DeleteRolePolicy` denials remain
  historical evidence, not a new assertion of missing current permissions.

A separate read-only **platform** audit at **2026-10-09T06:01:58.998Z** read the
currently deployed worker and guardrail role trust and inline policies in
`230639770018 / us-west-1`. The historical grants are already present. No new
IAM grant was justified, and this release changes no platform IAM policy.
Policy hashes: worker `4b0b6a7ea0b2268d4cc52b06658a9f99efb46cd3b9787d1389eb53102b2919c9`;
guardrail `680f48aad3d6ca0491f2994f56e8441daf913d7289d5c832559b077b6b110617`.
These are actual **reads**, not proof of successful deployment execution.

## Implemented MCP contract

`server.discover({"schemaVersion":1,"topic":"lifecycle"})` publishes the actual
input schemas, result schemas, examples, permissions, state transitions,
cancellation semantics and preservation limits. The `iac.review` discovery
schema is shared with its registered tool schema.

| Tool | Behavior |
| --- | --- |
| `iac.cancel` | Requires graph-scoped `graph:read` and `iac:propose`, exact graph/node/current operation ID, optional bounded reason. Cancels an unapproved deployment or recovery review. No AWS resource call occurs. |
| `iac.inspect` | Optional `preservation:"strict"` reports current state limitations without changing AWS. Static template validation, current document analysis, actual AWS reads/assumption and historical failures remain distinct. |
| `iac.review` | Optional `preservation:"strict"` prepares a separately approved deployment review. After cancellation, `retryOf` can link to the cancelled operation. Fresh AWS readiness can still block it. |
| `iac.recovery.plan` | Optional `preservation:"strict"` binds preservation into the immutable recovery digest. Unsupported in-place states return prerequisites without destructive actions. Required idempotency key remains unchanged. |
| `iac.status`, `iac.events`, `iac.history`, `observations.watch` | Expose cancellation, invalidated digests, constraints, blockers and allowed next actions, through the same durable envelopes published on the graph bus. |
| `iac.maintenance.request` | Still record-and-verify-only. It cannot modify IAM or trigger a release, recovery or deployment. Platform-admin configuration is not needed to cancel an unapproved review. |

Example for an application agent, using the operation returned by status:

```json
{"tool":"iac.cancel","arguments":{"schemaVersion":1,"graphId":"example","nodeId":"stack","operationId":"01M4C000000000000000000000","reason":"Discard the unapproved recovery; preserve all existing stacks and resources."}}
{"tool":"iac.inspect","arguments":{"schemaVersion":1,"graphId":"example","nodeId":"stack","preservation":"strict"}}
{"tool":"iac.review","arguments":{"schemaVersion":1,"graphId":"example","nodeId":"stack","retryOf":"01M4C000000000000000000000","preservation":"strict"}}
```

Cancelling requires no deployment approval. A successful review still needs its
own exact-digest human deployment approval. Inspecting, monitoring, cancelling,
or approving recovery never grants application deployment approval.

### Cancellation and concurrency

Eligible states: `awaiting-review`, `recovery-ready`, `recovery-blocked`,
`expired`, `stale`, with no approval, execution start or recovery dispatch.
Planning, approved and executing work is refused with `REVIEW_NOT_CANCELLABLE`.
`execution.cancel` remains a separate graph-runtime operation.

A conditional operation write is the linearization point shared with approval:
state becomes `cancelled`, `reviewInvalidatedAt` is set, deployment/recovery
approval digests become null, and the owned fence is logically free. S3 has no
multi-object transaction. Physical fence cleanup is conditional on the same
operation ID; a retry or `iac.status` completes it and the durable event outbox
after interruption. It cannot clear a newer operation's lock. The old worker
cannot execute cancelled work, even when its delivery is delayed.

Duplicate cancellation returns the original result. Old digests remain in the
cancellation audit record as **invalidated** evidence. Expiry does not require a
live worker to release the fence. Unexecuted change sets remain inert metadata;
cancellation does not call DeleteChangeSet or any other AWS resource API.

The bus event is `deployment.review.cancelled`, correlated by graph/node/operation,
revision and input digest, with `reviewDigest:null`, terminal state and
`lifecycle:{approvalValid:false,lockReleased:true,cancellation:{...}}`. Stable
IDs, cursor replay, deduplication and outbox recovery are unchanged.

### Strict preservation

The constraint is part of the approval digest and inherited by subsequent
reviews on that node. Omitting it cannot silently downgrade a strict review.
The option on `iac.inspect` is advisory; specify it on the review itself.

- Require `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain` on application
  resources. Reject removals, replacements and uncertain replacement analysis.
- Reject deployment-induced deletion through S3 lifecycle expiration, enabled
  DynamoDB TTL, reduced queue retention, introduced/reduced log retention,
  removed indexes or reduced point-in-time recovery history.
- Check current stack state before preparatory guardrails, and recheck the
  actual change set/current template before application execution.
- Set CloudFormation `DisableRollback:true` for strict guardrail creation,
  supported in-place reconciliation and application change-set execution.
  Failed work remains for inspection; there is no automatic destructive rollback.
- Fixed role-policy/trust updates and additions can reconcile stable guardrails
  in place. Boundary document/version changes, deletion, import and unverified
  rollback paths are blocked. Strict operations retain change-set metadata.

CloudFormation does not permit an ordinary in-place update of `ROLLBACK_FAILED`,
`ROLLBACK_COMPLETE` or `DELETE_FAILED`. Strict requests return
`PRESERVATION_BLOCKED`, with a `PRESERVATION_IN_PLACE_UNSUPPORTED` problem,
component/status/resource, `limitation:"aws-stack-state"`, and non-executing
alternatives: leave the stack intact; independently review a separate stack
node/namespace without adopting existing resources; or ask AWS Support about a
possible service-side repair. No such repair is promised or performed.

`CREATE_FAILED`, `UPDATE_FAILED`, `UPDATE_ROLLBACK_FAILED` and import/rollback
paths currently return `PRESERVATION_STATE_UNVERIFIED`. AWS has retry/rollback
APIs, but the platform does not yet prove that every resource survives them.
This is a platform verification limit, separate from an AWS state restriction.
Finite log-retention introduction is incompatible with strict preservation;
the existing cost policy also rejects unbounded log groups. A generic retention
capability would need its own review. No application-specific exception is added.

Preservation governs deployment/recovery effects. It does not suspend application
traffic, existing retention/TTL processing, independent administrator actions,
or deliberately invoked application code. It is not a backup guarantee or
indefinite SQS retention.

AWS references: [stack states](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/view-stack-events.html),
[ExecuteChangeSet](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_ExecuteChangeSet.html),
[UpdateStack](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_UpdateStack.html).

## Scoped permission audit

The inspector now checks 30 current guardrail-policy action/resource pairs,
covering fixed-definition creation, inspection, policy/trust updates and legacy
rollback/cleanup. This expansion adds no AWS calls or IAM grants. Absence probes
use the existing restricted root-name read/inline-policy-cleanup grants; creation
and mutation remain restricted to `/graph-deploy/gapp-*`. Boundaries remain
restricted to `/graph-guardrails/gapp-*`.

Tests pin AWS IAM resource-provider handler requirements and distinguish optional
properties the fixed definition cannot request (managed-policy attachments,
role-boundary changes, description/session-duration edits) from operations it
actually uses. Account-wide IAM list authority is not added. The platform worker's
CF calls target guardrail namespaces; application workers operate only their
assigned stack/change sets and can pass only their own CF execution role. The
application execution policy retains boundary enforcement, restricted Lambda
role passing and explicit foreign-resource/shared-IAM denials. Read-only
`logs:DescribeLogGroups` remains the documented unscoped exception.

The installed SDK v2 does not accept `RetainExceptOnCreate`; its strict CF requests
omit that field (AWS default false) and set supported `DisableRollback:true`.
SDK v3 application/guardrail requests explicitly set the deletion override false.
No application role receives platform IAM repair authority.

## Verification and release status

Passing: **793 server tests in 49 suites**, TypeScript, five deployment-config
tests, both Auth0/Cognito Lambda builds and MCP schema assertions. After the
final error/discovery changes, 103 affected tests passed again. Jest uses the
repository's existing `--forceExit` workaround for a test-harness handle.
New coverage uses disposable in-memory graphs, the real MCP SDK/handler and
simulated AWS adapters. It proves:

- Pending recovery/deployment cancellation, expiry, duplicate requests, interrupted
  fence cleanup, newer-lock protection, and both approval/cancellation race winners.
- Delayed workers and stale digests cannot execute cancelled work. Cross-graph,
  wrong-node, unauthenticated and executing-operation cancellation are rejected.
- Fresh review after cancellation reaches current-state checks instead of the old
  recovery lock error. Unsupported in-place recovery never offers destructive actions.
- SDK request flags preserve failed creations; in-place role-policy reconciliation
  completes in a fixture without deleting its stack or boundary. Application
  deployment remains separately approved.
- Strict review and worker checks reject delete/replacement/uncertain/import
  actions and deployment-induced data removal. Existing cross-stack/shared-IAM
  denial tests pass.
- The MCP cancellation event, durable history, reconnect/cursor replay and graph
  bus carry consistent data.

These tests are not live AWS execution or a human approval. Prior live disposable
fixture evidence remains in git history: graph `e76298c1-3d45-47ed-be95-19e1104ebab2`
created guardrails/queue and encountered an intentional table failure. Its
historically approved delete/import attempt is not authorization to repeat it.
The current task performs no stack or data deletion. Its old destructive
instructions are retired by this artifact.

Released server commit **`156fbfb7cab51fd85f3c14e2b1de81eca31d2d2c`** to platform
stack `pio-auth-test-230639770018`, account **230639770018**, region **us-west-1**.
The editor remains **`fbad254cfea0d5b41422841f995203f5bbb7eed1`**; only its public
release manifest was updated. CloudFormation reached `UPDATE_COMPLETE`.
The packaged template changed 75 Lambda code references and an ephemeral API
deployment snapshot, with **no IAM changes, function-environment changes, stack
deletions or persistent-resource removals**. CloudFormation lint passed. The
production dependency audit reported zero advisories.

Verification at **2026-10-09T06:15:28.748Z** matched eight deployed Lambda package
hashes, the editor index hash and manifest. All **72 protected REST methods** and
the WebSocket authorizer remained enabled. **30 anonymous/invalid-token requests**,
including the discard route, were rejected. Private deployment/repair/application
workers still have no public function URLs. Platform-admin configuration was
preserved, not expanded. The deployment smoke check also passed OAuth discovery,
provider selection and unauthenticated REST/MCP/WebSocket rejection.

Post-release **read-only MCP** inspection at **2026-10-09T06:15:32.719Z** confirmed
that the referenced recovery is still unapproved, its application is still
`NOT_CREATED`, and the guardrail remains `ROLLBACK_FAILED` with both roles absent.
The live status now advertises `iac.cancel` with `allowed:true` and no approval
requirement. All **30** current document checks allowed their checked actions;
actual role assumption remains untested because the role is absent. The operation
was not cancelled or otherwise acted on.

Live mutation acceptance under the new strict constraint still requires a fresh
disposable graph review and its exact human approval. The current MCP connection
caches an older callable tool catalogue; reconnect/refresh it to discover
`iac.cancel` and the new constraint arguments. The live cancellation/strict
execution cycle is therefore **not claimed as verified**. No AWS CLI, direct
authenticated HTTP or browser-token fallback was used to run application
acceptance. No Chess deployment readiness is claimed.
