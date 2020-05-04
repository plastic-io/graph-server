import EventSourceService from './eventSourceService';
import BroadcastService from './broadcastService';
const broadcastService = new BroadcastService();
const eventSourceService = new EventSourceService();
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
export {
    connect,
    disconnect,
    sendToChannel,
    sendToConnection,
    subscribe,
    unsubscribe,
    addEvent,
    getGraph,
};
