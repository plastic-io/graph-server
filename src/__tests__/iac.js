const { IacService } = require("../iac/service");
const { TemplateStore } = require("../iac/templates");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;

/**
 * Planning infrastructure (plan §4.9, M4a: D-43).
 *
 * The milestone's whole claim is that nothing here can change a resource, so
 * these tests are as much about what is *not* asked of CloudFormation as about
 * what is: the client is a record of every call, and the tests read it.
 */

const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
const agent = { sub: "agent|a1", kind: "agent", tenant: "personal:auth0|u1", scopes: [] };
const ULID = "01J8ZK5K0B1C2D3E4F5G6H7J8A";
const policy = () => ({
    stackPrefix: "pio-dev-",
    accounts: ["695527765921"],
    regions: ["us-west-1"],
    substrateStacks: ["plastic-io-graph-server"],
});
const TEMPLATE = `Resources:\n  Bucket:\n    Type: AWS::S3::Bucket\n    Properties:\n      BucketName: pio-dev-uploads\n`;
const iacNode = (over = {}) => ({
    id: "stack", url: "stack", properties: {
        name: "Uploads bucket",
        iac: {
            schemaVersion: 1,
            stack: { name: "pio-dev-uploads", account: "695527765921", region: "us-west-1", environment: "dev" },
            template: { text: TEMPLATE, format: "yaml" },
            ...over,
        },
    },
});
const graph = (nodes) => ({ id: "infra", url: "infra", nodes, properties: { name: "Infrastructure" } });

/** Every call CloudFormation was asked for, in order, and what it answered. */
function fakeCloudFormation(over = {}) {
    const calls = [];
    return {
        calls,
        async stackExists(name) { calls.push(["stackExists", name]); return over.exists === undefined ? false : over.exists; },
        async createChangeSet(input) { calls.push(["createChangeSet", input]); return { changeSetId: "arn:changeset/one" }; },
        async describeChangeSet(input) {
            calls.push(["describeChangeSet", input]);
            if (over.describe) { return over.describe(calls.filter((c) => c[0] === "describeChangeSet").length); }
            return { status: "CREATE_COMPLETE", changes: over.changes || [{ action: "Add", logicalId: "Bucket", resourceType: "AWS::S3::Bucket" }] };
        },
        async deleteChangeSet(input) { calls.push(["deleteChangeSet", input]); },
    };
}

function serviceFor(nodes, options = {}) {
    const store = new FakeS3Service();
    const cloudformation = options.cloudformation === null ? undefined : (options.cloudformation || fakeCloudFormation());
    const observed = [];
    const service = new IacService(store, {
        policy: options.policy || policy,
        projection: async () => ({ revisionId: "rev_01J8ZK5K0B1C2D3E4F5G6H7J8A", projection: graph(nodes) }),
        template: async () => null,
        cloudformation,
        observe: async (record) => { observed.push(record); },
        pollMs: 1,
        timeoutMs: options.timeoutMs === undefined ? 50 : options.timeoutMs,
        now: () => new Date("2026-09-23T00:00:00.000Z"),
    });
    return { service, store, cloudformation, observed };
}

