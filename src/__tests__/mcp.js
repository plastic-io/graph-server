const { fromJSON, toJSON, reconcile, encodeState, applyUpdate } = require("@plastic-io/graph-crdt");
const Y = require("yjs");
const CrdtStore = require("../crdtStore").default;
const CrdtService = require("../crdtService").default;
const TocStore = require("../tocStore").default;
const { RevisionService } = require("../revisions/service");
const { ComponentService } = require("../components/service");
const { SummaryService } = require("../summary/service");
const { ProposalService } = require("../proposals/service");
const { DelegationStore } = require("../policy/delegation");
const { makeMcpHandler } = require("../mcp/handler");
const { TaskService } = require("../mcp/tasks");
const { SimulationService } = require("../proposals/simulate");
const { Client } = require("@modelcontextprotocol/client");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { listGraph } = require("../tocService");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

const port = (name, external = false) => ({ name, type: "Object", external, visible: true });
const node = (id, over = {}) => ({ id, url: id, edges: [{ field: "out", connectors: [] }], version: 0, graphId: "g1", artifact: null, data: null, properties: { inputs: [port("in")], outputs: [port("out")], groups: [], name: id, description: "does " + id, tags: [], icon: "", x: 0, y: 0, z: 0, createdOn: 1, presentation: { x: 0, y: 0, z: 0 } }, template: { set: "edges.out = value;", vue: "" }, ...over });
function graphJson() {
    const a = node("form"), b = node("normalize"), c = node("validate");
    a.edges[0].connectors.push({ id: "c-ab", nodeId: "normalize", field: "in", graphId: "g1", version: 0 });
    b.edges[0].connectors.push({ id: "c-bc", nodeId: "validate", field: "in", graphId: "g1", version: 0 });
    return { id: "g1", url: "g1", version: 0, nodes: [a, b, c], properties: { name: "Account settings", description: "a journey", exportable: true, icon: "mdi-graph", createdBy: "", createdOn: 0, lastUpdate: 0, height: 1, width: 1 } };
}
const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
const agent = { sub: "agent|a1", kind: "agent", tenant: "personal:auth0|u1", scopes: [] };
const ULID = "01J8ZK5K0B1C2D3E4F5G6H7J8A";
function fakeBroadcast() { const b = { channel: [] }; b.postToClient = (d, c, p, cb) => cb(); b._sendToChannel = (ch, v, cb) => { b.channel.push([ch, v]); cb(); }; b.broadcast = b._sendToChannel; return b; }

async function setup(opts = {}) {
    const s3 = new FakeS3Service(); const store = new CrdtStore(s3); const broadcast = fakeBroadcast();
    const crdt = new CrdtService(store, broadcast); const tocStore = new TocStore(s3);
    const revisions = new RevisionService(store, crdt.admission, { fanOut: (g, u) => crdt.fanOutUpdate(g, u) });
    const components = new ComponentService(store, revisions, crdt.admission, { tocStore, broadcastService: broadcast });
    const summaries = new SummaryService(revisions, components);
    const delegations = new DelegationStore(s3);
    crdt.admission.resolvePrincipal = (p, g) => delegations.resolve(p, g);
    const notified = [];
    const { AutonomyStore } = require("../policy/autonomy");
    const autonomy = new AutonomyStore(s3);
    const proposals = new ProposalService(store, crdt.admission, revisions, summaries, { fanOut: (g, u) => crdt.fanOutUpdate(g, u), notify: async (g, e) => notified.push(e), autonomy });
    const doc = fromJSON(graphJson());
    await store.appendUpdate("g1", encodeState(doc), "seed", "system");
    await listGraph(tocStore, broadcast, graphJson(), "system");
    const { JourneyService } = require("../journeys/service");
    const { ExecutionRunner } = require("../runtime/executor");
    const journeys = new JourneyService(s3, store, { runner: (live) => new ExecutionRunner(s3, { live }) });
    const { TestService } = require("../tests/runner");
    const { validatorFor_ } = require("../runtime/contracts");
    const tests = new TestService(s3, store, { runner: (live) => new ExecutionRunner(s3, { live }), validator: validatorFor_ });
    const invoked = [];
    const cancelled = [];
    const { RateLimiter } = require("../admission/limits");
    // Work that outlives one call: here the worker is this process, called
    // when the test decides to, so a task can be watched half way through.
    const dispatched = [];
    const tasks = new TaskService(s3, { dispatch: async (task) => { dispatched.push(task.taskId); } });
    const simulations = new SimulationService(s3, store, {
        proposals: { get: (g, p) => proposals.get(g, p), projection: (g, p) => proposals.projection(g, p) },
        runner: (live) => new ExecutionRunner(s3, { live }),
    });
    let consumers;
    if (opts.consumers) {
        const { ConsumerIndex } = require("../components/consumers");
        const { decide } = require("../policy/decide");
        consumers = new ConsumerIndex(s3, { readable: async (graphId, principal) => decide(await delegations.resolve(principal, graphId), ["graph:read"]).allow });
    }
    const chat = opts.chat ? new (require("../chat/service").ChatService)(s3, broadcast, id => store.exists(id)) : undefined;
    const {IacReviewService}=require('../iac/review');
    const {IacService}=require('../iac/service');
    const lifecycleFixture=opts.lifecycle?await require('../__testHelpers__/lifecycleCloud').fixture('g1','stack',{store:s3,projection:g=>store.projectGraph(g)}):undefined;
    const reviews=lifecycleFixture?.reviews||(opts.infrastructure?new IacReviewService(s3,{enabled:true,projection:g=>store.projectGraph(g),start:async()=>{},cloud:opts.infrastructure,notify:async(g,e)=>notified.push(e)}):undefined);
    const iac=reviews?new IacService(s3,{projection:async g=>({revisionId:'live',projection:await store.projectGraph(g)}),template:async()=>null,reviewStatus:(g,n,p)=>reviews.current(g,n,p)}):undefined;
    const application=opts.applicationBackend?new (require('../application/service').ApplicationService)(s3,{invoke:opts.applicationBackend,publish:async(g,e)=>broadcast._sendToChannel('graph-notify-'+g,e,()=>{})}):undefined;
    const mcp = makeMcpHandler({
        chat,reviews,iac,
        crdtStore: store, tocStore, admission: crdt.admission, revisions, components, proposals, summaries, delegations, journeys, tests, tasks, simulations, consumers,
        // the brake is tested in its own suite; here it would only stop the test
        rate: { reads: new RateLimiter({ maxMutations: 1000 }), writes: new RateLimiter({ maxMutations: opts.writeLimit ?? 1000 }), chat: new RateLimiter({ maxMutations: 1000 }) },
        invoke: async (graphId, principal, request) => {
            invoked.push({ graphId, principal: principal && principal.sub, request });
            const graph = await store.projectGraph(graphId);
            const node = graph.nodes.find((n) => n.url === request.nodeUrl || n.id === request.nodeUrl);
            if (!node) return { error: `no node ${request.nodeUrl}`, code: "NOT_FOUND" };
            const runner = new ExecutionRunner(s3,{application:application?r=>application.invoke(r):undefined});
            const summary = await runner.run({ graph, nodeUrl: node.url, field: request.field || "in", value: request.value, principal,revisionId:await require('../runtime/source').executionRevision(graph,revisions) });
            return { summary };
        },
        cancel: async (graphId, principal, executionId, reason) => {
            cancelled.push({ graphId, executionId, reason, by: principal && principal.sub });
            return { executionId, requested: true, reason };
        },
    });
    return { s3, store, tocStore, crdt, revisions, components, summaries, proposals, delegations, journeys, tests, tasks, simulations, consumers, dispatched, autonomy, doc, mcp, notified, broadcast, invoked, cancelled, chat, reviews, application, lifecycleFixture };
}

