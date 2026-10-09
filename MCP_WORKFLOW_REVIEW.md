# Graph MCP lifecycle — current platform review

Updated October 8, 2026 (PDT). This is the current review for graph-server and
its paired graph-editor. This change implements server discovery **2.4.3** and
lifecycle contract **1.2.1**. The missing-role, retained-import and editor changes
are released. The bounded inspection retry fix awaits release and the live gates below. Previous release instructions are superseded; their evidence remains in
git history. No Chess application source, graph node, or template was changed.

## Confirmed regression

A live, read-only MCP `iac.inspect` at **2026-10-09T01:20:46.263Z** checked graph
`f1963a3b-7e9a-43b3-87ee-068d56431374`, node `node-chess-storage-stack`, current
operation `01M4EZ7MQHV4Y0R15VP37GSS72`.

- The owned guardrail stack was `ROLLBACK_FAILED`; the application was
  `NOT_CREATED`. The retained boundary existed and matched the platform definition.
- IAM returned **`NoSuchEntity`** for both assigned roles with the message
  **“The role with name … cannot be found.”**
- The inspector incorrectly returned `exists: "unknown"` and
  `AWS_CHECK_FAILED`. Its absence check searched `error.message || error.code`,
  so the message hid the service code and did not match its text expression.
- Current policy-document checks reported the checked actions as allowed. Those
  checks are structural analysis, **not IAM simulation or AWS deployment proof**.
  The absent worker was not assumed. Historical permission/assumption failures
  do not establish a current permission failure.

The apparent prerequisite cycle is therefore a classification bug in this
reported state. Failed-stack recovery already uses the platform worker and fixed
CloudFormation guardrail service role. It does not require assuming either
missing per-stack role before restoring them. The older test fixture used a
convenient “does not exist” message and failed to catch the real AWS wording.

## Implemented MCP contract

`server.discover({"schemaVersion":1,"topic":"lifecycle"})` publishes input
schemas, JSON result schemas, approval requirements, examples, states and limits.
No redundant recovery or deployment tools were added.

| Existing tool | Current contract |
| --- | --- |
| `iac.inspect` | Fresh AWS stack/inventory/ownership checks; role existence is `true`, `false`, or `"unknown"`. `recoveryReadiness` distinguishes recovery-review availability from application `canReview`. Static validation, document analysis and actual AWS reads/STS probes remain separate. Historical failures retain their source operation ID. |
| `iac.recovery.plan` | Requires the current operation and an idempotency key. Returns immutable actions, affected resources, ownership evidence, retained imports, data-loss implications, prerequisites, expiry and exact recovery digest. No AWS mutation occurs. |
| `iac.maintenance.request` | **Record-and-verify-only**. `execution.executesAws` and `approvalTriggersRelease` are false. `administration` explains configuration and `PLATFORM_ADMIN_NOT_CONFIGURED` when applicable. Requesting/approving it cannot edit AWS, release the platform, recover a stack or approve deployment. |
| `iac.status` | Current operation, inspection, plan, approval, action outcomes, maintenance configuration and machine-readable `nextActions`. |
| `iac.events`, `iac.history`, `observations.watch` | Durable progress/evidence and operation history, also delivered through the existing graph bus. |
| `iac.review` | After recovery, prepares a fresh application deployment review with `retryOf` equal to the current recovered operation. Its separate human approval triggers deployment. |

For recoverable missing roles, inspection reports:

```json
{
  "roles": [
    {"logicalId":"WorkerRole","exists":false,"matches":false},
    {"logicalId":"ExecutionRole","exists":false,"matches":false}
  ],
  "recoveryReadiness": {
    "state":"review-available",
    "missingRoles":["WorkerRole","ExecutionRole"],
    "prerequisites":[],
    "requiredApproval":"human-exact-recovery-digest",
    "requiresPlatformAdmin":false
  },
  "canReview":false
}
```

This is a result excerpt; discovery contains the full JSON schemas.
`canReview:false` here concerns **application deployment**, which must wait for
recovery. `canReviewMaintenance:false` does not prevent ordinary graph recovery
approval. The graph human needs `graph:read` and `iac:approve`; agents cannot
approve via MCP. No maintenance-admin allowlist change is needed for this fix.

