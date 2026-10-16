export const MODEL_ID = 'us.anthropic.claude-opus-5-5';
export const LIMITS = {requestsPerHour: 20, turns: 8, toolsPerTurn: 4, outputTokens: 4096,
    contextBytes: 80000, resultBytes: 20000, historyMessages: 24, runMs: 240000, requestTtlMs: 900000};
export const TOOL_NAMES = ['server.discover', 'graph.summary', 'graph.expand', 'proposal.create', 'proposal.validate',
    'proposal.retire', 'iac.preflight', 'iac.review', 'iac.inspect', 'iac.status', 'iac.events', 'iac.history',
    'iac.recovery.plan', 'iac.runtime.logs', 'observations.watch', 'observations.query', 'chat.read'];
export function assistantContract() {
    return {version: '1.1.0', uri: 'plastic://schema/1/assistant', enabled: process.env.BEDROCK_AGENT_ENABLED === 'true', handle: '@opus',
        modelId: process.env.BEDROCK_MODEL_ID || MODEL_ID, provider: 'Amazon Bedrock',
        conversation: 'Private to the authenticated user and the saved graph. Select Opus or send @opus in graph chat. Follow-up messages in that private thread invoke it too.',
        authorization: 'Graph-bound agent, not a human approver. Proposals use the editor AI Permissions mode. Infrastructure needs its own current exact-digest approval. Application template choices reach human review unchanged. Strict constrains separate stack deletion and recovery fallback, not template retention or resource replacements.',
        tools: TOOL_NAMES, limits: LIMITS,
        unavailable: ['Human approvals', 'Direct graph execution', 'AWS shell or credentials', 'Arbitrary network access', 'Direct stack deletion or destructive recovery'],
        interruptions: 'Send a private message with Interrupt enabled. The current inference is aborted when the worker next checks (about 3 seconds); already accepted proposals are not undone. The new message starts a fresh turn.',
        status: 'Queued, thinking, tool activity and terminal replies are durable chat messages on the same private Yjs/WSS bus. Reconnect via chat.read cursors. A failed worker is not allowed to replay previously attempted tools.',
        examples: [
            {tool: 'chat.join', arguments: {schemaVersion: 1, graphId: '<saved-graph-id>', agentSessionId: '<unique-session>', name: 'My MCP session'}},
            {tool: 'chat.post', arguments: {schemaVersion: 1, graphId: '<saved-graph-id>', agentSessionId: '<unique-session>', messageId: '<unique-id>', text: '@opus Explain this graph and propose a clearer layout.'}},
        ]};
}
