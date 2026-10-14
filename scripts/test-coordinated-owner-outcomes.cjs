/* Real resolver/replay/runner/relay through the existing isolated calendar fixture.
 * No Graph, Slack or LLM calls. Saved pre-a4 sources use the same fixture loader. */
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const filename=path.join(__dirname,'test-coordinated-approval-replay.cjs');
let source=fs.readFileSync(filename,'utf8');
source=source.replace("module.exports=harness;',__filename)","module.exports=harness; module.exports.profile=profile;',__filename)");
const m=new Module(filename,module);m.filename=filename;m.paths=module.paths;
const req=m.require.bind(m);m.require=id=>id==='node:test'?{test(){}}:req(id);
m._compile(source+'\nmodule.exports={fixture,lifecycle,plan,durableRestart};',filename);
const {fixture,lifecycle,plan,durableRestart}=m.exports;
function unknownAfterFirst(options={}){
 let f;f=fixture({...options,failEvent:'oct11',verification:p=>f?.p.h.state.writes.length&&p.args.meeting_id==='oct11'
  ?{status:'unavailable',reason:'calendar_read_failed'}:undefined});return f;
}
function privateOnly(f){
 for(const send of f.h.effects.sends){assert.doesNotMatch(send.body,/First|Second|oct11|sep2|13:30|14:10|14:15|14:55|17:15/);}
 assert.equal(f.h.effects.owner.length,1);assert.doesNotMatch(f.h.effects.owner[0],/oct11|sep2/);f.h.check();
}
test('N01 C22 owner receives confirmed label and unknown exact target, once',async()=>{
 const f=unknownAfterFirst();const r=await f.h.resolve();const text=f.h.effects.owner[0];
 assert.match(text,/Second: confirmed at 2026-10-14T14:15Z – 2026-10-14T14:55Z/);
 assert.match(text,/Meeting 1: outcome unconfirmed; requested 2026-10-14T13:30Z – 2026-10-14T14:10Z/);
 assert.match(text,/request is closed; no automatic retry or check is pending/);
 assert.equal(r.outcomes.find(o=>o.meeting_id==='sep2').moved,'Second');
 assert.deepEqual(f.p.h.state.writes.map(w=>w.meetingId),['sep2']);
 await f.h.resolve();assert.equal(f.h.effects.sends.length,1);privateOnly(f);
});
test('N02 expiry reports known different state and retained confirmed label',async()=>{
 const f=fixture({failEvent:'oct11'});await f.h.resolve();f.h.update(f.h.row().id,{nextCheckAt:'2020-01-01T00:00:00Z'});await f.h.sweep();
 assert.match(f.h.effects.owner[0],/Meeting 1: calendar check did not match the requested interval 2026-10-14T13:30Z – 2026-10-14T14:10Z/);
 assert.match(f.h.effects.owner[0],/Second: confirmed at 2026-10-14T14:15Z – 2026-10-14T14:55Z/);
 assert.equal(f.h.row().state,'resolved');assert.equal(f.h.row().next_check_handler,null);privateOnly(f);
});
test('N03 unavailable preflight uses original approved plan ordinals without invented names',async()=>{
 const f=fixture({verification:{status:'unavailable',reason:'calendar_read_failed'}});await f.h.resolve();
 const text=f.h.effects.owner[0];assert.match(text,/Meeting 1: outcome unconfirmed; requested 2026-10-14T13:30Z/);
 assert.match(text,/Meeting 2: outcome unconfirmed; requested 2026-10-14T14:15Z/);assert.doesNotMatch(text,/First|Second/);
 assert.equal(f.h.effects.executes.length,0);privateOnly(f);
});
test('N04 owner interval converts to owner timezone with exact offsets',async()=>{
 lifecycle.profile.user.timezone='Asia/Jerusalem';
 try{const f=unknownAfterFirst();await f.h.resolve();assert.match(f.h.effects.owner[0],/Second: confirmed at 2026-10-14T17:15\+03:00 – 2026-10-14T17:55\+03:00/);privateOnly(f);}
 finally{lifecycle.profile.user.timezone='UTC';}
});
test('N05 room-origin partial closure keeps all event detail in private owner notice',async()=>{
 const f=unknownAfterFirst({room:true,row:{origin_channel:'CROOM',origin_is_mpim:1}});await f.h.resolve();
 assert.equal(f.h.effects.sends[0].id,'CROOM');assert.match(f.h.effects.owner[0],/confirmed at.*14:15Z/);privateOnly(f);
});
test('N06 colleague acceptance gets no detailed result but owner gets full status',async()=>{
 const f=unknownAfterFirst({row:{state:'awaiting_colleague'}});const r=await f.h.resolve('approve',{resolvedByColleague:true,resolvingUserId:'COLLEAGUE'});
 assert.equal(r.outcomes,undefined);assert.match(f.h.effects.owner[0],/Second: confirmed at/);privateOnly(f);
});
test('N07 durable prior outcome closure reports remaining-only target as not completed',async()=>{
 const f=fixture();const targets=plan().coordinated_moves;
 f.h.update(f.h.row().id,{outcomeJson:{approved:true,replayed:'move_meeting',verified:false,outcomes:[{...targets[1],success:true,unchanged:true}],remaining:[targets[0]]}});
 const resumed=durableRestart(f);await resumed.h.resolve();const text=resumed.h.effects.owner[0];
 assert.match(text,/Meeting 1: not completed; requested 2026-10-14T13:30Z – 2026-10-14T14:10Z/);
 assert.match(text,/Meeting 2: confirmed at 2026-10-14T14:15Z/);assert.doesNotMatch(text,/not attempted|moved/);
 assert.equal(resumed.h.effects.executes.length,0);privateOnly(resumed);
});
test('N08 full coordinated completion preserves successful requester outcome',async()=>{
 const f=fixture();const r=await f.h.resolve();assert.equal(r.ok,true);assert.equal(r.outcomes.length,2);
 assert.match(f.h.effects.sends[0].body,/every meeting.*agreed time/);assert.doesNotMatch(f.h.effects.owner.join('\n'),/outcome unconfirmed|not completed/);f.h.check();
});
test('N09 singular uncertain execution retains its original terminal notice',async()=>{
 const h=lifecycle({row:{outcome_json:JSON.stringify({approved:true,replayed:'move_meeting',verified:false})}});
 await h.resolve();assert.equal(h.effects.owner.length,1);assert.doesNotMatch(h.effects.owner[0],/Meeting 1|calendar plan/);h.check();
});
for(const [lang,unknown,confirmed] of [['he','התוצאה אינה מאושרת','אושר ביומן'],['de','Ergebnis unbestätigt','bestätigt für'],['es','resultado sin confirmar','confirmado para'],['ar','النتيجة غير مؤكدة','مؤكد في'],['ru','результат не подтверждён','подтверждено на']]){
 test('N10 localized owner statuses '+lang,async()=>{const f=unknownAfterFirst({lang});await f.h.resolve();
  assert.ok(f.h.effects.owner[0].includes(unknown));assert.ok(f.h.effects.owner[0].includes(confirmed));privateOnly(f);
 });
}
