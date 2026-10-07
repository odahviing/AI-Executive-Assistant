// Actual handler -> actual finder/checkSlot -> actual compact history summary.
// Isolated calendar/people I/O; fixed clock. No writes, network or LLM.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const file=path.join(__dirname,'test-timezone-owner-interval.cjs'),mod={exports:{}};
let source=fs.readFileSync(file,'utf8').split('if(require.main===module)')[0]
 .replace("'src/utils/attendeeAvailability.ts':{attendeeTzForDay:e=>e.timezone},",'')
 .replace("if(rel==='src/connectors/graph/calendar.ts')return {...mocks['src/connectors/graph/calendarReads.ts'],","if(rel==='src/connectors/graph/calendar.ts')return {...mocks['src/connectors/graph/calendarReads.ts'],...options.calendar,")
 .replace("const before=process.env.SLOT_PRIORITY_BEFORE", "const before=process.env.GARAGE_BEFORE && rel === 'src/skills/meetings/ops/handlers/findAvailableSlots.ts' ? path.join(root,process.env.GARAGE_BEFORE,rel) : process.env.SLOT_PRIORITY_BEFORE");
vm.runInNewContext(source,{require:createRequire(file),module:mod,__dirname,process,console,Date,Buffer,setTimeout,clearTimeout});
const email='peer@example.test',zone='Asia/Jerusalem';
const prefixes=['attendee_busy_collision','outside_attendee_work_hours','attendee_out_of_office'];
async function run({clean=false,busy=false,offhours=false,offline=false,unknown=false,role='owner',mustBe=false,multi=false,argsOverride={},contacts=[],availabilityOverride,workHoursOverride}={}) {
 const availability=availabilityOverride??[{email,timezone:zone,week:require('./fixtures/regular-week.cjs').regularWeek(['Sunday','Monday','Tuesday','Wednesday','Thursday'],offhours?'20:00':'09:00',offhours?'21:00':'18:00')}];
 const h=mod.exports.harness(multi?{'2026-10-05':{isWorkday:false}}:{}, {offline, calendar:{oofUntilDisplayFor:()=>undefined,GraphPermissionError:class extends Error{},firstRejectReason:d=>Object.keys(d??{})[0]},extraMocks:{
  'src/skills/meetings/ops/analysis.ts':{},'src/skills/meetings/ops/handlers/createMeeting.ts':{},'src/skills/meetings/ops/handlers/moveMeeting.ts':{},'src/skills/meetings/ops/handlers/calendarReads.ts':{},
  'src/skills/meetings/ops/violationLabels.ts':{humanizeViolationLabel:x=>x,attendeeFirstName:()=> 'Peer',attendeeConflictLine:c=>c.email+' '+c.reason},
  'src/skills/meetings/bookingRequest.ts':{grantRelaxed:()=>({relaxed:false})},
  'src/db/slotHolds.ts':{getActiveSlotHolds:()=>[]},'src/utils/offeredSlotsStash.ts':{getOfferedSlots:()=>[],getOfferedSearchFingerprint:()=>null,recordOfferedSlots:()=>{}},
  'src/db.ts':{getPersonMemory:()=>({}),getPersonByEmail:()=>({name:'Peer'}),listSchedulingContacts:()=>contacts,getEffectiveTimezoneById:id=>({timezone:contacts.find(p=>p.person_id===id)?.timezone}),getTravelRecordById:()=>null},
  'src/utils/displaySubject.ts':{subjectViewerFor:()=> 'owner',viewerEmailFor:()=>undefined},
  'src/connectors/graph/calendarReads.ts':{getFreeBusyForDecision:async(_u,_e,_s,_t,_z,diag)=>{if(unknown&&diag)diag.notChecked=[email];return {[email]:busy?[{start:'2026-10-06T00:00:00+03:00',end:'2026-10-07T00:00:00+03:00',status:'busy'}]:[]}},getOwnerEventsForDecision:async()=>{if(offline)throw Error('fixture calendar unavailable');return []},isOutageShaped:()=>false,CalendarOfflineError:Error},
 }});
 Object.assign(h.load('src/utils/attendeeAvailability.ts'),{loadAttendeeAvailabilityForEmails:()=>availability,singleAttendeePresentationZone:()=>undefined});
 h.profile.schedule.work_hours=workHoursOverride??Object.fromEntries(['Sunday','Monday','Tuesday','Wednesday','Thursday'].map(d=>[d,['09:00-18:00']]));
 h.profile.meetings.work_hours_per_free_hour=clean?0:1;
 const args={search_from:multi?'2026-10-05T09:00:00+03:00':'2026-10-06T09:00:00+03:00',search_to:'2026-10-06T18:00:00+03:00',duration_minutes:40,meeting_mode:'online',attendee_emails:[email],must_be:mustBe,...argsOverride};
 const out=await new(h.load('src/skills/meetings/ops.ts').SchedulingSkill)().executeToolCall('find_available_slots',args,{profile:h.profile,channel:'slack',senderRole:role,userId:'UOWNER',channelId:'fixture',threadTs:'fixture'});
 const summary=h.load('src/core/orchestrator/turnHelpers.ts').summarizeToolCall('find_available_slots',args,out,zone);
 return {out,summary,warnings:h.warnings,calls:h.calls};
}
module.exports={run};
for(const role of ['owner','colleague'])test('recovery '+role+' uses final candidate day facts, not strict offhours blame',async()=>{const {out,summary,warnings}=await run({role,mustBe:role==='colleague'});assert.equal(warnings.length,0,JSON.stringify(warnings));const offers=out.slots?.length?out.slots:out.owner_approval_candidates;assert.ok(offers.length);const day=out.day_summary.find(d=>d.date==='2026-10-06');assert.ok(day.accepted>0);assert.equal(day.blocked_by,undefined);assert.ok(!day.top_reasons.includes('outside_attendee_work_hours'));assert.ok(!summary.includes('attendee_blocked='),summary);});
test('preserved clean offers and retry produce identical history facts',async()=>{const a=await run({clean:true}),b=await run({clean:true});assert.ok(a.out.slots.length);assert.equal(a.summary,b.summary);assert.ok(!a.summary.includes('attendee_blocked='));});
test('preserved true offhours empty day remains grounded',async()=>{const {out,summary}=await run({offhours:true});assert.equal(out.slots.length,0);assert.ok(out.day_summary[0].top_reasons.includes('outside_attendee_work_hours'));assert.ok(out.day_summary[0].attendee_hours_note?.length);assert.match(summary,/outside_attendee_work_hours/);});
test('tagged busy fallback uses accepted day and retains actual per-slot conflict',async()=>{const {out,summary}=await run({clean:true,busy:true});assert.ok(out.slots.length);assert.ok(out.slots.every(s=>s.attendee_conflicts.some(c=>c.reason==='busy')));assert.ok(out.day_summary[0].accepted>0);assert.ok(!summary.includes('attendee_blocked='),summary);});
test('preserved unavailable calendar cannot fabricate offers',async()=>{await assert.rejects(()=>run({offline:true}),/fixture calendar unavailable/);});
test('preserved recovered multi-day search retains real earlier offday',async()=>{const {out}=await run({multi:true});assert.ok(out.slots.length);const friday=out.day_summary.find(d=>d.date==='2026-10-05');assert.equal(friday.accepted,0);assert.ok(friday.top_reasons.length);});


test('preserved unknown attendee calendar stays explicit on recovered offers',async()=>{const {out}=await run({unknown:true});assert.ok(out.slots.length);assert.ok(out.attendees_not_checked.includes(email));assert.match(out._attendee_not_checked_warning,/NOT confirmed-free/);});

test('colleague owner-only fallback retains accepted-day facts and unverified calendar disclosure',async()=>{const {out,summary}=await run({clean:true,busy:true,role:'colleague'});assert.ok(out.slots.length);assert.ok(out.day_summary[0].accepted>0);assert.ok(!summary.includes('attendee_blocked='),summary);assert.ok(out._attendee_unverified_note,JSON.stringify(out));});

