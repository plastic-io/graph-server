const { DelegationStore } = require("../policy/delegation");
const { decide } = require("../policy/decide");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

describe("agent delegations", () => {
    const agent = { sub: "agent|a1", kind: "agent", tenant: "t", scopes: [] };
    test("no record, no authority; a record grants its scopes; the graph's own record beats the wildcard; expiry ends it", async () => {
        const s3 = new FakeS3Service(); const store = new DelegationStore(s3);
        expect(decide(await store.resolve(agent, "g1"), ["graph:read"])).toMatchObject({ allow: false, reason: expect.stringMatching(/no delegation/) });
        await store.put({ agentSub: "agent|a1", graphId: "*", delegatedBy: "auth0|u1", scopes: ["graph:read"], expiresAt: null, createdAt: "2026-09-21T00:00:00Z" });
        const wide = await store.resolve(agent, "g1");
        expect(wide.scopes).toEqual(["graph:read"]); expect(wide.delegatedBy).toBe("auth0|u1");
        expect(decide(wide, ["graph:propose"]).allow).toBe(false);
        await store.put({ agentSub: "agent|a1", graphId: "g1", delegatedBy: "auth0|u1", scopes: ["graph:read", "graph:propose"], expiresAt: null, createdAt: "2026-09-21T00:00:00Z" });
        expect((await store.resolve(agent, "g1")).scopes).toEqual(["graph:read", "graph:propose"]);
        expect((await store.resolve(agent, "g2")).scopes).toEqual(["graph:read"]);
        // token scopes narrow the delegation, never widen it
        expect((await store.resolve({ ...agent, scopes: ["graph:read", "graph:commit"] }, "g1")).scopes).toEqual(["graph:read"]);
        await store.put({ agentSub: "agent|a1", graphId: "g1", delegatedBy: "auth0|u1", scopes: ["graph:read"], expiresAt: "2000-01-01T00:00:00Z", createdAt: "2026-09-21T00:00:00Z" });
        expect((await store.resolve(agent, "g1")).scopes).toEqual(["graph:read"]);   // falls back to the wildcard
        await store.remove("agent|a1", "*");
        expect((await store.resolve(agent, "g1")).scopes).toEqual([]);
        expect(await store.list()).toHaveLength(1);
        // humans pass through untouched
        const human = { sub: "auth0|u1", kind: "human", tenant: "t", scopes: [] };
        expect(await store.resolve(human, "g1")).toBe(human);
    });
});
