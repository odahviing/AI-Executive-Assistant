const {test}=require('node:test'),assert=require('node:assert/strict');
const {harness,profile,verdict}=require('./test-gatekeeper-readiness.cjs');
const good="[create_meeting OK — Booked 'Customer Status' for Mon 16 Nov 10:15–10:40 (America/New_York). [invited: ayalla@example.test, elinor@example.test]] mutated=book";
const search='[find_available_slots dur=25m → 1 slots: Wednesday 09:15 attendee_status=busy] attendee_check=slots';
for(const trusted of [true,false])test('older action evidence survives a later read only when typed: '+trusted,async()=>{
 const seen=[];const h=harness([verdict(true)],{'src/utils/claimChecker.ts':{checkReplyClaims:async input=>{seen.push(input);return {claimed_action:false}}}});
 const history=[{role:'assistant',content:good+'\nBooked.',...(trusted?{toolSummaries:[good]}:{})},{role:'user',content:'What about Wednesday?'},{role:'assistant',content:search+'\nBusy.',toolSummaries:[search]}];
 await h.gates.runOutputGates('The invite was already sent.',{profile,result:{toolSummaries:['[get_calendar: 2 events]'],bookingOccurred:false},history,userMessage:'Can you send the invite?',senderId:'UELINOR',channelId:'DEL',threadTs:'1',role:'colleague'});
 const ctx=seen.find(x=>x.mode==='owner_fact')?.finalOutcomeContext;
 assert.ok(ctx,'fact checker ran');assert.equal(ctx.includes(good),trusted);assert.ok(ctx.includes(search));
});
