const {test}=require('node:test'),assert=require('node:assert/strict');
const {planner}=require('./test-dina-owner-roster.cjs');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const chosen={clock:'11:00',zone:'Asia/Jerusalem',quote:'Book at 11:00 Israel time'};
function run(extra={},opts={}){const h=planner({offHours:true,...opts});return h.plan({...h.input,intent:'new_booking',exactRequestClock:chosen,...extra});}
test('owner named clock books outside attendee hours with a notice on first attempt',async()=>{
 const r=await run();assert.equal(r.action,'book');assert.match(r.overrideNotice,/outside.*working hours/);
});
test('a computed time or another requested clock retains the hours decision',async()=>{
 for(const exactRequestClock of [undefined,{...chosen,clock:'12:00'},{...chosen,zone:'America/New_York'}])assert.equal((await run({exactRequestClock})).action,'confirm_override');
});
test('choosing a clock does not skip a previously undisclosed busy conflict',async()=>{
 assert.equal((await run({}, {peerBusy:true})).action,'confirm_override');
});
test('conditional availability still refuses outside hours',async()=>{
 assert.equal((await run({requireAttendeeAvailability:true})).action,'attendee_condition_unmet');
});
test('the booking adapter carries authenticated clock context, never raw model flags',()=>{
 const h=planner();const req={intent:'new_booking',initiator:'owner',participants:[],context:{surface:'owner_dm',channel:'slack',exactRequestClock:chosen},_origin:{rawArgs:{start_is_explicit:true}}};
 assert.deepEqual(h.adapt(req,h.input.profile).exactRequestClock,chosen);
 assert.equal(h.adapt({...req,context:{surface:'room',channel:'slack'}},h.input.profile).exactRequestClock,undefined);
});
test('normalizer binds clock authority to the direct authenticated human instruction',async()=>{
 const m={exports:{}};const deps={
  '../../utils/meetingDuration':{},'../../db/people':{getPersonMemory:()=>null},
  '../../utils/displaySubject':{viewerEmailFor:()=>undefined},
  '../../utils/logger':{default:{info(){},warn(){}}},
 };
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/skills/meetings/bookingRequest.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:m,exports:m.exports,require:n=>{assert.ok(n in deps,n);return deps[n]}});
 const context={profile:{user:{email:'owner@example.test'},meetings:{}},channel:'slack',surface:'owner_dm',senderRole:'owner',typedUserMessage:chosen.quote,exactRequestClock:chosen};
 for(const [patch,expected]of [[{},chosen],[{senderRole:'colleague'},undefined],[{surface:'room'},undefined],[{typedUserMessage:'Quoted text is not my instruction'},undefined],[{typedUserMessage:undefined},undefined]]){
  const r=await m.exports.normalizeBookingRequest('create_meeting',{start_is_explicit:true},{...context,...patch});
  assert.deepEqual(r.context.exactRequestClock,expected);
 }
});
