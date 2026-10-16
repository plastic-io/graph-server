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
import type {RuntimeEvidence} from './provenance';
export class ObservationRecorder extends SharedRecorder {
    constructor(options:ConstructorParameters<typeof SharedRecorder>[0],private readonly runtime?:RuntimeEvidence){super(options);}
    record(partial:Parameters<SharedRecorder['record']>[0]) {
        if(partial.kind==='exec.begin'&&this.runtime)partial={...partial,payload:{...partial.payload,runtime:this.runtime}};
        return super.record(redactCredentials(partial));
    }
}
export type { Observation, ObservationKind, ObservationDomain, ExecutionRecord, RecorderOptions } from "@plastic-io/graph-crdt";
