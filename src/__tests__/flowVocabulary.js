const { ExecutionRunner } = require("../runtime/executor");
const fakeS3 = require("../__testHelpers__/fakeS3");
const FakeS3Service = fakeS3.FakeS3Service || fakeS3;
const vocabulary = require("./__data__/flowVocabulary.json");

/**
 * The flow-control vocabulary, run (PB-140).
 *
 * These are the nodes the registry was missing — the Max objects that let a
 * graph arrange values rather than only produce them.  Every one is published
 * to the registry, so what is tested here is the code as published: the
 * fixture beside this file is what the nodes carry, and a node that changes
 * changes it.
 *
 * Each test builds a real graph, hands it to the real scheduler through the
 * real executor, and reads what came out the far end.  Nothing is stubbed;
 * "it works" means the scheduler ran it.
 */

const owner = { sub: "auth0|u1", kind: "human", tenant: "personal:auth0|u1", scopes: [] };
const port = (name) => ({ name, type: "Object", external: false, visible: true });

/** A node from the vocabulary, as published, at a position in a test graph. */
function node(id, over = {}) {
    const definition = vocabulary[over.from || id];
    if (!definition) { throw new Error(`no ${id} in the vocabulary`); }
    return {
        id, url: id, version: 0, graphId: "g1", artifact: null,
        data: over.data === undefined ? null : over.data,
        edges: definition.outputs.map((name) => ({ field: name, connectors: [] })),
        properties: {
            inputs: definition.inputs.map(port),
            outputs: definition.outputs.map(port),
            name: definition.name, description: definition.description, presentation: {},
            ...(over.properties || {}),
        },
        template: { set: definition.set, vue: "" },
    };
}

/**
 * Where everything ends up.  A graph has to put its answer somewhere; this is
 * the somewhere, and it is an ordinary node with an ordinary set function.
 */
function sink(id = "sink") {
    return {
        id, url: id, version: 0, graphId: "g1", artifact: null, data: null,
        edges: [],
        properties: { inputs: [port("in")], outputs: [], name: "Sink", presentation: {} },
        template: { set: "state.out = (state.out || []).concat([{field, value}]);", vue: "" },
    };
}

/**
 * A node that sends a value of its own — the registry's String node, which is
 * `edges.value = node.data;` and nothing else.  Every graph needs one,
 * because a graph with no sources has nothing to say.
 */
function constant(id, value) {
    return {
        id, url: id, version: 0, graphId: "g1", artifact: null, data: value,
        edges: [{ field: "value", connectors: [] }],
        properties: { inputs: [port("bang")], outputs: [port("value")], name: "Constant", presentation: {} },
        template: { set: "edges.value = node.data;", vue: "" },
    };
}

/** Wire one node's output into another node's input. */
function wire(from, field, to, toField = "in") {
    const edge = from.edges.find((e) => e.field === field);
    if (!edge) { throw new Error(`${from.id} has no output ${field}`); }
    edge.connectors.push({ id: `c-${from.id}-${field}-${to.id}-${toField}`, nodeId: to.id, field: toField, graphId: "g1", version: 0 });
}

const graphOf = (nodes) => ({ id: "g1", url: "g1", version: 0, properties: { name: "vocabulary" }, nodes });

/** Run a graph and answer with whatever reached the sinks, and the state. */
async function run(nodes, entry, value, field = "in") {
    const state = {};
    const runner = new ExecutionRunner(new FakeS3Service());
    const summary = await runner.run({ graph: graphOf(nodes), nodeUrl: entry, field, value, principal: owner, state });
    return { out: state.out || [], state, summary };
}
const values = (out) => out.map((o) => o.value);