describe("planning a change", () => {
    test("asks what would happen, reads it, and leaves nothing behind", async () => {
        const { service, cloudformation, observed } = serviceFor([iacNode()]);
        const r = await service.plan("infra", "stack", owner, { idempotencyKey: ULID });

        expect(r.error).toBeUndefined();
        expect(r.plan.changes).toEqual([{ action: "Add", logicalId: "Bucket", resourceType: "AWS::S3::Bucket" }]);
        expect(r.plan.destructive).toBe(false);
        expect(r.plan.stackExists).toBe(false);
        // the change set is deleted, because nothing here can execute one
        expect(r.plan.changeSetRetained).toBe(false);
        const asked = cloudformation.calls.map((c) => c[0]);
        expect(asked).toEqual(["stackExists", "createChangeSet", "describeChangeSet", "deleteChangeSet"]);
        // nothing that changes a resource was asked for, and there is no code that could
        expect(asked).not.toContain("executeChangeSet");
        expect(Object.keys(cloudformation)).not.toContain("executeChangeSet");

        const created = cloudformation.calls.find((c) => c[0] === "createChangeSet")[1];
        expect(created.changeSetType).toBe("CREATE");
        // the key is what makes a retry the same request rather than a second one
        expect(created.clientRequestToken).toBe(ULID);
        expect(created.templateBody).toBe(TEMPLATE);

        // and whoever is watching hears the same thing the status document says
        expect(observed.map((o) => o.state)).toEqual(["planning", "planned"]);
        expect(observed[1]).toMatchObject({ kind: "deploy.status", graphId: "infra", nodeId: "stack", changes: 1, destructive: false });
    });

    test("an existing stack is an update, not a create", async () => {
        const { service, cloudformation } = serviceFor([iacNode()], { cloudformation: fakeCloudFormation({ exists: true }) });
        await service.plan("infra", "stack", owner);
        expect(cloudformation.calls.find((c) => c[0] === "createChangeSet")[1].changeSetType).toBe("UPDATE");
    });

    test("taking something away is what a person is being asked about", async () => {
        const { service } = serviceFor([iacNode()], { cloudformation: fakeCloudFormation({ changes: [
            { action: "Modify", logicalId: "Bucket", resourceType: "AWS::S3::Bucket", replacement: "True" },
        ] }) });
        const r = await service.plan("infra", "stack", owner);
        expect(r.plan.destructive).toBe(true);
    });

    test("the answer is kept, so somebody who was not watching can still read it", async () => {
        const { service, store } = serviceFor([iacNode()]);
        await service.plan("infra", "stack", owner);
        const status = await new Promise((resolve) => store.get(IacService.statusKey({ account: "695527765921", region: "us-west-1", name: "pio-dev-uploads" }), (err, d) => resolve(d)));
        expect(status).toMatchObject({ state: "planned", requestedRevision: "rev_01J8ZK5K0B1C2D3E4F5G6H7J8A", by: { sub: "auth0|u1" } });
        expect(status.templateSha256).toMatch(/^[0-9a-f]{64}$/);
        const read = await service.status("infra", "stack", owner);
        expect(read.state).toBe("planned");
    });

    test("a stack nobody has planned says so rather than nothing", async () => {
        const { service } = serviceFor([iacNode()]);
        expect(await service.status("infra", "stack", owner)).toMatchObject({ state: "never-planned" });
    });
});

describe("what it refuses before asking AWS anything", () => {
    test("a template this environment does not allow", async () => {
        const bad = iacNode({ template: { text: `Resources:\n  X:\n    Type: Custom::Thing\n    Properties: {}\n`, format: "yaml" } });
        const { service, cloudformation } = serviceFor([bad]);
        const r = await service.plan("infra", "stack", owner);
        expect(r.code).toBe("IAC_REFUSED");
        expect(r.problems.map((p) => p.code)).toEqual(["CUSTOM_RESOURCE"]);
        expect(cloudformation.calls).toEqual([]);
    });

    test("a stack outside this environment", async () => {
        const elsewhere = iacNode({ stack: { name: "someone-elses", account: "695527765921", region: "us-west-1", environment: "dev" } });
        const { service, cloudformation } = serviceFor([elsewhere]);
        const r = await service.plan("infra", "stack", owner);
        expect(r.problems.map((p) => p.code)).toContain("STACK_PREFIX");
        expect(cloudformation.calls).toEqual([]);
    });

    test("an agent with no delegation", async () => {
        const { service, cloudformation } = serviceFor([iacNode()]);
        const r = await service.plan("infra", "stack", agent);
        expect(r.code).toBe("ADMISSION_DENIED");
        expect(cloudformation.calls).toEqual([]);
    });

    test("a node that carries no infrastructure", async () => {
        const { service } = serviceFor([{ id: "plain", url: "plain", properties: { name: "plain" } }]);
        expect(await service.plan("infra", "plain", owner)).toMatchObject({ code: "NOT_FOUND" });
    });
});

