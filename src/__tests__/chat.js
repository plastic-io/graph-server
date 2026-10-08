const Y = require('yjs');
const {applyUpdate, encodeStateVector, toBase64, fromBase64, isEmptyUpdate} = require('@plastic-io/graph-crdt');
const {messagesFrom} = require('../chat/document');
const {ChatStore, digest} = require('../chat/store');
const {ChatService, graphRoom, graphChannel, personalChannel, userIdOf} = require('../chat/service');
const BroadcastService = require('../broadcastService').default;
const S3Service = require('../s3Service').default;
const {ChangeFeed, watchesFor} = require('../mcp/subscriptions');
const FakeS3 = require('../__testHelpers__/fakeS3');
const human = (sub, name = sub) => ({sub, name, kind:'human', tenant:'test', scopes:[]});
const alice = human('alice', 'Alice'), bob = human('bob', 'Bob'), carol = human('carol', 'Carol');
function setup() {
  const store = new FakeS3(), events = [], replies = [];
  const broadcast = {_sendToChannel: (channel, value, cb) => {events.push({channel, ...value}); cb();}, postToClient: (_d, _c, value, cb) => {replies.push(value); cb();}};
  const chat = new ChatService(store, broadcast, async id => ['g1','g2'].includes(id));
  return {store, chat, events, replies};
}
const body = id => ({id, sender:{id:'agent:a', userId:'a', name:'Agent', role:'agent'}, text:id, phase:'message', interrupt:false, acknowledges:[]});

