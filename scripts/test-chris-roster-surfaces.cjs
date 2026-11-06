// Additional authenticated colleague/room coverage; only fixture calendar I/O.
const assert=require('node:assert/strict'),{test}=require('node:test'),path=require('node:path');
const {run}=require('./test-garage-recovery-summary.cjs');
const chris='chris@example.test',paul='paul@example.test',adam='adam@example.test';
const context={resolvedMeetingAttendees:[chris,paul,adam],resolvedMeetingAttendeeGroups:[[chris,paul],[chris,adam]].map(emails=>({emails,unresolvedNames:[]}))};
for(const surface of ['colleague_dm','room'])test(`regression ${surface} uses chosen roster and authenticated requester`,async()=>{
 const r=await run({clean:true,role:'colleague',requesterEmail:chris,contextOverride:{...context,surface,isMpim:surface==='room'},argsOverride:{attendee_emails:[paul],candidate_slots:[{start:'2026-10-06T15:40:00+03:00'}]}});
 assert.ok(r.calls.searches.length);for(const call of r.calls.searches)assert.deepEqual([...call.attendeeBusyEmails].sort(),[chris,paul].sort());
});
test('control authenticated nonattending organizer excludes only requester',async()=>{
 const r=await run({clean:true,role:'colleague',requesterEmail:chris,contextOverride:{resolvedMeetingAttendees:[chris,paul],resolvedMeetingAttendeeGroups:[{emails:[chris,paul],unresolvedNames:[]}]},argsOverride:{attendee_emails:[paul],candidate_slots:[{start:'2026-10-06T15:40:00+03:00'}],requester_is_attending:false}});
 assert.ok(r.calls.searches.length);for(const call of r.calls.searches)assert.deepEqual([...call.attendeeBusyEmails],[paul]);
});
