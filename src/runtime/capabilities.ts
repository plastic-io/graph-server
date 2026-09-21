/**
 * Capabilities live in the package both domains share (plan §4.5.2), so that a
 * grant means the same thing in the browser worker and in this runtime.  This
 * module is the server's import path for them.
 */
export {
    CAPABILITY_KINDS,
    PRIVILEGED_KINDS,
    CapabilityDenied,
    parseCapability,
    parseCapabilities,
    scopeMatches,
    effectiveCapabilities,
    assertCapability,
} from "@plastic-io/graph-crdt";
export type { CapabilityKind, CapabilityRequirement, EffectiveCapabilities } from "@plastic-io/graph-crdt";
