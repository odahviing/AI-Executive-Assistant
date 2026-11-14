// Full update handler, real room checker and Graph PATCH serializer. No provider writes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./test-timezone-owner-interval.cjs');
const room = 'room@example.test', guest = { email:'peer@example.test', optional:true };
async function update(args, options = {}) {
  const calls = [], writes = [];
  const start = '2026-09-14T12:00:00+03:00', end = '2026-09-14T12:25:00+03:00';
  const event = { id:'fixture', subject:'Fixture', attendees: options.roster || [guest], categories:[],
    startIso:start,endIso:end,location:options.oldVenue || 'Old',isOnline:true };
  const calendar = {
    getEventType:async()=>({type:'singleInstance',subject:'Fixture'}),
    getEventForAttendeeUpdate:async()=>event,
    getFreeBusyForDecision:async(user,emails,s,e,tz,diag,ignore)=>{
      if (emails.includes(room)) {
        calls.push({kind:'resource',ignore});
        if(options.unavailable) diag.notChecked=[room];
        if(options.busy) return {[room]:[{start,end,status:'busy'}]};
      }
      return {};
    },
    getOwnerEventsForDecision:async()=>[],
    updateMeeting:args=>h.load('src/connectors/graph/calendarMutations.ts').updateMeeting(args),
  };
  const h = harness({}, {extraMocks:{
    'src/connectors/graph/calendarReads.ts':calendar,
    'src/skills/meetings/findMeetingOwner.ts':{findMeetingOwner:async()=>({ownerIsOrganizer:true,requesterSlackId:'allowed'})},
    'src/skills/meetings/ops/helpers.ts':{subjectsPlausiblyMatch:(a,b)=>a===b,HANDLER_ERROR_CODE:{MEETING_ROOM_UNAVAILABLE_LARGE_MEETING:'room_full'}},
    'src/utils/closeMeetingArtifacts.ts':{closeMeetingArtifacts:async()=>{}},
    'src/skills/meetings/ops/violationLabels.ts':{},'src/skills/meetings/bookingRequest.ts':{},
    'src/skills/meetings/ops/analysis.ts':{},'src/tasks/skill.ts':{},'src/core/requests/logActivity.ts':{},
    'src/memory/resolveAttendeeEmails.ts':{resolveAttendeeEmail:a=>a},
    'src/db.ts':{auditLog(){},getPersonMemory:()=>({})},
    'src/utils/displaySubject.ts':{displaySubject:e=>e.subject,subjectViewerFor:()=> 'owner',viewerEmailFor:()=>null,isEventPrivate:()=>false},
    'src/connectors/graph/graphClient.ts':{getClient:()=>({api:()=>({patch:async body=>{calls.push({kind:'patch'});writes.push(body);}})})},
    'src/connectors/graph/calendarCache.ts':{invalidateCalendarCache(){}},'src/config/userProfile.ts':{getProfileByEmail:()=>({user:{slack_user_id:'UOWNER'}})},
  }});
  Object.assign(h.load('src/utils/resolveLocation.ts'),h.load('src/utils/resolveLocation.ts',true));
  h.profile.meetings.room_email=room;
  h.profile.meetings.office_location={meeting_room_label:'Main Room',small_meeting_room_label:'Annex'};
  const role=options.role||'owner';
  const response=await h.load('src/skills/meetings/ops/handlers/moveMeeting.ts').handleUpdateMeeting({meeting_id:'fixture',meeting_subject:'Fixture',...args},{
    context:{profile:h.profile,senderRole:role,authority:role,channel:'slack',userId:options.denied?'other':'allowed',surface:role==='owner'?'owner_dm':'room'},userEmail:h.profile.user.email,timezone:h.profile.user.timezone});
  return {response,calls,writes};
}
const addresses = body => Array.from(body.attendees || [], a=>a.emailAddress.address);
const requested = {location:' MAIN room '};
test('configured label checks before PATCH and preserves hybrid and existing optional role',async()=>{
 const x=await update(requested);assert.equal(x.response.success,true);assert.deepEqual(x.calls.map(c=>c.kind),['resource','patch']);
 assert.deepEqual(addresses(x.writes[0]),[guest.email,room]);assert.equal(x.writes[0].attendees[0].type,'optional');assert.equal(x.writes[0].isOnlineMeeting,undefined);
});
test('explicit resource mailbox checks, respects existing attendee type, and writes once',async()=>{
 const x=await update({add_attendees:[{email:room},{email:room.toUpperCase()}]});assert.equal(x.response.success,true);
 assert.deepEqual(x.calls.map(c=>c.kind),['resource','patch']);assert.deepEqual(addresses(x.writes[0]),[guest.email,room]);
});
test('existing room identity excludes its occurrence and never re-adds its copy',async()=>{
 const x=await update(requested,{oldVenue:'Main Room',roster:[guest,{email:room,type:'resource'}]});assert.equal(x.response.success,true);
 assert.deepEqual(Array.from(x.calls[0].ignore),['fixture']);assert.equal(x.writes[0].attendees,undefined);
});
test('busy explicit room is absent from roster and from added-attendees receipt',async()=>{
 const x=await update({add_attendees:[{email:room}]},{busy:true});assert.equal(x.response.success,true);assert.ok(!addresses(x.writes[0]).includes(room));assert.deepEqual(Array.from(x.response.added_attendees),[]);
 assert.match(x.response._attendee_busy_note,/taken/);assert.ok(!x.response.action_summary.includes('added '+room));
});
test('owner learns that resource availability is unknown',async()=>{
 const x=await update(requested,{unavailable:true});assert.equal(x.response.success,true);assert.match(x.response._attendee_busy_note,/not be confirmed/);assert.ok(addresses(x.writes[0]).includes(room));
});
test('authorized colleague gets the unknown-room result too',async()=>{
 const x=await update({add_attendees:[{email:room}]},{role:'colleague',unavailable:true});assert.equal(x.response.success,true);assert.match(x.response._attendee_busy_note,/not be confirmed/);
});
test('colleague large busy room defers without a Graph PATCH',async()=>{
 const roster=Array.from({length:5},(_,i)=>({email:'peer'+i+'@example.test'}));
 const x=await update({add_attendees:[{email:room}]},{role:'colleague',busy:true,roster});assert.equal(x.response.needs_owner_approval,true);assert.equal(x.writes.length,0);
});
test('explicit remove wins over the configured label and releases the resource',async()=>{
 const x=await update({...requested,remove_attendees:[room]},{oldVenue:'Main Room',roster:[guest,{email:room}]});assert.equal(x.response.success,true);assert.deepEqual(addresses(x.writes[0]),[guest.email]);assert.equal(x.calls.some(c=>c.kind==='resource'),false);
});
test('relocation away from named room releases its resource and keeps other invitees',async()=>{
 const x=await update({location:'Other venue'},{oldVenue:'Main Room',roster:[guest,{email:room}]});assert.equal(x.response.success,true);assert.deepEqual(addresses(x.writes[0]),[guest.email]);
});
test('plain text venue leaves roster and online setting alone',async()=>{
 const x=await update({location:'Other venue'});assert.equal(x.response.success,true);assert.deepEqual(x.calls.map(c=>c.kind),['patch']);assert.equal(x.writes[0].attendees,undefined);assert.equal(x.writes[0].isOnlineMeeting,undefined);
});
test('rename with a room on the invite does not revalidate or change the room',async()=>{
 const x=await update({new_subject:'Revised'},{oldVenue:'Main Room',roster:[guest,{email:room}]});assert.equal(x.response.success,true);assert.deepEqual(x.calls.map(c=>c.kind),['patch']);assert.equal(x.writes[0].attendees,undefined);
});
test('unauthorized requester cannot check or acquire the room',async()=>{
 const x=await update(requested,{role:'colleague',denied:true});assert.equal(x.response.error,'colleague_not_requester');assert.deepEqual(x.calls,[]);
});
test('colleague busy small-room fallback describes the venue actually written',async()=>{
 const x=await update(requested,{role:'colleague',busy:true});assert.equal(x.response.success,true);
 assert.equal(x.writes[0].location.displayName,'Annex');assert.ok(!addresses(x.writes[0]).includes(room));
 assert.match(x.response.action_summary,/Annex/);assert.match(x.response._attendee_busy_note,/not checked/);
});
// An explicit resource request still checks availability for an unstamped logistical event.
const scenario = require('./test-nov13-second-scheduling.cjs');
for (const busy of [true, false]) {
  test('explicit room on a logistic event with a ' + (busy ? 'busy' : 'free') + ' resource', async () => {
    const f = scenario.fixture({
      roster:[scenario.room, ...Array.from({length:5}, (_, n) => 'guest' + n + '@example.test')],
      resourceBusy:busy,
    });
    f.h.profile.categories = [{name:'Logistic', no_default_location:true}];
    f.h.load('src/skills/meetings/detectCategory.ts').detectCategory = async () => ({category:'Logistic', reason:'fixture'});
    const result = await f.plan();
    assert.equal(result.action, busy ? 'room_unavailable_large' : 'book');
  });
}
test('ordinary named attendee has one resolved address and name in receipt', async () => {
  const a={name:'Taylor',email:'taylor@example.test'};
  const x=await update({add_attendees:[a]});
  assert.equal(x.response.success,true);assert.match(x.response.action_summary,/Taylor \(taylor@example.test\)/);
  assert.deepEqual(Array.from(x.response.added_attendees),[a.email]);
});
