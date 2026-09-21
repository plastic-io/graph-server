// eslint-disable-next-line @typescript-eslint/no-var-requires
const Ajv = require("ajv").default || require("ajv");

/**
 * Contract validation at edges (plan §4.3.5, PB-045): a port that declares a
 * JSON Schema is checked when a value enters (`onInput`) or leaves
 * (`onOutput`) its node.  The scheduler turns a thrown error into a
 * `CONTRACT_VIOLATION` warning (mode `warn`) or drops the delivery (mode
 * `reject`); the recorder turns either into a `contract.violation` observation.
 */
const ajv = new Ajv({ allErrors: false, strict: false });
const compiled = new Map<string, any>();

function validatorFor(schema: any) {
    const key = JSON.stringify(schema);
    let v = compiled.get(key);
    if (!v) {
        v = ajv.compile(schema);
        compiled.set(key, v);
    }
    return v;
}

function portOf(node: any, direction: "inputs" | "outputs", field: string): any {
    return ((node && node.properties && node.properties[direction]) || []).find((p: any) => p && p.name === field);
}

export function makeContractHooks() {
    const check = (direction: "inputs" | "outputs") => ({ node, field, value }: any) => {
        const port = portOf(node, direction, field);
        if (!port || !port.schema || typeof port.schema !== "object" || !Object.keys(port.schema).length) return;
        const validate = validatorFor(port.schema);
        if (!validate(value)) {
            const first = (validate.errors || [])[0];
            throw new Error(`${direction === "inputs" ? "input" : "output"} ${field} of ${node.id}: ${first ? (first.instancePath || "value") + " " + first.message : "does not match its schema"}`);
        }
    };
    return { onInput: check("inputs"), onOutput: check("outputs") };
}

/** Conservative assignability: same declared type, or either side untyped/Object. */
export function assignable(from: any, to: any): boolean {
    const a = from && from.type ? String(from.type) : "Object";
    const b = to && to.type ? String(to.type) : "Object";
    return a === b || a === "Object" || b === "Object";
}