/** a real MCP client whose fetch goes straight into the handler, as the Lambda would */
async function connect(mcp, principal) {
    const transport = new StreamableHTTPClientTransport(new URL("https://api.test/dev/mcp"), {
        fetch: (url, init) => mcp.serve(new Request(url, init), principal),
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);
    return client;
}
const parse = (r) => r.structuredContent || JSON.parse(r.content[0].text);
/** the proposal service behind a handler, for checking what was recorded */
const proposalsOf = (mcp) => (mcp.deps ? mcp.deps.proposals : mcp.proposals);

test('MCP-only deployment diagnosis uses the same durable events as the graph socket, including reconnect and history',async()=>{
 const f=await setup({infrastructure:{}}),client=await connect(f.mcp,owner);
 const {IacReviewService}=require('../iac/review'),{DeploymentProgress}=require('../iac/progress');
 const operationId='01M4CSD7D7H7YM2HKY2Z5AJRHZ';
 const op={operationId,graphId:'g1',nodeId:'form',revisionId:'rev_accepted',state:'failed',createdAt:1,updatedAt:2,inputDigest:'a'.repeat(64),history:[],reason:'Original failure',input:{text:'{"Resources":{}}',format:'json',stack:{name:'gapp-example-stack'}}};
 const put=(key,v)=>new Promise((resolve,reject)=>f.s3.set(key,v,{},e=>e?reject(e):resolve()));
 await put(IacReviewService.key(operationId),op);await put(IacReviewService.index('g1','form'),{operationId});
 const progress=new DeploymentProgress(f.s3,async(g,e)=>f.notified.push(e));
 await progress.append(op,[{id:'guardrail-role-failure',source:'cloudformation',phase:'guardrails',kind:'resource',stackName:'graph-guardrails-example',logicalId:'WorkerRole',resourceType:'AWS::IAM::Role',status:'CREATE_FAILED',reason:'Not authorized to perform iam:GetRole on the assigned worker role.'}]);
 const call=async(name,args={})=>parse(await client.callTool({name,arguments:{schemaVersion:1,graphId:'g1',...args}}));
 const discovered=parse(await client.callTool({name:'server.discover',arguments:{schemaVersion:1,topic:'progress'}}));
 expect(JSON.stringify(discovered)).toContain('plastic://schema/1/progress');
 const status=(await call('iac.status',{nodeId:'form',operationId})).result;
 expect(status.reason).toContain('iam:GetRole');expect(status.recovery.category).toBe('platform-intervention');
 const history=(await call('iac.history',{nodeId:'form'})).result;expect(history.operations[0].operationId).toBe(operationId);
 const watched=(await call('observations.watch',{filter:{operationId}})).result;
 expect(watched.observations).toEqual(f.notified);
 const events=(await call('iac.events',{nodeId:'form',operationId})).result;
 expect(events.events.map(e=>e.id)).toEqual(f.notified.map(e=>e.id));
 await progress.append(op,[{id:'late-cleanup-failure',source:'cloudformation',phase:'cleanup',kind:'resource',status:'DELETE_FAILED',logicalId:'WorkerRole',reason:'iam:DeleteRolePolicy denied',at:1000}]);
 const late=(await call('observations.watch',{filter:{operationId},cursor:watched.nextCursor})).result;
 expect(late.observations).toHaveLength(1);expect(late.observations[0].reason).toContain('iam:DeleteRolePolicy');
 expect((await call('iac.events',{nodeId:'other',operationId,cursor:events.nextCursor})).error.code).toBe('NOT_FOUND');
 await client.close();
 const restricted=await connect(f.mcp,agent);
 await f.delegations.put({agentSub:agent.sub,graphId:'g1',delegatedBy:owner.sub,scopes:['graph:read','graph:observe'],expiresAt:null});
 expect(parse(await restricted.callTool({name:'iac.events',arguments:{schemaVersion:1,graphId:'g1',nodeId:'form',operationId}})).error.code).toBe('ADMISSION_DENIED');
 expect(parse(await restricted.callTool({name:'observations.watch',arguments:{schemaVersion:1,graphId:'g1'}})).result.observations).toHaveLength(0);
 await restricted.close();
});

describe("MCP over the Lambda handler", () => {
    test("tools and resources are listed; graph.summary returns the envelope, a named revision and a bounded summary", async () => {
        const { mcp } = await setup();
        const client = await connect(mcp, owner);
        const tools = (await client.listTools()).tools.map((t) => t.name).sort();
        expect(tools).toEqual([
            "component.consumers", "component.publish", "component.search", "execution.cancel", "graph.expand", "graph.invoke", "graph.summary",
            "iac.cancel", "iac.events", "iac.history", "iac.inspect", "iac.maintenance.request", "iac.plan", "iac.preflight", "iac.readiness", "iac.recovery.plan", "iac.review", "iac.runtime.logs", "iac.status", "journey.run", "observations.query", "observations.watch", "proposal.commit", "proposal.create", "proposal.decide", "proposal.retire", "proposal.simulate", "proposal.validate",
            "revision.activate", "revision.cut", "revision.rollback", "server.discover", "tasks.cancel", "tasks.get", "tasks.list", "tests.run",
            "view.screenshot",
        ]);
        const r = parse(await client.callTool({ name: "graph.summary", arguments: { schemaVersion: 1, graphId: "g1" } }));
        expect(r.envelope).toMatchObject({ schemaVersion: "1", principal: { sub: "auth0|u1", kind: "human" }, graphId: "g1", policyVersion: "m1-diff", truncated: false });
        expect(r.envelope.resultRevision).toMatch(/^rev_[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(r.result).toMatchObject({ id: "g1", kind: "graph", name: "Account settings", purpose: "a journey", placement: "portable", degree: { in: 0, out: 0, nestedNodes: 3 }, untrusted: ["purpose"] });
        const n = parse(await client.callTool({ name: "graph.summary", arguments: { schemaVersion: 1, graphId: "g1", nodeId: "normalize", include: ["deps"] } }));
        expect(n.result).toMatchObject({ id: "normalize", kind: "node", degree: { in: 1, out: 1 }, inputs: [{ name: "in", schema: {}, required: false }], dependencies: [] });
        expect(n.result.pointers.node).toBe(`plastic://graph/g1/rev/${r.envelope.resultRevision}/node/normalize`);
        const missing = await client.callTool({ name: "graph.summary", arguments: { schemaVersion: 1, graphId: "g1", nodeId: "nope" } });
        expect(missing.isError).toBe(true); expect(parse(missing).error.code).toBe("NOT_FOUND");
        const unknownField = await client.callTool({ name: "graph.summary", arguments: { schemaVersion: 1, graphId: "g1", extra: true } });
        expect(unknownField.isError).toBe(true);
        await client.close();
    });

    test("graph.expand walks a bounded neighbourhood with cursors bound to the revision; code needs inspect-internals", async () => {
        const { mcp } = await setup();
        const client = await connect(mcp, owner);
        const rev = parse(await client.callTool({ name: "graph.summary", arguments: { schemaVersion: 1, graphId: "g1" } })).envelope.resultRevision;
        const args = { schemaVersion: 1, graphId: "g1", revisionId: rev, root: { nodeId: "validate" }, direction: "in", depth: 1, maxNodes: 20, maxBytes: 65536 };
        const r = parse(await client.callTool({ name: "graph.expand", arguments: args }));
        expect(r.result.nodes.map((n) => n.id)).toEqual(["validate", "normalize"]);
        expect(r.result.edges).toEqual([{ from: { nodeId: "normalize", field: "out" }, to: { nodeId: "validate", field: "in" }, connectorId: "c-bc" }]);
        expect(r.result.truncated).toEqual({ byDepth: true, byCount: false, byBytes: false });
        const one = parse(await client.callTool({ name: "graph.expand", arguments: { ...args, depth: 4, maxNodes: 1 } }));
        expect(one.result.nodes.map((n) => n.id)).toEqual(["validate"]); expect(one.result.truncated.byCount).toBe(true); expect(one.envelope.truncated).toBe(true);
        const rest = parse(await client.callTool({ name: "graph.expand", arguments: { ...args, depth: 4, maxNodes: 10, cursor: one.result.nextCursor } }));
        expect(rest.result.nodes.map((n) => n.id)).toEqual(["normalize", "form"]);
        const withCode = parse(await client.callTool({ name: "graph.expand", arguments: { ...args, includeCode: true } }));
        expect(withCode.result.nodes[0].code.set).toBe("edges.out = value;");
        const stale = await client.callTool({ name: "graph.expand", arguments: { ...args, revisionId: "rev_01J8ZK5K0B1C2D3E4F5G6H7J8A" } });
        expect(parse(stale).error.code).toBe("NOT_FOUND");
        await client.close();
    });

    test("resources: graphs, graph, revision, node (code only with expand), history, diff", async () => {
        const { mcp, store, doc, revisions } = await setup();
        const client = await connect(mcp, owner);
        const graphs = JSON.parse((await client.readResource({ uri: "plastic://graphs" })).contents[0].text);
        expect(graphs.graphs).toEqual([{ graphId: "g1", name: "Account settings", description: "a journey", url: "g1", version: "0" }]);
        const summary = JSON.parse((await client.readResource({ uri: "plastic://graph/g1" })).contents[0].text);
        const rev1 = summary.revisionId;
        const manifest = JSON.parse((await client.readResource({ uri: `plastic://graph/g1/rev/${rev1}` })).contents[0].text);
        expect(manifest).toMatchObject({ revisionId: rev1, seq: 1, label: "auto", createdBy: { sub: "system:revisions" } }); expect(manifest.snapshot).toBeUndefined();
        const n = JSON.parse((await client.readResource({ uri: `plastic://graph/g1/rev/${rev1}/node/normalize` })).contents[0].text);
        expect(n.code).toBeUndefined(); expect(n.edges[0].connectors[0].id).toBe("c-bc");
        const withCode = JSON.parse((await client.readResource({ uri: `plastic://graph/g1/rev/${rev1}/node/normalize?expand=code` })).contents[0].text);
        expect(withCode.code.set).toBe("edges.out = value;");
        // an edit, then the live alias moves to a new auto revision and the diff between them is readable
        const snapshot = JSON.parse(JSON.stringify(toJSON(doc))); snapshot.nodes[1].template.set = "edges.out = value.trim();";
        let out; const h = (u) => (out = u); doc.on("updateV2", h); reconcile(doc, snapshot, { source: "t" }); doc.off("updateV2", h);
        await store.appendUpdate("g1", out, "Edit", "auth0|u1");
        const summary2 = JSON.parse((await client.readResource({ uri: "plastic://graph/g1" })).contents[0].text);
        expect(summary2.revisionId).not.toBe(rev1);
        const diff = JSON.parse((await client.readResource({ uri: `plastic://graph/g1/diff/${rev1}/${summary2.revisionId}` })).contents[0].text);
        expect(diff.namespaces).toEqual(["code"]); expect(diff.changes).toEqual([{ op: "set-node-code", namespace: "code", nodeId: "normalize", field: "template.set" }]); expect(diff.layoutOnly).toBe(false);
        const history = JSON.parse((await client.readResource({ uri: "plastic://graph/g1/history?limit=5" })).contents[0].text);
        expect(history.entries[0].description).toBe("Version 2");
        await expect(client.readResource({ uri: "plastic://graph/g1/rev/rev_01J8ZK5K0B1C2D3E4F5G6H7J8A" })).rejects.toBeTruthy();
        await client.close();
    });

    test("an agent without a delegation can do nothing; with one it can read and propose but not more; proposals are validated, stored, audited and committed by a human", async () => {
        const { mcp, delegations, proposals, notified, store, broadcast, s3 } = await setup();
        let client = await connect(mcp, agent);
        const denied = await client.callTool({ name: "graph.summary", arguments: { schemaVersion: 1, graphId: "g1" } });
        expect(denied.isError).toBe(true); expect(parse(denied).error).toMatchObject({ code: "ADMISSION_DENIED", message: expect.stringMatching(/no delegation/) });
        await delegations.put({ agentSub: "agent|a1", graphId: "g1", delegatedBy: "auth0|u1", scopes: ["graph:read", "graph:propose", "graph:observe"], expiresAt: null, createdAt: new Date().toISOString() });
        const summary = parse(await client.callTool({ name: "graph.summary", arguments: { schemaVersion: 1, graphId: "g1" } }));
        expect(summary.envelope.principal).toEqual({ sub: "agent|a1", kind: "agent", tenant: "personal:auth0|u1", delegatedBy: "auth0|u1" });
        const rev = summary.envelope.resultRevision;
        const noCode = await client.callTool({ name: "graph.expand", arguments: { schemaVersion: 1, graphId: "g1", revisionId: rev, root: { nodeId: "validate" }, direction: "in", depth: 1, maxNodes: 5, maxBytes: 65536, includeCode: true } });
        expect(parse(noCode).error.code).toBe("ADMISSION_DENIED");
        // stale base
        const stale = await client.callTool({ name: "proposal.create", arguments: { schemaVersion: 1, graphId: "g1", baseRevision: "rev_01J8ZK5K0B1C2D3E4F5G6H7J8A", ops: [{ op: "set-node-code", nodeId: "normalize", template: "set", text: "edges.out = value.trim();" }], description: "Trim only whitespace", idempotencyKey: ULID } });
        expect(parse(stale).error).toMatchObject({ code: "STALE_BASE", retry: { retryable: true, rebaseTo: rev } });
        // a good proposal
        const created = parse(await client.callTool({ name: "proposal.create", arguments: { schemaVersion: 1, graphId: "g1", baseRevision: rev, ops: [{ op: "set-node-code", nodeId: "normalize", template: "set", text: "edges.out = value.trim();" }], description: "Trim only whitespace", rationale: "the old code stripped a trailing dot", idempotencyKey: ULID } }));
        expect(created.result).toMatchObject({ state: "awaiting-review", validation: { ok: true }, requiredDecisions: ["approve"], impact: { downstream: ["validate"], consumers: [], privilegeDelta: [] }, created: true });
        expect(created.result.proposalDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(created.result.diffSummary.namespaces).toEqual(["code"]);
        expect(created.envelope.baseRevision).toBe(rev);
        // idempotent
        const again = parse(await client.callTool({ name: "proposal.create", arguments: { schemaVersion: 1, graphId: "g1", baseRevision: rev, ops: [{ op: "set-node-code", nodeId: "normalize", template: "set", text: "edges.out = value.trim();" }], description: "Trim only whitespace", idempotencyKey: ULID } }));
        expect(again.result.proposalId).toBe(created.result.proposalId); expect(again.result.created).toBe(false);
        // privilege needs a decision the agent cannot give
        const priv = parse(await client.callTool({ name: "proposal.create", arguments: { schemaVersion: 1, graphId: "g1", baseRevision: rev, ops: [{ op: "set-placement", nodeId: "validate", placement: "server" }], description: "Run validate on the server", idempotencyKey: "01J8ZK5K0B1C2D3E4F5G6H7J8B" } }));
        expect(priv.result.requiredDecisions).toEqual(["approve", "privileged-connect"]);   // the agent holds neither; the committing owner supplies both
        expect(priv.result.impact.privilegeDelta).toEqual([{ kind: "graph:invoke", scope: ["placement:server:validate"] }]);
        // the proposal resource and the observations
        const p = JSON.parse((await client.readResource({ uri: `plastic://graph/g1/proposal/${created.result.proposalId}` })).contents[0].text);
        expect(p.principal).toMatchObject({ sub: "agent|a1", delegatedBy: "auth0|u1" }); expect(p.update).toBeUndefined();
        const obs = parse(await client.callTool({ name: "observations.query", arguments: { schemaVersion: 1, graphId: "g1", filter: { kind: "proposal" }, limit: 10 } }));
        expect(obs.result.observations.map((o) => o.kind)).toEqual(["proposal.created", "proposal.created"]);
        expect(notified.map((e) => e.action)).toEqual(["created", "created"]);
        await client.close();
        // the human commits it through admission: the graph changes, replicas hear it, a revision is cut
        const committed = await proposals.commit("g1", created.result.proposalId, owner);
        expect(committed.proposal.state).toBe("committed"); expect(committed.result.decision).toBe("accepted");
        expect(committed.proposal.resultRevision).toMatch(/^rev_/);
        expect((await store.projectGraph("g1")).nodes[1].template.set).toBe("edges.out = value.trim();");
        expect(broadcast.channel.some(([ch, v]) => ch === "graph-crdt-g1" && v.kind === "sync")).toBe(true);
        expect(await proposals.commit("g1", created.result.proposalId, owner)).toMatchObject({ result: { replayed: true } });
        // a stale proposal is refused until validated with rebase
        const stale2 = await proposals.commit("g1", priv.result.proposalId, owner);
        expect(stale2.code).toBe("STALE_BASE");
        const revalidated = await proposals.validate("g1", priv.result.proposalId, owner, true);
        expect(revalidated.proposal.state).toBe("awaiting-review");
        // the owner cannot approve their own... it is not theirs: approving as a different human clears the decision
        const approved = await proposals.decideProposal("g1", priv.result.proposalId, owner, "approve", revalidated.proposal.proposalDigest, "fine");
        expect(approved.proposal.state).toBe("validated"); expect(approved.proposal.requiredDecisions).toEqual([]);
        const committed2 = await proposals.commit("g1", priv.result.proposalId, owner);
        expect(committed2.proposal.state).toBe("committed");
        expect((await store.projectGraph("g1")).nodes[2].properties.placement).toBe("server");
        // the execution projection follows the commit (graphService loads it by url)
        const projection = JSON.parse(s3.objects.get("graphs/projections/endpoints/g1.json").toString());
        expect(projection.nodes.find((n) => n.id === "normalize").template.set).toBe("edges.out = value.trim();");
        expect(projection.nodes[2].properties.placement).toBe("server");
        client = await connect(mcp, agent);
        const audit = parse(await client.callTool({ name: "observations.query", arguments: { schemaVersion: 1, graphId: "g1", limit: 50 } }));
        expect(audit.result.observations.map((o) => o.kind)).toEqual(expect.arrayContaining(["mcp.tool.proposal.create", "proposal.created", "proposal.committed", "mutation.accepted", "revision.cut", "proposal.decided"]));
        await client.close();
    });

    test("a rejected proposal, a conflicting rebase, and component.search", async () => {
        const { mcp, delegations, proposals, components, store, doc } = await setup();
        await delegations.put({ agentSub: "agent|a1", graphId: "*", delegatedBy: "auth0|u1", scopes: ["graph:read", "graph:propose", "registry:read"], expiresAt: null, createdAt: new Date().toISOString() });
        const client = await connect(mcp, agent);
        const rev = parse(await client.callTool({ name: "graph.summary", arguments: { schemaVersion: 1, graphId: "g1" } })).envelope.resultRevision;
        const bad = await client.callTool({ name: "proposal.create", arguments: { schemaVersion: 1, graphId: "g1", baseRevision: rev, ops: [{ op: "connect", from: { nodeId: "form", field: "out" }, to: { nodeId: "ghost", field: "in" } }], description: "Wire to a ghost", idempotencyKey: ULID } });
        expect(parse(bad).error).toMatchObject({ code: "NOT_FOUND", message: expect.stringMatching(/no node ghost/) });
        const created = parse(await client.callTool({ name: "proposal.create", arguments: { schemaVersion: 1, graphId: "g1", baseRevision: rev, ops: [{ op: "set-node-code", nodeId: "normalize", template: "set", text: "edges.out = value.trim();" }], description: "Trim", idempotencyKey: "01J8ZK5K0B1C2D3E4F5G6H7J8C" } }));
        const rejected = await proposals.decideProposal("g1", created.result.proposalId, owner, "reject", created.result.proposalDigest, "no");
        expect(rejected.proposal.state).toBe("rejected");
        expect((await proposals.commit("g1", created.result.proposalId, owner)).code).toBe("CONFLICT");
        // someone edits the same node's code underneath another proposal: rebase reports a conflict
        const second = parse(await client.callTool({ name: "proposal.create", arguments: { schemaVersion: 1, graphId: "g1", baseRevision: rev, ops: [{ op: "set-node-code", nodeId: "normalize", template: "set", text: "edges.out = value.toLowerCase();" }], description: "Lowercase", idempotencyKey: "01J8ZK5K0B1C2D3E4F5G6H7J8D" } }));
        const snapshot = JSON.parse(JSON.stringify(toJSON(doc))); snapshot.nodes[1].template.set = "edges.out = value.toUpperCase();";
        let out; const h = (u) => (out = u); doc.on("updateV2", h); reconcile(doc, snapshot, { source: "t" }); doc.off("updateV2", h);
        await store.appendUpdate("g1", out, "Human edit", "auth0|u1");
        const v = await client.callTool({ name: "proposal.validate", arguments: { schemaVersion: 1, graphId: "g1", proposalId: second.result.proposalId } });
        expect(parse(v).error.code).toBe("STALE_BASE");
        const conflict = await client.callTool({ name: "proposal.validate", arguments: { schemaVersion: 1, graphId: "g1", proposalId: second.result.proposalId, rebase: true } });
        expect(parse(conflict).error.code).toBe("CONFLICT");
        // search
        const published = await components.publish("g1", owner, { label: "v1" });
        const found = parse(await client.callTool({ name: "component.search", arguments: { schemaVersion: 1, query: "account" } }));
        expect(found.result.components).toEqual([expect.objectContaining({ publishedId: "g1", version: published.manifest.version, kind: "graph", name: "Account settings", revisionId: expect.stringMatching(/^rev_/) })]);
        const c = JSON.parse((await client.readResource({ uri: `plastic://component/g1/${published.manifest.version}` })).contents[0].text);
        expect(c.manifest.version).toBe(published.manifest.version);
        const versions = JSON.parse((await client.readResource({ uri: "plastic://component/g1" })).contents[0].text);
        expect(versions.head.version).toBe(published.manifest.version);
        await client.close();
    });

    test("observations.query and the execution resources read what the runtime recorded; payloads need inspect-payloads", async () => {
        const { ExecutionRunner } = require("../runtime/executor");
        const { mcp, delegations, s3 } = await setup();
        const g = graphJson();
        g.nodes[2].properties.inputs[0].capture = "full";
        const runner = new ExecutionRunner(s3);
        const summary = await runner.run({ graph: g, nodeUrl: "form", field: "in", value: "  Ada  ", principal: { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1" }, revisionId: "01J8ZK5K0B1C2D3E4F5G6H7J8A" });
        expect(summary.state).toBe("completed");
        let client = await connect(mcp, owner);
        const all = parse(await client.callTool({ name: "observations.query", arguments: { schemaVersion: 1, graphId: "g1", filter: { executionId: summary.executionId } } }));
        expect(all.result.observations.map((o) => o.kind)).toEqual(["exec.end", "edge.input", "route", "edge.input", "route", "edge.input", "exec.begin"]);
        const intoValidate = all.result.observations.find((o) => o.kind === "edge.input" && o.nodeId === "validate");
        expect(intoValidate.payload.value).toBe("  Ada  ");
        const routes = parse(await client.callTool({ name: "observations.query", arguments: { schemaVersion: 1, graphId: "g1", filter: { kind: "route" }, limit: 1 } }));
        expect(routes.result.observations).toHaveLength(1); expect(routes.result.nextCursor).toBeDefined();
        const next = parse(await client.callTool({ name: "observations.query", arguments: { schemaVersion: 1, graphId: "g1", filter: { kind: "route" }, limit: 1, cursor: routes.result.nextCursor } }));
        expect(next.result.observations[0].id < routes.result.observations[0].id).toBe(true);
        const executions = JSON.parse((await client.readResource({ uri: "plastic://graph/g1/executions" })).contents[0].text);
        expect(executions.executions.map((e) => [e.executionId, e.state, e.revisionId])).toEqual([[summary.executionId, "completed", "rev_01J8ZK5K0B1C2D3E4F5G6H7J8A"]]);
        const one = JSON.parse((await client.readResource({ uri: `plastic://graph/g1/execution/${summary.executionId}` })).contents[0].text);
        expect(one.execution.executionId).toBe(summary.executionId); expect(one.observations).toHaveLength(7);
        await client.close();
        // an observing agent without inspect-payloads sees metadata only
        await delegations.put({ agentSub: "agent|a1", graphId: "g1", delegatedBy: "auth0|u1", scopes: ["graph:read", "graph:observe"], expiresAt: null, createdAt: new Date().toISOString() });
        client = await connect(mcp, agent);
        const redacted = parse(await client.callTool({ name: "observations.query", arguments: { schemaVersion: 1, graphId: "g1", filter: { executionId: summary.executionId, nodeId: "validate" } } }));
        expect(redacted.result.observations.map((o) => o.kind)).toEqual(["edge.input", "route"]);
        expect(redacted.result.observations[0].payload).toEqual({ meta: expect.objectContaining({ type: "string" }), redacted: "payload" });
        const noExec = await client.readResource({ uri: "plastic://graph/g1/execution/01J8ZK5K0B1C2D3E4F5G6H7J8Z" }).catch((e) => e);
        expect(String(noExec.message || noExec)).toMatch(/not found/);
        await client.close();
    });

    test("an agent acts on the graph only where it was delegated, and every act is bounded by the same rules", async () => {
        const { mcp, delegations, proposals, invoked, cancelled, store } = await setup();
        // a delegation that can read and run, and nothing else
        await delegations.put({ agentSub: "agent|a1", graphId: "g1", delegatedBy: "auth0|u1", scopes: ["graph:read", "graph:observe", "graph:execute", "graph:propose"], expiresAt: null, createdAt: new Date().toISOString() });
        let client = await connect(mcp, agent);
        const ran = parse(await client.callTool({ name: "graph.invoke", arguments: { schemaVersion: 1, graphId: "g1", nodeUrl: "form", value: { hello: "world" } } }));
        expect(ran.result).toMatchObject({ graphId: "g1", state: "completed", hops: expect.any(Number) });
        expect(invoked[0]).toMatchObject({ graphId: "g1", principal: "agent|a1" });
        const stop = parse(await client.callTool({ name: "execution.cancel", arguments: { schemaVersion: 1, graphId: "g1", executionId: ran.result.executionId, reason: "changed my mind" } }));
        expect(stop.result).toMatchObject({ requested: true, reason: "changed my mind" });
        expect(cancelled[0]).toMatchObject({ executionId: ran.result.executionId, by: "agent|a1" });
        // what it was not given, it cannot do
        for (const call of [
            { name: "revision.cut", arguments: { schemaVersion: 1, graphId: "g1", label: "mine now" } },
            { name: "revision.activate", arguments: { schemaVersion: 1, graphId: "g1", revisionId: "rev_01J8ZK5K0B1C2D3E4F5G6H7J8A" } },
            { name: "component.publish", arguments: { schemaVersion: 1, graphId: "g1" } },
            { name: "journey.run", arguments: { schemaVersion: 1, graphId: "g1", journeyId: "anything" } },
        ]) {
            const refused = await client.callTool(call);
            expect(refused.isError).toBe(true);
            expect(parse(refused).error).toMatchObject({ code: "ADMISSION_DENIED", message: expect.stringMatching(/lacks/) });
        }
        // an agent without a commit delegation cannot commit its own proposal
        const rev = parse(await client.callTool({ name: "graph.summary", arguments: { schemaVersion: 1, graphId: "g1" } })).envelope.resultRevision;
        const created = parse(await client.callTool({ name: "proposal.create", arguments: { schemaVersion: 1, graphId: "g1", baseRevision: rev, ops: [{ op: "set-node-code", nodeId: "normalize", template: "set", text: "edges.out = value.trim();" }], description: "Trim", idempotencyKey: ULID } }));
        expect(created.result.requiredDecisions).toEqual(["approve"]);
        await client.close();
        // the human approves and commits through the same tools
        client = await connect(mcp, owner);
        const decided = parse(await client.callTool({ name: "proposal.decide", arguments: { schemaVersion: 1, graphId: "g1", proposalId: created.result.proposalId, decision: "approve", proposalDigest: created.result.proposalDigest, rationale: "read it, it is fine" } }));
        expect(decided.result).toMatchObject({ state: "validated", requiredDecisions: [] });
        const committed = parse(await client.callTool({ name: "proposal.commit", arguments: { schemaVersion: 1, graphId: "g1", proposalId: created.result.proposalId } }));
        expect(committed.result).toMatchObject({ state: "committed", resultRevision: expect.stringMatching(/^rev_/) });
        expect((await store.projectGraph("g1")).nodes.find((n) => n.id === "normalize").template.set).toBe("edges.out = value.trim();");
        // and can name, publish and activate what it committed
        const cut = parse(await client.callTool({ name: "revision.cut", arguments: { schemaVersion: 1, graphId: "g1", label: "after the trim" } }));
        expect(cut.result).toMatchObject({ revision: expect.stringMatching(/^rev_/), seq: expect.any(Number) });
        const published = parse(await client.callTool({ name: "component.publish", arguments: { schemaVersion: 1, graphId: "g1", label: "trimmed" } }));
        expect(published.result).toMatchObject({ publishedId: "g1", version: expect.any(Number), digest: expect.stringMatching(/^sha256:/) });
        const activated = parse(await client.callTool({ name: "revision.activate", arguments: { schemaVersion: 1, graphId: "g1", revisionId: cut.result.revision } }));
        expect(activated.result.active).toMatchObject({ revision: cut.result.revision });
        const rolledBack = parse(await client.callTool({ name: "revision.rollback", arguments: { schemaVersion: 1, graphId: "g1", revisionId: rev } }));
        expect(rolledBack.result.decision).toBe("accepted");
        await client.close();
    });

    test("an agent the owner trusted with commit may commit what it proposed; one without that grant may not", async () => {
        const { mcp, delegations, proposals, autonomy, store } = await setup();
        // the owner delegates commit for this graph, and says they do not need
        // to see this work first
        await delegations.put({ agentSub: "agent|a1", graphId: "g1", delegatedBy: "auth0|u1", scopes: ["graph:read", "graph:propose", "graph:commit"], expiresAt: null, createdAt: new Date().toISOString() });
        await autonomy.put("auth0|u1", owner, { autonomy: "auto", note: "the journeys watch this graph" });
        let client = await connect(mcp, agent);
        const rev = parse(await client.callTool({ name: "graph.summary", arguments: { schemaVersion: 1, graphId: "g1" } })).envelope.resultRevision;
        const created = parse(await client.callTool({ name: "proposal.create", arguments: { schemaVersion: 1, graphId: "g1", baseRevision: rev, ops: [{ op: "set-node-code", nodeId: "normalize", template: "set", text: "edges.out = value.trim();" }], description: "Trim", idempotencyKey: ULID } }));
        expect(created.result.requiredDecisions).toEqual([]);          // nobody else has to say yes
        const committed = parse(await client.callTool({ name: "proposal.commit", arguments: { schemaVersion: 1, graphId: "g1", proposalId: created.result.proposalId } }));
        expect(committed.result).toMatchObject({ state: "committed", resultRevision: expect.stringMatching(/^rev_/) });
        expect((await store.projectGraph("g1")).nodes.find((n) => n.id === "normalize").template.set).toBe("edges.out = value.trim();");
        // who committed it is in the record, and nobody else is named there
        const stored = await proposals.get("g1", created.result.proposalId);
        expect(stored.decisions.map((d) => [d.by, d.decision])).toEqual([["agent|a1", "commit"]]);
        await client.close();
        // the same agent without that grant leaves the proposal waiting for a person, even in auto
        await delegations.put({ agentSub: "agent|a2", graphId: "g1", delegatedBy: "auth0|u1", scopes: ["graph:read", "graph:propose"], expiresAt: null, createdAt: new Date().toISOString() });
        client = await connect(mcp, { ...agent, sub: "agent|a2" });
        const head = parse(await client.callTool({ name: "graph.summary", arguments: { schemaVersion: 1, graphId: "g1" } })).envelope.resultRevision;
        const second = parse(await client.callTool({ name: "proposal.create", arguments: { schemaVersion: 1, graphId: "g1", baseRevision: head, ops: [{ op: "set-node-props", nodeId: "normalize", patch: { description: "from an agent without commit" } }], description: "Describe", idempotencyKey: "01J8ZK5K0B1C2D3E4F5G6H7J9Z" } }));
        expect(second.result.requiredDecisions).toEqual(["approve"]);
        const refused = await client.callTool({ name: "proposal.commit", arguments: { schemaVersion: 1, graphId: "g1", proposalId: second.result.proposalId } });
        expect(refused.isError).toBe(true);
        expect(parse(refused).error).toMatchObject({ code: "ADMISSION_DENIED" });
        await client.close();
    });

    test("a proposal whose operations no longer apply is stale, and says why", async () => {
        const { mcp, proposals, store, broadcast } = await setup();
        const client = await connect(mcp, owner);
        const rev = parse(await client.callTool({ name: "graph.summary", arguments: { schemaVersion: 1, graphId: "g1" } })).envelope.resultRevision;
        const created = parse(await client.callTool({ name: "proposal.create", arguments: { schemaVersion: 1, graphId: "g1", baseRevision: rev, ops: [{ op: "add-node", node: { id: "brand-new", url: "brand-new", name: "New", inputs: [{ name: "in" }], outputs: [{ name: "out" }], template: { set: "edges.out = value;" } } }], description: "Add a node", idempotencyKey: ULID } }));
        expect(created.result.state).toBe("validated");
        // someone else adds that node first, so the graph moves and the operation no longer applies
        const graph = await store.projectGraph("g1");
        const { applyOps } = require("@plastic-io/graph-crdt");
        const applied = applyOps(graph, [{ op: "add-node", node: { id: "brand-new", url: "brand-new", name: "New", inputs: [{ name: "in" }], outputs: [{ name: "out" }], template: { set: "edges.out = value;" } } }]);
        const doc = new Y.Doc();
        applyUpdate(doc, (await store.loadMerged("g1")).update);
        reconcile(doc, applied.projection);
        await store.appendUpdate("g1", encodeState(doc), "someone else", "system");
        const refused = await client.callTool({ name: "proposal.commit", arguments: { schemaVersion: 1, graphId: "g1", proposalId: created.result.proposalId } });
        expect(refused.isError).toBe(true);
        expect(parse(refused).error).toMatchObject({ code: "STALE_BASE", message: expect.stringMatching(/moved to rev_/) });
        // re-applying where the graph is now says what stands in the way, and the proposal stops looking ready
        const rebased = parse(await client.callTool({ name: "proposal.validate", arguments: { schemaVersion: 1, graphId: "g1", proposalId: created.result.proposalId, rebase: true } }));
        expect(rebased.result).toMatchObject({ state: "stale", validation: { ok: false, errors: [{ code: "CONFLICT", message: expect.stringMatching(/brand-new already exists/) }] } });
        const stored = await proposals.get("g1", created.result.proposalId);
        expect(stored.state).toBe("stale");
        void broadcast;
        await client.close();
    });

    test("a journey is runnable through the protocol, and says what it found", async () => {
        const { mcp, journeys, store } = await setup();
        await journeys.put("g1", owner, {
            id: "still-normalises", intent: "A value sent to the form is normalised", capability: "form.normalise",
            schedule: "*/5 * * * *", effects: "sim",
            steps: [{ act: { invoke: { capability: "form.normalise", input: "  Ada  " } }, expect: { observation: { kind: "exec.end", where: { state: "completed" } } } }],
        });
        const client = await connect(mcp, owner);
        const missing = parse(await client.callTool({ name: "journey.run", arguments: { schemaVersion: 1, graphId: "g1", journeyId: "still-normalises" } }));
        expect(missing.result).toMatchObject({ state: "unresolvable", reason: expect.stringMatching(/nothing in this graph provides form.normalise/) });
        // say what the node provides, and the same journey passes
        const graph = await store.projectGraph("g1");
        graph.nodes.find((n) => n.id === "form").properties.provides = ["form.normalise"];
        // change the document, the way an editor would, rather than merging a new one over it
        const doc = new Y.Doc();
        applyUpdate(doc, (await store.loadMerged("g1")).update);
        reconcile(doc, graph);
        await store.appendUpdate("g1", encodeState(doc), "provide", "system");
        const passed = parse(await client.callTool({ name: "journey.run", arguments: { schemaVersion: 1, graphId: "g1", journeyId: "still-normalises" } }));
        expect(passed.result).toMatchObject({ state: "passed", intent: expect.stringContaining("normalised") });
        expect(passed.result.steps[0]).toMatchObject({ capability: "form.normalise", resolvedNode: "form", state: "passed" });
        await client.close();
    });

    test("the Lambda face: an API Gateway event becomes a request; no principal is 401; a foreign Origin is refused", async () => {
        const { mcp } = await setup();
        const call = (event) => new Promise((res) => mcp.lambda(event, {}, (e, r) => res(r)));
        const unauth = await call({ httpMethod: "POST", path: "/dev/mcp", headers: {}, body: "{}" });
        expect(unauth.statusCode).toBe(401); expect(unauth.headers["WWW-Authenticate"]).toMatch(/resource_metadata/);
        const foreign = await call({ httpMethod: "POST", path: "/dev/mcp", headers: { Origin: "https://evil.example" }, body: "{}", principal: owner });
        expect(foreign.statusCode).toBe(403);
        const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
        const r = await call({ httpMethod: "POST", path: "/dev/mcp", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Host: "api.test" }, body, principal: owner, requestContext: { domainName: "api.test" } });
        expect(r.statusCode).toBe(200);
        expect(r.headers["Access-Control-Allow-Origin"]).toBe("*");
        const parsed = JSON.parse(r.body);
        expect(parsed.result.tools.map((t) => t.name)).toContain("graph.summary");
    });
});

/**
 * Work that outlives one call (plan §5.0, PB-084).  What matters over the
 * protocol is that the answer is honest about being a promise, that polling it
 * says something useful, and that the promise belongs to whoever made it.
 */
describe("work that outlives one call", () => {
    test("asking for it in the background answers with a task, which the worker then finishes", async () => {
        const { mcp, tasks, dispatched } = await setup();
        const client = await connect(mcp, owner);
        const started = parse(await client.callTool({ name: "tests.run", arguments: { schemaVersion: 1, graphId: "g1", async: true } }));
        expect(started.result).toMatchObject({ resultType: "task", task: { kind: "tests.run", status: "working", pollIntervalMs: 2000 } });
        const taskId = started.result.task.taskId;
        expect(dispatched).toEqual([taskId]);

        const working = parse(await client.callTool({ name: "tasks.get", arguments: { schemaVersion: 1, taskId } }));
        expect(working.result).toMatchObject({ taskId, status: "working", by: owner.sub });
        expect(working.result.principal).toBeUndefined();

        // the worker, here in this process
        await tasks.work(taskId, async () => ({ runs: [], failed: 0 }));
        const done = parse(await client.callTool({ name: "tasks.get", arguments: { schemaVersion: 1, taskId } }));
        expect(done.result).toMatchObject({ taskId, status: "completed", result: { failed: 0 } });

        const listed = parse(await client.callTool({ name: "tasks.list", arguments: { schemaVersion: 1, graphId: "g1" } }));
        expect(listed.result.tasks.map((task) => task.taskId)).toEqual([taskId]);
    });

    test("a task belongs to whoever started it: another tenant cannot read or stop it", async () => {
        const { mcp } = await setup();
        const mine = await connect(mcp, owner);
        const started = parse(await mine.callTool({ name: "graph.invoke", arguments: { schemaVersion: 1, graphId: "g1", nodeUrl: "entry", async: true } }));
        const taskId = started.result.task.taskId;
        const theirs = await connect(mcp, { sub: "auth0|u9", kind: "human", tenant: "personal:auth0|u9", scopes: [] });
        const read = await theirs.callTool({ name: "tasks.get", arguments: { schemaVersion: 1, taskId } });
        expect(read.isError).toBe(true);
        expect(parse(read).error.code).toBe("ADMISSION_DENIED");
        const stop = await theirs.callTool({ name: "tasks.cancel", arguments: { schemaVersion: 1, taskId } });
        expect(stop.isError).toBe(true);
    });

    test("asking it to stop reaches the work, and the record says how it ended", async () => {
        const { mcp, tasks } = await setup();
        const client = await connect(mcp, owner);
        const started = parse(await client.callTool({ name: "tests.run", arguments: { schemaVersion: 1, graphId: "g1", async: true } }));
        const taskId = started.result.task.taskId;
        const cancelled = parse(await client.callTool({ name: "tasks.cancel", arguments: { schemaVersion: 1, taskId, reason: "not now" } }));
        expect(cancelled.result.cancelRequested).toMatchObject({ reason: "not now" });
        const steps = [];
        await tasks.work(taskId, async (task, isCancelled) => {
            if (await isCancelled()) { return { stopped: true }; }
            steps.push("ran");
            return { runs: [] };
        });
        expect(steps).toEqual([]);
        const done = parse(await client.callTool({ name: "tasks.get", arguments: { schemaVersion: 1, taskId } }));
        expect(done.result.status).toBe("cancelled");
    });

    test("without a worker behind it, a tool says so instead of promising", async () => {
        const s = await setup();
        const { RateLimiter } = require("../admission/limits");
        // the same services, with nothing to take the work
        const bare = makeMcpHandler({
            crdtStore: s.store, tocStore: new TocStore(s.s3), admission: s.crdt.admission, revisions: s.revisions,
            components: s.components, proposals: s.proposals, summaries: s.summaries, delegations: s.delegations, tests: s.tests,
            rate: { reads: new RateLimiter({ maxMutations: 1000 }), writes: new RateLimiter({ maxMutations: 1000 }) },
        });
        const client = await connect(bare, owner);
        const answer = await client.callTool({ name: "tests.run", arguments: { schemaVersion: 1, graphId: "g1", async: true } });
        expect(answer.isError).toBe(true);
        expect(parse(answer).error.message).toContain("background");
    });
});

/**
 * What a proposal would do, over the protocol (plan §4.7.5).  A review needs
 * to know what a change touches and, where it can be shown, what it would have
 * done to work this graph has already handled.
 */
describe("asking what a proposal would do", () => {
    test("structural comes back at once; a shadow run is a task", async () => {
        const { mcp, tasks } = await setup();
        const client = await connect(mcp, owner);
        const summary = parse(await client.callTool({ name: "graph.summary", arguments: { schemaVersion: 1, graphId: "g1" } }));
        const created = parse(await client.callTool({ name: "proposal.create", arguments: {
            schemaVersion: 1, graphId: "g1", baseRevision: summary.envelope.resultRevision,
            ops: [{ op: "set-node-code", nodeId: "normalize", template: "set", text: "edges.out = value.trim();" }],
            description: "Trim only whitespace", idempotencyKey: "01J8ZK5K0B1C2D3E4F5G6H7J8B",
        } }));
        const proposalId = created.result.proposalId;

        const structural = parse(await client.callTool({ name: "proposal.simulate", arguments: { schemaVersion: 1, graphId: "g1", proposalId } }));
        expect(structural.result).toMatchObject({ mode: "structural", required: true, namespaces: ["code"], verdict: "unproven" });

        const shadow = parse(await client.callTool({ name: "proposal.simulate", arguments: { schemaVersion: 1, graphId: "g1", proposalId, mode: "shadow" } }));
        expect(shadow.result).toMatchObject({ resultType: "task", task: { kind: "proposal.simulate", status: "working" } });
        // and the work, when it runs, answers with a simulation
        const done = await tasks.work(shadow.result.task.taskId, async (task) => ({ proposalId: task.input.proposalId, mode: "shadow", verdict: "unproven" }));
        expect(done.status).toBe("completed");
        expect(done.result.proposalId).toBe(proposalId);
    });

    test("a replay says why it cannot be given, rather than guessing", async () => {
        const { mcp } = await setup();
        const client = await connect(mcp, owner);
        const summary = parse(await client.callTool({ name: "graph.summary", arguments: { schemaVersion: 1, graphId: "g1" } }));
        const created = parse(await client.callTool({ name: "proposal.create", arguments: {
            schemaVersion: 1, graphId: "g1", baseRevision: summary.envelope.resultRevision,
            ops: [{ op: "set-node-code", nodeId: "normalize", template: "set", text: "edges.out = value.trim();" }],
            description: "Trim only whitespace", idempotencyKey: "01J8ZK5K0B1C2D3E4F5G6H7J8C",
        } }));
        const answer = await client.callTool({ name: "proposal.simulate", arguments: { schemaVersion: 1, graphId: "g1", proposalId: created.result.proposalId, mode: "replay", async: false } });
        expect(answer.isError).toBe(true);
        expect(parse(answer).error.code).toBe("UNSUPPORTED");
    });
});

describe("who uses a published component", () => {
    /**
     * `graph.summary` says what a graph depends on; this is the other
     * direction, which is the question asked *before* a version is replaced.
     * It is still a question about graphs, so it answers about the ones the
     * caller could have read directly and no others (PB-044).
     */
    async function withConsumers(extraGraphs = []) {
        const parts = await setup({ consumers: true });
        const pinned = (nodeId, publishedId, version, name) => ({
            id: nodeId, url: nodeId, properties: { name: name || nodeId, component: { publishedId, version, digest: "sha256:abc" } },
        });
        await parts.consumers.record({ id: "g1", url: "g1", nodes: [pinned("left", "c1", 1, "Left"), pinned("right", "c1", 1, "Right")], properties: { name: "Account settings" } });
        for (const g of extraGraphs) {
            await parts.consumers.record(g);
        }
        return parts;
    }

    test("lists the graphs that carry it, with the nodes and versions they pin", async () => {
        const { mcp } = await withConsumers();
        const client = await connect(mcp, owner);
        const r = parse(await client.callTool({ name: "component.consumers", arguments: { schemaVersion: 1, publishedId: "c1" } }));
        expect(r.result.publishedId).toBe("c1");
        expect(r.result.consumers.map((c) => c.graphName)).toEqual(["Account settings"]);
        expect(r.result.consumers[0].uses.map((u) => `${u.name}@${u.version}`).sort()).toEqual(["Left@1", "Right@1"]);
        expect(r.envelope.principal.sub).toBe("auth0|u1");
        await client.close();
    });

    test("with a version, says who would be behind it, level with it, and ahead of it", async () => {
        const { mcp } = await withConsumers([
            { id: "g2", url: "g2", nodes: [{ id: "n", url: "n", properties: { name: "n", component: { publishedId: "c1", version: 3 } } }], properties: { name: "Ahead already" } },
        ]);
        const client = await connect(mcp, owner);
        const r = parse(await client.callTool({ name: "component.consumers", arguments: { schemaVersion: 1, publishedId: "c1", version: 2 } }));
        expect(r.result.consumers).toBe(2);
        expect(r.result.behind.map((c) => c.graphName)).toEqual(["Account settings"]);
        expect(r.result.current).toEqual([]);
        // ahead is not nothing: it says a rollback happened, or that somebody
        // is running a version that was withdrawn
        expect(r.result.ahead.map((c) => c.graphName)).toEqual(["Ahead already"]);
        await client.close();
    });

    test("an agent is told about the graphs it may read, and not about the others", async () => {
        const { mcp, delegations } = await withConsumers([
            { id: "secret", url: "secret", nodes: [{ id: "n", url: "n", properties: { name: "n", component: { publishedId: "c1", version: 1 } } }], properties: { name: "Somebody else's graph" } },
        ]);
        // may browse the registry everywhere, may read one graph
        await delegations.put({ agentSub: "agent|a1", graphId: "*", delegatedBy: "auth0|u1", scopes: ["registry:read"], expiresAt: null, createdAt: new Date().toISOString() });
        await delegations.put({ agentSub: "agent|a1", graphId: "g1", delegatedBy: "auth0|u1", scopes: ["graph:read", "registry:read"], expiresAt: null, createdAt: new Date().toISOString() });
        const client = await connect(mcp, agent);
        const r = parse(await client.callTool({ name: "component.consumers", arguments: { schemaVersion: 1, publishedId: "c1" } }));
        expect(r.result.consumers.map((c) => c.graphId)).toEqual(["g1"]);
        await client.close();
    });

    test("an agent with no delegation is refused outright", async () => {
        const { mcp } = await withConsumers();
        const client = await connect(mcp, agent);
        const r = await client.callTool({ name: "component.consumers", arguments: { schemaVersion: 1, publishedId: "c1" } });
        expect(r.isError).toBe(true);
        expect(parse(r).error.code).toBe("ADMISSION_DENIED");
        await client.close();
    });

    test("a server with no index says so rather than answering emptily", async () => {
        const { mcp } = await setup();
        const client = await connect(mcp, owner);
        const r = await client.callTool({ name: "component.consumers", arguments: { schemaVersion: 1, publishedId: "c1" } });
        expect(r.isError).toBe(true);
        expect(parse(r).error.code).toBe("UNSUPPORTED");
        await client.close();
    });

    test("the same answer is a resource, for a client that reads rather than calls", async () => {
        const { mcp } = await withConsumers();
        const client = await connect(mcp, owner);
        const r = await client.readResource({ uri: "plastic://component/c1/consumers" });
        const body = JSON.parse(r.contents[0].text);
        expect(body.publishedId).toBe("c1");
        expect(body.consumers.map((c) => c.graphId)).toEqual(["g1"]);
        await client.close();
    });
});

describe("looking at what a graph serves", () => {
    /**
     * The picture comes back as a picture (PB-149).  A tool that described an
     * image in words would leave the agent exactly where it was: told that
     * something is fine.
     */
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const withCapture = async (answer) => {
        const parts = await setup();
        const asked = [];
        const capture = {
            screenshot: async (graphId, principal, options) => {
                asked.push({ graphId, sub: principal && principal.sub, options });
                return answer || { shot: { key: "screenshots/g1/x.png", url: "https://api.test/dev/g1", viewport: { width: 1280, height: 800 }, fullPage: false, format: "png", bytes: png.length, takenAt: "2026-10-02T00:00:00.000Z", by: { sub: "auth0|u1", kind: "human" }, from: "server", title: "Storefront", status: 200, console: [] }, image: png };
            },
        };
        const { makeMcpHandler } = require("../mcp/handler");
        const { RateLimiter } = require("../admission/limits");
        const mcp = makeMcpHandler({
            crdtStore: parts.store, tocStore: parts.tocStore, admission: parts.crdt.admission, revisions: parts.revisions,
            components: parts.components, proposals: parts.proposals, summaries: parts.summaries, delegations: parts.delegations,
            capture,
            rate: { reads: new RateLimiter({ maxMutations: 1000 }), writes: new RateLimiter({ maxMutations: 1000 }) },
        });
        return { ...parts, mcp, asked };
    };

    test("the answer carries the image itself, beside what it is a picture of", async () => {
        const { mcp, asked } = await withCapture();
        const client = await connect(mcp, owner);
        const r = await client.callTool({ name: "view.screenshot", arguments: { schemaVersion: 1, graphId: "g1" } });
        const image = r.content.find((c) => c.type === "image");
        expect(image).toBeTruthy();
        expect(image.mimeType).toBe("image/png");
        expect(Buffer.from(image.data, "base64")).toEqual(png);
        const answer = parse(r);
        expect(answer.result).toMatchObject({ from: "server", title: "Storefront", status: 200, url: "https://api.test/dev/g1" });
        expect(asked[0]).toMatchObject({ graphId: "g1", sub: "auth0|u1" });
        await client.close();
    });

    test("what it was asked for is passed through: one node, a phone-shaped viewport, something to wait for", async () => {
        const { mcp, asked } = await withCapture();
        const client = await connect(mcp, owner);
        await client.callTool({ name: "view.screenshot", arguments: { schemaVersion: 1, graphId: "g1", nodeUrl: "index", viewport: { width: 375, height: 667 }, fullPage: true, waitFor: ".bag" } });
        expect(asked[0].options).toMatchObject({ nodeUrl: "index", viewport: { width: 375, height: 667 }, fullPage: true, waitFor: ".bag" });
        await client.close();
    });

    test("a browser that could not reach the page is an answer, and carries no picture", async () => {
        const { mcp } = await withCapture({ error: "net::ERR_CONNECTION_REFUSED", code: "CAPTURE_FAILED" });
        const client = await connect(mcp, owner);
        const r = await client.callTool({ name: "view.screenshot", arguments: { schemaVersion: 1, graphId: "g1" } });
        expect(r.isError).toBe(true);
        expect(parse(r).error.code).toBe("CAPTURE_FAILED");
        // nothing that looks like a picture of a working page
        expect(r.content.find((c) => c.type === "image")).toBeUndefined();
        await client.close();
    });

    test("an agent with no delegation cannot look", async () => {
        const { mcp } = await withCapture();
        const client = await connect(mcp, agent);
        const r = await client.callTool({ name: "view.screenshot", arguments: { schemaVersion: 1, graphId: "g1" } });
        expect(parse(r).error.code).toBe("ADMISSION_DENIED");
        await client.close();
    });

    test("a server that cannot take pictures says so", async () => {
        const { mcp } = await setup();
        const client = await connect(mcp, owner);
        expect(parse(await client.callTool({ name: "view.screenshot", arguments: { schemaVersion: 1, graphId: "g1" } })).error.code).toBe("UNSUPPORTED");
        await client.close();
    });
});

describe("asking what an infrastructure change would do", () => {
    /**
     * A plan is a question, and the answer is the only thing this milestone
     * can produce (D-43).  The tool exists so an agent can ask it; there is
     * deliberately no tool that applies one.
     */
    const withIac = async (answers = {}) => {
        const parts = await setup();
        const plans = [];
        const iac = {
            plan: async (graphId, nodeId, principal, options) => {
                plans.push({ graphId, nodeId, sub: principal && principal.sub, options });
                return answers.plan || { plan: { changeSetId: "arn:cs", changes: [{ action: "Add", logicalId: "Bucket", resourceType: "AWS::S3::Bucket" }], destructive: false, changeSetRetained: false, stackExists: false } };
            },
            status: async () => answers.status || { state: "never-planned" },
        };
        const { makeMcpHandler } = require("../mcp/handler");
        const { RateLimiter } = require("../admission/limits");
        const mcp = makeMcpHandler({
            crdtStore: parts.store, tocStore: parts.tocStore, admission: parts.crdt.admission, revisions: parts.revisions,
            components: parts.components, proposals: parts.proposals, summaries: parts.summaries, delegations: parts.delegations,
            tasks: parts.tasks, iac,
            rate: { reads: new RateLimiter({ maxMutations: 1000 }), writes: new RateLimiter({ maxMutations: 1000 }) },
        });
        return { ...parts, mcp, plans };
    };

    test("a plan is a task, because a change set takes longer than a call", async () => {
        const { mcp, dispatched } = await withIac();
        const client = await connect(mcp, owner);
        const r = parse(await client.callTool({ name: "iac.plan", arguments: { schemaVersion: 1, graphId: "g1", nodeId: "stack" } }));
        expect(r.result.resultType).toBe("task");
        expect(r.result.task).toMatchObject({ kind: "iac.plan", status: "working", graphId: "g1" });
        expect(r.result.task.taskId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(dispatched).toContain(r.result.task.taskId);
        await client.close();
    });

    test("a caller who would rather wait gets the answer itself", async () => {
        const { mcp, plans } = await withIac();
        const client = await connect(mcp, owner);
        const r = parse(await client.callTool({ name: "iac.plan", arguments: { schemaVersion: 1, graphId: "g1", nodeId: "stack", async: false } }));
        expect(r.result.plan.changes).toHaveLength(1);
        expect(r.result.plan.destructive).toBe(false);
        expect(plans[0]).toMatchObject({ graphId: "g1", nodeId: "stack", sub: "auth0|u1" });
        await client.close();
    });

    test("a refusal names what it refused, so it can be fixed", async () => {
        const { mcp } = await withIac({ plan: { error: "this desired state is not one this environment allows", code: "IAC_REFUSED", problems: [{ code: "CUSTOM_RESOURCE", message: "a custom resource runs code of its own", resource: "X" }] } });
        const client = await connect(mcp, owner);
        const r = await client.callTool({ name: "iac.plan", arguments: { schemaVersion: 1, graphId: "g1", nodeId: "stack", async: false } });
        expect(r.isError).toBe(true);
        const answer = parse(r);
        expect(answer.error.code).toBe("IAC_REFUSED");
        expect(answer.error.details.problems[0].code).toBe("CUSTOM_RESOURCE");
        await client.close();
    });

    test("an agent with no delegation cannot ask for a plan, or for the status", async () => {
        const { mcp } = await withIac();
        const client = await connect(mcp, agent);
        for (const name of ["iac.plan", "iac.status"]) {
            const r = await client.callTool({ name, arguments: { schemaVersion: 1, graphId: "g1", nodeId: "stack" } });
            expect(parse(r).error.code).toBe("ADMISSION_DENIED");
        }
        await client.close();
    });

    test("there is no tool that applies one", async () => {
        const { mcp } = await withIac();
        const client = await connect(mcp, owner);
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names).toContain("iac.plan");
        expect(names.filter((n) => /apply|deploy|execute/i.test(n))).toEqual([]);
        await client.close();
    });

    test("a server with no infrastructure service says so", async () => {
        const { mcp } = await setup();
        const client = await connect(mcp, owner);
        const r = await client.callTool({ name: "iac.plan", arguments: { schemaVersion: 1, graphId: "g1", nodeId: "stack", async: false } });
        expect(parse(r).error.code).toBe("UNSUPPORTED");
        await client.close();
    });
});

describe("what an agent needs to find its way around", () => {
    /**
     * Two things an agent could not ask for: which named revisions a graph has
     * (so it can name a base other than HEAD), and what proposals are open
     * against it (so it can see what became of its own).  Both existed over
     * REST and neither was reachable through the protocol.
     */
    test("a graph's revisions are a resource, and say which one is active", async () => {
        const { mcp, revisions } = await setup();
        await revisions.cut("g1", owner, "first");
        const client = await connect(mcp, owner);
        const r = await client.readResource({ uri: "plastic://graph/g1/revisions" });
        const body = JSON.parse(r.contents[0].text);
        expect(body.graphId).toBe("g1");
        expect(body.revisions.length).toBeGreaterThan(0);
        expect(body.revisions[0].revisionId).toMatch(/^rev_[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(body.revisions[0].seq).toBe(1);
        expect(body).toHaveProperty("active");
        await client.close();
    });

    test("proposals against a graph are a resource, with what became of each", async () => {
        const { mcp } = await setup();
        const client = await connect(mcp, owner);
        const cut = parse(await client.callTool({ name: "graph.summary", arguments: { schemaVersion: 1, graphId: "g1" } }));
        const created = parse(await client.callTool({ name: "proposal.create", arguments: {
            schemaVersion: 1, graphId: "g1", baseRevision: cut.envelope.resultRevision, description: "Trim in normalize",
            rationale: "make normalize trim", idempotencyKey: ULID,
            ops: [{ op: "set-node-code", nodeId: "normalize", template: "set", text: "edges.out = String(value).trim();" }],
        } }));
        const r = await client.readResource({ uri: "plastic://graph/g1/proposals" });
        const body = JSON.parse(r.contents[0].text);
        expect(body.proposals.map((p) => p.proposalId)).toContain(created.result.proposalId);
        const mine = body.proposals.find((p) => p.proposalId === created.result.proposalId);
        // the listing agrees with what the tool said it had done
        expect(mine.state).toBe(created.result.state);
        expect(mine.baseRevision).toMatch(/^rev_/);
        await client.close();
    });

    test("the graph listing names only the graphs the caller may read", async () => {
        const { mcp, delegations, tocStore, broadcast } = await setup();
        await listGraph(tocStore, broadcast, { ...graphJson(), id: "g2", url: "g2", properties: { ...graphJson().properties, name: "Somebody else's graph" } }, "system");
        const client = await connect(mcp, owner);
        const all = JSON.parse((await client.readResource({ uri: "plastic://graphs" })).contents[0].text);
        expect(all.graphs.map((g) => g.graphId).sort()).toEqual(["g1", "g2"]);
        await client.close();
        await delegations.put({ agentSub: "agent|a1", graphId: "g1", delegatedBy: "auth0|u1", scopes: ["graph:read"], expiresAt: null, createdAt: new Date().toISOString() });
        const asAgent = await connect(mcp, agent);
        const mine = JSON.parse((await asAgent.readResource({ uri: "plastic://graphs" })).contents[0].text);
        expect(mine.graphs.map((g) => g.graphId)).toEqual(["g1"]);
        await asAgent.close();
    });

    test("a caller can ask what it is and what it may do, without being refused something first", async () => {
        const { mcp, delegations } = await setup();
        const human = await connect(mcp, owner);
        const me = JSON.parse((await human.readResource({ uri: "plastic://me" })).contents[0].text);
        expect(me).toMatchObject({ sub: "auth0|u1", kind: "human", policyVersion: "m1-diff" });
        expect(me.holdsEverywhere).toContain("graph:commit");
        expect(me.delegations).toBeUndefined();
        await human.close();

        await delegations.put({ agentSub: "agent|a1", graphId: "g1", delegatedBy: "auth0|u1", scopes: ["graph:read", "graph:propose"], expiresAt: null, createdAt: new Date().toISOString(), label: "reviewer" });
        const asAgent = await connect(mcp, agent);
        const theirs = JSON.parse((await asAgent.readResource({ uri: "plastic://me" })).contents[0].text);
        expect(theirs.kind).toBe("agent");
        // nothing was delegated for every graph, so it holds nothing at large
        expect(theirs.holdsEverywhere).toEqual([]);
        expect(theirs.delegations).toEqual([{ graphId: "g1", scopes: ["graph:read", "graph:propose"], expiresAt: null, delegatedBy: "auth0|u1", label: "reviewer" }]);
        await asAgent.close();
    });

    test("an agent with no delegation cannot list either", async () => {
        const { mcp } = await setup();
        const client = await connect(mcp, agent);
        await expect(client.readResource({ uri: "plastic://graph/g1/revisions" })).rejects.toThrow(/not found/);
        await expect(client.readResource({ uri: "plastic://graph/g1/proposals" })).rejects.toThrow(/not found/);
        await client.close();
    });
});


describe("MCP chat workflow", () => {
    test("agent status updates do not consume the graph mutation budget", async () => {
        const {mcp} = await setup({chat:true,writeLimit:1}); const client = await connect(mcp,owner);
        const call = async (name,args={}) => parse(await client.callTool({name,arguments:{schemaVersion:1,graphId:"g1",agentSessionId:"separate-budget",...args}}));
        try {
            expect((await call("chat.join",{name:"Planner"})).error).toBeUndefined();
            for (const phase of ["thinking","doing","done"]) expect((await call("chat.post",{messageId:phase,text:`@here ${phase}`,phase})).error).toBeUndefined();
            expect((await call("revision.cut")).error).toBeUndefined();
            expect((await call("revision.cut")).error.code).toBe("RATE_LIMITED");
        } finally {await client.close();}
    });
    test("real MCP tools enforce interruption acknowledgements before graph writes", async () => {
        const {mcp,chat} = await setup({chat:true}); const client = await connect(mcp,owner);
        const call = async (name,args) => parse(await client.callTool({name,arguments:{schemaVersion:1,graphId:"g1",...args}}));
        try {
            expect((await client.listTools()).tools.some(t => t.name === "chat.wait")).toBe(true);
            expect((await call("revision.cut",{})).error.code).toBe("SESSION_REQUIRED");
            await call("chat.join",{agentSessionId:"mcp-test",name:"Test agent"});
            await call("chat.post",{agentSessionId:"mcp-test",messageId:"thinking",text:"@here Planning",phase:"thinking"});
            const interruption = await chat.post(owner,{graphId:"g1",messageId:"feedback",text:"Wait for the new schema",interrupt:true});
            expect((await call("revision.cut",{agentSessionId:"mcp-test"})).error.code).toBe("CHAT_INTERRUPTED");
            const history = await call("chat.read",{agentSessionId:"mcp-test"});
            expect(history.result.pendingInterruptions[0].id).toBe(interruption.message.id);
            const waited = await call("chat.wait",{agentSessionId:"mcp-test",after:0,timeoutMs:0});
            expect(waited.result.messages.length).toBe(2);
            await call("chat.post",{agentSessionId:"mcp-test",messageId:"ack",text:"I will use the revised schema.",phase:"acknowledged",acknowledges:[interruption.message.id]});
            expect((await call("revision.cut",{agentSessionId:"mcp-test"})).error).toBeUndefined();
            const resource = await client.readResource({uri:"plastic://graph/g1/chat"});
            expect(JSON.parse(resource.contents[0].text).messages).toHaveLength(3);
        } finally {await client.close();}
    });
});

// Chess conversation regression: all application mutations use the public MCP schemas.
describe('MCP platform workflow contract',()=>{
 test('connection-only revalidation preserves reviewed impact, digest and approval',async()=>{
  const f=await setup();const client=await connect(f.mcp,owner);
  try{
   const call=async(name,args)=>parse(await client.callTool({name,arguments:{schemaVersion:1,graphId:'g1',...args}}));
   const base=(await call('graph.summary',{})).envelope.resultRevision;
   const created=(await call('proposal.create',{baseRevision:base,ops:[{op:'connect',from:{nodeId:'form',field:'out'},to:{nodeId:'validate',field:'in'}}],description:'Connect existing nodes',idempotencyKey:ULID})).result;
   expect(created.validation.ok).toBe(true);
   const approved=await f.proposals.decideProposal('g1',created.proposalId,{...owner,sub:'reviewer'},'approve',created.proposalDigest);
   expect(approved.error).toBeUndefined();
   const checked=(await call('proposal.validate',{proposalId:created.proposalId})).result;
   expect(checked.proposalDigest).toBe(created.proposalDigest);
   expect(checked.impact).toEqual(created.impact);
   expect((await f.proposals.get('g1',created.proposalId)).decisions).toHaveLength(1);
  }finally{await client.close();}
 });
 test('fresh client discovers schemas, renames graph, validates reproducibly and retires obsolete work',async()=>{
  const f=await setup();const client=await connect(f.mcp,owner);
  const discovery=parse(await client.callTool({name:'server.discover',arguments:{schemaVersion:1}})).result;
  expect(discovery.contracts.operations.examples.rename).toEqual([{op:'set-graph-props',patch:{name:'Chess'}}]);
  expect(discovery.contracts.workflow.boundary).toMatch(/never substitute AWS CLI/i);
  const base=parse(await client.callTool({name:'graph.summary',arguments:{schemaVersion:1,graphId:'g1'}})).envelope.resultRevision;
  const args={schemaVersion:1,graphId:'g1',baseRevision:base,ops:discovery.contracts.operations.examples.rename,description:'Rename to Chess',idempotencyKey:ULID};
  const created=parse(await client.callTool({name:'proposal.create',arguments:args})).result;
  const again=parse(await client.callTool({name:'proposal.validate',arguments:{schemaVersion:1,graphId:'g1',proposalId:created.proposalId}})).result;
  expect(again.proposalDigest).toBe(created.proposalDigest);
  const ready=parse(await client.callTool({name:'proposal.commit',arguments:{schemaVersion:1,graphId:'g1',proposalId:created.proposalId}})).result;
  expect(ready.state).toBe('committed');expect((await f.store.projectGraph('g1')).properties.name).toBe('Chess');
  const nextBase=parse(await client.callTool({name:'graph.summary',arguments:{schemaVersion:1,graphId:'g1'}})).envelope.resultRevision;
  const replacementArgs={...args,baseRevision:nextBase};
  const obsolete=parse(await client.callTool({name:'proposal.create',arguments:{...replacementArgs,idempotencyKey:require('ulid').ulid(),ops:[{op:'set-graph-props',patch:{name:'Obsolete'}}]}})).result;
  const replacement=parse(await client.callTool({name:'proposal.create',arguments:{...replacementArgs,idempotencyKey:require('ulid').ulid(),ops:[{op:'set-graph-props',patch:{name:'Current'}}]}})).result;
  const retired=parse(await client.callTool({name:'proposal.retire',arguments:{schemaVersion:1,graphId:'g1',proposalId:obsolete.proposalId,replacementProposalId:replacement.proposalId}}));
  expect(retired.result.state).toBe('superseded');
  expect((await f.proposals.decideProposal('g1',obsolete.proposalId,{...owner,sub:'different-reviewer'},'approve',obsolete.proposalDigest)).code).toBe('CONFLICT');
  expect((await f.proposals.validate('g1',obsolete.proposalId,owner)).proposal.state).toBe('superseded');
  await client.close();
 });
 test('schema failures identify fields and unknown runtime helper without guessing operation names',async()=>{
  const f=await setup();const client=await connect(f.mcp,owner);
  const base=parse(await client.callTool({name:'graph.summary',arguments:{schemaVersion:1,graphId:'g1'}})).envelope.resultRevision;
  const args={schemaVersion:1,graphId:'g1',baseRevision:base,description:'Chess regression',idempotencyKey:ULID};
  const invalid=parse(await client.callTool({name:'proposal.create',arguments:{...args,ops:[{op:'rename',name:'Chess'}]}}));
  expect(invalid.error.details.schemaUri).toBe('plastic://schema/1/operations');
  const helper=parse(await client.callTool({name:'proposal.create',arguments:{...args,ops:[{op:'set-node-code',nodeId:'validate',template:'set',text:'edges.out=identity();'}]}}));
  expect(helper.error.details.errors[0].code).toBe('UNSUPPORTED_HELPER');
  await client.close();
 });
});

test('Chess acceptance: discover, preflight, propose, graph approval, isolated review, MCP invocation and correlated errors',async()=>{
 const env={...process.env};
 Object.assign(process.env,{IAC_STACK_ISOLATION:'true',IAC_GUARDRAIL_ROLE_ARN:'configured',IAC_REVIEW_STATE_MACHINE:'configured',IAC_ACCOUNTS:'230639770018',IAC_REGIONS:'us-west-1'});
 let state={exists:false};
 const cloud={prepare:async()=>true,stack:async()=>state,create:async()=>({changeSetId:'cs',stackId:'stack'}),describe:async()=>({status:'CREATE_COMPLETE',executionStatus:'AVAILABLE',changes:[{action:'Add',logicalId:'Backend',resourceType:'AWS::Lambda::Function'}]}),execute:async()=>{state={exists:true,status:'CREATE_COMPLETE'};},remove:async()=>{},resources:async op=>[{logicalId:'Backend',resourceType:'AWS::Lambda::Function',physicalId:op.input.isolation.namespace+'backend'}]};
 let client,humanClient;
 try{
  const players=new Set();
  const f=await setup({infrastructure:cloud,chat:true,applicationBackend:async(_arn,event)=>{
   if(event.input.action==='fail')throw new Error('Application rejected an invalid move');
   if(event.input.action==='register')players.add(event.context.caller.sub);return {result:{players:[...players]},updates:[{topic:'players',value:{players:[...players]}}]};
  }});
  await f.delegations.put({agentSub:agent.sub,graphId:'g1',delegatedBy:owner.sub,scopes:['graph:read','graph:propose','graph:observe','graph:inspect-payloads','graph:execute','iac:propose','iac:read-status'],expiresAt:null,createdAt:new Date().toISOString(),label:'MCP builder'});
  client=await connect(f.mcp,agent);
  const call=async(name,args={})=>parse(await client.callTool({name,arguments:{schemaVersion:1,graphId:'g1',...args}}));
  const discover=await call('server.discover');expect(discover.result.contracts.operations.schema).toBeTruthy();
  const first=await call('iac.preflight',{nodeId:'stack'});expect(first.result.deployableResourceTypes).toContain('AWS::Lambda::Function');expect(first.result.evidence.awsPermissionsVerified).toBe(false);
  const example=(await call('server.discover',{topic:'example',nodeId:'stack'})).result.contracts.example;
  const unsupported=JSON.parse(JSON.stringify(example.configuration));const badTemplate=JSON.parse(unsupported.template.text);badTemplate.Resources.Url={Type:'AWS::Lambda::Url',Properties:{AuthType:'NONE'}};unsupported.template.text=JSON.stringify(badTemplate);
  expect((await call('iac.preflight',{nodeId:'stack',configuration:unsupported})).result.deployable).toBe(false);
  expect((await call('iac.preflight',{nodeId:'stack',configuration:example.configuration})).result.deployable).toBe(true);
  await call('chat.join',{agentSessionId:'builder',name:'MCP builder'});
  await call('chat.post',{agentSessionId:'builder',messageId:'intent',phase:'thinking',text:'@here I will build the isolated application example.'});
  await call('chat.post',{agentSessionId:'builder',messageId:'work',phase:'doing',text:'@here Creating the graph proposal.'});
  const base=(await call('graph.summary')).envelope.resultRevision;
  const created=await call('proposal.create',{agentSessionId:'builder',baseRevision:base,ops:example.ops,description:'Isolated authenticated application',idempotencyKey:ULID});
  expect(created.error).toBeUndefined();
  const proposal=created.result;
  expect(proposal.requiredDecisions).toContain('iac-approve');expect(proposal.impact.infrastructure[0].resources.some(r=>r.type==='AWS::IAM::Role')).toBe(true);
  const checked=await call('proposal.validate',{agentSessionId:'builder',proposalId:proposal.proposalId});expect(checked.result.proposalDigest).toBe(proposal.proposalDigest);
  expect((await call('proposal.commit',{agentSessionId:'builder',proposalId:proposal.proposalId})).error).toBeTruthy();
  // The graph editor's human decision, distinct from deployment approval.
  const accepted=await f.proposals.commit('g1',proposal.proposalId,owner);expect(accepted.error).toBeUndefined();expect(accepted.proposal.state).toBe('committed');
  const graph=await f.store.projectGraph('g1');expect(graph.properties.name).toBe('Chess workflow regression');
  expect(graph.nodes.find(n=>n.id==='listener').properties).toMatchObject({appearsInPresentation:false,runInBackground:true});
  const review=await call('iac.review',{agentSessionId:'builder',nodeId:'stack'});expect(review.error).toBeUndefined();
  await f.reviews.step(review.result.operationId);await f.reviews.step(review.result.operationId);
  const plan=await f.reviews.current('g1','stack',owner);expect(plan.state).toBe('awaiting-review');expect(state.exists).toBe(false);
  await f.reviews.approve('g1','stack',owner,{operationId:plan.operationId,reviewDigest:plan.reviewDigest});
  await f.reviews.step(plan.operationId);await f.reviews.step(plan.operationId);
  expect((await call('iac.status',{nodeId:'stack'})).result.state).toBe('succeeded');
  // Runtime through MCP, not a direct Lambda invocation. Local backend responses are simulated.
  const invoked=await call('graph.invoke',{agentSessionId:'builder',nodeUrl:'backend',field:'request',value:{action:'refresh'}});
  expect(invoked.error).toBeUndefined();expect(invoked.result.errors).toBe(0);
  expect(f.broadcast.channel.some(([channel,e])=>channel==='graph-notify-g1'&&e.eventType==='application.update')).toBe(true);
  const failed=await call('graph.invoke',{agentSessionId:'builder',nodeUrl:'backend',field:'request',value:{action:'fail'}});expect(failed.result.errors).toBeGreaterThan(0);
  const watched=await call('observations.watch',{filter:{kind:'exec.error'}});
  expect(watched.result.observations).toEqual(expect.arrayContaining([expect.objectContaining({nodeId:'backend',operationId:plan.operationId,provenance:'server'}),expect.objectContaining({proposalId:proposal.proposalId,executionId:failed.result.executionId})]));
  // A browser report is visible over the same MCP poll, while retaining its untrusted provenance.
  const ingest=new (require('../runtime/ingest').ExecutionIngest)(f.s3);
  await ingest.ingest('g1',owner,{record:{executionId:require('ulid').ulid(),revisionId:'live',state:'error'},observations:[{kind:'exec.error',nodeId:'players',payload:{message:'Browser component error'}}]});
  const more=await call('observations.watch',{cursor:watched.result.nextCursor,filter:{kind:'exec.error'}});
  expect(more.result.observations).toEqual(expect.arrayContaining([expect.objectContaining({nodeId:'players',provenance:'browser-report'})]));
 }finally{await client?.close();await humanClient?.close();process.env=env;}
});

test('MCP lifecycle acceptance: recover an induced guardrail failure, get fresh graph approval, invoke and diagnose without an agent AWS path',async()=>{
 const env={...process.env};require('../__testHelpers__/lifecycleCloud').environment();
 delete process.env.PLATFORM_ADMIN_SUBS;
 Object.assign(process.env,{IAC_ACCOUNTS:'230639770018',IAC_REGIONS:'us-west-1'});
 let client;
 try{
  const f=await setup({lifecycle:true,applicationBackend:async(_arn,event)=>{
   if(event.input.action==='fail')throw Object.assign(new Error('Application invariant failed'),{requestId:'abcdef00-0000-0000-0000-000000000000',bridgeRequestId:'bridge-test'});
   return {result:{ready:true},updates:[{topic:'players',value:{ready:true}}]};
  }}),fixture=f.lifecycleFixture;
  await f.delegations.put({agentSub:agent.sub,graphId:'g1',delegatedBy:owner.sub,scopes:['graph:read','graph:propose','graph:observe','graph:inspect-payloads','graph:execute','iac:propose','iac:read-status'],expiresAt:null});
  client=await connect(f.mcp,agent);
  const call=async(name,args={})=>parse(await client.callTool({name,arguments:{schemaVersion:1,graphId:'g1',...args}}));
  const discovery=(await call('server.discover',{topic:'lifecycle'})).result.contracts.lifecycle;
  expect(discovery.tools['iac.recovery.plan'].inputSchema.required).toContain('idempotencyKey');
  const Ajv=require('ajv/dist/2020').default,validate=(name,result)=>{const check=new Ajv({strict:false,validateFormats:false}).compile(discovery.resultSchemas[name]);expect({valid:check(result),errors:check.errors}).toEqual({valid:true,errors:null});};
  expect((await client.listTools()).tools.some(t=>/approve|deploy$/.test(t.name))).toBe(false);
  const example=(await call('server.discover',{topic:'example',nodeId:'stack'})).result.contracts.example;
  expect((await call('iac.preflight',{nodeId:'stack',configuration:example.configuration})).result.deployable).toBe(true);
  const base=(await call('graph.summary')).envelope.resultRevision;
  const proposal=(await call('proposal.create',{baseRevision:base,ops:example.ops,description:'Generic isolated lifecycle acceptance',idempotencyKey:ULID})).result;
  expect((await call('proposal.validate',{proposalId:proposal.proposalId})).result.proposalDigest).toBe(proposal.proposalDigest);
  expect((await f.proposals.commit('g1',proposal.proposalId,owner)).proposal.state).toBe('committed');
  const inspection=(await call('iac.inspect',{nodeId:'stack'})).result;
  validate('iac.inspect',inspection);expect(inspection.roles.map(r=>r.exists)).toEqual([false,false]);
  expect(inspection.recoveryReadiness).toMatchObject({state:'review-available',requiresPlatformAdmin:false});
  expect(inspection.maintenanceConfiguration.configured).toBe(false);
  expect(inspection.application.status).toBe('NOT_CREATED');expect(inspection.guardrail.status).toBe('ROLLBACK_FAILED');
  const plan=(await call('iac.recovery.plan',{nodeId:'stack',operationId:fixture.source.operationId,idempotencyKey:'recover'})).result;
  validate('iac.recovery.plan',plan);
  expect(plan.state).toBe('recovery-ready');expect(plan.recoveryPlan.preservesData).toBe(true);
  const fromUi=(action,body,principal=owner)=>new Promise((resolve,reject)=>f.reviews.route({principal,httpMethod:'POST',pathParameters:{id:'g1',nodeId:'stack'},path:'/iac/stack/'+action,body:JSON.stringify(body)},null,(error,result)=>error?reject(error):resolve({...result,json:JSON.parse(result.body)})));
  expect((await fromUi('recovery-approve',{operationId:plan.operationId,recoveryDigest:plan.recoveryPlan.digest},agent)).statusCode).toBe(403);
  expect((await fromUi('recovery-approve',{operationId:plan.operationId,recoveryDigest:plan.recoveryPlan.digest})).statusCode).toBe(200);
  for(let i=0;i<20;i++)if((await f.reviews.lifecycle.step(plan.operationId)).done)break;
  await client.close();client=await connect(f.mcp,agent); // reconnect using only durable graph state
  const recovered=(await call('iac.status',{nodeId:'stack'})).result;
  expect(recovered.state).toBe('recovered');expect(recovered.approval).toBeUndefined();
  expect(recovered.canReviewMaintenance).toBe(false);
  const recoveryEvents=(await call('iac.events',{nodeId:'stack',operationId:plan.operationId,limit:100})).result.events;
  const recoveryWatch=(await call('observations.watch',{filter:{operationId:plan.operationId},from:'beginning',limit:100})).result.observations;
  expect(recoveryWatch.map(({arrival,...event})=>event)).toEqual(recoveryEvents);
  expect(recoveryWatch).toEqual(fixture.sent.filter(e=>e.operationId===plan.operationId));
  expect(recoveryEvents.some(e=>e.kind==='deployment.recovery.complete')).toBe(true);
  const review=(await call('iac.review',{nodeId:'stack',retryOf:recovered.operationId})).result;
  await f.reviews.step(review.operationId);await f.reviews.step(review.operationId);
  const pending=(await call('iac.status',{nodeId:'stack'})).result;
  expect(pending.state).toBe('awaiting-review');expect(fixture.deployCloud.execute).not.toHaveBeenCalled();
  expect((await fromUi('apply',{operationId:pending.operationId,reviewDigest:plan.recoveryPlan.digest})).statusCode).not.toBe(200);
  expect((await fromUi('apply',{operationId:pending.operationId,reviewDigest:pending.reviewDigest})).statusCode).toBe(200);
  await f.reviews.step(pending.operationId);await f.reviews.step(pending.operationId);
  expect((await call('iac.status',{nodeId:'stack'})).result.state).toBe('succeeded');
  expect((await call('graph.invoke',{nodeUrl:'backend',field:'request',value:{action:'refresh'}})).result.errors).toBe(0);
  expect((await call('graph.invoke',{nodeUrl:'backend',field:'request',value:{action:'fail'}})).result.errors).toBeGreaterThan(0);
  const failed=(await call('observations.watch',{filter:{operationId:pending.operationId,kind:'deployment.runtime-invocation'}})).result.observations.find(e=>e.status==='FAILED');
  expect(failed.error.message).toContain('invariant');expect(failed.requestId).toBe('abcdef00-0000-0000-0000-000000000000');
  const logs=jest.fn(async()=>({events:[{eventId:'failure',timestamp:Date.now(),message:JSON.stringify({errorType:'Error',errorMessage:'Application invariant failed',requestId:failed.requestId})}]}));
  const reader=new(require('../application/diagnostics').ApplicationDiagnostics)(f.s3,{cloud:fixture.clients.cloud,logs,policy:()=>require('../__testHelpers__/lifecycleCloud').policy});
  f.reviews.lifecycle.deps.logs=(op,args)=>reader.read(op,args);
  const diagnostic=(await call('iac.runtime.logs',{nodeId:'stack',logicalId:'Backend',correlationId:failed.correlationId})).result;
  expect(diagnostic.events[0].error.message).toBe('Application invariant failed');
  const watched=(await call('observations.watch',{filter:{kind:'deployment.runtime-log'}})).result.observations;
  expect(watched.map(({arrival,...e})=>e)).toEqual(diagnostic.events);
  expect((await call('iac.history',{nodeId:'stack'})).result.operations.map(o=>o.operationId)).toEqual([pending.operationId,plan.operationId,fixture.source.operationId]);
  expect((await call('iac.inspect',{graphId:'other',nodeId:'stack',operationId:pending.operationId})).error.code).toBe('ADMISSION_DENIED');
 }finally{await client?.close();process.env=env;}
});

test('MCP cancellation and preservation: discover, discard unwanted recovery, reconnect, and reach current-state validation without AWS mutations',async()=>{
 const env={...process.env};require('../__testHelpers__/lifecycleCloud').environment();
 Object.assign(process.env,{IAC_ACCOUNTS:'230639770018',IAC_REGIONS:'us-west-1'});
 let client;
 try{
  const f=await setup({lifecycle:true}),fixture=f.lifecycleFixture;
  await f.delegations.put({agentSub:agent.sub,graphId:'g1',delegatedBy:owner.sub,scopes:['graph:read','graph:propose','graph:observe','iac:propose','iac:read-status'],expiresAt:null});
  client=await connect(f.mcp,agent);
  const call=async(name,args={})=>parse(await client.callTool({name,arguments:{schemaVersion:1,graphId:'g1',...args}}));
  const discovery=(await call('server.discover',{topic:'lifecycle'})).result;
  expect(discovery.server.version).toBe('2.5.2');expect(discovery.contracts.lifecycle.version).toBe('1.3.0');
  const contracts=discovery.contracts.lifecycle;
  expect(contracts.tools['iac.cancel'].inputSchema.required).toContain('operationId');
  for(const name of ['iac.inspect','iac.review','iac.recovery.plan'])expect(contracts.tools[name].inputSchema.properties.preservation.const).toBe('strict');
  const config=JSON.parse(JSON.stringify(fixture.graph.nodes[0].properties.iac)),table=JSON.parse(config.template.text).Resources.Records;
  config.template.text=JSON.stringify({Resources:{Records:table}});config.capabilities=[];
  const base=(await call('graph.summary')).envelope.resultRevision;
  const proposal=(await call('proposal.create',{baseRevision:base,idempotencyKey:ULID,description:'Disposable preservation-only platform fixture',ops:[
   {op:'add-node',node:{id:'stack',url:'stack',name:'Preservation test stack'}},
   {op:'set-iac-desired',nodeId:'stack',desired:config},
  ]})).result;
  expect((await f.proposals.commit('g1',proposal.proposalId,owner)).proposal.state).toBe('committed');
  const plan=(await call('iac.recovery.plan',{nodeId:'stack',operationId:fixture.source.operationId,idempotencyKey:'pending-unwanted'})).result;
  expect(plan.state).toBe('recovery-ready');
  const before=fixture.calls.length;
  const cancelled=(await call('iac.cancel',{nodeId:'stack',operationId:plan.operationId,reason:'Keep every stack and resource intact.'})).result;
  expect(cancelled).toMatchObject({state:'cancelled',reviewDigest:null,recoveryPlan:{digest:null},cancellation:{awsMutations:false}});
  const check=new(require('ajv/dist/2020').default)({strict:false,validateFormats:false}).compile(contracts.resultSchemas['iac.cancel']);
  expect({valid:check(cancelled),errors:check.errors}).toEqual({valid:true,errors:null});
  expect(fixture.calls).toHaveLength(before);
  await client.close();client=await connect(f.mcp,agent);
  expect((await call('iac.cancel',{nodeId:'stack',operationId:plan.operationId})).result.cancellation).toEqual(cancelled.cancellation);
  const status=(await call('iac.status',{nodeId:'stack'})).result;expect(status.state).toBe('cancelled');
  expect(status.nextActions.actions.find(a=>a.tool==='iac.review').allowed).toBe(true);
  const blocked=await call('iac.review',{nodeId:'stack',retryOf:plan.operationId,preservation:'strict'});
  expect(blocked.error.code).toBe('PRESERVATION_BLOCKED');
  expect(JSON.stringify(blocked)).toContain('PRESERVATION_IN_PLACE_UNSUPPORTED');expect(JSON.stringify(blocked)).not.toContain('Recovery owns this stack');
  const strict=(await call('iac.recovery.plan',{nodeId:'stack',operationId:plan.operationId,idempotencyKey:'preserve-1',preservation:'strict'})).result;
  expect(strict.state).toBe('recovery-blocked');expect(strict.recoveryPlan.actions.every(a=>a.kind==='release-operation')).toBe(true);
  await expect(f.reviews.lifecycle.approve('g1','stack',owner,{operationId:plan.operationId,recoveryDigest:plan.recoveryPlan.digest})).rejects.toMatchObject({code:'STALE_RECOVERY'});
  const events=(await call('iac.events',{nodeId:'stack',operationId:plan.operationId,limit:100})).result.events;
  const watched=(await call('observations.watch',{from:'beginning',filter:{operationId:plan.operationId},limit:100})).result;
  expect(watched.observations.map(({arrival,...e})=>e)).toEqual(events);
  expect(watched.observations).toEqual(fixture.sent.filter(e=>e.operationId===plan.operationId));
  expect(events.filter(e=>e.kind==='deployment.review.cancelled')).toHaveLength(1);
  expect((await call('observations.watch',{cursor:watched.nextCursor,filter:{operationId:plan.operationId}})).result.observations).toEqual([]);
  expect((await call('iac.history',{nodeId:'stack'})).result.operations.find(o=>o.operationId===plan.operationId)).toMatchObject({state:'cancelled',cancellation:{awsMutations:false}});
  expect((await call('iac.cancel',{graphId:'another-graph',nodeId:'stack',operationId:plan.operationId})).error.code).toBe('ADMISSION_DENIED');
  expect(fixture.calls.some(c=>/^(delete|create|update|execute|put|purge|rollback|continue)/i.test(c.method))).toBe(false);expect(fixture.start).not.toHaveBeenCalled();
 }finally{await client?.close();process.env=env;}
});
