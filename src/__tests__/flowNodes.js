const vocabulary = require("./__data__/flowVocabulary.json");

/**
 * Each flow-control node, on its own, against what it says it does (PB-140).
 *
 * The set script is the node: it is handed the same parameters the scheduler
 * hands it, and what it sends is whatever it assigns to `edges`.  So that is
 * what these run — the published code, called directly — which makes it
 * possible to check what a node *remembers* as well as what it sends.  What it
 * remembers is what its presentation shows, so it is part of the promise.
 *
 * The graphs that wire these together are in `flowVocabulary.js`.
 */

const AsyncFunction = Object.getPrototypeOf(async function () { /* empty */ }).constructor;
/** The parameters a set script is called with (plastic-io `Node.ts`). */
const SET_PARAMETERS = ["scheduler", "graph", "cache", "node", "field", "state", "value", "edges", "data", "properties", "require", "host", "instance"];

/**
 * Run one node's set script.  `node` survives between calls, the way it does
 * within one execution, so a node that remembers can be given several arrivals.
 */
function nodeFor(id, over = {}) {
    const definition = vocabulary[id];
    if (!definition) { throw new Error(`no ${id} in the vocabulary`); }
    return {
        id, url: id, data: over.data === undefined ? null : over.data,
        properties: {
            name: definition.name,
            inputs: (over.inputs || definition.inputs).map((name) => ({ name })),
            outputs: (over.outputs || definition.outputs).map((name) => ({ name })),
        },
        edges: (over.outputs || definition.outputs).map((field) => ({ field, connectors: [] })),
    };
}

async function send(node, field, value, context = {}) {
    const definition = vocabulary[node.id];
    const sent = [];
    const edges = new Proxy({}, {
        set(target, key, v) { sent.push({ field: String(key), value: v }); return true; },
        get() { return undefined; },
    });
    const emitted = [];
    const host = {
        emit: (kind, payload) => emitted.push({ kind, payload }),
        throwIfCancelled: () => undefined,
        ...(context.host || {}),
    };
    const state = context.state || {};
    const run = new AsyncFunction(SET_PARAMETERS, definition.set);
    await run(context.scheduler || {}, context.graph || { id: "g1", nodes: [node] }, context.cache || {}, node, field, state,
        value, edges, node.data, node.properties, () => undefined, host, undefined);
    return { sent, emitted, state, data: node.data, one: sent[0] };
}
/** What it sent, as [field, value] pairs. */
const pairs = (r) => r.sent.map((s) => [s.field, s.value]);

describe("Pack: the cold inputs remember, bang sends", () => {
    test("nothing is sent while it is only remembering", async () => {
        const pack = nodeFor("pack");
        expect((await send(pack, "a", "one")).sent).toEqual([]);
        expect((await send(pack, "b", 2)).sent).toEqual([]);
        expect(pack.data).toEqual({ a: "one", b: 2 });
    });

    test("bang sends one object, keyed by the input each value came in on", async () => {
        const pack = nodeFor("pack");
        await send(pack, "a", "one");
        await send(pack, "b", 2);
        expect(pairs(await send(pack, "bang", "BANG"))).toEqual([["value", { a: "one", b: 2 }]]);
    });

    test("what it sends is a copy, so what it holds cannot be changed underneath it", async () => {
        const pack = nodeFor("pack");
        await send(pack, "a", 1);
        const out = (await send(pack, "bang", "BANG")).one.value;
        out.a = "meddled with";
        expect(pack.data.a).toBe(1);
    });

    test("a later value on the same input replaces the earlier one", async () => {
        const pack = nodeFor("pack");
        await send(pack, "a", "first");
        await send(pack, "a", "second");
        expect((await send(pack, "bang", "BANG")).one.value).toEqual({ a: "second" });
    });

    test("banging twice sends twice: it holds what it holds until it is told otherwise", async () => {
        const pack = nodeFor("pack");
        await send(pack, "a", 1);
        expect((await send(pack, "bang", "BANG")).one.value).toEqual({ a: 1 });
        expect((await send(pack, "bang", "BANG")).one.value).toEqual({ a: 1 });
    });
});

