// Actual SchedulingSkill dispatcher/return boundary and actual graph finder/checkSlot.
// Handler adapters below isolate Graph/DB and package actual finder output; no extracted production code.
const fs=require('fs'),path=require('path'),vm=require('vm'),ts=require('typescript'),assert=require('node:assert/strict');
const {test}=require('node:test'),{harness}=require('./test-timezone-owner-interval.cjs');
const root=path.resolve(__dirname,'..'),rel='src/skills/meetings/ops.ts';
function boundary(value,channel='email',senderRole='owner',surface='dm',tool='find_available_slots'){
 const file=process.env.EMAIL_MECHANICS_BEFORE?path.join(root,process.env.EMAIL_MECHANICS_BEFORE,rel):path.join(root,rel);
 const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const mod={exports:{}},handle=async()=>structuredClone(value);
 const imports={'../../utils/scheduleRules':harness().load('src/utils/scheduleRules.ts'),'./ops/analysis':{},'./bookingRequest':{grantRelaxed:()=>({granted:true})},'./ops/handlers/findAvailableSlots':{handleFindAvailableSlots:handle},'./ops/handlers/createMeeting':{handleCreateMeeting:handle},'./ops/handlers/moveMeeting':{},'./ops/handlers/calendarReads':{}};
 vm.runInThisContext('(function(require,module,exports){'+js+'\n})',{filename:file})(id=>{assert.ok(id in imports,id);return imports[id];},mod,mod.exports);
 return new mod.exports.SchedulingSkill().executeToolCall(tool,{}, {channel,senderRole,surface,profile:{user:{name:'Owner Example',email:'owner@example.test',timezone:'Asia/Jerusalem'}}});
}
const plain=x=>JSON.parse(JSON.stringify(x));
test('regression email retains identity-free attendee-hours attribution before privacy scrub',async()=>{
 const out=await boundary({slots:[],day_summary:[{date:'2026-10-21',accepted:0,top_reasons:['outside_attendee_work_hours'],blocked_by:[{email:'private@example.test'}],attendee_hours_note:['private hours']}]});
 assert.match(out._scheduling_decision_note,/not by a demonstrated conflict on the owner's calendar/);
 assert.ok(!JSON.stringify(out).includes('private@example.test'));
 assert.equal(out.day_summary[0].attendee_hours_note,undefined);
});
test('preserved mixed owner conflict does not become attendee-only attribution',async()=>{
 const out=await boundary({slots:[],day_summary:[{date:'2026-10-21',accepted:0,top_reasons:['outside_attendee_work_hours','owner_busy_collision']}]});
 assert.doesNotMatch(out._scheduling_decision_note??'',/limited by an attendee's working-hours window/);
});
for(const shape of ['candidate','preferred','day_summary'])for(const [category,reasons,expected] of [
 ['attendee',['outside_attendee_work_hours:private@example.test'],/attendee.*working-hours/],
 ['owner',['owner_busy_collision'],/owner-side scheduling constraints/],
 ['mixed',['outside_attendee_work_hours:private@example.test','owner_busy_collision'],/attendee availability and other scheduling constraints/],
 ['unknown',['future_rule:private@example.test'],/does not establish whose calendar/],
])test('regression email '+shape+' projects '+category+' without identities or authority',async()=>{
 const item={available:false,start:'fixed-start',end:'fixed-end',broken_rule:reasons[0],broken_rules:reasons.slice(1),broken_rule_label:'private subject',attendee_hours_note:'private hours'};
 const value=shape==='candidate'?{results:[item]}:shape==='preferred'?{preferred_slot_status:item}:{slots:[],day_summary:[{accepted:0,top_reasons:reasons,blocked_by:[{email:'private@example.test'}]}]};
 const out=await boundary(value),scoped=shape==='candidate'?out.results[0]:shape==='preferred'?out.preferred_slot_status:out;
 assert.match(scoped._scheduling_decision_note,expected);
 assert.doesNotMatch(JSON.stringify(out),/private@example|private subject|private hours|future_rule/);
 if(shape!=='day_summary'){assert.equal(scoped.available,false);assert.equal(scoped.start,'fixed-start');assert.equal(scoped.end,'fixed-end');}
 assert.equal(out.slots?.length??0,0);
});
test('regression candidate validation failure remains unconfirmed without invented calendar blame',async()=>{
 const out=await boundary({results:[{available:false,error:'validation_error',start:'fixed',end:'end'}]});
 assert.equal(out.results[0].available,false);assert.equal(out.results[0].error,'validation_error');
 assert.match(out.results[0]._scheduling_decision_note,/could not be established/);
 assert.match(out.results[0]._scheduling_decision_note,/does not establish a calendar conflict/);
});
test('preserved partial days and successful candidates do not acquire a rejection',async()=>{
 const out=await boundary({results:[{available:true,start:'fixed',end:'end'}],day_summary:[{accepted:1,top_reasons:[]}]});
 assert.equal(out._scheduling_decision_note,undefined);assert.equal(out.results[0]._scheduling_decision_note,undefined);assert.equal(out.results[0].available,true);
});
test('preserved full-day occupancy explanation and bounded recovery instructions survive projection',async()=>{
 for(const occupied of [false,true]){
  const note=occupied?'All-day commitment; earlier or later attendee hours cannot remove it. Busy alone is not vacation.':'Obtain a specific bounded local window and timezone; search consent is not booking authority.';
  const out=await boundary({_scheduling_decision_note:note,slots:[],day_summary:[{accepted:0,top_reasons:['outside_attendee_work_hours','owner_busy_collision'],...(occupied?{owner_all_day_busy:true}:{})}]});
  assert.ok(out._scheduling_decision_note.includes(note));
  assert.doesNotMatch(out._scheduling_decision_note,/limited by an attendee's working-hours window/);
 }
});
async function actualSlots(){const h=harness();h.profile.meetings.work_hours_per_free_hour=1;const slots=await h.find('2026-09-14T12:00:00+03:00','2026-09-14T12:25:00+03:00',{relaxed:true,viewer:'owner'});assert.equal(slots.length,1);assert.ok(slots[0].broken_rule_label);assert.ok(slots[0].broken_rules.includes('focus_time_floor'));return slots;}
for(const shape of ['bare','wrapped'])test('regression actual focus finder '+shape+' email payload withholds mechanics and retains slots',async()=>{const slots=await actualSlots();const input=shape==='bare'?slots:{slots,_relaxed_recovery:true,_recovery_note:'focus floor'};const out=await boundary(input),got=shape==='bare'?out:out.slots;assert.equal(got.length,slots.length);assert.equal(got[0].start,slots[0].start);assert.equal(got[0].end,slots[0].end);for(const key of ['broken_rule_label','broken_rules','disturbs_floating_block','day_type','density'])assert.equal(got[0][key],undefined,key);assert.equal(got[0].less_preferred_label,'requires confirmation');assert.equal(out._relaxed_recovery,undefined);});
test('regression candidate and preferred-slot diagnostics retain availability and computed clocks',async()=>{const slot={start:'2026-11-03T10:00:00-05:00',end:'2026-11-03T10:25:00-05:00',presentation_local:'17:00 Jerusalem',available:false,broken_rule:'focus_time_floor',broken_rule_label:'focus floor'};const out=await boundary({results:[slot],preferred_slot_status:{...slot,_note:'focus floor'},day_summary:[{date:'2026-11-03',accepted:0,top_reasons:['focus_time_office']}]});for(const item of [out.results[0],out.preferred_slot_status]){assert.equal(item.available,false);assert.equal(item.presentation_local,slot.presentation_local);assert.equal(item.broken_rule_label,undefined);assert.equal(item._note,undefined);}assert.equal(out.day_summary[0].top_reasons,undefined);assert.equal(out.day_summary[0].accepted,0);});
test('regression refusal carrier without attendee note is scoped without success claim',async()=>{const out=await boundary({success:false,error:'rule_violation',violation_label:'lunch',suggested_ask_text:'Override lunch?',open_questions:['lunch'],_ask_all_at_once:'lunch',_note:'lunch'},'email','owner','dm','create_meeting');assert.equal(out.success,false);assert.equal(out.suggested_ask_text,undefined);assert.equal(out.open_questions,undefined);assert.ok(!JSON.stringify(out).includes('lunch'));});
test('preserved actual finder diagnostics remain in owner DM and owner-authenticated payloads',async()=>{const slots=await actualSlots();for(const [role,surface] of [['owner','dm'],['owner','room']])assert.deepEqual(plain(await boundary({slots},'slack',role,surface)),plain({slots}));});
test('preserved ordinary successful booking, location question and clean search slots',async()=>{for(const value of [{success:true,id:'event',start:'time',end:'end',join_url:'https://example.test/join'},{success:false,error:'location_mode_unspecified',suggested_ask_text:'Onsite or online?'},[{start:'time',end:'end',label:'Monday 10:00',presentation_local:'17:00 Jerusalem'}]])assert.deepEqual(plain(await boundary(value,'email','owner','dm','create_meeting')),value);});
test('preserved email attendee privacy and unavailable identity-free honesty',async()=>{const out=await boundary({slots:[{start:'time',end:'end',over_optional:'secret',attendee_status:[{email:'peer'}],attendee_conflicts:[{email:'peer'}]}],attendees_not_checked:['peer'],unresolved_attendee_emails:['missing'],day_summary:[{date:'day',accepted:0,blocked_by:[{email:'peer'}],attendee_partial_conflicts:[{email:'peer'}],attendee_hours_note:'peer hours'}]});assert.ok(out._unverified_availability_notice);assert.ok(!JSON.stringify(out).includes('peer'));assert.ok(!JSON.stringify(out).includes('missing'));assert.ok(!JSON.stringify(out).includes('secret'));});
test('preserved email attendee refusal removes private details and retains failure',async()=>{const out=await boundary({success:false,error:'rule_violation',violation_label:'peer busy',_attendee_busy_note:'peer busy',suggested_ask_text:'peer busy?',open_questions:['peer busy']},'email','owner','dm','create_meeting');assert.equal(out.success,false);assert.ok(!JSON.stringify(out).includes('peer'));});
test('preserved null and primitive unknown results unchanged',async()=>{for(const value of [null,'unavailable',false])assert.equal(await boundary(value),value);});

for(const reason of ['vacation_or_off_day','owner_out_of_office'])for(const shape of ['candidate','preferred','day_summary'])test('regression trusted absence '+reason+' survives '+shape+' mixed privacy projection',async()=>{
 const item={available:false,start:'fixed',end:'end',broken_rule:reason,broken_rule_label:'PRIVATE detail',broken_rules:['outside_attendee_work_hours:private@example.test'],attendee_hours_note:'PRIVATE hours'};
 const input=shape==='candidate'?{results:[item]}:shape==='preferred'?{preferred_slot_status:item}:{slots:[],day_summary:[{date:'2026-09-14',accepted:0,top_reasons:[reason,'outside_attendee_work_hours'],blocked_by:[{email:'private@example.test'}]}]};
 const out=await boundary(input),scoped=shape==='candidate'?out.results[0]:shape==='preferred'?out.preferred_slot_status:out;
 if(shape==='day_summary')assert.deepEqual(plain(out.day_summary[0].top_reasons),[reason]);else {assert.equal(scoped.broken_rule,reason);assert.equal(scoped.available,false);assert.match(scoped.broken_rule_label,/owner.*(?:off|out of office)/);}
 assert.match(scoped._scheduling_decision_note,/owner.*(?:off|out of office)/);assert.match(scoped._scheduling_decision_note,/attendee availability/i);
 assert.doesNotMatch(JSON.stringify(out),/PRIVATE|private@example/);
});
test('control successful or failed-check records cannot acquire authoritative absence',async()=>{
 const out=await boundary({results:[{available:true},{available:false,error:'validation_error',broken_rule:'owner_out_of_office'}],day_summary:[{accepted:1,top_reasons:['vacation_or_off_day']}]});
 assert.equal(out.results[0].broken_rule,undefined);assert.equal(out.results[1].broken_rule,undefined);assert.match(out.results[1]._scheduling_decision_note,/could not be established/);assert.equal(out.day_summary[0].top_reasons,undefined);
});
test('regression secondary owner absence survives mixed candidate projection without attendee OOF promotion',async()=>{
 const out=await boundary({results:[{available:false,broken_rule:'outside_attendee_work_hours:private@example.test',broken_rules:['owner_out_of_office']},{available:false,broken_rule:'attendee_out_of_office:private@example.test'}]});
 assert.equal(out.results[0].broken_rule,'owner_out_of_office');assert.match(out.results[0]._scheduling_decision_note,/Attendee availability is also constrained/);
 assert.equal(out.results[1].broken_rule,undefined);assert.match(out.results[1]._scheduling_decision_note,/attendee availability/);assert.doesNotMatch(JSON.stringify(out),/private@example/);
});
