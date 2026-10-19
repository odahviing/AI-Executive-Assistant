// Actual humanGate, controlled model verdicts. Prompt capture proves the
// evidence boundary and deterministic rewrite handling, never model obedience.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {harness,profile,verdict}=require('./test-gatekeeper-readiness.cjs');
const facts=JSON.stringify({items:[
 {kind:'calendar_today',events:[{event_id:'gartner-event',subject:'To Be Rescheduled: Reflectiz-Gartner//Sync',subject_source:'calendar_invite'}]},
 {kind:'outreach',meeting_id:'elan-event',meeting_subject:'Elan & Idan - Triweekly',state:'awaiting_colleague',awaitsReply:true}
],healthSummary:null,slotHoldsSummary:'- Levana: Wed 21 Oct 11:15 and 12:15, held 16h'});
const gate=(h,draft,audience='owner',evidence=facts)=>h.human.runHumanGate(draft,profile,audience,undefined,false,false,undefined,evidence);
test('brief truth boundary receives exact distinct event and tracked-request evidence in existing call',async()=>{
 const h=harness();await gate(h,'The Gartner sync is at 14:30. I am checking whether the pending reschedule is that one.');
 assert.equal(h.calls.length,1);const input=JSON.parse(h.calls[0].messages[0].content);
 assert.equal(input.briefingEvidence,facts);assert.ok(h.calls[0].system.includes("meeting_id to the calendar event_id"));
 assert.ok(h.calls[0].system.includes('awaiting_colleague'));assert.ok(h.calls[0].system.includes('minimal correction'));
});
test('brief waiting boundary receives hold-age facts and preserves real deadlines in its contract',async()=>{
 const h=harness();await gate(h,'The candidate has not replied after 16 hours.');
 assert.equal(JSON.parse(h.calls[0].messages[0].content).briefingEvidence,facts);
 assert.ok(h.calls[0].system.includes("reservation's age, not how long its candidate has had to respond"));
 assert.ok(h.calls[0].system.includes('actual response deadlines, expiry'));
 assert.ok(h.calls[0].system.includes('or infer an overdue response from hold age'));
});
test('brief contract distinguishes unsupported work from a real tracked commitment or proposed next step',async()=>{
 const h=harness();await gate(h,'I can ask whether the Gartner sync needs a new time.');
 assert.ok(h.calls[0].system.includes('A proposal is not a report that work has begun'));
 assert.ok(h.calls[0].system.includes('Preserve a legitimate tracked commitment'));
 assert.ok(!h.calls[0].system.includes('You judge voice, not who owns a task'));
});
for(const [name,draft,rewrite] of [
 ['unsupported-work','Gartner at 14:30 is titled To Be Rescheduled. I am checking that now. Elan has not replied.','Gartner at 14:30 is titled To Be Rescheduled. Elan has not replied.'],
 ['hold-age','Holding Wednesday at 11:15 and 12:15. The candidate has not replied after 16 hours.','Holding Wednesday at 11:15 and 12:15 while we wait for confirmation.'],
 ['hebrew','שומרת את 11:15 ואת 12:15. המועמד לא ענה כבר 16 שעות.','שומרת את 11:15 ואת 12:15 עד לקבלת אישור.'],
])test('controlled minimal correction accepted '+name,async()=>{const h=harness([verdict(false,rewrite)]);const result=await gate(h,draft);assert.equal(result.ok,false);assert.equal(result.rewrite,rewrite);assert.equal(h.calls.length,1)});
for(const draft of ['Elan has not replied to the Triweekly proposal.','The confirmation deadline is today at 17:00.','I can ask the organizer whether this needs a new time.'])test('preserved clear legitimate status '+draft,async()=>{const h=harness();assert.equal((await gate(h,draft)).ok,true);assert.equal(h.calls.length,1)});
test('preserved dropped deadline retries with same facts then safely keeps owner original',async()=>{
 const h=harness([verdict(false,'Waiting for confirmation.'),verdict(false,'Still waiting.')]);
 const r=await gate(h,'Waiting for confirmation; deadline 17:00.');
 assert.equal(r.ok,true);assert.equal(r.rewrite,null);assert.equal(h.calls.length,2);
 assert.ok(h.calls[1].messages[0].content.includes('17:00'));assert.ok(h.calls[1].messages[0].content.includes('gartner-event'));
});
for(const response of [new Error('unavailable'),{content:[]}])test('preserved unknown verdict does not invent a result '+String(response),async()=>{
 const h=harness([response]);const r=await gate(h,'Waiting for confirmation at 11:15.');assert.equal(r.ok,true);assert.equal(r.rewrite,null);
});
for(const audience of ['internal','external'])test('owner brief facts withheld from '+audience,async()=>{
 const h=harness();await gate(h,'Please forward the invite.',audience);assert.equal(h.calls[0].messages[0].content,'Please forward the invite.');assert.ok(!h.calls[0].system.includes('BRIEFING EVIDENCE'));
});
test('ordinary owner reply preserves original voice-only contract without facts',async()=>{
 const h=harness();await h.human.runHumanGate('Let me check and come back to you.',profile,'owner');assert.equal(h.calls.length,1);assert.ok(h.calls[0].system.includes('You judge voice, not who owns a task'));assert.ok(!h.calls[0].system.includes('BRIEFING EVIDENCE'));
});
