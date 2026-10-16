# Built-in Opus graph assistant

Open a saved graph, open chat, and choose **Ask Opus** or send `@opus …`.
This starts a private conversation for the signed-in user and that graph.
Follow-up messages in the same conversation invoke Opus without repeating the
mention. The private inbox on the TOC keeps existing conversations accessible.
Other users and graphs have different Opus identities and conversation histories.

The model is **Claude Opus 5.5**, using Amazon Bedrock Converse with
`us.anthropic.claude-opus-5-5`. This US inference profile can route requests to
us-east-1, us-east-2, us-west-1 and us-west-2. Text and tool results are sent to
Bedrock; no browser credentials or AWS credentials are included. Credential
redaction is applied to model context, tool results and visible replies. Do not
store secrets as literals in graph code or chat; redaction cannot identify every
arbitrary application secret.

## Authority and graph changes

Opus uses the actual MCP schemas, validators, authorization gates, audit trail
and proposal services. Its identity is a short-lived, in-process, graph-bound
delegation from the authenticated requester. Serialized claims cannot recreate
that delegation. Owner restrictions are rechecked on each bridge request.

Available operations: discovery, graph summaries and code inspection, proposal
creation/validation/retirement, infrastructure preflight/review/inspection,
status/events/history, preservation-constrained recovery planning, runtime log
inspection, observations and shared-chat reading. `server.discover` with
`topic: "assistant"` publishes the exact allowlist, limits and examples. The
same contract is at `plastic://schema/1/assistant`.

The assistant cannot approve or commit proposals, execute graph code, approve
deployment or recovery, run AWS commands, access arbitrary network endpoints,
or inspect other private conversations. The editor's **Manual**, **Safe Actions**
or **Fully Automatic** mode controls graph-side acceptance and eligible review
approvals. The assistant cannot enable those modes. Every assistant infrastructure
review enforces `preservation: "strict"`; deletion, replacement and data-loss
requests are rejected. Recovery approval remains separate from deployment.

## Delivery, cost limits and interruptions

Human posts enter the existing immutable Yjs chat sidecar. A durable request
record captures graph/user binding, the triggering message and model ID. An SQS
FIFO queue serializes each private conversation; stable message IDs deduplicate
retries. Agent replies never invoke the model recursively. A conditional worker
lease prevents concurrent or duplicate execution. A worker abandoned after a
crash is reported as failed instead of replaying potentially completed tools.

Queued state, tool activity, interruption acknowledgements, replies and failures
use the same `chat.update` WSS bus and durable `chat.read` history as ordinary
messages. Reconnect uses existing Yjs synchronization and sequence cursors.
Reasoning blocks/signatures remain inside the model loop and are never published.
Structured usage totals and terminal state are retained in the job record.

Limits: 20 requests per authenticated user per UTC hour, two concurrent workers,
eight model rounds per request, four tools per round, 4,096 output tokens per
round, 80 KB of conversation context, 20 KB per tool result, 24 history messages,
and a four-minute model loop. Bedrock calls are pay-per-token; these are usage
bounds, not a dollar budget. Requests expire after 15 minutes or when the
originating authenticated session expires, whichever occurs first. Long model
responses are split into UTF-8-safe chat messages.

Send a message with **Interrupt agents** selected to stop current inference.
The worker polls durable control about every three seconds, aborts the model
request and stops subsequent tools. An in-flight service call cannot be undone.
The new human message gets its own turn; existing proposals remain reviewable.
Ordinary follow-ups queue behind the current turn. Shared-room interruptions
also stop work. Only the private requester receives model output.

## CI/CD and AWS isolation

Set GitHub environment variable `BEDROCK_AGENT_ENABLED=true` to enable Opus;
it defaults to false. `BEDROCK_MODEL_ID` defaults to the US Opus 5.5 profile.
The shared deployment configuration derives the corresponding foundation-model
identifier and rejects wildcard/global profiles. The workflow verifies model
availability and the profile's destination regions before packaging. Availability
checks are not proof of runtime permissions; a real inference check is separate.

The platform release adds one retained nested stack containing two private
Lambdas, a FIFO queue, retained dead-letter queue, queue alarm and worker role.
The packaging plugin compiles and uploads its digest-checked template through
the normal Serverless/CI lifecycle. No local stack-preparation command is needed.
This keeps the existing 498-resource platform within CloudFormation limits. The model worker can invoke only the selected
Bedrock profile/model ARNs and its private tool bridge, consume its queue, read
immutable assistant requests and update assistant job records. It has no
application IAM, CloudFormation, role-passing, graph-data-write or request-identity-
write permission. The bridge uses the existing platform services under a narrow
agent principal. Neither Lambda has a Function URL or HTTP/WebSocket event.
The existing authenticated chat route is the only conversational entry point.

Disabling the feature hides the new-conversation entry and disables queue
consumption. Existing histories and resources remain retained. Operators should
inspect the project queue alarm if a worker cannot report a terminal failure;
this release does not add automatic redrive or replay of abandoned graph work.

## Verification

Automated tests cover actual MCP schemas and gates, owner revocation, serialized
identity rejection, cross-user/graph denial, private Yjs/bus history, duplicate
requests, abandoned leases, per-user quotas, strict preservation, interruption
during inference, credential redaction, Unicode bounds, model failure reporting,
private Lambda/IAM configuration, editor graph routing and CI model validation.

The opt-in `RUN_BEDROCK_LIVE=true` assistant test uses a synthetic in-memory graph
and actual Bedrock inference. On October 15, 2026, Opus 5.5 discovered operations
and created a real rename proposal in `awaiting-review`; the graph stayed unchanged.
That verifies model/tool interoperability, not a deployed worker's IAM role or a
live browser session. No application stack or application data is used by this test.