### Supported recovery sequence

1. Inspect the current operation. An IAM `NoSuchEntity`/`NoSuchEntityException`
   proves absence independently of message wording. Denials, networking errors,
   timeouts, bare HTTP 404s and unrecognized errors remain unknown and block
   mutation. CloudFormation and Step Functions use their own service errors.
2. Prepare a new recovery plan with a **new request key** after a platform fix.
   A previously blocked plan does not silently become approved. For the reported
   state the actions are: delete the owned failed guardrail stack; import the
   retained boundary; restore the platform-defined roles; retire the failed
   operation. The boundary remains retained and there is no application data loss.
3. A human reviews resource outcomes and approves the **exact recovery digest**
   in the CF node. Approval starts the platform worker. State, ownership,
   immutable IAM resource IDs, policy contents and boundary consumers are checked
   again before deletion/import. No arbitrary resource adoption is permitted.
4. Observe recovery via the node, `iac.status`, `iac.events` and
   `observations.watch`. Reconnect uses durable cursors, stable event IDs,
   operation IDs and fragmented-report reassembly. No UI-only diagnostic path
   was added.
5. After `recovered`, the application agent can correct its own template through
   proposals if needed, call `iac.review` with the current `retryOf`, and obtain
   a **new exact-digest human deployment approval**. Recovery cannot reuse or
   grant application deployment approval.

Use `RetainResources` only for `DELETE_FAILED`. The approved list can preserve
owned data and skip deletion handlers for confirmed-absent owned IAM role
records; nonexistent roles are never imported as live resources. If an ordinary
`ROLLBACK_FAILED` deletion itself fails, its new diagnostics require a fresh
state-appropriate recovery review. There is no blind or automatic retry.

Imports use supported CloudFormation import operations and verified ownership
records, never name matching alone. AWS documents
[IAM role/managed-policy import support](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import-supported-resources.html)
and [manual import constraints](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/import-resources-manually.html).
Matching a policy document does not prove an import will succeed; real AWS events
remain authoritative.

## Isolation and approval safeguards

The follow-up adds `iam:ListAttachedRolePolicies` only on graph deployment roles
and `iam:ListEntitiesForPolicy` only on graph runtime boundary policies to the
platform guardrail service role. The pinned AWS public provider read contracts
are covered by a permission regression. No shared or root-path role deletion
permission is added. The per-stack platform worker gains `CreateStack` on its
single assigned application stack, conditional on the assigned service role and
GraphId/NodeId/GraphStack request tags. Application runtime roles and boundaries
are unchanged. This updated platform definition is reconciled only through an
approved graph recovery. The platform worker can pass the fixed guardrail service
role and invoke the private approved-definition repair function. Application
recovery still uses its assigned per-stack worker/execution roles; the missing-role
regression specifically verifies guardrail restoration uses no application client.
Root-path role creation, role deletion and policy grants were not added.

A graph agent cannot select AWS commands, accounts, ARNs, guardrail policy JSON,
role contents or trust relationships. The approved platform definition determines
those values. Extra/foreign guardrail resources, unexpected role paths, replaced
IAM physical identities, unproven ownership and foreign boundary attachments stop
recovery. The retained boundary is preserved on refusal. Shared IAM and unrelated
resources remain outside the recovery target.

Plans expire after 15 minutes. Their digest binds lifecycle contract version,
source operation, namespace, input digest, approved platform definition, observed
resource identities/state/retention, proposed actions and data-loss choice.
Timestamps and historical error wording are not freshness evidence. A contract
change invalidates old approval freshness. Conditional-write stack fences,
worker leases and deterministic AWS request tokens serialize concurrent work and
handle duplicate requests. Explicit data-loss approval is additionally required
before any action in a destructive plan can run.

## Graph review UI

The CF node labels absent and unknown roles, shows recovery availability,
separates historical failures from fresh checks, and lists resources to delete,
retain, import or recreate. Recovery approval explicitly does not require
platform-maintenance administrator membership or approve application deployment.
Maintenance requests explain that they record a review, not an executable repair.
Missing administrator configuration is actionable rather than an opaque AWS
error. The Recovery button is in the lower system bar beside the CloudFormation
notifications. Its dialog restores the current operation and full review without
requiring scrolling to the bottom of a node. CF nodes default to 600 × 480 px
(twice the previous 300 px natural width), have a drag/keyboard resize handle,
persist dimensions through graph properties, and retain internal scrolling with
bounds of 300–1600 px wide and 200–960 px high.

