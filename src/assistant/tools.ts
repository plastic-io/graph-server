import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {Principal} from '../auth/principal';
import {makeMcpHandler} from '../mcp/handler';
import {McpDeps} from '../mcp/server';
import {TOOL_NAMES} from './contract';

/** Real MCP schemas and service gates; the transport never leaves this process. */
export async function withGraphTools<T>(deps: McpDeps, principal: Principal, graphId: string, sessionId: string,
    run: (api: {list(): Promise<any[]>; call(name: string, args: any): Promise<any>}) => Promise<T>) {
    const mcp = makeMcpHandler(deps), client = new Client({name: 'built-in-opus', version: '1.0.0'});
    await client.connect(new StreamableHTTPClientTransport(new URL('https://internal.invalid/mcp'), {
        fetch: (url, init) => mcp.serve(new Request(url, init), principal),
    }));
    try {
        const {tools} = await client.listTools();
        const allowed = tools.filter(t => TOOL_NAMES.includes(t.name));
        return await run({list: async () => allowed, call: async (name, input) => {
            const tool = allowed.find(t => t.name === name);
            if (!tool) throw new Error('This tool is not available to the built-in assistant.');
            if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 65536) throw new Error('Invalid tool arguments');
            if (input.graphId && input.graphId !== graphId) throw new Error('Cross-graph tool calls are prohibited');
            if (input.agentSessionId && input.agentSessionId !== sessionId) throw new Error('This agent session is assigned by the server');
            if (input.peerId) throw new Error('Other private conversations are not available to Opus');
            const args = {...input, schemaVersion: 1, graphId};
            if ((tool.inputSchema.properties as any)?.agentSessionId) args.agentSessionId = sessionId;
            if (['iac.review', 'iac.recovery.plan', 'iac.inspect'].includes(name)) {
                if (input.action === 'destroy' || input.allowDataLoss === true || (input.preservation && input.preservation !== 'strict')) throw new Error('Direct stack deletion or destructive recovery is prohibited; template consequences may be prepared for human review');
                args.preservation = 'strict';
            }
            const result = await client.callTool({name, arguments: args});
            return result.structuredContent || {content: result.content, isError: result.isError};
        }});
    } finally {await client.close();}
}