describe("Collect: hold until there are enough, then send them as one", () => {
    test("it sends nothing until the last one arrives, and then sends all of them", async () => {
        const collect = nodeFor("collect", { data: { count: 3, items: [] } });
        expect((await send(collect, "value", "one")).sent).toEqual([]);
        expect((await send(collect, "value", "two")).sent).toEqual([]);
        expect(pairs(await send(collect, "value", "three"))).toEqual([["value", ["one", "two", "three"]]]);
    });

    test("it starts again rather than sending the same list twice", async () => {
        const collect = nodeFor("collect", { data: { count: 2, items: [] } });
        await send(collect, "value", "a");
        await send(collect, "value", "b");
        expect(collect.data.items).toEqual([]);
        expect((await send(collect, "value", "c")).sent).toEqual([]);
        expect((await send(collect, "value", "d")).one.value).toEqual(["c", "d"]);
    });

    test("reset throws away what a branch that never fired left behind", async () => {
        const collect = nodeFor("collect", { data: { count: 2, items: [] } });
        await send(collect, "value", "stale");
        expect((await send(collect, "reset", true)).sent).toEqual([]);
        expect(collect.data.items).toEqual([]);
        await send(collect, "value", "a");
        expect((await send(collect, "value", "b")).one.value).toEqual(["a", "b"]);
    });

    test("with no count set it waits for two, which is what its presentation says", async () => {
        const collect = nodeFor("collect");
        await send(collect, "value", "a");
        expect((await send(collect, "value", "b")).one.value).toEqual(["a", "b"]);
    });

    test("a count of one sends each value as it arrives, wrapped", async () => {
        const collect = nodeFor("collect", { data: { count: 1, items: [] } });
        expect((await send(collect, "value", "a")).one.value).toEqual(["a"]);
        expect((await send(collect, "value", "b")).one.value).toEqual(["b"]);
    });
});

describe("Store: the cold input remembers, the bang decides when it is read", () => {
    test("value remembers and sends nothing; bang sends what is held", async () => {
        const store = nodeFor("store");
        expect((await send(store, "value", { kept: true })).sent).toEqual([]);
        expect(pairs(await send(store, "bang", "BANG"))).toEqual([["value", { kept: true }]]);
    });

    test("banged before anything was given, it sends nothing rather than undefined", async () => {
        const store = nodeFor("store");
        const r = await send(store, "bang", "BANG");
        expect(r.one.value).toBeUndefined();
    });

    test("it keeps the last thing it was given", async () => {
        const store = nodeFor("store");
        await send(store, "value", "first");
        await send(store, "value", "second");
        expect((await send(store, "bang", "BANG")).one.value).toBe("second");
    });
});

describe("Toggle: flips on each bang", () => {
    test("it flips, and says which it now is", async () => {
        const toggle = nodeFor("toggle");
        expect(pairs(await send(toggle, "bang", "BANG"))).toEqual([["value", true]]);
        expect(pairs(await send(toggle, "bang", "BANG"))).toEqual([["value", false]]);
        expect(pairs(await send(toggle, "bang", "BANG"))).toEqual([["value", true]]);
    });

    test("set puts it where you want without sending, so a graph can be armed", async () => {
        const toggle = nodeFor("toggle");
        expect((await send(toggle, "set", true)).sent).toEqual([]);
        expect(toggle.data.on).toBe(true);
        expect((await send(toggle, "bang", "BANG")).one.value).toBe(false);
    });
});

describe("Counter: counts what arrives", () => {
    test("it counts from one, and says the running count", async () => {
        const counter = nodeFor("counter");
        expect((await send(counter, "bang", "BANG")).one.value).toBe(1);
        expect((await send(counter, "bang", "BANG")).one.value).toBe(2);
        expect((await send(counter, "bang", "BANG")).one.value).toBe(3);
    });

    test("reset puts it back, and sends nothing while doing it", async () => {
        const counter = nodeFor("counter");
        await send(counter, "bang", "BANG");
        expect((await send(counter, "reset", true)).sent).toEqual([]);
        expect((await send(counter, "bang", "BANG")).one.value).toBe(1);
    });
});

