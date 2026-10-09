# Graph MCP lifecycle — current platform review

Updated October 8, 2026 (PDT). This is the current review for graph-server and
its paired graph-editor. This change implements server discovery **2.4.1** and
lifecycle contract **1.1.0**. Release and live acceptance are pending the gates
below. Previous release instructions are superseded; their evidence remains in
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

No platform IAM permissions were expanded in this fix. The currently released
worker can perform the fixed guardrail lifecycle, pass the fixed guardrail service
role, and invoke the private approved-definition repair function. Application
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
error. Existing 640 × 480 px bounds and internal scrolling are preserved.

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

Passing checks: **726 server tests in 44 suites**, **115 editor integration tests
in 13 files**, **125 CRDT tests in 12 files**, both browser review tests, both
TypeScript checks, 5 deployment-configuration tests, and both Auth0/Cognito
server and editor bundles. The result-schema assertions were rerun after the
final schema refinement. Jest uses the repository's existing `--forceExit`
workaround for a test-harness handle; this is not runtime evidence.

**Live gates:** the account-specific platform profile was refreshed and its
account identity verified. The signed-in editor created disposable test graph
`e76298c1-3d45-47ed-be95-19e1104ebab2`; MCP can read it. Platform release and
real disposable-stack failure/recovery/import/deployment with their exact human
approvals remain pending. Automated AWS responses do not establish actual
CloudFormation execution. The Chess regression was read only and remains owned
by the application agent.

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

Last released baseline: server `ac72acd806f8686c29983145e6be1dbfc7f2cb73`, editor
`f9ce6c1b8083659959d9a0acbcdbd775c1a08e40`, account **230639770018 / us-west-1**.
The prior release evidence is retained at
`/private/tmp/graph-lifecycle-release-ac72acd/`; the public
[release manifest](https://d2fqgid0yzbc85.cloudfront.net/graph-editor/release.json)
identifies the deployed pair. This document does not instruct or authorize
shipping the Chess application.

Paired editor revision for this platform change:
`39c84424f9ed2660b911f5ed87e3aaa809b2e0b3`.
No CloudFormation stack deletion is authorized by platform release. Any recovery
deletion requires the human to approve the specific stack and exact recovery
digest in the graph. Unrelated CloudFormation projects in this shared account
are outside the task.