describe('durable, concurrent graph chat sidecars', () => {
  test('concurrent writers survive page rotation and stable forward cursors; archived retries do not duplicate', async () => {
    const storage = new FakeS3();
    const logs = Array.from({length:8}, () => new ChatStore(storage, 3));
    await Promise.all(Array.from({length:16}, (_, i) => logs[i % logs.length].append('graph-g1', body('m'+i))));
    const log = new ChatStore(storage, 3); let cursor = 0, all = [];
    while (true) {const page = await log.read('graph-g1', {after:cursor, limit:4}); all.push(...page.messages); cursor = page.cursor; if (!page.hasMore) break;}
    expect(all.map(m => m.seq)).toEqual(Array.from({length:16}, (_, i) => i+1));
    expect(new Set(all.map(m => m.id)).size).toBe(16);
    expect(await log.append('graph-g1', body(all[0].id))).toEqual(all[0]);
    expect((await log.read('graph-g1')).latestSeq).toBe(16);
    await expect(log.append('graph-g1', {...body(all[0].id), text:'changed'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    const newest = await log.read('graph-g1', {limit:4});
    const older = await log.read('graph-g1', {before:newest.before, limit:4});
    expect(newest.messages.map(m => m.seq)).toEqual([13,14,15,16]);
    expect(older.messages.map(m => m.seq)).toEqual([9,10,11,12]);
    await log.append('graph-g1', body('late'));
    expect((await log.read('graph-g1', {after:cursor})).messages.map(m => m.id)).toEqual(['late']);
  });
  test('Yjs replicas converge after duplicate/out-of-order pages and reconnect state-vector sync', async () => {
    const log = new ChatStore(new FakeS3(), 2);
    await Promise.all(Array.from({length:8}, (_, i) => log.append('graph-g1', body('msg'+i))));
    const updates = await Promise.all(Array.from({length:8}, (_,i) => log.updateFor('graph-g1','msg'+i)));
    const a = new Y.Doc(), b = new Y.Doc();
    try {
      for (const item of updates) applyUpdate(a, fromBase64(item.payload));
      for (const item of [...updates].reverse().concat(updates)) applyUpdate(b, fromBase64(item.payload));
      expect(a.getMap('messages').toJSON()).toEqual(b.getMap('messages').toJSON());
      expect(a.getMap('messages').size).toBe(8);
      const upToDate = await log.read('graph-g1', {after:0, limit:50, stateVector:toBase64(encodeStateVector(a))});
      expect(isEmptyUpdate(fromBase64(upToDate.payload))).toBe(true);
      await log.append('graph-g1',body('reconnected'));
      const delta = await log.read('graph-g1',{after:0,limit:50,stateVector:toBase64(encodeStateVector(a))});
      applyUpdate(a,fromBase64(delta.payload));
      expect(a.getMap('messages').size).toBe(9);
    } finally {a.destroy(); b.destroy();}
  });
  test('concurrent identical retries and a lost post-commit receipt recover one admitted Yjs update', async () => {
    const store = new FakeS3(); const log = new ChatStore(store, 2);
    const same = await Promise.all(Array.from({length:8},()=>log.append('graph-g1',body('same'))));
    expect(new Set(same.map(m=>m.seq)).size).toBe(1);
    const original = store.set.bind(store); let lose = true;
    store.set = (key,value,meta,cb) => {
      if (lose && key.includes('/requests/') && value.entry) {lose=false; return cb(new Error('lost receipt write'));}
      original(key,value,meta,cb);
    };
    await expect(log.append('graph-g1',body('lost'))).rejects.toThrow('lost receipt');
    const recovered = await log.append('graph-g1',body('lost'));
    expect(recovered.seq).toBe(2); expect((await log.read('graph-g1')).latestSeq).toBe(2);
  });
  test('storage failures are not treated as empty history', async () => {
    const storage = new FakeS3(); storage.getVersioned = (_k, cb) => cb(Object.assign(new Error('Access denied'), {statusCode:403}));
    await expect(new ChatStore(storage).read('g')).rejects.toThrow('Access denied');
  });
  test('S3 conditional headers are attached before signing and ETag is returned with the value', done => {
    const service = new S3Service('bucket'); const headers = {};
    service.s3 = {putObject: () => ({httpRequest:{headers}, on: (_name, fn) => {fn();}, send: cb => cb(null,{})}), getObject: (_args, cb) => cb(null, {ETag:'v1',Body:Buffer.from('{"seq":1}')})};
    service.compareAndSet('head', {seq:2}, 'v1', () => {
      expect(headers['If-Match']).toBe('v1');
      service.getVersioned('head', (err, value) => {expect(err).toBeNull(); expect(value).toEqual({etag:'v1', value:{seq:1}}); done();});
    });
  });
});

describe('private messaging and graph access', () => {
  test('large directories are split into bounded WebSocket receipts without dropping people', async () => {
    const {chat,replies} = setup();
    await Promise.all(Array.from({length:180},(_,i)=>chat.person(human('person-'+i,'Person '+i))));
    await new Promise(resolve => chat.route({principal:alice,requestContext:{connectionId:'c',domainName:'d'},body:JSON.stringify({action:'chat',operation:'directory',messageId:'rpc'})},{},resolve));
    expect(replies.length).toBeGreaterThan(1);
    expect(replies.every(r=>Buffer.byteLength(JSON.stringify(r))<25000)).toBe(true);
    expect(replies[replies.length-1].response.chunk.final).toBe(true);
    expect(new Set(replies.flatMap(r=>r.response.people.map(p=>p.id))).size).toBe(181);
  });
  test('mentions produce private delivery only, with durable private history and no graph copy', async () => {
    const {chat, events, store} = setup(); const recipient = await chat.person(bob); await chat.person(carol);
    const sent = await chat.post(alice, {graphId:'g1', messageId:'hello', text:`(@${recipient.handle}) private feedback`, interrupt:true});
    expect(events.map(e => e.channel)).toEqual([personalChannel(alice), personalChannel(bob)]);
    expect((await chat.read(bob, {peerId:userIdOf(alice)})).messages[0].id).toBe(sent.message.id);
    expect((await chat.read(carol, {peerId:userIdOf(alice)})).messages).toEqual([]);
    expect((await chat.read(alice, {graphId:'g1'})).messages).toEqual([]);
    expect((await chat.inbox(bob)).threads).toMatchObject([{peer:{id:userIdOf(alice)},latestSeq:1}]);
    expect([...store.objects.keys()].some(k => k.startsWith('graphs/'))).toBe(false);
    await expect(chat.post(alice,{graphId:'g1',messageId:'typo',text:'@unknown secret'})).rejects.toMatchObject({code:'SCHEMA_INVALID'});
    await expect(chat.post(alice,{graphId:'g1',messageId:'ambiguous',text:`@here @${recipient.handle} secret`})).rejects.toMatchObject({code:'SCHEMA_INVALID'});
  });
  test('an unauthorized principal cannot read, post, or subscribe across a graph or a private account', async () => {
    const {chat, store} = setup();
    const agent = {sub:'agent',kind:'agent',tenant:'test',scopes:[]};
    await expect(chat.read(agent,{graphId:'g1'})).rejects.toMatchObject({code:'ADMISSION_DENIED'});
    await chat.delegations.put({agentSub:agent.sub,graphId:'g1',delegatedBy:alice.sub,scopes:['graph:read'],expiresAt:null,createdAt:new Date().toISOString()});
    expect((await chat.read(agent,{graphId:'g1'})).messages).toEqual([]);
    await expect(chat.read(agent,{graphId:'g2'})).rejects.toMatchObject({code:'ADMISSION_DENIED'});
    const broadcast = new BroadcastService(); broadcast.store = store;
    expect(await broadcast.chatAllowed(alice,personalChannel(bob))).toBe(false);
    expect(await broadcast.chatAllowed(alice,personalChannel(alice))).toBe(true);
    expect(await broadcast.chatAllowed(agent,graphChannel('g1'))).toBe(true);
    expect(await broadcast.chatAllowed(agent,graphChannel('g2'))).toBe(false);
    expect(await broadcast.chatAllowed(undefined,'graph-notify-g1')).toBe(false);
    expect(await broadcast.chatAllowed(agent,'graph-notify-g1')).toBe(true);
    expect(await broadcast.chatAllowed(agent,'graph-notify-g2')).toBe(false);
    await chat.delegations.remove(agent.sub,'g1');
    expect(await broadcast.chatAllowed(agent,graphChannel('g1'))).toBe(false);
    expect(await broadcast.chatAllowed(agent,'graph-notify-g1')).toBe(false);
  });
  test('WSS attributes messages to the verified principal and sends explicit bounded errors', async () => {
    const {chat, replies} = setup();
    const route = args => new Promise(resolve => chat.route({principal:alice,requestContext:{connectionId:'c',domainName:'d'},body:JSON.stringify({action:'chat',operation:'post',messageId:'rpc',args})},{},resolve));
    await route({graphId:'g1',messageId:'message',text:'hello',sender:{name:'Bob',role:'agent'}});
    expect(replies[0].response.message.sender).toMatchObject({name:'Alice',role:'human',userId:userIdOf(alice)});
    await route({graphId:'g1',messageId:'big',text:'😀'.repeat(600)});
    expect(replies[1].response.code).toBe('SCHEMA_INVALID');
  });
});

describe('coordinating multiple agent sessions', () => {
  test('a session uses private-room sequence watermarks instead of writer clocks', async () => {
    const {chat} = setup(); await chat.person(alice);
    await chat.post(bob,{peerId:userIdOf(alice),messageId:'old',text:'Previous session feedback',interrupt:true});
    const session = await chat.join('g1',alice,'later-session','Planner');
    expect(Object.values(session.directCursors)).toEqual([1]);
    await expect(chat.assertMayWork('g1',alice,'later-session')).resolves.toBeUndefined();
    await chat.post(bob,{peerId:userIdOf(alice),messageId:'new',text:'Current session feedback',interrupt:true});
    expect((await chat.interruptions('g1',alice,'later-session')).map(m=>m.text)).toEqual(['Current session feedback']);
  });
  test('two agents using one login must each respond to an interruption before further work', async () => {
    const {chat} = setup();
    await chat.join('g1',alice,'session-a','Planner'); await chat.join('g1',alice,'session-b','Builder');
    const thinking = await chat.post(alice,{graphId:'g1',agentSessionId:'session-a',messageId:'thinking',text:'@here Planning node A',phase:'thinking'},true);
    const doing = await chat.post(alice,{graphId:'g1',agentSessionId:'session-b',messageId:'doing',text:'@here Working on node B',phase:'doing'},true);
    expect(thinking.message.sender.id).not.toBe(doing.message.sender.id);
    const stop = await chat.post(alice,{graphId:'g1',messageId:'feedback',text:'@here Pause; the contract changed.',interrupt:true});
    await expect(chat.assertMayWork('g1',alice,'session-a')).rejects.toMatchObject({code:'CHAT_INTERRUPTED'});
    await expect(chat.assertMayWork('g1',alice,'session-b')).rejects.toMatchObject({code:'CHAT_INTERRUPTED'});
    const reply = {graphId:'g1',agentSessionId:'session-a',messageId:'reply',text:'I will update the plan to use the new contract.',phase:'acknowledged',acknowledges:[stop.message.id]};
    await chat.post(alice,reply,true); await chat.post(alice,reply,true);
    await expect(chat.assertMayWork('g1',alice,'session-a')).resolves.toBeUndefined();
    await expect(chat.assertMayWork('g1',alice,'session-b')).rejects.toMatchObject({code:'CHAT_INTERRUPTED'});
    await expect(chat.post(bob,{...reply,messageId:'spoof'},true)).rejects.toMatchObject({code:'SESSION_REQUIRED'});
  });
  test('a private interruption is acknowledged privately and blocks only its recipient account', async () => {
    const {chat} = setup();
    await chat.join('g1',alice,'agent-a','A'); await chat.join('g1',bob,'agent-b','B');
    const stop = await chat.post(carol,{peerId:userIdOf(alice),messageId:'stop',text:'Private instruction: stop changing that node.',interrupt:true});
    await expect(chat.assertMayWork('g1',alice,'agent-a')).rejects.toMatchObject({code:'CHAT_INTERRUPTED'});
    await expect(chat.assertMayWork('g1',bob,'agent-b')).resolves.toBeUndefined();
    await expect(chat.post(alice,{graphId:'g1',agentSessionId:'agent-a',messageId:'leak',text:'Acknowledged',phase:'acknowledged',acknowledges:[stop.message.id]},true)).rejects.toMatchObject({code:'NOT_FOUND'});
    await chat.post(alice,{graphId:'g1',peerId:userIdOf(carol),agentSessionId:'agent-a',messageId:'ack',text:'Paused that change; I will revise it.',phase:'acknowledged',acknowledges:[stop.message.id]},true);
    await expect(chat.assertMayWork('g1',alice,'agent-a')).resolves.toBeUndefined();
    expect((await chat.read(alice,{graphId:'g1'})).messages).toEqual([]);
  });
  test('the MCP feed announces graph chat changes without broadcasting private history', async () => {
    const {chat,store} = setup(); const feed = new ChangeFeed(store,watchesFor(['plastic://graph/g1/chat']));
    await feed.prime();
    await chat.post(alice,{graphId:'g1',messageId:'one',text:'@here Starting'});
    await feed.poll(); expect(feed.published).toEqual([{kind:'resource_updated',uri:'plastic://graph/g1/chat'}]);
    await chat.person(bob); await chat.post(alice,{peerId:userIdOf(bob),messageId:'two',text:'Private'});
    expect(await feed.poll()).toBe(0);
  });
});
