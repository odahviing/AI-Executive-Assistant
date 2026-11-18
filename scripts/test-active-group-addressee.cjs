// The real Slack processor and queue; model and Slack I/O are isolated.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./test-slack-thread-boundaries.cjs');
function active(verdict){const h=harness({addressee:verdict});h.db.set('100.000001',[{role:'assistant',content:'Friday 12:30 is available. Which time?',ts:'99.000001'}]);return h;}
test('active group does not treat a question to another human as a booking command',async()=>{
 const h=active('HUMAN');await h.turn({senderId:'UCOLLEAGUE',channelId:'GROOM',isMpim:true,text:'<@UOWNER> 12:30?'});
 assert.equal(h.classifications.length,1);assert.equal(h.runs.length,0);assert.equal(h.posts.length,0);
});
test('a human-to-human yes still passes the addressee gate in an active group',async()=>{
 const h=active('HUMAN');h.append('100.000001','GROOM',{role:'user',content:'<@UOWNER> 12:30?',ts:'100.500001'});
 await h.turn({channelId:'GROOM',isMpim:true,text:'yes'});assert.equal(h.classifications.length,1);assert.equal(h.runs.length,0);
});
test('ambiguous group reply remains quiet despite a recent assistant answer',async()=>{
 const h=active('AMBIGUOUS');await h.turn({channelId:'GROOM',isMpim:true,text:'25?'});assert.equal(h.classifications.length,1);assert.equal(h.runs.length,0);
});
test('a real unmentioned continuation to Maelle reaches the orchestrator once',async()=>{
 const h=active('MAELLE');await h.turn({channelId:'GROOM',isMpim:true,text:'Please book 12:30'});await h.fire();
 assert.equal(h.runs.length,1);assert.equal(h.posts.length,1);
});
test('explicit bot mention remains a zero-classifier-call path',async()=>{
 const h=active('HUMAN');await h.turn({channelId:'GROOM',isMpim:true,isExplicitMention:true,text:'<@UBOT> book 12:30'});await h.fire();
 assert.equal(h.classifications.length,0);assert.equal(h.runs.length,1);
});
test('one-to-one DM remains a zero-addressee-call path',async()=>{
 const h=active('HUMAN');await h.turn({text:'Book 12:30'});await h.fire();assert.equal(h.classifications.length,0);assert.equal(h.runs.length,1);
});
test('unavailable group addressee gate cannot fall through into calendar work',async()=>{
 const h=active('MAELLE');h.load('src/utils/addresseeGate.ts').classifyAddressee=async()=>{throw Error('unavailable');};
 await h.turn({channelId:'GROOM',isMpim:true,text:'12:30?'});assert.equal(h.runs.length,0);assert.equal(h.posts.length,0);
 assert.ok(h.logs.some(row=>String(row[1]).includes('staying silent')));
});
test('actual queue refuses a late write reservation after a merge abort',async()=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});let writes=0;
 const h=harness({orchestrator:async(p,n)=>{if(n===1){await pending;p.onWriteExecuted();writes++;}return {reply:'Stopped.'};}});
 await h.turn();await h.fire();await h.turn({text:'Stop',ts:'102.000001'});release();
 await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
 assert.equal(writes,0);assert.equal(h.posts.length,0);await h.fire();assert.equal(h.runs.length,2);assert.equal(h.posts.length,1);
});
