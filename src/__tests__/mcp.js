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
    const mcp = makeMcpHandler({
        crdtStore: store, tocStore, admission: crdt.admission, revisions, components, proposals, summaries, delegations, journeys, tests, tasks, simulations, consumers,
        // the brake is tested in its own suite; here it would only stop the test
        rate: { reads: new RateLimiter({ maxMutations: 1000 }), writes: new RateLimiter({ maxMutations: 1000 }) },
        invoke: async (graphId, principal, request) => {
            invoked.push({ graphId, principal: principal && principal.sub, request });
            const graph = await store.projectGraph(graphId);
            const node = graph.nodes.find((n) => n.url === request.nodeUrl || n.id === request.nodeUrl);
            if (!node) return { error: `no node ${request.nodeUrl}`, code: "NOT_FOUND" };
            const runner = new ExecutionRunner(s3);
            const summary = await runner.run({ graph, nodeUrl: node.url, field: request.field || "in", value: request.value, principal: principal ? { sub: principal.sub, kind: principal.kind, tenant: principal.tenant } : null });
            return { summary };
        },
        cancel: async (graphId, principal, executionId, reason) => {
            cancelled.push({ graphId, executionId, reason, by: principal && principal.sub });
            return { executionId, requested: true, reason };
        },
    });
    return { s3, store, tocStore, crdt, revisions, components, summaries, proposals, delegations, journeys, tests, tasks, simulations, consumers, dispatched, autonomy, doc, mcp, notified, broadcast, invoked, cancelled };
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

describe("MCP over the Lambda handler", () => {
    test("tools and resources are listed; graph.summary returns the envelope, a named revision and a bounded summary", async () => {
        const { mcp } = await setup();
        const client = await connect(mcp, owner);
        const tools = (await client.listTools()).tools.map((t) => t.name).sort();
        expect(tools).toEqual([
            "component.consumers", "component.publish", "component.search", "execution.cancel", "graph.expand", "graph.invoke", "graph.summary",
            "iac.plan", "iac.status", "journey.run", "observations.query", "proposal.commit", "proposal.create", "proposal.decide", "proposal.simulate", "proposal.validate",
            "revision.activate", "revision.cut", "revision.rollback", "tasks.cancel", "tasks.get", "tasks.list", "tests.run",
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
