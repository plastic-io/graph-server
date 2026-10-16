const FakeS3 = require('../__testHelpers__/fakeS3');
const {ChatService, userIdOf, graphChannel} = require('../chat/service');
const {AssistantService} = require('../assistant/service');
const {AgentStore} = require('../assistant/store');
const {assistantPrincipal} = require('../assistant/identity');
const {DelegationStore} = require('../policy/delegation');
const {decide} = require('../policy/decide');
const {withGraphTools} = require('../assistant/tools');
const {makeAssistantBridge} = require('../assistant/bridge');
const {runTurn} = require('../assistant/worker');
const {LIMITS, MODEL_ID} = require('../assistant/contract');
const {chatChunks, boundedResult} = require('../assistant/safety');
const human = (sub = 'alice') => ({sub, kind:'human', tenant:'test', name:sub, scopes:[]});
function setup() {
  const storage = new FakeS3(), events = [], queued = [];
  const chat = new ChatService(storage, {_sendToChannel:(channel,value,cb)=>{events.push({channel,...value});cb();}}, async id => ['g1','g2'].includes(id));
  const service = new AssistantService(chat, async(id,room)=>{queued.push({id,room});},()=>true); chat.assistant=service;
  const begin = jest.fn(async(...args)=>({args}));
  const deps = {chat, crdtStore:{store:storage,exists:async id=>['g1','g2'].includes(id)}, delegations:new DelegationStore(storage), admission:{chain:{append:async()=>{}}},
    summaries:{resolveRevision:async()=>({revisionId:'01J8ZK5K0B1C2D3E4F5G6H7J8A'}),graphSummary:()=>({name:'Disposable graph'})},revisions:{projection:async()=>({nodes:[]})}, reviews:{begin}};
  const bridge=makeAssistantBridge(service,deps);
  return {storage,events,queued,chat,service,deps,bridge,begin};
}
async function request(f, text='@opus Explain this graph') {
  await f.chat.post(human(),{graphId:'g1',messageId:'first',text});
  const req=await f.service.store.get(AgentStore.requestKey(f.queued[0].id));
  await f.service.store.claimRun(req.id,'lease');return req;
}
test('built-in authority cannot be forged, serialized, widened, moved to another graph or used after owner revocation',async()=>{
 const old=process.env.OWNER_SUBS;process.env.OWNER_SUBS='alice';
 try{const d=new DelegationStore(new FakeS3()),p=assistantPrincipal(human(),'g1',Date.now()+60000);
  expect(decide(await d.resolve(p,'g1'),['graph:propose']).allow).toBe(true);
  for(const q of [await d.resolve(p,'g2'),await d.resolve(p),await d.resolve(JSON.parse(JSON.stringify(p)),'g1'),{...p,scopes:['graph:approve']}]) expect(decide(await d.resolve(q,'g1'),['graph:approve']).allow).toBe(false);
  process.env.OWNER_SUBS='bob';expect(decide(p,['graph:read']).allow).toBe(false);
 }finally{if(old===undefined)delete process.env.OWNER_SUBS;else process.env.OWNER_SUBS=old;}
});
test('@opus is private, graph/user bound, durable and idempotent; agents cannot start model loops',async()=>{
 const f=setup(),a=human(),b=human('bob');
 const one=await f.chat.post(a,{graphId:'g1',messageId:'one',text:'@opus Hi'});
 const retry=await f.chat.post(a,{graphId:'g1',messageId:'one',text:'@opus Hi'});
 expect(one.message.id).toBe(retry.message.id);expect(new Set(f.queued.map(q=>q.id)).size).toBe(1);
 expect(f.events.some(e=>e.channel===graphChannel('g1'))).toBe(false);
 const peer=(await f.chat.directory(a,'g1')).people.find(p=>p.assistant);
 expect(peer.handle).toBe('opus');
 expect((await f.chat.directory(b,'g1')).people.filter(p=>p.assistant).map(p=>p.id)).not.toContain(peer.id);
 expect((await f.chat.directory(a,'g2')).people.filter(p=>p.assistant).map(p=>p.id)).not.toContain(peer.id);
 await expect(f.chat.read(b,{graphId:'g1',peerId:peer.id})).rejects.toMatchObject({code:'ADMISSION_DENIED'});
 await expect(f.chat.post(a,{graphId:'g2',peerId:peer.id,messageId:'bad',text:'Hi'})).rejects.toMatchObject({code:'ADMISSION_DENIED'});
 const req=await f.service.store.get(AgentStore.requestKey(f.queued[0].id));
 await f.service.reply(req,'reply','Here is an example mentioning @another-user without disclosing this conversation.');
 expect(f.queued).toHaveLength(2); // same human retry, no enqueue from agent reply
 const page=await f.chat.read(a,{peerId:peer.id,after:0,limit:50});
 expect(page.messages).toHaveLength(3);expect(page.updateFormat).toBe(2);
 expect(f.events.filter(e=>e.message.id===page.messages[2].id).every(e=>e.room===page.room||e.room===one.room)).toBe(true);
});
test('requests per hour are durable across workers, and worker leases never replay abandoned tools',async()=>{
 const f=setup();const decisions=await Promise.all(Array.from({length:22},(_,i)=>f.service.store.quota('alice','job'+i,0)));
 expect(decisions.filter(Boolean)).toHaveLength(20);expect(await new AgentStore(f.storage).quota('alice','job0',0)).toBe(true);
 expect(await f.service.store.claimRun('id','first')).toBe('claimed');
 await expect(f.service.store.claimRun('id','second')).rejects.toThrow('still running');
 await f.service.store.put(AgentStore.stateKey('id'),{status:'running',token:'first',startedAt:Date.now()-400000});
 expect(await f.service.store.claimRun('id','second')).toBe('abandoned');
 expect(await f.service.store.claimRun('id','third')).toBe('finished');
});
test('an authenticated user invoking Opus through MCP remains the requesting user in model history',async()=>{
 const f=setup();await f.chat.join('g1',human(),'external','MCP session');
 await f.chat.post(human(),{graphId:'g1',agentSessionId:'external',messageId:'mcp',text:'@opus Explain'},true);
 const req=await f.service.store.get(AgentStore.requestKey(f.queued[0].id));await f.service.store.claimRun(req.id,'lease');
 const result=await f.bridge({id:req.id,token:'lease',action:'bootstrap'});
 expect(result.history.at(-1)).toEqual({role:'user',text:'@opus Explain'});
});
test('actual MCP catalog and guards enforce graph binding, approval separation and strict preservation',async()=>{
 const f=setup(),req=await request(f),p=assistantPrincipal(human(),'g1',Date.now()+60000),session=`opus-${req.id.slice(0,40)}`;
 await withGraphTools(f.deps,p,'g1',session,async api=>{
  const names=(await api.list()).map(t=>t.name);expect(names).toContain('proposal.create');expect(names).not.toContain('proposal.commit');expect(names).not.toContain('graph.invoke');
  expect((await api.call('server.discover',{topic:'assistant'})).result.contracts.assistant.handle).toBe('@opus');
  expect((await api.call('graph.summary',{})).result.name).toBe('Disposable graph');
  await expect(api.call('proposal.commit',{})).rejects.toThrow('not available');
  await expect(api.call('graph.summary',{graphId:'g2'})).rejects.toThrow('Cross-graph');
  await expect(api.call('chat.read',{peerId:userIdOf(human('bob'))})).rejects.toThrow('private');
  await expect(api.call('iac.review',{nodeId:'stack',action:'destroy'})).rejects.toThrow('Destructive');
  const r=await api.call('iac.review',{nodeId:'stack'});expect(r.error).toBeUndefined();expect(f.begin.mock.calls[0][6]).toBe('strict');
 });
});
test('worker uses real tool schemas, preserves reasoning privately, and returns replies over the same durable chat bus',async()=>{
 const f=setup(),req=await request(f);let round=0;
 const converse=jest.fn(async(input)=>{
  expect(input.modelId).toBe(MODEL_ID);expect(input.toolConfig.tools.some(t=>t.toolSpec.name==='proposal__create')).toBe(true);
  if(round++===0)return {output:{message:{role:'assistant',content:[{reasoningContent:{reasoningText:{text:'private reasoning',signature:'sig'}}},{toolUse:{toolUseId:'tool_1',name:'graph__summary',input:{}}}]}},usage:{inputTokens:20,outputTokens:10}};
  expect(input.messages[1].content[0].reasoningContent.reasoningText.signature).toBe('sig');
  return {output:{message:{role:'assistant',content:[{text:'The graph is named Disposable graph.'}]}},stopReason:'end_turn',usage:{inputTokens:40,outputTokens:15}};
 });
 await runTurn(req,'lease',f.bridge,converse);
 const state=await f.service.store.get(AgentStore.stateKey(req.id));expect(state.status).toBe('done');expect(state.usage).toEqual({inputTokens:60,outputTokens:25});
 const page=await f.chat.read(human(),{peerId:req.peerId,after:0,limit:50});expect(page.messages.at(-1).text).toContain('Disposable graph');
 expect(JSON.stringify(f.events)).not.toContain('private reasoning');expect(f.events.some(e=>e.message.text.includes('Using graph.summary'))).toBe(true);
 expect(f.queued).toHaveLength(1);
});
test('interrupts and expired requests stop tools; model permission errors are actionable without revealing credentials',async()=>{
 const f=setup(),req=await request(f);
 await f.chat.post(human(),{graphId:'g1',peerId:req.peerId,messageId:'stop',text:'Stop and explain first',interrupt:true});
 expect(await f.bridge({id:req.id,token:'lease',action:'control'})).toMatchObject({interrupted:true});
 await expect(f.bridge({id:req.id,token:'lease',action:'tool',name:'iac.review',callId:'blocked',args:{nodeId:'stack'}})).rejects.toMatchObject({code:'CHAT_INTERRUPTED'});
 expect(f.begin).not.toHaveBeenCalled();
 const f2=setup(),req2=await request(f2);
 await runTurn(req2,'lease',f2.bridge,async()=>{throw Object.assign(new Error('Bedrock access denied; authorization=very-secret-token'),{name:'AccessDeniedException'});});
 const messages=(await f2.chat.read(human(),{peerId:req2.peerId,limit:50})).messages;
 expect(messages.at(-1).text).toContain('Bedrock access denied');expect(JSON.stringify(messages)).not.toContain('very-secret-token');
 expect((await f2.service.store.get(AgentStore.stateKey(req2.id))).status).toBe('failed');
});
test('outputs are redacted and UTF-8 bounded without splitting Unicode characters',()=>{
 const parts=chatChunks('🐟'.repeat(900)+' password="top-secret"');
 expect(parts.every(p=>Buffer.byteLength(p)<=1800)).toBe(true);expect(parts.join('')).not.toContain('top-secret');expect(parts.join('')).not.toContain('�');
 expect(boundedResult({large:'a'.repeat(40000)}).truncated).toBe(true);
 expect(boundedResult({accessToken:'secret',nested:{password:'secret'}})).toEqual({accessToken:'[redacted]',nested:{password:'[redacted]'}});
});
test('an interruption during inference aborts the model and acknowledges feedback before any tool can run',async()=>{
 const f=setup(),req=await request(f);let began;
 const started=new Promise(resolve=>{began=resolve;});
 const run=runTurn(req,'lease',f.bridge,async(_input,signal)=>{
  began();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('Aborted')),{once:true}));
 });
 await started;
 const sent=await f.chat.post(human(),{graphId:'g1',peerId:req.peerId,messageId:'interrupt',text:'Stop and explain first',interrupt:true});
 await run;
 expect((await f.service.store.get(AgentStore.stateKey(req.id))).status).toBe('interrupted');expect(f.begin).not.toHaveBeenCalled();
 const messages=(await f.chat.read(human(),{peerId:req.peerId,limit:50})).messages;
 expect(messages.some(m=>m.phase==='acknowledged'&&m.acknowledges.includes(sent.message.id))).toBe(true);
},10000);

