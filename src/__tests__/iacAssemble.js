const { assemble, reaches, fragmentOf, logicalIdFor, referencesIn } = require("../iac/assemble");

/**
 * Infrastructure composed as a graph (D-48).
 *
 * The arrangement on the canvas is the arrangement in the account: a resource
 * node declares one resource, and the wire into a stack node says which stack
 * it belongs to.  These are the things that arrangement can get wrong, and
 * what it is told when it does.
 */

const resource = (id, type, properties, over = {}) => ({
    id, url: id, edges: [{ field: "out", connectors: [] }],
    properties: { name: over.name || id, iac: { schemaVersion: 1, resource: { type, properties, ...(over.resource || {}) } } },
});
const stack = (id = "stack", over = {}) => ({
    id, url: id, edges: [],
    properties: { name: "Uploads", description: "what this stack is", iac: { schemaVersion: 1, stack: { name: "pio-dev-uploads", account: "695527765921", region: "us-west-1", environment: "dev" }, ...over } },
});
/** wire `from` into `to` */
const wire = (from, to, field = "in") => {
    from.edges[0].connectors.push({ id: `c-${from.id}-${to.id}`, nodeId: to.id, field, graphId: "infra", version: 0 });
    return from;
};
const graph = (nodes) => ({ id: "infra", url: "infra", nodes, properties: { name: "Infrastructure" } });

describe("what the graph describes", () => {
    test("a resource wired into a stack is in that stack, and the template says so", () => {
        const bucket = resource("bucket", "AWS::S3::Bucket", { BucketName: "pio-dev-uploads" }, { name: "Uploads" });
        const logs = resource("logs", "AWS::Logs::LogGroup", { LogGroupName: "pio-dev-uploads-log", RetentionInDays: 14 }, { name: "Upload log" });
        const target = stack();
        wire(bucket, target); wire(logs, target);

        const r = assemble(graph([bucket, logs, target]), "stack");
        expect(r.problems).toEqual([]);
        expect(r.ok).toBe(true);
        expect(Object.keys(r.template.Resources).sort()).toEqual(["Uploadlog", "Uploads"]);
        expect(r.template.Resources.Uploads).toEqual({ Type: "AWS::S3::Bucket", Properties: { BucketName: "pio-dev-uploads" } });
        expect(r.template.Description).toBe("what this stack is");
        // the same graph assembles to the same bytes, which is what lets a plan
        // and the apply that follows be about one thing
        expect(assemble(graph([bucket, logs, target]), "stack").text).toBe(r.text);
    });

    test("a resource reaches a stack through whatever is in between", () => {
        const bucket = resource("bucket", "AWS::S3::Bucket", {});
        const shaper = { id: "shaper", url: "shaper", edges: [{ field: "out", connectors: [] }], properties: { name: "names it" } };
        const target = stack();
        wire(bucket, shaper); wire(shaper, target);
        const r = assemble(graph([bucket, shaper, target]), "stack");
        expect(r.fragments.map((f) => f.nodeId)).toEqual(["bucket"]);
        // the node in between shapes a value; it is not a resource and is not in the template
        expect(Object.keys(r.template.Resources)).toEqual(["bucket"]);
    });

    test("a logical id is what the node is called, so it reads the same in AWS", () => {
        expect(logicalIdFor({ id: "n1", properties: { name: "Upload bucket" } })).toBe("Uploadbucket");
        expect(logicalIdFor({ id: "n1", properties: { name: "Upload bucket", iac: { resource: { logicalId: "Chosen" } } } })).toBe("Chosen");
        expect(logicalIdFor({ id: "n1", properties: {} })).toBe("n1");
    });
});

