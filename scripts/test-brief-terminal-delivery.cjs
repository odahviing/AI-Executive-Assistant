// Joint B01: actual delivered brief -> terminal closure -> shared durable retry.
// The timer consumer is Registrar's; these tests call its exact helper serially.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {test,afterEach}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'test-brief-stale-closure.cjs'),'utf8').split('\nafterEach(')[0];
const {harness}=new Function('require','__dirname',source+'\nreturn {harness};')(require,__dirname);
const all=[];const make=o=>{const h=harness(o);all.push(h);return h;};
afterEach(()=>{for(const h of all.splice(0))assert.deepEqual(h.unexpected,[]);});
for(const room of [false,true])test(`B01 brief explicit rejection retries exact terminal copy once in ${room?'room':'DM'}`,async()=>{
  const h=make({sendFails:true,row:room?{origin_is_mpim:1,origin_channel:'CROOM'}:{}});await h.run();
  assert.equal(h.row().state,'cancelled');assert.equal(h.row().requester_notified_at,undefined);
  assert.equal(h.row().next_check_handler,'requester_relay_retry');
  const stored=JSON.parse(h.row().outcome_json).requester_relay;
  assert.equal(stored.delivery,'failed');assert.equal(stored.body,h.effects.requester[0].body);
  h.recover();assert.equal(await h.retry(),true);
  assert.equal(h.row().state,'cancelled');assert.ok(h.row().requester_notified_at);
  assert.equal(h.row().next_check_handler,null);assert.equal(JSON.parse(h.row().outcome_json).requester_relay,undefined);
  assert.equal(h.effects.requester.length,2);assert.equal(h.effects.requester[1].body,stored.body);
  assert.equal(h.effects.requester[1].opts.threadTs,'origin.1');
  assert.equal(await h.retry(),false);assert.equal(h.effects.requester.length,2);
});
test('B01 brief missing requester connection preserves exact copy for recovery',async()=>{
  const h=make({noConnection:true});await h.run();assert.equal(h.row().next_check_handler,'requester_relay_retry');
  const copy=JSON.parse(h.row().outcome_json).requester_relay.body;assert.equal(h.effects.requester.length,0);
  h.recover();await h.retry();assert.equal(h.effects.requester[0].body,copy);assert.ok(h.row().requester_notified_at);
});
for(const [name,options]of [['thrown',{sendThrows:true}],['generic transport error',{sendFails:true,sendReason:'error'}]])test(`B01 brief ${name} stays unconfirmed without automatic resend`,async()=>{
  const h=make(options);await h.run();assert.equal(h.row().state,'cancelled');
  assert.equal(JSON.parse(h.row().outcome_json).requester_relay.delivery,'unconfirmed');
  assert.equal(h.row().next_check_handler,null);h.recover();assert.equal(await h.retry(),false);
  assert.equal(h.effects.requester.length,1);assert.equal(h.row().requester_notified_at,undefined);
});
for(const room of [false,true])test(`B01 confirmed brief closure in ${room?'room':'DM'} remains single-send without retry state`,async()=>{
  const h=make({row:room?{origin_is_mpim:1,origin_channel:'CROOM'}:{}});await h.run();
  assert.equal(h.row().state,'cancelled');assert.ok(h.row().requester_notified_at);assert.equal(h.effects.requester.length,1);
  assert.equal(JSON.parse(h.row().outcome_json||'{}').requester_relay,undefined);
});
