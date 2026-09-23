// Join actual processor+queue to actual whole postReply+voice+eligibility.
// Orchestrator, output gate and provider decisions remain explicit fixtures.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {harness:processor}=require('./test-slack-thread-boundaries.cjs');
const {harness:voice}=require('./test-slack-voice-readiness.cjs');
for(const mode of ['unknown','confirmed','preparation-failed'])test(`actual processor voice ${mode} history and completion boundary`,async()=>{
 const v=voice({uploadError:mode==='unknown',ttsError:mode==='preparation-failed'});
 const p=processor({postReply:input=>v.post(input)});
 await p.turn({voiceInput:true,text:'[Voice message]: שלום'});await p.fire();await new Promise(r=>setImmediate(r));
 assert.equal(p.runs.length,1);assert.equal(p.runs[0].authority,'owner');assert.equal(p.runs[0].surface,'owner_dm');
 assert.equal(v.s.uploads.length,mode==='preparation-failed'?0:1);
 assert.equal(p.posts.length,mode==='preparation-failed'?1:0,'unknown audio cannot emit processor failure apology');
 assert.equal(v.s.history.length,mode==='unknown'?0:1);
 assert.equal(p.logs.some(row=>String(row[1]).includes('Turn failed after')),false);
});
const incoming={user:'UOWNER',ts:'100.000001',text:'',subtype:'file_share',files:[{mimetype:'audio/webm'}]};
for(const outcome of ['accepted-visible','not-visible','history-unavailable'])test(`actual recovery after unknown audio ${outcome}`,async()=>{
 const p=processor({replies:()=>{if(outcome==='history-unavailable')throw Error('no history');return {ok:true,messages:[incoming,...outcome==='accepted-visible'?[{user:'UBOT',bot_id:'B',ts:'101.000001',subtype:'file_share',files:[{mimetype:'audio/mpeg'}]}]:[]]};}});
 const result=await p.load('src/core/background.ts').boundaryProbe.findUnansweredInThread({...p.checkOpts,channelId:'DOWNER'},'100.000001');
 assert.equal(Boolean(result),outcome==='not-visible','unobservable acceptance remains replay eligible; no durable receipt is claimed');
});
