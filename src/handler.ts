// Interim hardening (2026-09-20): the client-callable fan-out routes (sendToChannel,
// sendToConnection, broadcast), the connection-enumeration routes (listSubscribers,
// listSubscriptions) and the deprecated addEvent write path are no longer exported.
// The BroadcastService/EventSourceService methods remain for internal use and tests.
import EventSourceService from './eventSourceService';
import BroadcastService from './broadcastService';
import CrdtService from './crdtService';
import { RevisionService } from './revisions/service';
import { makeMcpHandler } from './mcp/handler';
import { decide, Authority } from './policy/decide';
import GraphService, {panic as _panic} from './graphService';
import { withPrincipal } from './auth/principal';
import { ExecutionRunner } from './runtime/executor';
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
// The REST routes have their own revision service, and a gate that only one of
// them knows about is not a gate: what refuses over the protocol has to refuse
// here too (plan §8.1.8).
revisionService.gate = (graphId, revisionId, projection) => eventSourceService.revisions.gate
    ? eventSourceService.revisions.gate(graphId, revisionId, projection)
    : Promise.resolve([]);
const graphService = new GraphService();
/**
 * Running a graph for an agent (plan PB-083 `graph.invoke`).  It is the same
 * runner the HTTP route uses, with the agent as the principal, so what an agent
 * can reach is exactly what its delegation allows.
 */
async function invokeForAgent(graphId: string, principal: any, request: { nodeUrl: string; field?: string; value?: any; budget?: any }) {
    const graph: any = await eventSourceService.crdtStore.projectGraph(graphId).catch(() => null);
    if (!graph || !Array.isArray(graph.nodes)) {
        return { error: `no graph ${graphId}`, code: "NOT_FOUND" };
    }
    const node = graph.nodes.find((n: any) => n.url === request.nodeUrl || n.id === request.nodeUrl);
    if (!node) {
        return { error: `no node ${request.nodeUrl} in ${graphId}`, code: "NOT_FOUND" };
    }
    const active: any = await eventSourceService.crdtStore.activeRevision(graphId).catch(() => null);
    const runner = new ExecutionRunner(eventSourceService.crdtStore.store as any, {
        live: (observation) => { broadcastService._sendToChannel("graph-notify-" + graphId, { ...observation, eventType: "observation" }, () => undefined); },
    });
    const summary = await runner.run({
        graph,
        nodeUrl: node.url,
        field: request.field || ((node.properties && node.properties.inputs && node.properties.inputs[0] && node.properties.inputs[0].name) || "in"),
        value: request.value,
        principal: principal ? { sub: principal.sub, kind: principal.kind, tenant: principal.tenant } : null,
        revisionId: active && active.revisionId ? active.revisionId : "live",
        budget: { wallMs: 25000, hops: 10000, fanOut: 1000, depth: 64, ...(request.budget || {}) },
        defaultContainment: process.env.DEFAULT_CONTAINMENT === "isolate" ? "isolate" : "worker",
        deliver: async (delivery: any) => {
            // parked before it is broadcast: handing a delivery to nobody must
            // not look like handing it to someone (plan §4.8.2, PB-072)
            await eventSourceService.parking.park(graphId, delivery, graph.properties && graph.properties.deliveryTtlMs).catch((err: any) => console.error("Cannot park a delivery.", err));
            broadcastService._sendToChannel("graph-notify-" + graphId, { ...delivery, eventType: "edge.deliver" }, () => undefined);
        },
    } as any);
    return { summary };
}

/** Ask a running execution to stop; it notices at its next hop (plan PB-065). */
async function cancelExecution(graphId: string, principal: any, executionId: string, reason: string) {
    const record: any = await new Promise((resolve) => eventSourceService.crdtStore.store.get(ExecutionRunner.executionKey(executionId), (err: any, data: any) => resolve(err ? null : data)));
    if (record && record.graphId && record.graphId !== graphId) {
        return { error: "that execution belongs to another graph", code: "NOT_FOUND" };
    }
    if (record && record.endedAt) {
        return { executionId, alreadyFinished: true, state: record.state };
    }
    await new Promise<void>((resolve, reject) => eventSourceService.crdtStore.store.set(ExecutionRunner.cancelKey(executionId), {
        at: new Date().toISOString(), by: principal ? principal.sub : null, reason,
    }, {}, (err: any) => (err ? reject(err) : resolve())));
    return { executionId, requested: true, reason };
}

