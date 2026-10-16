import {randomUUID} from 'crypto';
import {isolationDiagnostics} from './isolate';

const instanceId=randomUUID(),initializedAt=new Date().toISOString();
let executionCount=0;
/** Host-authored metadata, not graph input. An instance's first graph execution
 * does not necessarily coincide with its first Lambda request. */
export function executionRuntime(){
    return {schemaVersion:1,instanceId,initializedAt,executionIndex:++executionCount,
        functionName:process.env.AWS_LAMBDA_FUNCTION_NAME||null,
        functionVersion:process.env.AWS_LAMBDA_FUNCTION_VERSION||null,
        logStream:process.env.AWS_LAMBDA_LOG_STREAM_NAME||null,
        nodeVersion:process.version,nodeAbi:process.versions.modules,platform:process.platform,architecture:process.arch,
        containment:isolationDiagnostics()};
}
export type RuntimeEvidence=ReturnType<typeof executionRuntime>;
