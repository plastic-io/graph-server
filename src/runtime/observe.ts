/**
 * The observation recorder is shared with the editor (plan §4.5.3): one shape
 * of observation whichever domain produced it.  This module is the server's
 * import path, and fixes the domain it records.
 */
export {
    capturePayload,
    describeValue,
    fingerprint,
    byteLength,
} from "@plastic-io/graph-crdt";
import {ObservationRecorder as SharedRecorder} from '@plastic-io/graph-crdt';
import {redactCredentials} from '../security/credentials';
export class ObservationRecorder extends SharedRecorder {
    record(partial:Parameters<SharedRecorder['record']>[0]) {return super.record(redactCredentials(partial));}
}
export type { Observation, ObservationKind, ObservationDomain, ExecutionRecord, RecorderOptions } from "@plastic-io/graph-crdt";
