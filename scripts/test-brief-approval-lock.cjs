// Joint B05 regression derived from independent bouncer-critical-probes.cjs.
// Runs the real resolver FIFO/replay and real brief/close/relay against shared
// isolated row/transport doubles. BRIEF_SOURCE_FIXTURE selects the pre-bounce brief.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {test,afterEach}=require('node:test');
const root=path.resolve(__dirname,'..');
function prefix(file,edits=[]){
  let source=fs.readFileSync(path.join(__dirname,file),'utf8').split('\nafterEach(')[0];
  for(const [from,to] of edits){assert.equal(source.split(from).length,2,`single exact harness adaptation: ${from}`);source=source.replace(from,to);}
  return new Function('require','__dirname',source+'\nreturn {harness,profile};')(require,__dirname);
}
const approval=prefix('test-approval-replay-identity.cjs',[
  ["if (options.throwTool) throw new Error('isolated executor failure');", "if(options.actionGate)await options.actionGate; if (options.throwTool) throw new Error('isolated executor failure');"],
  ["terminalDmMsgTs:'terminal_dm_msg_ts',nextCheckAt", "terminalDmMsgTs:'terminal_dm_msg_ts',requesterNotifiedAt:'requester_notified_at',nextCheckAt"],
  ["closeRequest: args => { effects.closes.push(clone(args)); row = { ...row, state: args.state }; }", "closeRequest: args => { effects.closes.push(clone(args)); if(['resolved','cancelled','expired'].includes(row.state))return {ok:true,reason:'already terminal'}; row = { ...row, state: args.state }; return {ok:true}; }"],
  ["lock: work => resolver.withRequestLock(row.id, work),", "lock: work => resolver.withRequestLock(row.id, work), lockId:(id,work)=>resolver.withRequestLock(id,work),"],
]);
const brief=prefix('test-brief-stale-closure.cjs',[
  ["const update=(id,data)=>{assert.equal(id,row.id);", "const update=(id,data)=>{options.onUpdate?.(id,data);assert.equal(id,row.id);"],
  ["getRequest:()=>{freshReads++;", "getRequest:()=>{if(options.sharedRow)row=options.sharedRow();freshReads++;"],
]);
const all=[];
const makeGate=()=>{let release;const promise=new Promise(r=>release=r);return {promise,release};};
async function advanceUntil(predicate){for(let i=0;i<30&&!predicate();i++)await new Promise(r=>setImmediate(r));assert.ok(predicate(),'bounded fixture phase became observable');}
function linked(h,extra={}){const b=brief.harness({row:h.row(),sharedRow:h.row,onUpdate:h.update,withRequestLock:(id,work)=>h.lockId(id,work),...extra});all.push(h,b);return b;}
afterEach(()=>{for(const h of all.splice(0))assert.deepEqual(h.unexpected,[],'no swallowed unexpected dependency failure');});

test('B05 approved replay in flight cannot be auto-parked or receive false no-owner-answer relay',async()=>{
  const gate=makeGate(),h=approval.harness({actionGate:gate.promise,row:{surfaced_count:2}});
  const deciding=h.resolve();await advanceUntil(()=>h.effects.executes.length===1);
  const b=linked(h);let briefDone=false;const briefing=b.run().then(()=>briefDone=true);
  await advanceUntil(()=>b.effects.owner.length===1);await new Promise(r=>setImmediate(r));
  const before={state:h.row().state,relays:b.effects.requester.length,briefDone};
  gate.release();const result=await deciding;await briefing;
  assert.deepEqual(before,{state:'awaiting_owner',relays:0,briefDone:false});
  assert.equal(result.state,'resolved');assert.equal(h.row().state,'resolved');
  assert.equal(b.effects.requester.length,0);assert.equal(h.effects.sends.length,1);
});
test('B05 state revalidated after a queued owner closure prevents stale cancellation',async()=>{
  const gate=makeGate(),h=approval.harness({row:{surfaced_count:2}});
  const deciding=h.lock(async()=>{await gate.promise;h.update(h.row().id,{state:'resolved'});});
  const b=linked(h);const briefing=b.run();await advanceUntil(()=>b.effects.owner.length===1);
  gate.release();await deciding;await briefing;
  assert.equal(h.row().state,'resolved');assert.equal(b.effects.requester.length,0);
});
test('B05 waiting writer that leaves request open still permits one legitimate stale closure',async()=>{
  const gate=makeGate(),h=approval.harness({row:{surfaced_count:2}});
  const holding=h.lock(()=>gate.promise);const b=linked(h);const briefing=b.run();
  await advanceUntil(()=>b.effects.owner.length===1);gate.release();await holding;await briefing;
  assert.equal(h.row().state,'cancelled');assert.equal(b.effects.requester.length,1);
  assert.ok(h.row().requester_notified_at);
});
test('B05 failed earlier lock releases FIFO for legitimate brief closure',async()=>{
  const gate=makeGate(),h=approval.harness({row:{surfaced_count:2}});
  const holding=h.lock(async()=>{await gate.promise;throw Error('isolated prior failure');}).catch(()=>{});
  const b=linked(h);const briefing=b.run();await advanceUntil(()=>b.effects.owner.length===1);
  gate.release();await holding;await briefing;
  assert.equal(h.row().state,'cancelled');assert.equal(b.effects.requester.length,1);
});
test('B05 unrelated request lock does not delay legitimate stale closure',async()=>{
  const gate=makeGate(),h=approval.harness({row:{surfaced_count:2}});
  const holding=h.lockId('req_unrelated',()=>gate.promise);const b=linked(h);
  await b.run();assert.equal(h.row().state,'cancelled');assert.equal(b.effects.requester.length,1);
  gate.release();await holding;
});