const mcp = makeMcpHandler({
    crdtStore: eventSourceService.crdtStore,
    tocStore: eventSourceService.tocStore,
    admission: eventSourceService.crdtService.admission,
    journeys: eventSourceService.journeys,
    tests: eventSourceService.tests,
    invoke: invokeForAgent,
    cancel: cancelExecution,
    revisions: eventSourceService.revisions,
    components: eventSourceService.components,
    proposals: eventSourceService.proposals,
    summaries: eventSourceService.summaries,
    delegations: eventSourceService.delegations,
});
const corsJson = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": true };
function _mcp(event: any, context: any, callback: (err: any, response: any) => void) {
    mcp.lambda(event, context, callback);
}
function _proposalsList(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.proposals.listRoute(event, context, callback);
}
function _proposalGet(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.proposals.getRoute(event, context, callback);
}
function _proposalCreate(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.proposals.createRoute(event, context, callback);
}
function _proposalDecide(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.proposals.decideRoute(event, context, callback);
}
function _proposalCommit(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.proposals.commitRoute(event, context, callback);
}
function _proposalValidate(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.proposals.validateRoute(event, context, callback);
}
/** Bringing graphs written before this server into it (plan §9.5, PB-122). */
function _migrations(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.migrations.route(event, context, callback);
}
/** How much of an agent's work a person wants to see first (plan §4.4.5). */
function _autonomy(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.autonomy.route(event, context, callback);
}
/** Component tests: whether each part still keeps its word (plan §8.1.2). */
function _tests(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.tests.listRoute(event, context, callback);
}
function _test(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.tests.testRoute(event, context, callback);
}
/** Journeys: what this graph is for, and whether it still does it (plan §8.1.7). */
function _journeys(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.journeys.listRoute(event, context, callback);
}
function _journey(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.journeys.journeyRoute(event, context, callback);
}
/**
 * The scheduled tick; EventBridge calls this, not a person.  It also sweeps
 * the deliveries nobody took, which is the only moment anything notices.
 */