describe("Gate: shut until something opens it", () => {
    test("shut by default, because the first run is the one that matters", async () => {
        const gate = nodeFor("gate");
        expect((await send(gate, "value", "dropped")).sent).toEqual([]);
    });

    test("open lets values through, and shuts again", async () => {
        const gate = nodeFor("gate");
        expect((await send(gate, "open", true)).sent).toEqual([]);
        expect(pairs(await send(gate, "value", "through"))).toEqual([["value", "through"]]);
        await send(gate, "open", false);
        expect((await send(gate, "value", "dropped")).sent).toEqual([]);
    });

    test("anything truthy opens it, anything falsy shuts it", async () => {
        const gate = nodeFor("gate");
        await send(gate, "open", "yes");
        expect((await send(gate, "value", 1)).sent).toHaveLength(1);
        await send(gate, "open", 0);
        expect((await send(gate, "value", 1)).sent).toEqual([]);
    });
});

describe("Route: out of the output its kind names", () => {
    test("it sends out of the output named by the property, and remembers which", async () => {
        const route = nodeFor("route", { outputs: ["a", "b", "unmatched"] });
        expect(pairs(await send(route, "value", { kind: "a", n: 1 }))).toEqual([["a", { kind: "a", n: 1 }]]);
        expect(route.data.last).toBe("a");
    });

    test("anything it has no output for goes out unmatched, rather than nowhere", async () => {
        const route = nodeFor("route", { outputs: ["a", "unmatched"] });
        expect(pairs(await send(route, "value", { kind: "zzz" }))).toEqual([["unmatched", { kind: "zzz" }]]);
        expect(route.data.last).toBe("unmatched");
    });

    test("it can be told to read a different property", async () => {
        const route = nodeFor("route", { outputs: ["bucket", "unmatched"], data: { on: "type" } });
        expect(pairs(await send(route, "value", { type: "bucket" }))).toEqual([["bucket", { type: "bucket" }]]);
    });

    test("a plain value routes on itself", async () => {
        const route = nodeFor("route", { outputs: ["go", "unmatched"] });
        expect(pairs(await send(route, "value", "go"))).toEqual([["go", "go"]]);
    });

    test("with nowhere to put it, it sends nothing rather than throwing", async () => {
        const route = nodeFor("route", { outputs: ["a"] });
        expect((await send(route, "value", { kind: "b" })).sent).toEqual([]);
    });
});

describe("Select: equal goes yes, everything else no", () => {
    test("it compares, sends, and remembers which way it went", async () => {
        const select = nodeFor("select", { data: { match: "go" } });
        expect(pairs(await send(select, "value", "go"))).toEqual([["yes", "go"]]);
        expect(select.data.last).toBe("yes");
        expect(pairs(await send(select, "value", "stop"))).toEqual([["no", "stop"]]);
        expect(select.data.last).toBe("no");
    });

    test("what to match can be set by the graph, and sends nothing by itself", async () => {
        const select = nodeFor("select");
        expect((await send(select, "match", { kind: "bucket" })).sent).toEqual([]);
        expect(pairs(await send(select, "value", { kind: "bucket" }))).toEqual([["yes", { kind: "bucket" }]]);
    });

    test("it compares what things are, not whether they are the same object", async () => {
        const select = nodeFor("select", { data: { match: { a: [1, 2] } } });
        expect((await send(select, "value", { a: [1, 2] })).one.field).toBe("yes");
        expect((await send(select, "value", { a: [2, 1] })).one.field).toBe("no");
    });
});