// Opt-in paid integration: synthetic graph in memory, actual Bedrock inference.
// Never reads an application graph, creates AWS resources or approves a proposal.
(process.env.RUN_BEDROCK_LIVE === 'true' ? test : test.skip)('live Opus discovers MCP operations and creates a real, uncommitted rename proposal',async()=>{
 const f=setup();
 const {fromJSON,encodeState}=require('@plastic-io/graph-crdt');
 const CrdtStore=require('../crdtStore').default,CrdtService=require('../crdtService').default;
 const {RevisionService}=require('../revisions/service'),{SummaryService}=require('../summary/service'),{ProposalService}=require('../proposals/service');
 const crdtStore=new CrdtStore(f.storage),crdt=new CrdtService(crdtStore,{_sendToChannel:(_c,_v,cb)=>cb()});
 crdt.admission.resolvePrincipal=(p,g)=>f.deps.delegations.resolve(p,g);
 const revisions=new RevisionService(crdtStore,crdt.admission),summaries=new SummaryService(revisions,{});
 const proposals=new ProposalService(crdtStore,crdt.admission,revisions,summaries);
 const doc=fromJSON({id:'g1',url:'g1',version:0,nodes:[],properties:{name:'Disposable Opus verification',description:'Synthetic fixture',createdOn:0,lastUpdate:0}});
 await crdtStore.appendUpdate('g1',encodeState(doc),'seed','system');doc.destroy();
 Object.assign(f.deps,{crdtStore,admission:crdt.admission,revisions,summaries,proposals});
 const req=await request(f,'@opus This is a disposable platform test. Use server.discover topic operations and graph.summary to learn the contract. Create a proposal to rename this graph to Opus verified. Do not commit it. Report its proposal ID and that it is awaiting acceptance.');
 const {BedrockRuntimeClient,ConverseCommand}=require('@aws-sdk/client-bedrock-runtime');
 const client=new BedrockRuntimeClient({region:'us-west-1',maxAttempts:1});
 try{await runTurn(req,'lease',f.bridge,(input,signal)=>client.send(new ConverseCommand(input),{abortSignal:signal}));}finally{client.destroy();}
 const state=await f.service.store.get(AgentStore.stateKey(req.id));
 const rows=await proposals.list('g1',human());
 expect(state.status).toBe('done');
 expect(rows.length).toBe(1);
 expect((await crdtStore.projectGraph('g1')).properties.name).toBe('Disposable Opus verification');
 console.log('LIVE_BEDROCK_EVIDENCE',JSON.stringify({model:MODEL_ID,status:state.status,usage:state.usage,proposalId:rows[0].proposalId,state:rows[0].state,graphUnchanged:true}));
},300000);
