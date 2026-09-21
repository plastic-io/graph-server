import { parseCapabilities } from "../runtime/capabilities";

/**
 * Gates (plan §8.1.8, PB-107): the checks that stand between a change and the
 * people using the application, sized to what the change could do.
 *
 * A gate refuses; it does not fix.  Each one says what it found in the words
 * of the thing it checked, so the answer to "why can I not publish this" is
 * the finding itself rather than a code.
 */

/** What a node's code reaches for, read from the code rather than from what it claims. */
const HOST_CALLS: { pattern: RegExp; kind: string; what: string }[] = [
    { pattern: /host\s*\.\s*fetch\s*\(/, kind: "net:https", what: "host.fetch" },
    { pattern: /host\s*\.\s*kv\s*\./, kind: "storage:kv", what: "host.kv" },
    { pattern: /host\s*\.\s*secret\s*\(/, kind: "secret", what: "host.secret" },
];

export interface GateFinding {
    gate: string;
    nodeId?: string;
    says: string;
}

/**
 * The publication gate's static half: a node that reaches for an effect must
 * say so in its capabilities.  This reads the code, so a node that asks for
 * something it never declared cannot be published and then surprise whoever
 * imports it.
 */
export function undeclaredEffects(graph: any, nodeId?: string): GateFinding[] {
    const findings: GateFinding[] = [];
    const nodes = ((graph && graph.nodes) || []).filter((n: any) => !nodeId || n.id === nodeId);
    nodes.forEach((node: any) => {
        const code = String((node.template && node.template.set) || "");
        if (!code) {
            return;
        }
        const declared = parseCapabilities((node.properties || {}).capabilities).map((c) => c.kind);
        HOST_CALLS.forEach(({ pattern, kind, what }) => {
            if (pattern.test(code) && !declared.includes(kind)) {
                findings.push({
                    gate: "publication",
                    nodeId: node.id,
                    says: `${(node.properties && node.properties.name) || node.id} calls ${what} without declaring ${kind}; whoever imports it would be surprised by what it does`,
                });
            }
        });
    });
    return findings;
}

/** Which namespaces a change touches decide whether the heavier gates apply at all. */
export const RISKY_NAMESPACES = ["code", "capabilities", "placement", "containment", "iac"];

export function touchesRisk(namespaces: string[] | undefined): boolean {
    return (namespaces || []).some((n) => RISKY_NAMESPACES.includes(n));
}

/** A test run, or a journey run, reduced to what a gate needs to say. */
export function fromRuns(gate: string, runs: { state: string; description?: string; intent?: string; failures?: string[]; reason?: string }[]): GateFinding[] {
    return runs.filter((r) => r.state !== "passed").map((r) => ({
        gate,
        says: `${r.description || r.intent || "a check"} ${r.state === "unresolvable" ? "could not be run" : "failed"}: ${(r.failures && r.failures[0]) || r.reason || "no reason given"}`,
    }));
}