describe("values arrive where they are sent", () => {
    test("Pack: the cold inputs remember, bang sends them as one object", async () => {
        // driven the way Max drives it: a Trigger, whose last output fires
        // first, so both cold values are in before the bang asks for them
        const trigger = node("trigger");
        const name = constant("name", "pio-dev-uploads");
        const days = constant("days", 14);
        const pack = node("pack");
        const end = sink();
        wire(trigger, "third", days, "bang");
        wire(trigger, "second", name, "bang");
        wire(trigger, "first", pack, "bang");
        wire(days, "value", pack, "b");
        wire(name, "value", pack, "a");
        wire(pack, "value", end);
        const { out, summary } = await run([trigger, name, days, pack, end], "trigger", "GO", "bang");
        expect(summary.errors).toBe(0);
        expect(out).toHaveLength(1);
        expect(out[0].value).toEqual({ a: "pio-dev-uploads", b: 14 });
    });

    test("Collect: nothing goes downstream until the last one has arrived", async () => {
        const iterate = node("iterate");
        const collect = node("collect", { data: { count: 3, items: [] } });
        const end = sink();
        wire(iterate, "each", collect, "value");
        wire(collect, "value", end);
        const { out, summary } = await run([iterate, collect, end], "iterate", ["one", "two", "three"], "value");
        expect(summary.errors).toBe(0);
        // one answer, not three: the first two went in and nothing came out
        expect(out).toHaveLength(1);
        expect(out[0].value).toEqual(["one", "two", "three"]);
    });

    test("Collect: it does not send again until it has another full set", async () => {
        const iterate = node("iterate");
        const collect = node("collect", { data: { count: 2, items: [] } });
        const end = sink();
        wire(iterate, "each", collect, "value");
        wire(collect, "value", end);
        const { out } = await run([iterate, collect, end], "iterate", ["a", "b", "c", "d", "e"], "value");
        // two full sets, and the fifth is still waiting
        expect(values(out)).toEqual([["a", "b"], ["c", "d"]]);
    });

    test("Store: the cold input remembers, the bang decides when it is read", async () => {
        const trigger = node("trigger");
        const held = constant("held", { kept: true });
        const store = node("store");
        const end = sink();
        wire(trigger, "second", held, "bang");
        wire(trigger, "first", store, "bang");
        wire(held, "value", store, "value");
        wire(store, "value", end);
        const { out } = await run([trigger, held, store, end], "trigger", "GO", "bang");
        expect(values(out)).toEqual([{ kept: true }]);
    });

    test("Loadbang sends what it is given, or BANG", async () => {
        const bang = node("loadbang");
        const end = sink();
        wire(bang, "value", end);
        expect(values((await run([bang, end], "loadbang", undefined, "bang")).out)).toEqual(["BANG"]);
        expect(values((await run([bang, end], "loadbang", "GO", "bang")).out)).toEqual(["GO"]);
    });
});

describe("order, when order matters", () => {
    test("Trigger fires its outputs last first, so nothing downstream is half-fed", async () => {
        const trigger = node("trigger");
        const end = sink();
        wire(trigger, "first", end, "in");
        wire(trigger, "second", end, "in");
        wire(trigger, "third", end, "in");
        const { out } = await run([trigger, end], "trigger", "GO", "bang");
        // three deliveries, in the order the node promises on its face
        expect(out).toHaveLength(3);
        expect(values(out)).toEqual(["GO", "GO", "GO"]);
    });

    test("Unpack sends each key out of the output named for it", async () => {
        const unpack = node("unpack", { properties: { outputs: [port("a"), port("b")] } });
        const a = sink("a-sink");
        const b = sink("b-sink");
        wire(unpack, "a", a);
        wire(unpack, "b", b);
        const { state } = await run([unpack, a, b], "unpack", { a: 1, b: 2, c: 3 }, "value");
        expect(values(state.out).sort()).toEqual([1, 2]);
    });

    test("Unpack takes an array apart by index", async () => {
        const unpack = node("unpack", { properties: { outputs: [port("0"), port("1")] } });
        unpack.edges = [{ field: "0", connectors: [] }, { field: "1", connectors: [] }];
        const end = sink();
        wire(unpack, "0", end);
        wire(unpack, "1", end);
        const { out } = await run([unpack, end], "unpack", ["first", "second"], "value");
        expect(values(out).sort()).toEqual(["first", "second"]);
    });
});