describe("If: a condition written on the node", () => {
    test("it tests, sends the value the way it went, and remembers which way", async () => {
        const branch = nodeFor("if", { data: { test: "value > 10" } });
        expect(pairs(await send(branch, "value", 42))).toEqual([["then", 42]]);
        expect(branch.data.last).toBe("then");
        expect(pairs(await send(branch, "value", 2))).toEqual([["else", 2]]);
        expect(branch.data.last).toBe("else");
    });

    test("the condition can read the value's parts, and the graph's state", async () => {
        const branch = nodeFor("if", { data: { test: "value.kind === 'bucket'" } });
        expect((await send(branch, "value", { kind: "bucket" })).one.field).toBe("then");
        const onState = nodeFor("if", { data: { test: "state.ready" } });
        expect((await send(onState, "value", 1, { state: { ready: true } })).one.field).toBe("then");
    });

    test("a condition that throws says which one, and sends nothing", async () => {
        const branch = nodeFor("if", { data: { test: "value.((" } });
        await expect(send(branch, "value", 1)).rejects.toThrow(/If: value\.\(\(/);
    });

    test("with no condition set it passes what is truthy", async () => {
        const branch = nodeFor("if");
        expect((await send(branch, "value", "something")).one.field).toBe("then");
        expect((await send(branch, "value", 0)).one.field).toBe("else");
    });
});

describe("Trigger: one in, many out, last first", () => {
    test("it sends to every output, in reverse of the order they are drawn", async () => {
        const trigger = nodeFor("trigger");
        expect(pairs(await send(trigger, "bang", "GO"))).toEqual([["third", "GO"], ["second", "GO"], ["first", "GO"]]);
    });

    test("it sends to whichever outputs are there", async () => {
        const trigger = nodeFor("trigger", { outputs: ["only"] });
        expect(pairs(await send(trigger, "bang", "GO"))).toEqual([["only", "GO"]]);
    });
});

describe("Unpack: each key out of the output named for it", () => {
    test("it sends each key to its own output, last first", async () => {
        const unpack = nodeFor("unpack", { outputs: ["a", "b"] });
        expect(pairs(await send(unpack, "value", { a: 1, b: 2 }))).toEqual([["b", 2], ["a", 1]]);
    });

    test("an array is taken apart by index", async () => {
        const unpack = nodeFor("unpack", { outputs: ["0", "1"] });
        expect(pairs(await send(unpack, "value", ["first", "second"]))).toEqual([["1", "second"], ["0", "first"]]);
    });

    test("keys with no output of their own go out rest, rather than being lost", async () => {
        const unpack = nodeFor("unpack", { outputs: ["a", "rest"] });
        const r = await send(unpack, "value", { a: 1, b: 2, c: 3 });
        expect(r.sent.find((s) => s.field === "rest").value).toEqual({ b: 2, c: 3 });
        expect(r.sent.find((s) => s.field === "a").value).toBe(1);
    });

    test("nothing goes out rest when there is nothing left over", async () => {
        const unpack = nodeFor("unpack", { outputs: ["a", "rest"] });
        expect(pairs(await send(unpack, "value", { a: 1 }))).toEqual([["a", 1]]);
    });

    test("a key that is not there sends nothing, rather than undefined", async () => {
        const unpack = nodeFor("unpack", { outputs: ["a", "b"] });
        expect(pairs(await send(unpack, "value", { a: 1 }))).toEqual([["a", 1]]);
    });

    test("a plain value arrives as `value`, so it is not silently dropped", async () => {
        const unpack = nodeFor("unpack", { outputs: ["value"] });
        expect(pairs(await send(unpack, "value", "alone"))).toEqual([["value", "alone"]]);
    });
});

describe("Iterate: each element, then how many", () => {
    test("it sends every element, in order, then the count", async () => {
        const iterate = nodeFor("iterate");
        expect(pairs(await send(iterate, "value", ["a", "b"]))).toEqual([["each", "a"], ["each", "b"], ["done", 2]]);
    });

    test("something that is not a list is one element", async () => {
        const iterate = nodeFor("iterate");
        expect(pairs(await send(iterate, "value", "alone"))).toEqual([["each", "alone"], ["done", 1]]);
    });

    test("an empty list sends no elements, and still says so", async () => {
        const iterate = nodeFor("iterate");
        expect(pairs(await send(iterate, "value", []))).toEqual([["done", 0]]);
    });
});

describe("Repeat: send a number of times, counting", () => {
    test("it sends as many times as it was told, saying where it is each time", async () => {
        const repeat = nodeFor("repeat", { data: { times: 3 } });
        const r = await send(repeat, "bang", "GO");
        expect(r.sent.filter((s) => s.field === "each").map((s) => s.value.index)).toEqual([0, 1, 2]);
        expect(r.one.value).toEqual({ index: 0, of: 3, value: "GO" });
        expect(r.sent[r.sent.length - 1]).toEqual({ field: "done", value: 3 });
    });

    test("how many can be set by the graph, and sends nothing by itself", async () => {
        const repeat = nodeFor("repeat");
        expect((await send(repeat, "times", 2)).sent).toEqual([]);
        expect((await send(repeat, "bang", "GO")).sent.filter((s) => s.field === "each")).toHaveLength(2);
    });

    test("none is none, and still says it is done", async () => {
        const repeat = nodeFor("repeat", { data: { times: 0 } });
        expect(pairs(await send(repeat, "bang", "GO"))).toEqual([["done", 0]]);
    });
});

describe("Delay: hold a value, then send it", () => {
    test("it sends what it was given, after the wait", async () => {
        const delay = nodeFor("delay", { data: { ms: 30 } });
        const started = Date.now();
        expect(pairs(await send(delay, "value", "late"))).toEqual([["value", "late"]]);
        expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    });

    test("how long can be set by the graph, and sends nothing by itself", async () => {
        const delay = nodeFor("delay");
        expect((await send(delay, "ms", 1)).sent).toEqual([]);
        expect(delay.data.ms).toBe(1);
        expect(pairs(await send(delay, "value", "soon"))).toEqual([["value", "soon"]]);
    });

    test("a cancelled execution stops it sending what it was holding", async () => {
        const delay = nodeFor("delay", { data: { ms: 5 } });
        const cancelled = { throwIfCancelled: () => { throw new Error("cancelled"); } };
        await expect(send(delay, "value", "never", { host: cancelled })).rejects.toThrow(/cancelled/);
    });
});

describe("Get: read a path, or say it is missing", () => {
    test("it reads the path and remembers what it found", async () => {
        const get = nodeFor("get", { data: { path: "stack.name" } });
        expect(pairs(await send(get, "value", { stack: { name: "pio-dev-uploads" } }))).toEqual([["value", "pio-dev-uploads"]]);
        expect(get.data.last).toBe("pio-dev-uploads");
    });

    test("a path that is not there is a branch, not a surprise later", async () => {
        const get = nodeFor("get", { data: { path: "stack.name" } });
        const r = await send(get, "value", { stack: {} });
        expect(r.one.field).toBe("missing");
        expect(r.one.value).toEqual({ path: "stack.name", value: { stack: {} } });
        expect(get.data.last).toBe("missing");
    });

    test("it reads through arrays by index, and survives nothing in the middle", async () => {
        const get = nodeFor("get", { data: { path: "a.0.b" } });
        expect((await send(get, "value", { a: [{ b: "found" }] })).one.value).toBe("found");
        expect((await send(get, "value", { a: null })).one.field).toBe("missing");
    });

    test("the path can be set by the graph", async () => {
        const get = nodeFor("get");
        expect((await send(get, "path", "a")).sent).toEqual([]);
        expect((await send(get, "value", { a: 1 })).one.value).toBe(1);
    });
});

describe("Format: a string from a pattern", () => {
    test("it fills the pattern from what arrived, and remembers what it made", async () => {
        const format = nodeFor("format", { data: { pattern: "${value.name} in ${value.region}" } });
        expect(pairs(await send(format, "value", { name: "pio-dev-uploads", region: "us-west-1" })))
            .toEqual([["value", "pio-dev-uploads in us-west-1"]]);
        expect(format.data.last).toBe("pio-dev-uploads in us-west-1");
    });

    test("a part that is missing leaves a gap rather than the word undefined", async () => {
        const format = nodeFor("format", { data: { pattern: "[${value.nope}]" } });
        expect((await send(format, "value", {})).one.value).toBe("[]");
    });

    test("a part that will not evaluate is left as it was written", async () => {
        const format = nodeFor("format", { data: { pattern: "${value.((}" } });
        expect((await send(format, "value", {})).one.value).toBe("${value.((}");
    });

    test("with no pattern set it says what arrived", async () => {
        const format = nodeFor("format");
        expect((await send(format, "value", "plain")).one.value).toBe("plain");
    });
});

describe("Log: see what passes, without stopping it", () => {
    test("it records what went by and passes it on unchanged", async () => {
        const log = nodeFor("log", { data: { label: "on its way" } });
        const r = await send(log, "value", { n: 1 });
        expect(pairs(r)).toEqual([["value", { n: 1 }]]);
        expect(r.emitted).toEqual([{ kind: "log", payload: { label: "on its way", value: { n: 1 } } }]);
        expect(log.data.last).toBe('{"n":1}');
    });

    test("with no label of its own it uses the node's name", async () => {
        const log = nodeFor("log");
        const r = await send(log, "value", "x");
        expect(r.emitted[0].payload.label).toBe("Log");
    });
});

describe("Loadbang: sends once", () => {
    test("it sends BANG, or whatever it was given", async () => {
        const loadbang = nodeFor("loadbang");
        expect(pairs(await send(loadbang, "bang", undefined))).toEqual([["value", "BANG"]]);
        expect(pairs(await send(loadbang, "bang", "GO"))).toEqual([["value", "GO"]]);
    });
});