describe("an instance that cannot reach CloudFormation says so", () => {
    test("with no client, it validates and stops there", async () => {
        const { service, observed } = serviceFor([iacNode()], { cloudformation: null });
        const r = await service.plan("infra", "stack", owner);
        expect(r.code).toBe("UNSUPPORTED");
        expect(r.error).toMatch(/no CloudFormation authority/);
        // the validation still happened, which is the half it can do
        expect(r.validation.ok).toBe(true);
        expect(observed[observed.length - 1].state).toBe("failed");
    });

    test("a refusal from AWS reads as a refusal, not as a crash", async () => {
        const denying = fakeCloudFormation();
        denying.createChangeSet = async () => { throw new Error("User: arn:aws:sts::1:assumed-role/x is not authorized to perform: cloudformation:CreateChangeSet (AccessDenied)"); };
        const { service } = serviceFor([iacNode()], { cloudformation: denying });
        const r = await service.plan("infra", "stack", owner);
        expect(r.code).toBe("ADMISSION_DENIED");
        expect(r.error).toMatch(/not permitted to plan/);
    });

    test("a change set that never finishes is a failure with a reason", async () => {
        const slow = fakeCloudFormation({ describe: () => ({ status: "CREATE_IN_PROGRESS", changes: [] }) });
        const { service } = serviceFor([iacNode()], { cloudformation: slow, timeoutMs: 10 });
        const r = await service.plan("infra", "stack", owner);
        expect(r.code).toBe("IAC_PLAN_FAILED");
        expect(r.error).toMatch(/still being made/);
    });

    test("a change set with nothing in it is not a failure", async () => {
        const nothing = fakeCloudFormation({ describe: () => ({ status: "FAILED", statusReason: "The submitted information didn't contain changes.", changes: [] }) });
        const { service } = serviceFor([iacNode()], { cloudformation: nothing });
        const r = await service.plan("infra", "stack", owner);
        expect(r.error).toBeUndefined();
        expect(r.plan.changes).toEqual([]);
        expect(r.plan.destructive).toBe(false);
    });
});

describe("templates become artifacts when a revision is cut", () => {
    test("the text is written where CloudFormation can read it, addressed by its digest", async () => {
        const store = new FakeS3Service();
        const templates = new TemplateStore(store, { policy });
        const r = await templates.writeFor(graph([iacNode()]));
        expect(r.ok).toBe(true);
        expect(r.templates).toHaveLength(1);
        const record = r.templates[0];
        expect(record).toMatchObject({ nodeId: "stack", format: "yaml", resources: 1, resourceTypes: ["AWS::S3::Bucket"] });
        const back = await templates.read(record.sha256);
        expect(back.text).toBe(TEMPLATE);

        // content addressed, so cutting the same template twice writes the same bytes
        const again = await templates.writeFor(graph([iacNode()]));
        expect(again.templates[0].sha256).toBe(record.sha256);
    });

    test("a graph with no infrastructure writes nothing and is happy", async () => {
        const templates = new TemplateStore(new FakeS3Service(), { policy });
        expect(await templates.writeFor(graph([{ id: "n", url: "n", properties: {} }]))).toEqual({ ok: true, problems: [], templates: [] });
    });

    test("a template this environment refuses stops the cut, and leaves nothing behind", async () => {
        const store = new FakeS3Service();
        const templates = new TemplateStore(store, { policy });
        const bad = iacNode({ template: { text: `Resources:\n  R:\n    Type: AWS::IAM::Role\n    Properties: {RoleName: admin}\n`, format: "yaml" } });
        const r = await templates.writeFor(graph([iacNode(), bad]));
        expect(r.ok).toBe(false);
        expect(r.problems.map((p) => p.code)).toContain("NAME_OUTSIDE_PREFIX");
        expect(r.problems[0].nodeId).toBe("stack");
        expect(r.templates).toEqual([]);
        // not even the good one: a refused revision leaves nothing
        const keys = await new Promise((resolve) => store.list("iac/templates/", (err, items) => resolve(items || [])));
        expect(keys).toEqual([]);
    });
});

