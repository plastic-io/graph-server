/**
 * Contained server execution (plan §4.6.3, D-4, PB-062/063; spike S-1).
 *
 * A node marked for containment runs inside its own V8 isolate with nothing in
 * scope but what this module puts there.  `require`, `process`, `fetch` and the
 * Lambda's AWS credentials are simply absent from that realm, so the only way
 * out is the `host` binding, which is capability checked and observed like any
 * other effect.
 *
 * Two rules from the spike are load bearing.  An isolate is created for one
 * node invocation and never reused.  After a timeout or a memory-limit
 * rejection the isolate is disposed immediately and never called into again,
 * because a wedged isolate answers no further calls.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
let ivm: any = null;
let loadError: Error | null = null;
try {
    // Resolved at runtime from the Lambda layer; webpack must not bundle a .node binary.
    ivm = eval("require")("isolated-vm");
} catch (err: any) {
    loadError = err;
}

export const isolationAvailable = () => !!ivm;
export const isolationLoadError = () => loadError;

export interface IsolateLimits {
    /** Wall clock for one node invocation, in milliseconds. */
    timeoutMs: number;
    /** Heap ceiling for the isolate, in megabytes (minimum 8 in V8). */
    memoryMb: number;
}

export interface IsolateRunRequest {
    code: string;
    limits: IsolateLimits;
    /** What the node sees; everything crosses the boundary as JSON. */
    inputs: {
        value: any;
        state: any;
        data: any;
        properties: any;
        node: any;
        field: string;
        graph: any;
        cache: any;
        capabilities: any;
    };
    /** Assign to an output edge (routes immediately, exactly as in-process assignment does). */
    setEdge: (field: string, value: any) => void;
    /** Write into the shared execution state at a path. */
    setState: (path: string[], value: any) => void;
    /** Write into the node's data at a path. */
    setData: (path: string[], value: any) => void;
    /** Call a member of the host binding: `fetch`, `kv.get`, `secret.header`, `emit`, … */
    hostCall: (member: string, args: any[]) => Promise<any>;
    log: (level: string, args: any[]) => void;
}

export interface IsolateOutcome {
    result: any;
    /** What stopped the node, when something did. */
    error?: { message: string; kind: "timeout" | "memory" | "error" };
    cpuMs: number;
    wallMs: number;
}

/**
 * The script that runs inside the isolate.  It rebuilds the 2.0 parameter list
 * out of injected copies and callbacks, so ordinary node code reads the same,
 * and it keeps every host boundary explicit: an edge assignment is a call, a
 * state write is a call, a host effect is a call.
 */
const BOOTSTRAP = `
(function () {
  const json = (v) => { try { return JSON.stringify(v === undefined ? null : v); } catch (err) { throw new Error("a value that cannot cross the isolate boundary was written: " + err.message); } };
  const parse = (s) => (s === undefined || s === null ? undefined : JSON.parse(s));

  // A write anywhere in this tree is reported by path, so the host applies it
  // to the real object rather than receiving a replacement copy.
  function tracked(target, path, report) {
    if (target === null || typeof target !== "object") {
      return target;
    }
    return new Proxy(target, {
      get(obj, key) {
        if (typeof key === "symbol") { return obj[key]; }
        const value = obj[key];
        return (value !== null && typeof value === "object") ? tracked(value, path.concat(String(key)), report) : value;
      },
      set(obj, key, value) {
        obj[key] = value;
        report(path.concat(String(key)), value);
        return true;
      },
      deleteProperty(obj, key) {
        delete obj[key];
        report(path.concat(String(key)), undefined);
        return true;
      },
    });
  }

  // The declared outputs exist as own properties before anything is written,
  // because 2.0 node code asks edges.hasOwnProperty(field) to decide where to
  // send a value.
  const edgeBase = {};
  ((parse(__inputs).node.properties || {}).outputs || []).forEach((o) => { edgeBase[o.name] = undefined; });
  const edges = new Proxy(edgeBase, {
    set(obj, key, value) {
      obj[key] = value;
      __setEdge.applySync(undefined, [String(key), json(value)]);
      return true;
    },
  });

  const state = tracked(parse(__inputs).state || {}, [], (path, value) => __setState.applySync(undefined, [json(path), json(value)]));
  const input = parse(__inputs);
  const data = tracked(input.data === null || typeof input.data !== "object" ? {value: input.data} : input.data, [], (path, value) => __setData.applySync(undefined, [json(path), json(value)]));

  const callHost = (member) => (...args) => __hostCall.apply(undefined, [member, json(args)], {result: {promise: true, copy: true}}).then(parse);
  /**
   * A Response cannot cross the boundary, so the host sends what it read and
   * this rebuilds the small part of the interface node code uses.
   */
  const response = (r) => ({
    ok: r.ok, status: r.status, statusText: r.statusText, url: r.url, headers: r.headers, truncated: r.truncated,
    text: async () => r.body,
    json: async () => JSON.parse(r.body),
  });
  const host = {
    fetch: (url, init) => callHost("fetch")(url, init).then(response),
    kv: {
      get: (key) => callHost("kv.get")(key),
      put: (key, value) => callHost("kv.put")(key, value),
      del: (key) => callHost("kv.del")(key),
    },
    secret: (ref) => ({
      openai: () => { throw new Error("a client cannot cross the isolate boundary; use host.secret(ref).header() with host.fetch"); },
      header: (name, prefix) => callHost("secret.header")(ref, name, prefix),
    }),
    emit: (kind, value) => { __hostCall.applySync(undefined, ["emit", json([kind, value])]); },
    capabilities: input.capabilities,
    domain: "server",
    contained: true,
  };
  const console = {
    log: (...a) => __log.applySync(undefined, ["log", json(a)]),
    info: (...a) => __log.applySync(undefined, ["info", json(a)]),
    warn: (...a) => __log.applySync(undefined, ["warn", json(a)]),
    error: (...a) => __log.applySync(undefined, ["error", json(a)]),
    debug: (...a) => __log.applySync(undefined, ["debug", json(a)]),
  };
  const scheduler = {
    url: () => { throw new Error("a contained node cannot start another execution; connect an edge instead"); },
  };
  const require = () => { throw new Error("require is not available to a contained node; declare a capability and use host"); };

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("scheduler", "graph", "cache", "node", "field", "state", "value", "edges", "data", "properties", "require", "host", "console", __code);
  return fn.call(undefined, scheduler, input.graph, input.cache || {}, input.node, input.field, state, input.value, edges, data, input.properties, require, host, console)
    .then((result) => json(result === undefined ? null : result));
})()
`;

