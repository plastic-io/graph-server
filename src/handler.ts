// Interim hardening (2026-09-20): the client-callable fan-out routes (sendToChannel,
// sendToConnection, broadcast), the connection-enumeration routes (listSubscribers,
// listSubscriptions) and the deprecated addEvent write path are no longer exported.
// The BroadcastService/EventSourceService methods remain for internal use and tests.
import EventSourceService from './eventSourceService';
import BroadcastService from './broadcastService';
import CrdtService from './crdtService';
import { RevisionService } from './revisions/service';
import GraphService, {panic as _panic} from './graphService';
import { withPrincipal } from './auth/principal';
import { authorize as _authorize } from './auth/authorizer';
import { protectedResourceMetadataHandler } from './auth/metadata';
const broadcastService = new BroadcastService();
const eventSourceService = new EventSourceService();
const crdtService = new CrdtService();
// the CRDT service the revision routes use shares its admission gate with the event source service's integrity hook
crdtService.admission.integrity = (after, diff) => eventSourceService.components.integrityCheck(after, diff);
const revisionService = new RevisionService(crdtService.store, crdtService.admission, {
    fanOut: (graphId, update) => crdtService.fanOutUpdate(graphId, update),
    notify: (graphId, event) => crdtService.notifyGraph(graphId, event),
});
const graphService = new GraphService();
function _connect(event: any, context: any, callback: (err: any, response: any) => void) {
    broadcastService.connect(event, context, callback);
}
function _disconnect(event: any, context: any, callback: (err: any, response: any) => void) {
    broadcastService.disconnect(event, context, callback);
}
function _subscribe(event: any, context: any, callback: (err: any, response: any) => void) {
    broadcastService.subscribe(event, context, callback);
}
function _unsubscribe(event: any, context: any, callback: (err: any, response: any) => void) {
    broadcastService.unsubscribe(event, context, callback);
}
function _getGraph(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.getGraph(event, context, callback);
}
function _getToc(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.getToc(event, context, callback);
}
function _getEvents(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.getEvents(event, context, callback);
}
function _deleteGraph(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.deleteGraph(event, context, callback);
}
function _deleteGraphWs(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.deleteGraphWs(event, context, callback);
}
function _undeleteGraph(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.undeleteGraph(event, context, callback);
}
function _undeleteGraphWs(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.undeleteGraphWs(event, context, callback);
}
function _listDeletedGraphs(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.listDeletedGraphs(event, context, callback);
}
function _getTocState(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.getTocState(event, context, callback);
}
function _rebuildToc(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.rebuildToc(event, context, callback);
}
function _getGraphWs(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.getGraphWs(event, context, callback);
}
function _publishGraphWs(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.publishGraphWs(event, context, callback);
}
function _publishNodeWs(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.publishNodeWs(event, context, callback);
}
function _defaultRoute(event: any, context: any, callback: (err: any, response: any) => void) {
    graphService.init(event, context).then((res) => {
        console.error("Handler: complete");
        callback(null, { statusCode: 200, body: "ok", });
    }).catch((err) => {
        console.error("Handler: Caught a top level router error", err);
        callback(null, { statusCode: 200, body: "ok", });
    });
}
function _panicRoute(event: any, context: any, callback: (err: any, response: any) => void) {
    _panic(event, context, callback);
}
function _getArtifact(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.getArtifact(event, context, callback);
}
function _publish(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.components.publishRoute(event, context, callback);
}
function _componentsList(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.components.listRoute(event, context, callback);
}
function _componentGet(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.components.getRoute(event, context, callback);
}
/* ---- collaborative editing ---- */
function _crdtSync(event: any, context: any, callback: (err: any, response: any) => void) {
    crdtService.sync(event, context, callback);
}
function _crdtState(event: any, context: any, callback: (err: any, response: any) => void) {
    crdtService.getState(event, context, callback);
}
function _crdtStateAt(event: any, context: any, callback: (err: any, response: any) => void) {
    crdtService.getStateAt(event, context, callback);
}
function _crdtHistory(event: any, context: any, callback: (err: any, response: any) => void) {
    crdtService.getHistory(event, context, callback);
}
function _crdtUpdate(event: any, context: any, callback: (err: any, response: any) => void) {
    crdtService.postUpdate(event, context, callback);
}
function _crdtCheckpoint(event: any, context: any, callback: (err: any, response: any) => void) {
    crdtService.checkpoint(event, context, callback);
}
function _revisionsList(event: any, context: any, callback: (err: any, response: any) => void) {
    revisionService.listRoute(event, context, callback);
}
function _revisionsCut(event: any, context: any, callback: (err: any, response: any) => void) {
    revisionService.cutRoute(event, context, callback);
}
function _revisionGet(event: any, context: any, callback: (err: any, response: any) => void) {
    revisionService.getRoute(event, context, callback);
}
function _revisionActivate(event: any, context: any, callback: (err: any, response: any) => void) {
    revisionService.activateRoute(event, context, callback);
}
function _revisionRestore(event: any, context: any, callback: (err: any, response: any) => void) {
    revisionService.restoreRoute(event, context, callback);
}
// Every route runs with `event.principal` established on the server side (auth/principal.ts).
const connect = withPrincipal(broadcastService.store, _connect);
const subscribe = withPrincipal(broadcastService.store, _subscribe);
const unsubscribe = withPrincipal(broadcastService.store, _unsubscribe);
const getGraph = withPrincipal(broadcastService.store, _getGraph);
const getToc = withPrincipal(broadcastService.store, _getToc);
const getEvents = withPrincipal(broadcastService.store, _getEvents);
const deleteGraph = withPrincipal(broadcastService.store, _deleteGraph);
const deleteGraphWs = withPrincipal(broadcastService.store, _deleteGraphWs);
const undeleteGraph = withPrincipal(broadcastService.store, _undeleteGraph);
const undeleteGraphWs = withPrincipal(broadcastService.store, _undeleteGraphWs);
const listDeletedGraphs = withPrincipal(broadcastService.store, _listDeletedGraphs);
const getTocState = withPrincipal(broadcastService.store, _getTocState);
const rebuildToc = withPrincipal(broadcastService.store, _rebuildToc);
const getGraphWs = withPrincipal(broadcastService.store, _getGraphWs);
const publishGraphWs = withPrincipal(broadcastService.store, _publishGraphWs);
const publishNodeWs = withPrincipal(broadcastService.store, _publishNodeWs);
const defaultRoute = withPrincipal(broadcastService.store, _defaultRoute);
const getArtifact = withPrincipal(broadcastService.store, _getArtifact);
const publish = withPrincipal(broadcastService.store, _publish);
const componentsList = withPrincipal(broadcastService.store, _componentsList);
const componentGet = withPrincipal(broadcastService.store, _componentGet);
const crdtSync = withPrincipal(broadcastService.store, _crdtSync);
const crdtState = withPrincipal(broadcastService.store, _crdtState);
const crdtStateAt = withPrincipal(broadcastService.store, _crdtStateAt);
const crdtHistory = withPrincipal(broadcastService.store, _crdtHistory);
const crdtUpdate = withPrincipal(broadcastService.store, _crdtUpdate);
const crdtCheckpoint = withPrincipal(broadcastService.store, _crdtCheckpoint);
const revisionsList = withPrincipal(broadcastService.store, _revisionsList);
const revisionsCut = withPrincipal(broadcastService.store, _revisionsCut);
const revisionGet = withPrincipal(broadcastService.store, _revisionGet);
const revisionActivate = withPrincipal(broadcastService.store, _revisionActivate);
const revisionRestore = withPrincipal(broadcastService.store, _revisionRestore);
const panic = withPrincipal(broadcastService.store, _panicRoute);
// $disconnect must clean up even when the connection record is already gone.
const disconnect = withPrincipal(broadcastService.store, _disconnect, { required: false });
/** RFC 9728 metadata: which audience and authorization server this API uses (public). */
const protectedResourceMetadata = protectedResourceMetadataHandler;
/** REQUEST authorizer for the REST API and the WebSocket $connect route. */
function authorize(event: any) {
    return _authorize(event);
}

export {
    authorize,
    protectedResourceMetadata,
    revisionsList,
    revisionsCut,
    revisionGet,
    revisionActivate,
    revisionRestore,
    crdtSync,
    crdtState,
    crdtStateAt,
    crdtHistory,
    crdtUpdate,
    crdtCheckpoint,
    getArtifact,
    publish,
    componentsList,
    componentGet,
    publishGraphWs,
    publishNodeWs,
    connect,
    disconnect,
    subscribe,
    unsubscribe,
    getGraphWs,
    getGraph,
    getToc,
    getEvents,
    deleteGraph,
    deleteGraphWs,
    undeleteGraph,
    undeleteGraphWs,
    listDeletedGraphs,
    getTocState,
    rebuildToc,
    defaultRoute,
    panic,
};