describe("a revision carrying infrastructure", () => {
    const Y = require("yjs");
    const { fromJSON, toJSON, reconcile, encodeState } = require("@plastic-io/graph-crdt");
    const CrdtStore = require("../crdtStore").default;
    const CrdtService = require("../crdtService").default;
    const { RevisionService } = require("../revisions/service");

    const plainNode = (id) => ({
        id, url: id, edges: [{ field: "out", connectors: [] }], version: 0, graphId: "infra", artifact: null, data: null,
        properties: { inputs: [], outputs: [], groups: [], name: id, description: "", tags: [], icon: "", x: 0, y: 0, z: 0, createdOn: 1, presentation: { x: 0, y: 0, z: 0 } },
        template: { set: "", vue: "" },
    });
    const withIac = (iac) => {
        const n = plainNode("stack");
        n.properties.iac = iac;
        return n;
    };
    const graphJson = (nodes) => ({ id: "infra", url: "infra", version: 0, nodes, properties: { name: "Infrastructure", description: "", exportable: false, icon: "", createdBy: "", createdOn: 0, lastUpdate: 0, height: 1, width: 1 } });

    async function cutWith(nodes) {
        const s3 = new FakeS3Service();
        const store = new CrdtStore(s3);
        const broadcast = { channel: [], postToClient: (d, c, p, cb) => cb(), _sendToChannel: (ch, v, cb) => cb(), broadcast: (ch, v, cb) => cb() };
        const crdt = new CrdtService(store, broadcast);
        const templates = new TemplateStore(s3, { policy });
        const revisions = new RevisionService(store, crdt.admission, { templates: (projection) => templates.writeFor(projection) });
        const doc = fromJSON(graphJson(nodes));
        await store.appendUpdate("infra", encodeState(doc), "seed", "system");
        return { s3, revisions, cut: await revisions.cut("infra", owner, "first") };
    }

    test("records which node carried which template, so a plan can name the bytes", async () => {
        const { s3, cut } = await cutWith([withIac({
            schemaVersion: 1,
            stack: { name: "pio-dev-uploads", account: "695527765921", region: "us-west-1", environment: "dev" },
            template: { text: TEMPLATE, format: "yaml" },
        })]);
        expect(cut.error).toBeUndefined();
        expect(cut.revision.iac).toHaveLength(1);
        expect(cut.revision.iac[0]).toMatchObject({ nodeId: "stack", format: "yaml", resources: 1 });
        expect([...s3.objects.keys()]).toContain(`iac/templates/${cut.revision.iac[0].sha256}.yaml`);
    });

    test("a template this environment refuses is not cut at all", async () => {
        const { s3, cut } = await cutWith([withIac({
            schemaVersion: 1,
            stack: { name: "pio-dev-uploads", account: "695527765921", region: "us-west-1", environment: "dev" },
            template: { text: `Resources:\n  X:\n    Type: Custom::Anything\n    Properties: {}\n`, format: "yaml" },
        })]);
        expect(cut).toMatchObject({ code: "IAC_REFUSED" });
        expect(cut.problems.map((p) => p.code)).toEqual(["CUSTOM_RESOURCE"]);
        // no revision, no projection, no template: a refused cut leaves nothing
        expect([...s3.objects.keys()].filter((k) => k.startsWith("revisions/") || k.startsWith("iac/"))).toEqual([]);
    });

    test("a graph with no infrastructure is cut exactly as before", async () => {
        const { cut } = await cutWith([plainNode("n1")]);
        expect(cut.error).toBeUndefined();
        expect(cut.revision.iac).toBeUndefined();
    });
});