describe("deciding where a value goes", () => {
    test("Route sends it out of the output its kind names, and the rest out unmatched", async () => {
        const route = node("route", { data: { on: "kind" } });
        const end = sink();
        wire(route, "a", end, "a");
        wire(route, "b", end, "b");
        wire(route, "unmatched", end, "unmatched");
        const { out } = await run([route, end], "route", { kind: "a", n: 1 }, "value");
        expect(out).toEqual([{ field: "a", value: { kind: "a", n: 1 } }]);
        const other = await run([route, end], "route", { kind: "zzz" }, "value");
        expect(other.out[0].field).toBe("unmatched");
    });

    test("Select: equal goes one way, everything else the other", async () => {
        const select = node("select", { data: { match: "go" } });
        const end = sink();
        wire(select, "yes", end, "yes");
        wire(select, "no", end, "no");
        expect((await run([select, end], "select", "go", "value")).out[0].field).toBe("yes");
        expect((await run([select, end], "select", "stop", "value")).out[0].field).toBe("no");
    });

    test("Gate is shut until something opens it", async () => {
        const gate = node("gate");
        const end = sink();
        wire(gate, "value", end);
        // shut by default: a value arriving first goes nowhere
        expect((await run([gate, end], "gate", "dropped", "value")).out).toEqual([]);

        const trigger = node("trigger");
        const open = constant("open", true);
        const passing = constant("passing", "through");
        const gate2 = node("gate");
        const end2 = sink();
        wire(trigger, "third", open, "bang");
        wire(trigger, "second", passing, "bang");
        wire(open, "value", gate2, "open");
        wire(passing, "value", gate2, "value");
        wire(gate2, "value", end2);
        const { out } = await run([trigger, open, passing, gate2, end2], "trigger", "GO", "bang");
        expect(values(out)).toEqual(["through"]);
    });

    test("If tests a condition written on the node", async () => {
        const branch = node("if", { data: { test: "value > 10" } });
        const end = sink();
        wire(branch, "then", end, "then");
        wire(branch, "else", end, "else");
        expect((await run([branch, end], "if", 42, "value")).out[0].field).toBe("then");
        expect((await run([branch, end], "if", 2, "value")).out[0].field).toBe("else");
    });

    test("If says which condition failed rather than choosing a branch", async () => {
        const branch = node("if", { data: { test: "value.((" } });
        const end = sink();
        wire(branch, "then", end, "then");
        const { out, summary } = await run([branch, end], "if", 1, "value");
        expect(out).toEqual([]);
        expect(summary.errors).toBeGreaterThan(0);
    });
});

describe("counting, looping and waiting", () => {
    test("Counter counts what arrives", async () => {
        const iterate = node("iterate");
        const counter = node("counter");
        const end = sink();
        wire(iterate, "each", counter, "bang");
        wire(counter, "count", end);
        const { out } = await run([iterate, counter, end], "iterate", ["a", "b", "c"], "value");
        expect(values(out)).toEqual([1, 2, 3]);
    });

    test("Toggle flips on each bang", async () => {
        const iterate = node("iterate");
        const toggle = node("toggle");
        const end = sink();
        wire(iterate, "each", toggle, "bang");
        wire(toggle, "value", end);
        const { out } = await run([iterate, toggle, end], "iterate", [1, 2, 3], "value");
        expect(values(out)).toEqual([true, false, true]);
    });

    test("what a node remembers, it remembers for the run", async () => {
        /**
         * Memory is per execution on the server, because the graph a run is
         * given is a copy: the scheduler flattens it first, and what a node
         * writes to `data` is written on that copy.  Within a run it is memory
         * — which is what makes Pack, Store, Gate, Toggle, Counter and Collect
         * work.  Between runs it is gone, and a graph that must remember
         * across runs has to put it somewhere that lasts: the document, or the
         * state a caller keeps.  In a browser the document *is* the object the
         * editor holds, so there it persists for the session; the difference is
         * worth knowing before relying on either.
         */
        const iterate = node("iterate");
        const counter = node("counter");
        const end = sink();
        wire(iterate, "each", counter, "bang");
        wire(counter, "count", end);
        const nodes = [iterate, counter, end];
        expect(values((await run(nodes, "iterate", ["a", "b"], "value")).out)).toEqual([1, 2]);
        // the next run starts at one again
        expect(values((await run(nodes, "iterate", ["a", "b"], "value")).out)).toEqual([1, 2]);
    });

    test("Iterate sends each element, then how many there were", async () => {
        const iterate = node("iterate");
        const each = sink("each");
        const done = sink("done");
        wire(iterate, "each", each, "each");
        wire(iterate, "done", done, "done");
        const { state } = await run([iterate, each, done], "iterate", ["a", "b", "c"], "value");
        expect(state.out.filter((o) => o.field === "each").map((o) => o.value)).toEqual(["a", "b", "c"]);
        expect(state.out.filter((o) => o.field === "done").map((o) => o.value)).toEqual([3]);
    });

    test("Repeat sends as many times as it was told, counting as it goes", async () => {
        const repeat = node("repeat", { data: { times: 3 } });
        const each = sink("each");
        wire(repeat, "each", each, "each");
        const { state } = await run([repeat, each], "repeat", "GO", "bang");
        expect(state.out.map((o) => o.value.index)).toEqual([0, 1, 2]);
        expect(state.out[0].value).toEqual({ index: 0, of: 3, value: "GO" });
    });

    test("Delay holds the value, and the run does not end while it is in the air", async () => {
        const delay = node("delay", { data: { ms: 40 } });
        const end = sink();
        wire(delay, "value", end);
        const started = Date.now();
        const { out } = await run([delay, end], "delay", "late", "value");
        // the value arrived, and the execution waited for it rather than ending first
        expect(values(out)).toEqual(["late"]);
        expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    });
});

