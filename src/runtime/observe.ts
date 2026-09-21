/**
 * The observation recorder is shared with the editor (plan §4.5.3): one shape
 * of observation whichever domain produced it.  This module is the server's
 * import path, and fixes the domain it records.
 */
export {
    ObservationRecorder,
    capturePayload,
    describeValue,
    fingerprint,
    byteLength,
} from "@plastic-io/graph-crdt";
export type { Observation, ObservationKind, ObservationDomain, ExecutionRecord, RecorderOptions } from "@plastic-io/graph-crdt";