/** Run one node's code in its own isolate.  Never reuses or revisits a stopped isolate. */
export async function runInIsolate(req: IsolateRunRequest): Promise<IsolateOutcome> {
    if (!ivm) {
        throw new Error(`containment is not available in this runtime: ${loadError ? loadError.message : "isolated-vm is not installed"}`);
    }
    const startedAt = Date.now();
    const isolate = new ivm.Isolate({ memoryLimit: Math.max(8, req.limits.memoryMb) });
    let disposed = false;
    /** The spike's rule: once stopped, dispose and never call in again. */
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        try { isolate.dispose(); } catch (err) { /* already gone */ }
    };
    // The escalation for a host call that blocks outside the isolate, where the
    // script timeout cannot reach (spike S-1).
    const watchdog = setTimeout(dispose, req.limits.timeoutMs + 1000);
    try {
        const context = await isolate.createContext();
        const jail = context.global;
        await jail.set("global", jail.derefInto());
        await jail.set("__code", req.code);
        await jail.set("__inputs", JSON.stringify({
            value: req.inputs.value === undefined ? null : req.inputs.value,
            state: req.inputs.state || {},
            data: req.inputs.data === undefined ? null : req.inputs.data,
            properties: req.inputs.properties || {},
            node: req.inputs.node,
            field: req.inputs.field,
            graph: req.inputs.graph,
            cache: req.inputs.cache || {},
            capabilities: req.inputs.capabilities,
        }));
        await jail.set("__setEdge", new ivm.Reference((field: string, json: string) => {
            req.setEdge(field, JSON.parse(json));
        }));
        await jail.set("__setState", new ivm.Reference((path: string, json: string) => {
            req.setState(JSON.parse(path), JSON.parse(json));
        }));
        await jail.set("__setData", new ivm.Reference((path: string, json: string) => {
            req.setData(JSON.parse(path), JSON.parse(json));
        }));
        await jail.set("__log", new ivm.Reference((level: string, json: string) => {
            req.log(level, JSON.parse(json));
        }));
        await jail.set("__hostCall", new ivm.Reference(async (member: string, json: string) => {
            const result = await req.hostCall(member, JSON.parse(json));
            return JSON.stringify(result === undefined ? null : result);
        }));
        const script = await isolate.compileScript(BOOTSTRAP);
        const resultJson: string = await script.run(context, { timeout: req.limits.timeoutMs, promise: true, copy: true });
        const outcome: IsolateOutcome = {
            result: resultJson === undefined || resultJson === null ? undefined : JSON.parse(resultJson),
            cpuMs: Number(isolate.cpuTime ? isolate.cpuTime / BigInt(1000000) : 0),
            wallMs: Date.now() - startedAt,
        };
        clearTimeout(watchdog);
        dispose();
        return outcome;
    } catch (err: any) {
        clearTimeout(watchdog);
        const message = String((err && err.message) || err);
        const kind: IsolateOutcome["error"] extends undefined ? never : "timeout" | "memory" | "error" =
            /timed out/i.test(message) ? "timeout" : /memory limit/i.test(message) ? "memory" : "error";
        // cpuTime is a plain property, so it is safe to read; anything that
        // calls into the isolate is not, and is not read here.
        const cpuMs = (() => { try { return Number(isolate.cpuTime / BigInt(1000000)); } catch (e) { return 0; } })();
        dispose();
        return { result: undefined, error: { message, kind }, cpuMs, wallMs: Date.now() - startedAt };
    }
}