describe("what it will not do quietly", () => {
    test("two resources with one name would silently drop one", () => {
        const a = resource("a", "AWS::S3::Bucket", {}, { name: "Same" });
        const b = resource("b", "AWS::SQS::Queue", {}, { name: "Same" });
        const target = stack();
        wire(a, target); wire(b, target);
        const r = assemble(graph([a, b, target]), "stack");
        expect(r.ok).toBe(false);
        expect(r.problems[0].message).toMatch(/both called Same/);
        expect(r.problems[0].resource).toBe("b");
    });

    test("a reference to something that is not in this stack", () => {
        const bucket = resource("bucket", "AWS::S3::Bucket", { BucketName: { Ref: "Missing" } });
        const target = stack();
        wire(bucket, target);
        const r = assemble(graph([bucket, target]), "stack");
        expect(r.ok).toBe(false);
        expect(r.problems[0].message).toMatch(/refers to Missing, which is not in this stack/);
    });

    test("a reference that is in the stack, a pseudo parameter, or a parameter, is fine", () => {
        const logs = resource("logs", "AWS::Logs::LogGroup", { LogGroupName: "l", RetentionInDays: 1 }, { name: "Logs" });
        const bucket = resource("bucket", "AWS::S3::Bucket", {
            BucketName: { "Fn::Sub": "${AWS::StackName}-uploads" },
            Tags: [{ Key: "log", Value: { "Fn::GetAtt": ["Logs", "Arn"] } }, { Key: "stage", Value: { Ref: "Stage" } }],
        }, { name: "Bucket" });
        const target = stack("stack", { parameters: { Stage: "dev" } });
        wire(logs, target); wire(bucket, target);
        expect(assemble(graph([logs, bucket, target]), "stack").problems).toEqual([]);
    });

    test("DependsOn on something that is not there", () => {
        const bucket = resource("bucket", "AWS::S3::Bucket", {}, { resource: { dependsOn: ["Ghost"] } });
        const target = stack();
        wire(bucket, target);
        expect(assemble(graph([bucket, target]), "stack").problems[0].message).toMatch(/depends on Ghost/);
    });

    test("a stack with nothing wired into it describes nothing", () => {
        const target = stack();
        const r = assemble(graph([target]), "stack");
        expect(r.ok).toBe(false);
        expect(r.problems[0].code).toBe("TEMPLATE_EMPTY");
        expect(r.problems[0].message).toMatch(/nothing is wired into this stack/);
    });

    test("a resource wired into nothing is somebody believing it is deployed", () => {
        const wired = resource("wired", "AWS::S3::Bucket", {}, { name: "Wired" });
        const lonely = resource("lonely", "AWS::SQS::Queue", {}, { name: "Lonely" });
        const target = stack();
        wire(wired, target);
        const r = assemble(graph([wired, lonely, target]), "stack");
        expect(r.ok).toBe(true);
        expect(r.orphans).toEqual([{ nodeId: "lonely", name: "Lonely" }]);
    });

    test("a resource belonging to another stack is not an orphan", () => {
        const mine = resource("mine", "AWS::S3::Bucket", {}, { name: "Mine" });
        const theirs = resource("theirs", "AWS::SQS::Queue", {}, { name: "Theirs" });
        const one = stack("one");
        const two = stack("two");
        wire(mine, one); wire(theirs, two);
        expect(assemble(graph([mine, theirs, one, two]), "one").orphans).toEqual([]);
    });

    test("a cycle in the wiring stops rather than spinning", () => {
        const a = resource("a", "AWS::S3::Bucket", {}, { name: "A" });
        const b = resource("b", "AWS::SQS::Queue", {}, { name: "B" });
        const target = stack();
        wire(a, b); wire(b, a); wire(b, target);
        const r = assemble(graph([a, b, target]), "stack");
        expect(r.ok).toBe(true);
        expect(Object.keys(r.template.Resources).sort()).toEqual(["A", "B"]);
    });
});

describe("the pieces it is built from", () => {
    test("reaches walks backwards, transitively, without counting the target", () => {
        const a = resource("a", "AWS::S3::Bucket", {});
        const b = resource("b", "AWS::SQS::Queue", {});
        const target = stack();
        wire(a, b); wire(b, target);
        expect(Array.from(reaches(graph([a, b, target]), "stack")).sort()).toEqual(["a", "b"]);
    });

    test("a node that declares no resource is not one", () => {
        expect(fragmentOf({ id: "n", properties: { name: "n" } })).toBeNull();
        expect(fragmentOf({ id: "n", properties: { iac: { stack: {} } } })).toBeNull();
        expect(fragmentOf({ id: "n", properties: { iac: { resource: { type: "AWS::S3::Bucket" } } } })).toMatchObject({ type: "AWS::S3::Bucket", properties: {} });
    });

    test("references are found wherever they are written", () => {
        expect(referencesIn({ a: { Ref: "One" }, b: [{ "Fn::GetAtt": ["Two", "Arn"] }], c: { "Fn::GetAtt": "Three.Arn" } }).sort()).toEqual(["One", "Three", "Two"]);
    });
});
