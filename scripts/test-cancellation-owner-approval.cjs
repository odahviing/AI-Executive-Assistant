// Actual cancellation handler with isolated calendar reads/writes. Approval replay
// enters the same handler with authenticated owner authority; no network calls.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./test-timezone-owner-interval.cjs');
async function cancel(options={}) {
  const effects={writes:[],plans:0};
  const probe={type:'singleInstance',subject:'Weekly',startDateTime:'2026-11-25T19:00:00Z',
    organizer:{emailAddress:{address:'owner@example.test'}},attendees:[{emailAddress:{address:'peer@example.test'}}],...options.probe};
  const h=harness({}, {extraMocks:{
    'src/connectors/graph/calendarReads.ts':{
      getEventType:async()=>{if(options.readFailure)throw Object.assign(Error('read failed'),{statusCode:503});return probe;},
      deleteMeeting:async(...args)=>{effects.writes.push({kind:'cancel',args});return {cancellationSent:true};},
      declineMeeting:async(...args)=>{effects.writes.push({kind:'decline',args});return {notified:'organizer'};},
      verifyEventDeleted:async()=>false,
    },
    'src/skills/meetings/planMeeting.ts':{planInputFromBookingRequest:x=>x,planMeeting:async()=>{effects.plans++;if(options.planFailure)throw Error('ownership read failed');return options.decision??{action:'cancel'};}},
    'src/skills/meetings/bookingRequest.ts':{normalizeBookingRequest:async()=>({})},
    'src/skills/meetings/ops/helpers.ts':{subjectsPlausiblyMatch:(a,b)=>a==='[Private]'||a===b},
    'src/skills/meetings/ops/analysis.ts':{},
    'src/utils/closeMeetingArtifacts.ts':{},'src/core/requests/logActivity.ts':{},'src/core/requests/activityRevertibility.ts':{},
    'src/db.ts':{getPersonMemory:id=>id==='UPEER'&&!options.noEmail?{email:'PEER@example.test'}:null,auditLog(){}},
    'src/db/requests.ts':{getMeetingsRequestedBy:()=>options.requestedRows??[]},
    'src/utils/displaySubject.ts':{displaySubject:e=>e.sensitivity==='private'?'[Private]':e.subject,subjectViewerFor:()=> 'colleague',viewerEmailFor:()=>null},
  }});
  const context={profile:h.profile,userId:options.actor??'UPEER',authority:options.authority??'colleague',senderRole:options.senderRole??'colleague',surface:'colleague_dm',channel:'slack'};
  const result=await h.load('src/skills/meetings/ops/handlers/calendarReads.ts').handleDeleteMeeting({meeting_id:'event',meeting_subject:options.subject??'Weekly',comment:'Please cancel',...options.args},{context,userEmail:h.profile.user.email,timezone:h.profile.user.timezone});
  return {result,effects};
}
test('participant cancellation returns exact replayable approval without any write',async()=>{
  const {result,effects}=await cancel();assert.equal(result.needs_owner_approval,true);assert.equal(effects.writes.length,0);assert.equal(effects.plans,0);
  assert.equal(result._deferred_action_hint.tool,'delete_meeting');assert.equal(result._deferred_action_hint.args.meeting_id,'event');assert.equal(result._deferred_action_hint.args.comment,'Please cancel');assert.ok(result.violation_label);
});

const bookingRecord={owner_user_id:'UOWNER',requester_slack_id:'UPEER',subkind:'colleague_booking_record',state:'resolved',outcome_external_event_id:'event'};
test('the verified arranger may request owner approval even when not an attendee',async()=>{
 const {result,effects}=await cancel({probe:{attendees:[]},requestedRows:[bookingRecord]});
 assert.equal(result.needs_owner_approval,true);assert.equal(result._deferred_action_hint.args.meeting_id,'event');assert.equal(effects.writes.length,0);
});
for(const change of [{owner_user_id:'OTHER'},{requester_slack_id:'OTHER'},{state:'cancelled'},{outcome_external_event_id:'other'},{subkind:'freeform'}])test('an unrelated or retired record cannot authorize cancellation '+JSON.stringify(change),async()=>{
 const {result,effects}=await cancel({probe:{attendees:[],subject:'Secret',sensitivity:'private'},requestedRows:[{...bookingRecord,...change}]});
 assert.equal(result.error,'not_your_meeting');assert.equal(effects.writes.length,0);assert.ok(!JSON.stringify(result).includes('Secret'));
});
test('organizer can request cancellation of owner copy but cannot mutate it',async()=>{
  const {result,effects}=await cancel({probe:{organizer:{emailAddress:{address:'peer@example.test'}},attendees:[]}});assert.equal(result.needs_owner_approval,true);assert.equal(effects.writes.length,0);
});
for(const options of [{probe:{attendees:[],subject:'Private secret',sensitivity:'private'}},{noEmail:true},{actor:'UNKNOWN'}, {authority:undefined,senderRole:'owner',actor:'UNKNOWN'}]) {
  test('unverified or unrelated requester gets no event metadata or replay authority '+JSON.stringify(options),async()=>{
    const {result,effects}=await cancel(options);assert.equal(effects.writes.length,0);assert.equal(result.error,'not_your_meeting');assert.equal(result._deferred_action_hint,undefined);assert.ok(!JSON.stringify(result).includes('Private secret'));
  });
}
test('series and mismatched target remain non-replayable',async()=>{
  for(const probe of [{type:'seriesMaster'},{subject:'Other meeting'}]) {const {result,effects}=await cancel({probe});assert.equal(effects.writes.length,0);assert.equal(result._deferred_action_hint,undefined);assert.ok(['recurring_series_master','meeting_id_subject_mismatch'].includes(result.error));}
});
test('private shared occurrence keeps the subject masked even in replay arguments',async()=>{
  const {result,effects}=await cancel({subject:'[Private]',probe:{subject:'Secret subject',sensitivity:'private'}});
  assert.equal(result.needs_owner_approval,true);assert.equal(effects.writes.length,0);assert.ok(!JSON.stringify(result).includes('Secret subject'));assert.equal(result._deferred_action_hint.args.meeting_subject,'[Private]');
});
test('owner and approved replay retain one cancellation with the supplied comment',async()=>{
  const {effects}=await cancel({authority:'owner',actor:'UOWNER'});assert.equal(effects.writes.length,1);assert.equal(effects.writes[0].kind,'cancel');assert.equal(effects.writes[0].args[2].comment,'Please cancel');
});
test('owner attendee retains decline instead of cancelling everyone',async()=>{
  const {effects}=await cancel({authority:'owner',actor:'UOWNER',decision:{action:'decline_as_attendee',organizerEmail:'peer@example.test'}});assert.equal(effects.writes.length,1);assert.equal(effects.writes[0].kind,'decline');
});
test('ownership decision failure never falls through to a raw cancellation',async()=>{
  const {result,effects}=await cancel({authority:'owner',actor:'UOWNER',planFailure:true});assert.equal(effects.writes.length,0);assert.equal(result.error,'ownership_unverified');
});
test('failed calendar probe never emits a replay or write',async()=>{await assert.rejects(cancel({readFailure:true}),/read failed/);});
