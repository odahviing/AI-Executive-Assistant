const assert = require('node:assert/strict');
const { test } = require('node:test');
const { run } = require('./test-garage-recovery-summary.cjs');

test('a date-window extraction without a length retains the planner supplied meeting length',async()=>{
 const {out}=await run({clean:true,role:'colleague',meetingsOverride:{allowed_durations:[25,40,55],default_meeting_duration:25},
  contextOverride:{meetingRequestId:'request',requestedSearchWindow:{start:'2026-10-06T09:00',end:'2026-10-06T12:30',zone:'Asia/Jerusalem'}},
  argsOverride:{duration_minutes:45}});
 assert.ok(out.slots.length);
 for(const slot of out.slots) assert.equal((Date.parse(slot.end)-Date.parse(slot.start))/60000,40);
});

test('an explicit carried human length takes priority over a stale planner default',async()=>{
 const {out}=await run({clean:true,role:'colleague',meetingsOverride:{allowed_durations:[25,40,55]},
  contextOverride:{meetingRequestId:'request',requestDurationMinutes:45,requestedSearchWindow:{start:'2026-10-06T09:00',end:'2026-10-06T12:30',zone:'Asia/Jerusalem'}},
  argsOverride:{duration_minutes:25}});
 assert.ok(out.slots.length);
 for(const slot of out.slots) assert.equal((Date.parse(slot.end)-Date.parse(slot.start))/60000,40);
});

test('repeated attendee conflict refers to every original slot once', async () => {
  const { out } = await run({ clean: true, busy: true });
  assert.ok(out.slots.length > 1);
  assert.deepEqual(Array.from(out.shared_attendee_fact_groups[0]), Array.from(out.slots, (_, i) => i + 1));
});

test('clean slots keep individual clocks without conflict groups', async () => {
  const { out } = await run({ clean: true });
  assert.ok((out.slots ?? out).every(slot => slot.start && slot.end));
  assert.ok(out.slots.every(slot=>slot.attendee_status.every(person=>person.status==='free')));
  assert.deepEqual(Array.from(out.shared_attendee_fact_groups[0]),Array.from(out.slots,(_,i)=>i+1));
});

test('later verified option reads replace stale broad-read warnings',async()=>{
 const {out}=await run({clean:true,unknown:true,extraMocks:{'src/utils/annotateSlotsWithAttendeeStatus.ts':{
  annotateSlotsWithAttendeeStatus:async({slots})=>slots.map(slot=>({slot,attendeeStatus:'free'}))
 }}});
 assert.ok(out.slots.length);assert.equal(out.attendees_not_checked,undefined);assert.equal(out._attendee_not_checked_warning,undefined);
 assert.ok(out.slots.every(s=>s.attendee_status.every(p=>p.status==='free')));
});

test('tentative conflicts have one precise status instead of conflicting busy prose',async()=>{
 const {out}=await run({clean:true,busy:true,extraMocks:{'src/utils/annotateSlotsWithAttendeeStatus.ts':{
  annotateSlotsWithAttendeeStatus:async({slots})=>slots.map(slot=>({slot,attendeeStatus:'tentative'}))
 }}});
 assert.ok(out.slots.length);for(const slot of out.slots){assert.equal(slot.attendee_status[0].status,'tentative');assert.match(slot.attendee_conflicts[0].line,/tentative/);}
});

test('exact candidate validation carries every attendee conflict as structured evidence',async()=>{
 const {out}=await run({clean:true,busy:true,role:'colleague',argsOverride:{candidate_slots:[{start:'2026-10-06T10:00:00+03:00'}]}});
 assert.equal(out.mode,'candidate_validation'); const c=out.results[0];assert.equal(c.available,false);assert.equal(c.owner_available,true);
 assert.equal(c.attendee_conflicts[0].email,'peer@example.test');assert.equal(c.attendee_conflicts[0].reason,'busy');
 assert.ok(c._attendee_busy_note.includes(c.attendee_conflicts[0].line));
});
