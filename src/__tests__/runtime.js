const { ExecutionRunner, readObservations } = require("../runtime/executor");
const { parseCapability, scopeMatches, assertCapability, effectiveCapabilities } = require("../runtime/capabilities");
const { capturePayload } = require("../runtime/observe");
const { assignable } = require("../runtime/contracts");
const { AuditChain } = require("../audit/chain");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

const port = (name, over = {}) => ({ name, type: "Object", external: false, visible: true, ...over });
const node = (id, set, over = {}) => ({ id, url: id, edges: [{ field: "out", connectors: [] }], version: 0, graphId: "g1", artifact: null, data: null, properties: { inputs: [port("in")], outputs: [port("out")], groups: [], name: id, description: "", tags: [], icon: "", x: 0, y: 0, z: 0, createdOn: 1, presentation: { x: 0, y: 0, z: 0 }, ...(over.properties || {}) }, template: { set, vue: "" }, ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "properties")) });
function graphOf(nodes, connectors = [], properties = {}) {
    const g = { id: "g1", url: "g1", version: 0, nodes, properties: { name: "g1", description: "", ...properties } };
    connectors.forEach(([from, to, field], i) => { g.nodes.find((n) => n.id === from).edges[0].connectors.push({ id: `c${i}`, nodeId: to, field: field || "in", graphId: "g1", version: 0 }); });
    return g;
}
const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1" };
const readJson = (s3, key) => JSON.parse(s3.objects.get(key).toString());
const keysUnder = (s3, prefix) => [...s3.objects.keys()].filter((k) => k.startsWith(prefix)).sort();

describe("capabilities", () => {
    test("parsing and scope matching", () => {
        expect(parseCapability("net:https")).toEqual({ kind: "net:https", scope: [] });
        expect(parseCapability("net:https:api.example.com,*.cdn.example.com")).toEqual({ kind: "net:https", scope: ["api.example.com", "*.cdn.example.com"] });
        expect(parseCapability({ kind: "storage:kv", scope: ["ratelimit/*"] })).toEqual({ kind: "storage:kv", scope: ["ratelimit/*"], optional: false });
        expect(parseCapability("nonsense")).toBeNull();
        expect(scopeMatches("*", "anything")).toBe(true);
        expect(scopeMatches("*.example.com", "api.example.com")).toBe(true);
        expect(scopeMatches("*.example.com", "example.com")).toBe(true);
        expect(scopeMatches("*.example.com", "evil.com")).toBe(false);
        expect(scopeMatches("ratelimit/*", "ratelimit/u1")).toBe(true);
        expect(scopeMatches("ratelimit/*", "other/u1")).toBe(false);
    });
    test("effective = instance ∩ manifest ∩ principal; the first refusing layer is named; nesting never widens", () => {
        const n = { properties: { capabilities: ["net:https:api.example.com", "storage:kv:ratelimit/*"] } };
        const unrestricted = effectiveCapabilities(n, null, null);
        expect(() => assertCapability(unrestricted, "net:https", "api.example.com")).not.toThrow();
        expect(() => assertCapability(unrestricted, "net:https", "evil.example")).toThrow(/instance/);
        expect(() => assertCapability(unrestricted, "secret", "openai")).toThrow(/instance/);
        const narrowedByManifest = effectiveCapabilities(n, ["storage:kv:ratelimit/*"], null);
        expect(() => assertCapability(narrowedByManifest, "net:https", "api.example.com")).toThrow(/manifest/);
        const narrowedByPrincipal = effectiveCapabilities(n, null, ["storage:kv:*"]);
        expect(() => assertCapability(narrowedByPrincipal, "net:https", "api.example.com")).toThrow(/principal/);
        expect(() => assertCapability(narrowedByPrincipal, "storage:kv", "ratelimit/u1")).not.toThrow();
        // a plain kind without scope grants nothing
        expect(() => assertCapability(effectiveCapabilities({ properties: { capabilities: ["net:https"] } }, null, null), "net:https", "api.example.com")).toThrow();
    });
    test("payload capture and redaction follow the port", () => {
        expect(capturePayload({ a: 1 }, undefined, "meta")).toEqual({ meta: { type: "object", bytes: 7, hash: expect.any(String) } });
        expect(capturePayload("x", { capture: "full" })).toEqual({ value: "x", meta: expect.any(Object) });
        expect(capturePayload("x", { redaction: "secret", capture: "full" })).toEqual({ redacted: "secret" });
        expect(capturePayload("x", { redaction: "hash" })).toMatchObject({ redacted: "hash", bytes: 3 });
        expect(capturePayload("x", { capture: "none" })).toBeUndefined();
        expect(capturePayload("y".repeat(10000), { capture: "full" })).toMatchObject({ redacted: "size", bytes: 10002 });
        expect(assignable({ type: "String" }, { type: "String" })).toBe(true);
        expect(assignable({ type: "String" }, { type: "Number" })).toBe(false);
        expect(assignable({ type: "String" }, { type: "Object" })).toBe(true);
    });
});