function journeyTick(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.parking.sweep()
        .then((swept) => {
            if (swept.expired.length || swept.forgotten) {
                console.log("Parked deliveries:", { expired: swept.expired, forgotten: swept.forgotten, considered: swept.considered });
            }
        })
        .catch((err) => console.error("Cannot sweep parked deliveries.", err))
        .then(() => eventSourceService.journeys.tickRoute(event, context, callback));
}
/** What is still waiting for a browser (plan §4.8.2, PB-073). */
function _deliveriesPending(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.parking.pendingRoute(event, context, callback);
}
/** A browser says it has taken one. */
function _deliveryClaim(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.parking.claimRoute(event, context, callback);
}
/** What ran for a graph, and what one execution observed (the editor's executions panel). */
function _executionsList(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.executions.listRoute(event, context, callback);
}
/** What crossed one wire or one node, across this graph's executions (plan §4.5.3). */
function _observationsQuery(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.executions.queryRoute(event, context, callback);
}
/** A browser-owned execution asks the server to run a server-placed node (plan §4.8.2). */
function _edgeDeliver(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.deliveries.route(event, context, callback);
}
/** A browser execution reports its observations when it ends (src/runtime/ingest.ts). */
function _executionIngest(event: any, context: any, callback: (err: any, response: any) => void) {
    eventSourceService.executions.route(event, context, callback);
}
/** The newest audit records of a graph (the editor's agent activity view). */
function _auditList(event: any, context: any, callback: (err: any, response: any) => void) {
    const graphId = event.pathParameters.id;
    const limit = Math.min(200, Number((event.queryStringParameters || {}).limit || 50));
    const chain = eventSourceService.crdtService.admission.chain;
    const store: any = eventSourceService.crdtStore.store;
    store.list(`${chain.prefix}/${graphId}/`, async (err: any, items: any[]) => {
        if (err) { console.error("Cannot list audit records.", err); return callback(null, { statusCode: 500, headers: corsJson }); }
        const keys = (items || []).map((i: any) => i.Key).filter((k: string) => !k.endsWith("HEAD.json")).sort().reverse().slice(0, limit);
        const records: any[] = [];
        for (const key of keys) {
            const r: any = await new Promise((resolve) => store.get(key, (e: any, d: any) => resolve(e ? null : d)));
            if (r) records.push({ id: r.id, seq: r.seq, kind: r.kind, at: r.at, principal: r.principal, description: r.description || r.label, decision: r.decision, code: r.code, reason: r.reason, mutationId: r.mutationId, proposalId: r.proposalId, revisionId: r.revisionId, namespaces: r.diff && r.diff.namespaces, warnings: r.warnings });
        }
        callback(null, { statusCode: 200, headers: corsJson, body: JSON.stringify({ graphId, records }) });
    });
}
/** Delegations: who may act as an agent, on what, until when.  Managed by policy:admin. */
function _delegationsList(event: any, context: any, callback: (err: any, response: any) => void) {
    const allowed = decide(event.principal, ["policy:admin"]);
    if (!allowed.allow) return callback(null, { statusCode: 403, headers: corsJson, body: JSON.stringify({ error: allowed.reason, code: "ADMISSION_DENIED" }) });
    eventSourceService.delegations.list()
        .then((delegations) => callback(null, { statusCode: 200, headers: corsJson, body: JSON.stringify({ delegations }) }))
        .catch((err) => { console.error("Cannot list delegations.", err); callback(null, { statusCode: 500, headers: corsJson }); });
}
function _delegationPut(event: any, context: any, callback: (err: any, response: any) => void) {
    const allowed = decide(event.principal, ["policy:admin"]);
    if (!allowed.allow) return callback(null, { statusCode: 403, headers: corsJson, body: JSON.stringify({ error: allowed.reason, code: "ADMISSION_DENIED" }) });
    let body: any = {};
    try { body = event.body ? JSON.parse(event.body) : {}; } catch (err) { body = {}; }
    const agentSub = decodeURIComponent(event.pathParameters.sub);
    const graphId = event.pathParameters.graphId === "_all" ? "*" : event.pathParameters.graphId;
    const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s: any) => typeof s === "string" && decide(event.principal, [s as Authority]).allow) : [];
    if (!scopes.length) return callback(null, { statusCode: 400, headers: corsJson, body: JSON.stringify({ error: "no scopes the delegator holds", code: "SCHEMA_INVALID" }) });
    const delegation = { agentSub, graphId, delegatedBy: event.principal.sub, scopes, expiresAt: body.expiresAt || null, createdAt: new Date().toISOString(), label: String(body.label || "").slice(0, 200) };
    eventSourceService.delegations.put(delegation)
        .then(() => callback(null, { statusCode: 200, headers: corsJson, body: JSON.stringify({ delegation }) }))
        .catch((err) => { console.error("Cannot write a delegation.", err); callback(null, { statusCode: 500, headers: corsJson }); });
}
function _delegationDelete(event: any, context: any, callback: (err: any, response: any) => void) {
    const allowed = decide(event.principal, ["policy:admin"]);
    if (!allowed.allow) return callback(null, { statusCode: 403, headers: corsJson, body: JSON.stringify({ error: allowed.reason, code: "ADMISSION_DENIED" }) });
    const agentSub = decodeURIComponent(event.pathParameters.sub);
    const graphId = event.pathParameters.graphId === "_all" ? "*" : event.pathParameters.graphId;
    eventSourceService.delegations.remove(agentSub, graphId)
        .then(() => callback(null, { statusCode: 200, headers: corsJson, body: JSON.stringify({ removed: true }) }))
        .catch((err) => { console.error("Cannot remove a delegation.", err); callback(null, { statusCode: 500, headers: corsJson }); });
}
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
        // the execution summary, or the node's own answer (plan §4.7.4)
        callback(null, res && res.statusCode ? res : { statusCode: 200, body: "ok", });
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
const executionIngest = withPrincipal(broadcastService.store, _executionIngest);
const executionsList = withPrincipal(broadcastService.store, _executionsList);
const migrations = withPrincipal(broadcastService.store, _migrations);
const autonomy = withPrincipal(broadcastService.store, _autonomy);
const tests = withPrincipal(broadcastService.store, _tests);
const test = withPrincipal(broadcastService.store, _test);
const journeys = withPrincipal(broadcastService.store, _journeys);
const journey = withPrincipal(broadcastService.store, _journey);
const edgeDeliver = withPrincipal(broadcastService.store, _edgeDeliver);
const observationsQuery = withPrincipal(broadcastService.store, _observationsQuery);
const deliveriesPending = withPrincipal(broadcastService.store, _deliveriesPending);
const deliveryClaim = withPrincipal(broadcastService.store, _deliveryClaim);
const defaultRoute = withPrincipal(broadcastService.store, _defaultRoute);
const getArtifact = withPrincipal(broadcastService.store, _getArtifact);
const publish = withPrincipal(broadcastService.store, _publish);
const mcpRoute = withPrincipal(broadcastService.store, _mcp, { required: false });
const proposalsList = withPrincipal(broadcastService.store, _proposalsList);
const proposalGet = withPrincipal(broadcastService.store, _proposalGet);
const proposalCreate = withPrincipal(broadcastService.store, _proposalCreate);
const proposalDecide = withPrincipal(broadcastService.store, _proposalDecide);
const proposalCommit = withPrincipal(broadcastService.store, _proposalCommit);
const proposalValidate = withPrincipal(broadcastService.store, _proposalValidate);
const auditList = withPrincipal(broadcastService.store, _auditList);
const delegationsList = withPrincipal(broadcastService.store, _delegationsList);
const delegationPut = withPrincipal(broadcastService.store, _delegationPut);
const delegationDelete = withPrincipal(broadcastService.store, _delegationDelete);
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
    mcpRoute,
    proposalsList,
    proposalGet,
    proposalCreate,
    proposalDecide,
    proposalCommit,
    proposalValidate,
    auditList,
    delegationsList,
    delegationPut,
    delegationDelete,
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
    executionIngest,
    executionsList,
    migrations,
    autonomy,
    tests,
    test,
    journeys,
    journey,
    journeyTick,
    edgeDeliver,
    observationsQuery,
    deliveriesPending,
    deliveryClaim,
    defaultRoute,
    panic,
};