Auto-approve is **off by default**. A human must accept a warning about costs and
IAM changes to enable it for this graph/editor session; reload or graph change
turns it off. It consumes existing current reviews and exact digests, never
accepts proposals or creates reviews. The server exposes
`status.automaticApproval={allowed,reason}` and rejects automatic stack deletion,
resource removal/replacement, uncertain changes, rollback recovery, and data loss.
`approval.mode` / `recoveryApproval.mode` records manual versus automatic approval
in durable status/events. MCP cannot enable the mode or approve. Turning the mode
off does not cancel already approved operations.

## Verification and remaining gates

Automated evidence uses **disposable in-memory graphs and simulated AWS**:

- The real MCP SDK regression discovers the result schemas, validates actual
  result objects, accepts a generic proposal via the human service, inspects
  `ROLLBACK_FAILED` with both roles absent and a retained boundary, prepares and
  approves recovery via the human graph route, reconnects, prepares a fresh
  deployment review, separately approves it, invokes and diagnoses an application
  failure. No maintenance admin is configured. The agent has only MCP access.
- `iac.events`, `observations.watch` and graph-notify bus recovery envelopes are
  compared for equality. The old operation's error survives replacement reviews.
- Regressions reject cross-graph access, ownership mismatch, stale/tampered
  approvals, unapproved data loss, concurrent operations, unexpected resources,
  foreign attachments and shared-IAM repair inputs. AccessDenied/transport errors
  cannot be mistaken for absent resources. Retained-boundary replacement between
  deletion and import is rejected.
- The fixture now uses AWS's real missing-role wording and the actual platform
  guardrail policy from `serverless.yaml`, not an unrestricted mock IAM grant.
- Browser tests exercise the actual CF component, reload, scrolling and distinct
  recovery/deployment requests using **mocked infrastructure routes**. This is
  UI evidence, not real AWS or real human approval. The deployment CI now includes
  `deployment-lifecycle.spec.ts` alongside existing browser regressions.

Passing checks: **752 server tests in 46 suites**, **119 editor integration tests
in 13 files**, **125 CRDT tests in 12 files**, the updated recovery/resize/warning browser test and prior deployment review test, both
TypeScript checks, 5 deployment-configuration tests, and both Auth0/Cognito
server and editor bundles. The result-schema assertions were rerun after the
final schema refinement. Jest uses the repository's existing `--forceExit`
workaround for a test-harness handle; this is not runtime evidence.

**Live evidence and remaining gates:** server `44f9760` / editor `39c8442`
released successfully to **230639770018 / us-west-1**. Eight deployed Lambda
package hashes and the editor manifest matched; 72 REST methods and WebSocket
connect retained authorizers; 28 anonymous/invalid-token probes were rejected.
The original regression inspected through MCP at `2026-10-09T01:55:17.946Z`
reported both roles absent and recovery review available, without maintenance
admin configuration. No Chess content or infrastructure was mutated.

On disposable graph `e76298c1-3d45-47ed-be95-19e1104ebab2`, a human accepted proposal
`01M4F5T35DVVGZ5KP7MYA2F2YR` and separately approved deployment
`01M4F5Z1V18RJQ365K92EYRYEE`. AWS created its guardrails and queue, rejected the
intentionally invalid generic DynamoDB key schema, and reported `ROLLBACK_COMPLETE`
with the queue `DELETE_SKIPPED`. MCP and the CF UI displayed the actual error.
Cross-graph recovery was denied; duplicate request keys returned the same plan;
16 recovery events matched the observation stream by event ID/content. Reload
restored the displayed recovery digest.

The human explicitly approved recovery `01M4F6813ATZW997B0QVZACBES`, digest
`3b17cbc651e6ae8f39644f9ad632819c2a76223b3b8dcc1fc98bb1c916034cc3`, including deletion
of only `gapp-02abf16a0ebe1b65929693f1-stack` while retaining its queue. That named
stack deletion completed. The import then failed with AWS `ValidationError`:
“As part of the import operation, you cannot modify or add [RoleArn, Tags]”.
Fresh MCP inspection recovered the deleted stack's ownership and retained queue
record; the original failure remains durable. No other stack was deleted.

