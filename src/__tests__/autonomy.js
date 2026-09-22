/**
 * How much of an agent's work a person wants to see before it takes effect.
 * The delegation says what an agent may do; autonomy says whether someone
 * reviews it. These check that the two stay separate, that a graph can answer
 * for itself, that a person can answer for all of their work, and that
 * nothing about either skips the gates.
 */
const { AutonomyStore } = require("../policy/autonomy");
const { ProposalService } = require("../proposals/service");
const { DelegationStore } = require("../policy/delegation");
const { RevisionService } = require("../revisions/service");
const { ComponentService } = require("../components/service");
const { SummaryService } = require("../summary/service");
const CrdtStore = require("../crdtStore").default;
const CrdtService = require("../crdtService").default;
const TocStore = require("../tocStore").default;
const { fromJSON, encodeState } = require("@plastic-io/graph-crdt");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
const someoneElse = { sub: "auth0|u2", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
const port = (name) => ({ name, type: "Object", external: false, visible: true });
const node = (id) => ({
    id, url: id, edges: [{ field: "out", connectors: [] }], version: 0, graphId: "g1", artifact: null, data: null,
    properties: { inputs: [port("in")], outputs: [port("out")], groups: [], name: id, description: "", tags: [], icon: "", x: 0, y: 0, z: 0, createdOn: 1, presentation: { x: 0, y: 0, z: 0 } },
    template: { set: "edges.out = value;", vue: "" },
});
const graphOf = (properties = {}) => ({ id: "g1", url: "g1", version: 0, nodes: [node("a")], properties: { name: "g1", description: "", ...properties } });

async function setup(graphProperties) {
    const s3 = new FakeS3Service();
    const store = new CrdtStore(s3);
    const broadcast = { channel: [], postToClient: (d, c, p, cb) => cb(), _sendToChannel: (ch, v, cb) => cb(), broadcast: (ch, v, cb) => cb() };
    const crdt = new CrdtService(store, broadcast);
    const tocStore = new TocStore(s3);
    const revisions = new RevisionService(store, crdt.admission, { fanOut: (g, u) => crdt.fanOutUpdate(g, u) });
    const components = new ComponentService(store, revisions, crdt.admission, { tocStore, broadcastService: broadcast });
    const summaries = new SummaryService(revisions, components);
    const delegations = new DelegationStore(s3);
    crdt.admission.resolvePrincipal = (p, g) => delegations.resolve(p, g);
    const autonomy = new AutonomyStore(s3);
    const proposals = new ProposalService(store, crdt.admission, revisions, summaries, { fanOut: (g, u) => crdt.fanOutUpdate(g, u), autonomy });
    await store.appendUpdate("g1", encodeState(fromJSON(graphOf(graphProperties))), "seed", "system");
    return { s3, store, proposals, delegations, autonomy, revisions };
}
const propose = async (ctx, principal, description = "Trim") => {
    const head = await ctx.revisions.head("g1");
    const base = head ? `rev_${head.revisionId}` : `rev_${(await ctx.revisions.cut("g1", owner, "base")).revision.revisionId}`;
    return ctx.proposals.create("g1", principal, {
        baseRevision: base,
        ops: [{ op: "set-node-props", nodeId: "a", patch: { description: description } }],
        description, idempotencyKey: "01J8ZK5K0B1C2D3E4F5G6H7J" + Math.floor(Math.random() * 9),
    });
};
const agentWith = async (ctx, scopes) => {
    await ctx.delegations.put({ agentSub: "agent|a1", graphId: "g1", delegatedBy: "auth0|u1", scopes, expiresAt: null, createdAt: new Date().toISOString() });
    return ctx.delegations.resolve({ sub: "agent|a1", kind: "agent", tenant: "personal:auth0|u1", scopes: [] }, "g1");
};

describe("autonomy", () => {
    test("supervised is what happens when nobody has said otherwise", async () => {
        const ctx = await setup();
        expect(await ctx.autonomy.resolve(graphOf(), "auth0|u1")).toEqual({ autonomy: "supervised", from: "default" });
        const agent = await agentWith(ctx, ["graph:read", "graph:propose", "graph:commit"]);
        const created = await propose(ctx, agent);
        expect(created.proposal.requiredDecisions).toEqual(["approve"]);
        const refused = await ctx.proposals.commit("g1", created.proposal.proposalId, agent);
        expect(refused).toMatchObject({ code: "APPROVAL_REQUIRED" });
    });

    test("a person sets it for their own work, and nobody sets it for them", async () => {
        const ctx = await setup();
        const saved = await ctx.autonomy.put("auth0|u1", owner, { autonomy: "auto", note: "I watch the journeys instead" });
        expect(saved).toMatchObject({ sub: "auth0|u1", autonomy: "auto", updatedBy: "auth0|u1", note: "I watch the journeys instead" });
        expect(await ctx.autonomy.resolve(graphOf(), "auth0|u1")).toEqual({ autonomy: "auto", from: "profile" });
        // nobody sets this on someone else's behalf, whatever else they hold
        expect(await ctx.autonomy.put("auth0|u1", someoneElse, { autonomy: "supervised" })).toMatchObject({ code: "ADMISSION_DENIED", error: expect.stringMatching(/only auth0\|u1 can set/) });
        expect((await ctx.autonomy.forUser("auth0|u1")).autonomy).toBe("auto");
        expect(await ctx.autonomy.put("auth0|u1", undefined, { autonomy: "auto" })).toMatchObject({ code: "ADMISSION_DENIED" });
        expect(await ctx.autonomy.put("auth0|u1", owner, { autonomy: "whenever" })).toMatchObject({ code: "SCHEMA_INVALID" });
    });

    test("with the profile set to auto, a delegated agent's work needs nobody", async () => {
        const ctx = await setup();
        await ctx.autonomy.put("auth0|u1", owner, { autonomy: "auto" });
        const agent = await agentWith(ctx, ["graph:read", "graph:propose", "graph:commit"]);
        const created = await propose(ctx, agent);
        expect(created.proposal.requiredDecisions).toEqual([]);
        const committed = await ctx.proposals.commit("g1", created.proposal.proposalId, agent);
        expect(committed.proposal.state).toBe("committed");
        expect((await ctx.store.projectGraph("g1")).nodes[0].properties.description).toBe("Trim");
    });

    test("auto still only lets an agent do what it was delegated", async () => {
        const ctx = await setup();
        await ctx.autonomy.put("auth0|u1", owner, { autonomy: "auto" });
        const agent = await agentWith(ctx, ["graph:read", "graph:propose"]);
        const created = await propose(ctx, agent);
        expect(created.proposal.requiredDecisions).toEqual(["approve"]);
        expect(await ctx.proposals.commit("g1", created.proposal.proposalId, agent)).toMatchObject({ code: "ADMISSION_DENIED" });
    });

    test("a graph answers for itself, whatever the profile says", async () => {
        const supervisedGraph = await setup({ autonomy: "supervised" });
        await supervisedGraph.autonomy.put("auth0|u1", owner, { autonomy: "auto" });
        const agent = await agentWith(supervisedGraph, ["graph:read", "graph:propose", "graph:commit"]);
        const created = await propose(supervisedGraph, agent);
        expect(created.proposal.requiredDecisions).toEqual(["approve"]);
        // and the other way round: a graph set to auto under a supervised profile
        const autoGraph = await setup({ autonomy: "auto" });
        await autoGraph.autonomy.put("auth0|u1", owner, { autonomy: "supervised" });
        const agent2 = await agentWith(autoGraph, ["graph:read", "graph:propose", "graph:commit"]);
        const created2 = await propose(autoGraph, agent2);
        expect(created2.proposal.requiredDecisions).toEqual([]);
        expect(await autoGraph.autonomy.resolve(graphOf({ autonomy: "auto" }), "auth0|u1")).toEqual({ autonomy: "auto", from: "graph" });
    });

    test("a person's own work is never held for review, in either mode", async () => {
        const ctx = await setup();
        const created = await propose(ctx, owner);
        expect(created.proposal.requiredDecisions).toEqual([]);
    });

    test("changing a graph's mode is a privileged change, visible in the diff", async () => {
        const { semanticDiff } = require("@plastic-io/graph-crdt");
        const before = graphOf();
        const after = graphOf({ autonomy: "auto" });
        const diff = semanticDiff(before, after);
        expect(diff.namespaces).toContain("policy-autonomy");
        expect(diff.ops.map((o) => o.op)).toContain("set-autonomy");
        const { requiredAuthorities } = require("../policy/decide");
        expect(requiredAuthorities(diff)).toContain("graph:connect-privileged");
    });
});
