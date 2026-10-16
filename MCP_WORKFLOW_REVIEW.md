# Current review: graph-authored CloudFormation templates

October 16, 2026. Source server **2.8.0**, lifecycle contract **1.5.0**,
assistant contract **1.1.0**, template contract **author-template-v1**.
Implementation is local and **not released**. The deployed baseline remains
server `22376da` / editor `c6471eb` from the release recorded below.

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
[`templateSubmission.js`](src/__tests__/templateSubmission.js); SDK calls are
mocked and no AWS deployment or application logging test has been run for this
change. Agreeable Dove's Lambda execution and S3 logging remain unverified.
Release requires the normal reviewed, paired server/editor deployment; this
change adds no IAM grants. Pending pre-release reviews need cancellation and
fresh preparation under the new contract, followed by separate human approval.

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