describe("a node asking for it, all the way down", () => {
    const { ExecutionRunner } = require("../runtime/executor");

    /**
     * The point of D-41: there is no builtin node kind, so this is an ordinary
     * node running ordinary code, and the only thing between it and
     * CloudFormation is the capability.  The whole path runs here — scheduler,
     * capability check, observation, audit, service, client.
     */
    const port = (name) => ({ name, type: "Object", external: false, visible: true });
    const deployingGraph = (capabilities) => ({
        id: "infra", url: "infra", version: 0, properties: { name: "Infrastructure" },
        nodes: [{
            id: "stack", url: "stack", version: 0, graphId: "infra", artifact: null, data: null,
            edges: [{ field: "out", connectors: [] }],
            properties: {
                inputs: [port("in")], outputs: [port("out")], name: "Uploads bucket", presentation: {},
                capabilities,
                iac: {
                    schemaVersion: 1,
                    stack: { name: "pio-dev-uploads", account: "695527765921", region: "us-west-1", environment: "dev" },
                    template: { text: TEMPLATE, format: "yaml" },
                },
            },
            template: { set: "state.answer = await host.deploy({stack: {name: 'pio-dev-uploads'}, operation: 'plan', parameters: {Stage: value}}); edges.out = state.answer;", vue: "" },
        }],
    });

    async function runWith(capabilities, iacOver = {}) {
        const s3 = new FakeS3Service();
        const graph = deployingGraph(capabilities);
        const cloudformation = fakeCloudFormation();
        const iac = new IacService(s3, {
            policy,
            projection: async () => ({ revisionId: "rev_01J8ZK5K0B1C2D3E4F5G6H7J8A", projection: graph }),
            template: async () => null,
            cloudformation,
            pollMs: 1,
            timeoutMs: 50,
            ...iacOver,
        });
        const observations = [];
        const runner = new ExecutionRunner(s3, {
            live: (o) => observations.push(o),
            deploy: (request) => iac.fromHost({ ...request, principal: owner }),
        });
        const state = {};
        const summary = await runner.run({ graph, nodeUrl: "stack", field: "in", value: "dev", principal: owner, state });
        return { summary, observations, cloudformation, s3, state };
    }

    test("a node granted aws:cfn gets a plan back, and the parameters it assembled reach it", async () => {
        const { summary, observations, cloudformation, state } = await runWith(["aws:cfn:pio-dev-*"]);
        expect(summary.errors).toBe(0);
        // what the node holds is the plan itself
        expect(state.answer.plan.changes).toEqual([{ action: "Add", logicalId: "Bucket", resourceType: "AWS::S3::Bucket" }]);
        expect(state.answer.plan.destructive).toBe(false);
        const created = cloudformation.calls.find((c) => c[0] === "createChangeSet")[1];
        // the template came from the document; only the parameters came from the node
        expect(created.templateBody).toBe(TEMPLATE);
        expect(created.parameters).toEqual({ Stage: "dev" });
        // the effect is observed like any other, and named for what it was
        const effects = observations.filter((o) => o.kind === "effect");
        expect(effects.map((o) => [o.capability.kind, o.capability.decision, o.capability.scope[0]])).toContainEqual(["aws:cfn", "allowed", "pio-dev-uploads"]);
    });

    test("a node without the capability never reaches the service", async () => {
        const { summary, observations, cloudformation } = await runWith(["net:https:example.com"]);
        expect(cloudformation.calls).toEqual([]);
        expect(observations.filter((o) => o.kind === "effect.denied").map((o) => o.capability.kind)).toEqual(["aws:cfn"]);
        // the node's code failed, which is what a refused effect does
        expect(summary.errors).toBeGreaterThan(0);
    });

    test("an instance with no CloudFormation authority answers the node, rather than throwing at it", async () => {
        const { summary, observations, state } = await runWith(["aws:cfn:pio-dev-*"], { cloudformation: undefined });
        // the capability was granted, so the effect happened as far as it could
        expect(observations.filter((o) => o.kind === "effect").map((o) => o.capability.kind)).toContain("aws:cfn");
        expect(summary.errors).toBe(0);
        // and what the node holds says why, in the vocabulary of the tools
        expect(state.answer.code).toBe("UNSUPPORTED");
        expect(state.answer.error).toMatch(/no CloudFormation authority/);
    });
});