This generic regression now prepares a fixed, empty stack with the assigned role
and tags before IMPORT. A false condition prevents the placeholder from creating
any resource. The import preserves these settings and executes only when its
change set contains exactly the reviewed imports. Interrupted preparation retains
and reverifies the archived ownership record for a new plan. Recovery-worker
failures now direct `iac.inspect` / a new recovery review rather than suggesting
an application template edit. AWS references:
[CreateChangeSet](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_CreateChangeSet.html),
[conditional resource creation](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/conditions-section-structure.html),
and [public resource provider schemas](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/resource-type-schemas.html).
The fixture now reproduces the real import-settings rejection.

The follow-up server `66558dc` / editor `b8d8b72` release passed deployed package
hash, authorizer and all 28 authentication rejection checks. Its editor has the
lower-system-bar Recovery and opt-in Auto-approve controls, plus persisted CF-node
resizing. A fresh MCP plan for the disposable graph contained only guardrail
reconciliation, retained import and operation release, but its inspection was
blocked by actual IAM `Throttling: Rate exceeded` responses. That inspection made
19 AWS checks, 11 of them IAM reads. No infrastructure was created by inspection
or planning. The response did not identify a numeric quota or account-wide load.

The inspector previously burst parallel IAM reads with retries disabled and
misclassified temporary failures as administrator prerequisites. The follow-up
serializes IAM inspection reads and retries transient checks at most three times
with jitter and an 18-second inspection budget. Exhausted reads remain unknown
and block approval; `AWS_CHECK_RETRYABLE` / `kind: transient` directs a fresh
inspection after a delay, without claiming a permission change is needed.
Deployment/recovery mutations are not automatically retried. See AWS's
[SDK retry guidance](https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/retry-strategy.html).

The bounded retry release, fresh **non-deleting** recovery approval/import and corrected
disposable deployment remain pending. The user's latest instruction prohibits
further stack deletion. Retained resources are left in place. Live missing-role
recreation is not established by the disposable queue test; the exact missing-role
case is covered by MCP SDK tests with simulated AWS and read-only live inspection.

Generic limits remain explicit:

- A stable guardrail stack with out-of-band deleted roles still recorded in its
  template returns `GUARDRAIL_ROLE_RECREATE_UNSUPPORTED`. An unchanged update
  cannot recreate those resources, and private repair cannot create roles. A
  separately reviewed platform replacement procedure is required. This does not
  block failed-creation recovery or updates after a boundary-only import.
- Unproven orphans, unsupported retained imports/dependencies and import rollback
  still require a separately reviewed preservation procedure. Inventory and
  diagnostic collection limits fail closed rather than assuming ownership.
- Shared platform permission changes require a platform release. Graph ownership
  does not grant platform administration. `PLATFORM_ADMIN_SUBS` remains empty;
  ordinary graph recovery does not need it. A maintenance review requires an
  explicitly configured verified human subject with `policy:admin`.
- GitHub OIDC bootstrap/activation remains an external administrator prerequisite
  for CI deployment. The previously authorized account-specific platform release
  process is separate from application operations; no application credential or
  CLI fallback is introduced.

Last released pair: server `66558dc8c1b764994c71629c007815464eb4ce47`, editor
`b8d8b72f1f614223a0bef4c06fa355b2f6b7921f`, account **230639770018 / us-west-1**.
Release evidence is retained at `/private/tmp/graph-import-release-66558dc/` and
the prior `/private/tmp/graph-guardrail-release-44f9760/`; the public
[release manifest](https://d2fqgid0yzbc85.cloudfront.net/graph-editor/release.json)
identifies the deployed pair. This document does not instruct or authorize
shipping the Chess application.

Paired editor revision for this follow-up:
`b8d8b72f1f614223a0bef4c06fa355b2f6b7921f`.
No CloudFormation stack deletion is authorized by platform release or automatic
approval. No further live stack deletion will be performed under this task. Unrelated CloudFormation projects in this shared account
are outside the task.