describe("browser executions reported to the server", () => {
    const { ExecutionIngest } = require("../runtime/ingest");
    const obs = (over = {}) => ({ id: "01M32AAAAAAAAAAAAAAAAAAAAA", seq: 1, at: "2026-09-21T10:00:00.000Z", kind: "edge.input", graphId: "somebody-elses", revisionId: "whatever", executionId: "nope", correlationId: "nope", domain: "server", owner: { sub: "auth0|attacker", kind: "human", tenant: "other" }, instancePath: [], nodeId: "a", edgeField: "in", payload: { meta: { type: "string", bytes: 3 } }, ...over });
    const record = (over = {}) => ({ executionId: "01M32BBBBBBBBBBBBBBBBBBBBB", graphId: "somebody-elses", revisionId: "01M32AAAAAAAAAAAAAAAAAAAAA", domain: "server", owner: { sub: "auth0|attacker", kind: "human", tenant: "other" }, entry: { nodeUrl: "a", field: "in" }, startedAt: "2026-09-21T10:00:00.000Z", endedAt: "2026-09-21T10:00:01.000Z", state: "completed", duration: 1000, hops: 2, errors: 0, observations: { count: 2, key: "anywhere", sampled: false, capped: false }, effects: { allowed: 9, denied: 9 }, correlationId: "01M32BBBBBBBBBBBBBBBBBBBBB", ...over });

    test("the report is stored under the requesting identity, not the one in the body", async () => {
        const s3 = new FakeS3Service();
        const ingest = new ExecutionIngest(s3);
        const r = await ingest.ingest("g1", owner, { record: record(), observations: [obs(), obs({ seq: 2, kind: "effect", capability: { kind: "net:https", scope: ["api.example.com"], decision: "allowed" } })] });
        expect(r).toMatchObject({ replayed: false, observations: 2 });
        expect(r.record).toMatchObject({ executionId: "01M32BBBBBBBBBBBBBBBBBBBBB", graphId: "g1", domain: "browser", owner, state: "completed", hops: 2, revisionId: "01M32AAAAAAAAAAAAAAAAAAAAA", effects: { allowed: 1, denied: 0 } });
        expect(r.record.receivedAt).toEqual(expect.any(String));
        const stored = await readObservations(s3, readJson(s3, "executions/01M32BBBBBBBBBBBBBBBBBBBBB.json"));
        expect(stored).toHaveLength(2);
        expect(stored.every((o) => o.graphId === "g1" && o.domain === "browser" && o.owner.sub === "auth0|u1" && o.executionId === "01M32BBBBBBBBBBBBBBBBBBBBB")).toBe(true);
        expect(readJson(s3, "executions/by-graph/g1/01M32BBBBBBBBBBBBBBBBBBBBB.json").executionId).toBe("01M32BBBBBBBBBBBBBBBBBBBBB");
        expect(stored[0].payload).toEqual({ meta: { type: "string", bytes: 3 } });
    });

    test("unknown kinds and stray fields are dropped; the first report of an execution wins", async () => {
        const s3 = new FakeS3Service();
        const ingest = new ExecutionIngest(s3);
        const first = await ingest.ingest("g1", owner, { record: record(), observations: [obs({ kind: "not-a-kind" }), obs({ seq: 2, kind: "route", secretField: "keep this out", capability: { kind: "secret", scope: ["openai"], decision: "allowed", layer: "instance" } })] });
        expect(first.observations).toBe(1);
        const stored = await readObservations(s3, first.record);
        expect(stored[0].secretField).toBeUndefined();
        expect(stored[0].capability).toEqual({ kind: "secret", scope: ["openai"], decision: "allowed", layer: "instance" });
        const again = await ingest.ingest("g1", owner, { record: record({ state: "error", hops: 999 }), observations: [] });
        expect(again).toMatchObject({ replayed: true });
        expect(again.record.state).toBe("completed");
        expect(readJson(s3, "executions/01M32BBBBBBBBBBBBBBBBBBBBB.json").hops).toBe(2);
    });

    test("volume, identity and shape are refused rather than trusted", async () => {
        const s3 = new FakeS3Service();
        const ingest = new ExecutionIngest(s3);
        expect(await ingest.ingest("g1", undefined, { record: record(), observations: [] })).toMatchObject({ code: "ADMISSION_DENIED" });
        expect(await ingest.ingest("g1", owner, { record: record({ executionId: "not-a-ulid" }), observations: [] })).toMatchObject({ code: "SCHEMA_INVALID" });
        const many = Array.from({ length: 5001 }, (_, i) => obs({ seq: i + 1 }));
        expect(await ingest.ingest("g1", owner, { record: record(), observations: many })).toMatchObject({ code: "LIMIT_EXCEEDED", details: { count: 5001 } });
        const fat = Array.from({ length: 200 }, (_, i) => obs({ seq: i + 1, payload: { value: "x".repeat(20000) } }));
        expect(await ingest.ingest("g1", owner, { record: record(), observations: fat })).toMatchObject({ code: "LIMIT_EXCEEDED" });
        expect([...s3.objects.keys()].filter((k) => k.startsWith("executions/"))).toEqual([]);
    });
});