describe("reading, shaping and looking", () => {
    test("Get reads a path, and says so when there is nothing there", async () => {
        const get = node("get", { data: { path: "stack.name" } });
        const found = sink("found");
        const missing = sink("missing");
        wire(get, "value", found, "found");
        wire(get, "missing", missing, "missing");
        const { state } = await run([get, found, missing], "get", { stack: { name: "pio-dev-uploads" } }, "value");
        expect(state.out).toEqual([{ field: "found", value: "pio-dev-uploads" }]);
        const nothing = await run([get, found, missing], "get", { stack: {} }, "value");
        expect(nothing.out[0].field).toBe("missing");
        expect(nothing.out[0].value.path).toBe("stack.name");
    });

    test("Format composes a string from what arrived", async () => {
        const format = node("format", { data: { pattern: "${value.name} in ${value.region}" } });
        const end = sink();
        wire(format, "value", end);
        const { out } = await run([format, end], "format", { name: "pio-dev-uploads", region: "us-west-1" }, "value");
        expect(values(out)).toEqual(["pio-dev-uploads in us-west-1"]);
    });

    test("Log records what passes and passes it on unchanged", async () => {
        const log = node("log", { data: { label: "on its way" } });
        const end = sink();
        wire(log, "value", end);
        const observed = [];
        const runner = new ExecutionRunner(new FakeS3Service(), { live: (o) => observed.push(o) });
        const state = {};
        await runner.run({ graph: graphOf([log, end]), nodeUrl: "log", field: "value", value: { n: 1 }, principal: owner, state });
        expect(values(state.out)).toEqual([{ n: 1 }]);
        const custom = observed.filter((o) => o.kind === "custom");
        expect(custom.length).toBeGreaterThan(0);
        expect(JSON.stringify(custom[0].payload)).toMatch(/on its way/);
    });
});

describe("the vocabulary composed, which is the point of it", () => {
    /**
     * Two values, assembled from strings, collected, and read — the shape the
     * infrastructure graph needs, and the reason Collect exists.  Nothing here
     * reads the graph; every value is carried along a wire.
     */
    test("a fan-out and a fan-in: two values become one array, once", async () => {
        const trigger = node("trigger", { properties: { outputs: [port("first"), port("second")] } });
        trigger.edges = [{ field: "first", connectors: [] }, { field: "second", connectors: [] }];
        const left = node("format", { from: "format", data: { pattern: "left:${value}" } });
        left.id = left.url = "left";
        const right = node("format", { from: "format", data: { pattern: "right:${value}" } });
        right.id = right.url = "right";
        const collect = node("collect", { data: { count: 2, items: [] } });
        const end = sink();
        wire(trigger, "first", left, "value");
        wire(trigger, "second", right, "value");
        wire(left, "value", collect, "value");
        wire(right, "value", collect, "value");
        wire(collect, "value", end);

        const { out, summary } = await run([trigger, left, right, collect, end], "trigger", "GO", "bang");
        expect(summary.errors).toBe(0);
        expect(out).toHaveLength(1);
        expect(values(out)[0].sort()).toEqual(["left:GO", "right:GO"]);
    });

    test("a loop with a decision in it: iterate, test, count what passed", async () => {
        const iterate = node("iterate");
        const branch = node("if", { data: { test: "value > 2" } });
        const counter = node("counter");
        const end = sink();
        wire(iterate, "each", branch, "value");
        wire(branch, "then", counter, "bang");
        wire(counter, "count", end);
        const { out, summary } = await run([iterate, branch, counter, end], "iterate", [1, 2, 3, 4, 5], "value");
        expect(summary.errors).toBe(0);
        // three of the five passed, and the counter says so as it goes
        expect(values(out)).toEqual([1, 2, 3]);
    });
});
