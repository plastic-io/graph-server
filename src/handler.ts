import EventSourceService from './eventSourceService';
import BroadcastService from './broadcastService';
import GraphService from './graphService';
const broadcastService = new BroadcastService();
const eventSourceService = new EventSourceService();
const graphService = new GraphService();
function connect(event: any, context: any, callback: (err: any, response: any) => void) {
    broadcastService.connect(event, context, callback);
}
function disconnect(event: any, context: any, callback: (err: any, response: any) => void) {
    broadcastService.disconnect(event, context, callback);
}
function subscribe(event: any, context: any, callback: (err: any, response: any) => void) {
    broadcastService.subscribe(event, context, callback);
}
function unsubscribe(event: any, context: any, callback: (err: any, response: any) => void) {
    broadcastService.unsubscribe(event, context, callback);
}
function sendToChannel(event: any, context: any, callback: (err: any, response: any) => void) {
    broadcastService.sendToChannel(event, context, callback);
}
function sendToConnection(event: any, context: any, callback: (err: any, response: any) => void) {
    broadcastService.sendToConnection(event, context, callback);
}
function addEvent(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.addEvent(event, context, callback);
}
function getGraph(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.getGraph(event, context, callback);
}
function getToc(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.getToc(event, context, callback);
}
function getEvents(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.getEvents(event, context, callback);
}
function deleteGraph(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.deleteGraph(event, context, callback);
}
function deleteGraphWs(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.deleteGraphWs(event, context, callback);
}
function listSubscribers(event: any, context: any, callback: (err: any, response: any) => void) {
    broadcastService.listSubscribers(event, context, callback);
}
function listSubscriptions(event: any, context: any, callback: (err: any, response: any) => void) {
    broadcastService.listSubscriptions(event, context, callback);
}
function getGraphWs(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.getGraphWs(event, context, callback);
}
function publishGraphWs(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.publishGraphWs(event, context, callback);
}
function publishNodeWs(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.publishNodeWs(event, context, callback);
}
function defaultRoute(event: any, context: any, callback: (err: any, response: any) => void) {
    graphService.router(event, context, callback);
}
function getArtifact(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.getArtifact(event, context, callback);
}
export {
    getArtifact,
    publishGraphWs,
    publishNodeWs,
    connect,
    disconnect,
    sendToChannel,
    sendToConnection,
    subscribe,
    unsubscribe,
    listSubscribers,
    listSubscriptions,
    getGraphWs,
    addEvent,
    getGraph,
    getToc,
    getEvents,
    deleteGraph,
    deleteGraphWs,
    defaultRoute,
};