describe("the execution runner", () => {
    test("observes an execution end to end and writes the NDJSON and the record", async () => {
        const s3 = new FakeS3Service();
        const events = [];
        const runner = new ExecutionRunner(s3, { live: (o) => events.push(o.kind) });
        const g = graphOf([
            node("a", "host.emit('note', {seen: value}); edges.out = value.toUpperCase();"),
            node("b", "edges.out = value + '!';", { properties: { inputs: [port("in", { redaction: "secret" })] } }),
            node("c", "return value;", { properties: { inputs: [port("in", { capture: "full" })] } }),
        ], [["a", "b"], ["b", "c"]]);
        const summary = await runner.run({ graph: g, nodeUrl: "a", field: "in", value: "hi", principal: owner, revisionId: "01M32AAAAAAAAAAAAAAAAAAAAA" });
        expect(summary).toMatchObject({ graphId: "g1", revisionId: "01M32AAAAAAAAAAAAAAAAAAAAA", state: "completed", hops: 3, errors: 0, effects: { allowed: 0, denied: 0 } });
        expect(summary.executionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        const record = readJson(s3, `executions/${summary.executionId}.json`);
        expect(record).toMatchObject({ executionId: summary.executionId, domain: "server", owner: owner, entry: { nodeUrl: "a", field: "in" }, state: "completed", observations: { count: expect.any(Number), sampled: false, capped: false } });
        expect(readJson(s3, `executions/by-graph/g1/${summary.executionId}.json`).executionId).toBe(summary.executionId);
        const observations = await readObservations(s3, record);
        expect(observations.map((o) => o.seq)).toEqual(observations.map((_, i) => i + 1));
        expect(observations.map((o) => o.kind)).toEqual(["exec.begin", "edge.input", "custom", "route", "edge.input", "route", "edge.input", "exec.end"]);
        expect(observations.every((o) => o.executionId === summary.executionId && o.graphId === "g1" && o.owner.sub === "auth0|u1")).toBe(true);
        const intoB = observations.find((o) => o.kind === "edge.input" && o.nodeId === "b");
        expect(intoB.payload).toEqual({ redacted: "secret" });
        const intoC = observations.find((o) => o.kind === "edge.input" && o.nodeId === "c");
        expect(intoC.payload).toEqual({ value: "HI!", meta: expect.objectContaining({ type: "string" }) });
        const intoA = observations.find((o) => o.kind === "edge.input" && o.nodeId === "a");
        expect(intoA.payload).toEqual({ meta: expect.objectContaining({ type: "string", bytes: 4 }) });
        expect(observations.find((o) => o.kind === "custom").payload).toEqual({ kind: "note", data: { value: { seen: "hi" }, meta: expect.any(Object) } });
        expect(observations.find((o) => o.kind === "exec.end").payload).toMatchObject({ state: "completed", hops: 3 });
        expect(events).toEqual(observations.map((o) => o.kind));
        expect(record.observations.key).toMatch(new RegExp(`^observations/g1/\\d{10}/${summary.executionId}\\.ndjson$`));
    });

    test("the host enforces capabilities: fetch in scope is observed, out of scope is refused; kv is prefix-scoped; a secret is a client, audited", async () => {
        const s3 = new FakeS3Service();
        const fetched = [];
        const fetchImpl = async (url, init) => { fetched.push(url); return { ok: true, status: 200, json: async () => ({ url }) }; };
        const runner = new ExecutionRunner(s3, { fetchImpl, secrets: async (ref) => (ref === "openai" ? "sk-test" : Promise.reject(new Error("no such secret"))) });
        const g = graphOf([
            node("a", `
                const r = await host.fetch('https://api.example.com/v1/x'); state.first = (await r.json()).url;
                try { await host.fetch('https://evil.example/steal'); state.evil = 'allowed'; } catch (e) { state.evil = e.name + ':' + e.layer; }
                try { await host.fetch('http://api.example.com/plain'); } catch (e) { state.plain = e.name; }
                await host.kv.put('ratelimit/u1', { n: 1 }); state.kv = await host.kv.get('ratelimit/u1');
                try { await host.kv.get('other/x'); } catch (e) { state.kvDenied = e.name; }
                const client = await host.secret('openai').openai(); state.client = typeof client.chat;
                try { await host.secret('stripe').header(); } catch (e) { state.secretDenied = e.name; }
                edges.out = value;
            `, { properties: { capabilities: ["net:https:api.example.com", "storage:kv:ratelimit/*", "secret:openai"] } }),
        ]);
        const state = {};
        const summary = await runner.run({ graph: g, nodeUrl: "a", field: "in", value: 1, principal: owner, state });
        expect(state).toEqual({ first: "https://api.example.com/v1/x", evil: "CapabilityDenied:instance", plain: "CapabilityDenied", kv: { n: 1 }, kvDenied: "CapabilityDenied", client: "object", secretDenied: "CapabilityDenied" });
        expect(fetched).toEqual(["https://api.example.com/v1/x"]);
        expect(summary.effects).toEqual({ allowed: 4, denied: 3 });
        expect(readJson(s3, "kv/g1/ratelimit/u1.json").value).toEqual({ n: 1 });
        const observations = await readObservations(s3, readJson(s3, `executions/${summary.executionId}.json`));
        const effects = observations.filter((o) => o.kind === "effect" || o.kind === "effect.denied").map((o) => [o.kind, o.capability.kind, o.capability.scope[0], o.capability.decision]);
        expect(effects).toEqual([
            ["effect", "net:https", "api.example.com", "allowed"],
            ["effect.denied", "net:https", "evil.example", "denied"],
            ["effect", "storage:kv", "ratelimit/u1", "allowed"],
            ["effect", "storage:kv", "ratelimit/u1", "allowed"],
            ["effect.denied", "storage:kv", "other/x", "denied"],
            ["effect", "secret", "openai", "allowed"],
            ["effect.denied", "secret", "stripe", "denied"],
        ]);
        // privileged effects are in the audit chain
        const audit = keysUnder(s3, "audit/g1/").filter((k) => !k.endsWith("HEAD.json")).map((k) => readJson(s3, k));
        expect(audit.map((a) => [a.kind, a.capability.kind, a.capability.scope[0]])).toEqual([["effect", "secret", "openai"], ["effect.denied", "secret", "stripe"]]);
        expect(await new AuditChain(s3).verify("g1")).toMatchObject({ ok: true, length: 2 });
    });

    test("a pinned component cannot exceed its manifest; a restricted principal cannot exceed its own grants", async () => {
        const s3 = new FakeS3Service();
        const runner = new ExecutionRunner(s3, { fetchImpl: async () => ({ ok: true }) });
        const g = graphOf([node("a", "try { await host.fetch('https://api.example.com/'); state.r = 'ok'; } catch (e) { state.r = e.layer; }", { properties: { capabilities: ["net:https:api.example.com"], component: { publishedId: "p", version: 1 } } })]);
        const state = {};
        await runner.run({ graph: g, nodeUrl: "a", principal: owner, state, manifestCapabilities: () => ["storage:kv:*"] });
        expect(state.r).toBe("manifest");
        const state2 = {};
        await runner.run({ graph: g, nodeUrl: "a", principal: owner, state: state2, principalCapabilities: ["storage:kv:*"] });
        expect(state2.r).toBe("principal");
    });

    test("contracts: a port schema is checked on delivery; warn records a violation and delivers, reject drops it", async () => {
        const s3 = new FakeS3Service();
        const runner = new ExecutionRunner(s3);
        const build = (mode) => graphOf([
            node("a", "edges.out = value;"),
            node("b", "state.got = value;", { properties: { inputs: [port("in", { schema: { type: "number" } })] } }),
        ], [["a", "b"]], mode ? { contractMode: mode } : {});
        const state = {};
        await runner.run({ graph: build(), nodeUrl: "a", value: "not a number", principal: owner, state });
        expect(state.got).toBe("not a number");
        const s1 = keysUnder(s3, "executions/g1/").length;
        const rec = readJson(s3, keysUnder(s3, "executions/by-graph/g1/")[0]);
        const obs = await readObservations(s3, rec);
        expect(obs.some((o) => o.kind === "contract.violation" && o.nodeId === "b" && /input in of b/.test(o.payload.message))).toBe(true);
        const state2 = {};
        const summary = await runner.run({ graph: build("reject"), nodeUrl: "a", value: "still not", principal: owner, state: state2 });
        expect(state2.got).toBeUndefined();
        expect(summary.hops).toBe(1);
        const obs2 = await readObservations(s3, readJson(s3, `executions/${summary.executionId}.json`));
        expect(obs2.filter((o) => o.kind === "contract.violation")).toHaveLength(1);
        void s1;
    });

    test("volume is capped: after the cap, routes are sampled one in ten and a budget.exhausted marker is written; errors always land", async () => {
        const s3 = new FakeS3Service();
        const runner = new ExecutionRunner(s3);
        const g = graphOf([
            node("a", "for (let i = 0; i < 60; i++) edges.out = i;"),
            node("b", "if (value === 59) throw new Error('last'); state.n = (state.n || 0) + 1;"),
        ], [["a", "b"]]);
        const state = {};
        const summary = await runner.run({ graph: g, nodeUrl: "a", principal: owner, state, maxObservations: 20 });
        expect(state.n).toBe(59);
        expect(summary.observations.capped).toBe(true);
        const obs = await readObservations(s3, readJson(s3, `executions/${summary.executionId}.json`));
        expect(obs.filter((o) => o.kind === "budget.exhausted")).toHaveLength(1);
        expect(obs.filter((o) => o.sampled).length).toBeGreaterThan(0);
        expect(obs.some((o) => o.kind === "exec.error" && /last/.test(o.payload.message))).toBe(true);
        expect(obs[obs.length - 1].kind).toBe("exec.end");
        expect(obs.length).toBeLessThan(60);
    });

    test("legacy events still reach the notify channel and the 2.0 `this` context is honoured", async () => {
        const s3 = new FakeS3Service();
        const runner = new ExecutionRunner(s3);
        const seen = [];
        const g = graphOf([node("a", "state.ctx = this.marker; edges.out = value;")]);
        const state = {};
        await runner.run({ graph: g, nodeUrl: "a", value: 1, principal: owner, state, onEvent: (name) => seen.push(name), setContext: () => ({ marker: "legacy" }) });
        expect(state.ctx).toBe("legacy");
        expect(seen).toEqual(expect.arrayContaining(["begin", "set", "afterSet", "end"]));
    });
});
