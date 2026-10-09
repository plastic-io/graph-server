# Application-role deployment permissions — current platform review

Updated October 9, 2026. Server **2.5.2** follow-up, lifecycle contract **1.3.0**.
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

After release, inspect Jolly Fish again and prepare a new recovery assessment
from the current operation with `preservation:"strict"`. That node already has
strict preservation, which is inherited if omitted. The application stack is
`ROLLBACK_FAILED`: ordinary CloudFormation updates are unsupported in this state.
The current generic strict recovery path must remain blocked, with **no stack
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

- **801 tests / 50 suites pass**, including policy-deny precedence, pre-creation
  existence probes, legitimate path-scoped lifecycle operations, foreign paths,
  cross-graph resources, boundary enforcement, PassRole, absent versus denied
  physical-role inspection, ownership mismatches, cancellation and preservation.
- TypeScript passes; five release-configuration tests pass; both Auth0 and
  Cognito production Lambda bundles build.
- Policy matrix and lifecycle fixtures are **local/simulated evidence**. AWS
  CloudTrail/IAM reads and IAM simulation above are separate evidence.
- Platform release **completed**: commit `b6dbb00b7ebb3a3a5a7e8483466366ee13d9c727`
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
- Disposable graph content was accepted after the overnight pause. Live
  deployment verification is tracked below; application deployment approval
  and actual CloudFormation role creation are still pending.
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
  assumption. The application change set was created; no application role has
  been deployed and no deployment approval has been given. Auto-approve is off.
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
Auth0/Cognito Lambda bundles pass. Live application role creation and cleanup
remain unverified; cleanup has local policy/fixture coverage only.

References: [CREATE change-set empty stack behavior](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_CreateChangeSet.html),
[change-set tags before execution](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_DescribeChangeSet.html).

Resume after the platform follow-up release by monitoring the operation through
MCP, inspecting current readiness, and obtaining the human's exact-digest
deployment approval in the graph. Do not click approval as the human or use AWS
credentials to deploy the fixture.

- Do not execute the Jolly Fish recovery assessment or change its application.
  No stack deletion or data removal is authorized, including test stacks.

Release package, diff, smoke results, verification and scoped MCP evidence:
`/private/tmp/graph-role-permissions-release-b6dbb00/`. Incident audit and IAM
simulation: `/private/tmp/jolly-platform-incident-evidence.json` and
`/private/tmp/jolly-policy-simulation.json`. These are verification artifacts;
the source and this durable review are in the repository.