describe("what the editor asks", () => {
    /**
     * The panel and the tool ask the same service the same questions, over the
     * routes the editor already speaks — so a stack cannot look one way to an
     * agent and another way to a person (PB-094).
     */
    const routeFor = (nodes, options = {}) => {
        const { service } = serviceFor(nodes, options);
        return {
            service,
            call: (event) => new Promise((resolve) => service.route(event, {}, (err, r) => resolve({ status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }))),
        };
    };

    test("an overview lists every node that describes infrastructure, with what is known of each", async () => {
        const { service } = serviceFor([iacNode(), { id: "plain", url: "plain", properties: { name: "plain" } }]);
        const before = await service.overview("infra", owner);
        expect(before.stacks).toHaveLength(1);
        expect(before.stacks[0]).toMatchObject({ nodeId: "stack", name: "Uploads bucket", status: null });
        expect(before.stacks[0].stack.name).toBe("pio-dev-uploads");
        // the template is validated as it stands, so a problem shows before anyone plans
        expect(before.stacks[0].validation.ok).toBe(true);
        expect(before.canPlan).toBe(true);

        await service.plan("infra", "stack", owner);
        const after = await service.overview("infra", owner);
        expect(after.stacks[0].status).toMatchObject({ state: "planned" });
    });

    test("an overview says when the template is the problem, before anything is asked of AWS", async () => {
        const bad = iacNode({ template: { text: `Resources:\n  X:\n    Type: AWS::EC2::NatGateway\n    Properties: {}\n`, format: "yaml" } });
        const { service } = serviceFor([bad], { policy: () => ({ ...policy(), allowedResourceTypes: ["AWS::S3::Bucket"], maxResources: 100 }) });
        const r = await service.overview("infra", owner);
        expect(r.stacks[0].validation.ok).toBe(false);
        expect(r.stacks[0].validation.problems[0].code).toBe("RESOURCE_TYPE_NOT_ALLOWED");
    });

    test("an instance that cannot plan says so, so the button can say so too", async () => {
        const { service } = serviceFor([iacNode()], { cloudformation: null });
        expect((await service.overview("infra", owner)).canPlan).toBe(false);
    });

    test("the routes answer the status, a plan, and a refusal with the code the editor reads", async () => {
        const { call } = routeFor([iacNode()]);
        const status = await call({ pathParameters: { id: "infra", nodeId: "stack" }, httpMethod: "GET", principal: owner });
        expect(status.status).toBe(200);
        expect(status.body.state).toBe("never-planned");

        const planned = await call({ pathParameters: { id: "infra", nodeId: "stack" }, httpMethod: "POST", principal: owner });
        expect(planned.status).toBe(200);
        expect(planned.body.plan.changes).toHaveLength(1);

        const denied = await call({ pathParameters: { id: "infra", nodeId: "stack" }, httpMethod: "POST", principal: agent });
        expect(denied.status).toBe(403);
        expect(denied.body.code).toBe("ADMISSION_DENIED");

        const missing = await call({ pathParameters: { id: "infra", nodeId: "nope" }, httpMethod: "GET", principal: owner });
        expect(missing.status).toBe(404);
    });

    test("a refused desired state answers 400 with the problems, not 500", async () => {
        const bad = iacNode({ stack: { name: "not-ours", account: "695527765921", region: "us-west-1", environment: "dev" } });
        const { call } = routeFor([bad]);
        const r = await call({ pathParameters: { id: "infra", nodeId: "stack" }, httpMethod: "POST", principal: owner });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe("IAC_REFUSED");
        expect(r.body.problems.map((p) => p.code)).toContain("STACK_PREFIX");
    });
});
