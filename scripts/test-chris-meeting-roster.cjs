// Real search handler and AST-selected create normalization; fixture I/O only.
const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {run}=require('./test-garage-recovery-summary.cjs');
const at=process.argv.indexOf('--source-root'),root=at<0?path.resolve(__dirname,'..'):path.resolve(process.argv[at+1]);
const chris='chris@example.test',paul='paul@example.test',adam='adam@example.test',scott='scott@example.test';
const flat=[chris,paul,adam,scott],groups=[[chris,paul],[chris,adam],[chris,scott]].map(emails=>({emails,unresolvedNames:[]}));
const context={resolvedMeetingAttendees:flat,resolvedMeetingAttendeeGroups:groups};
test('regression Paul search excludes unrelated Adam and Scott while recovering Chris',async()=>{
 const r=await run({clean:true,contextOverride:context,argsOverride:{attendee_emails:[paul]}});
 assert.ok(r.calls.searches.length);for(const call of r.calls.searches)assert.deepEqual([...call.attendeeBusyEmails].sort(),[chris,paul].sort());
});
test('explicit person check progresses without merging ambiguous meetings',async()=>{
 const r=await run({clean:true,contextOverride:context,argsOverride:{attendee_emails:[chris]}});assert.equal(r.out.availability_scope,'explicit_participant_only');assert.ok(r.calls.searches.length);assert.ok(r.calls.searches.every(s=>s.attendeeBusyEmails.length===1&&s.attendeeBusyEmails[0]===chris));
});
test('incomplete grouping permits only the explicit calendar check',async()=>{
 const r=await run({clean:true,contextOverride:{...context,resolvedMeetingAttendeeGroups:[]},argsOverride:{attendee_emails:[paul]}});assert.equal(r.out.availability_scope,'explicit_participant_only');assert.ok(r.calls.searches.length);assert.ok(r.calls.searches.every(s=>s.attendeeBusyEmails.length===1&&s.attendeeBusyEmails[0]===paul));
});
test('control single-meeting known attendee cannot be dropped by partial args',async()=>{
 const r=await run({clean:true,contextOverride:{resolvedMeetingAttendees:[paul,chris],resolvedMeetingAttendeeGroups:[{emails:[paul,chris],unresolvedNames:[]}]},argsOverride:{attendee_emails:[paul]}});assert.ok(r.calls.searches.length);assert.ok(r.calls.searches.every(c=>c.attendeeBusyEmails.includes(chris)));
});
function createRoster(emails,ctx=context){
 const f=fs.readFileSync(path.join(root,'src/skills/meetings/ops/handlers/createMeeting.ts'),'utf8');
 const start=f.indexOf('        const callerNamedAnAttendee ='),end=f.indexOf('        // v4.3.x (gh#165-a / relay-invite gap)',start);assert.ok(start>=0&&end>start);
 const hf=ts.createSourceFile('helpers.ts',fs.readFileSync(path.join(root,'src/skills/meetings/ops/helpers.ts'),'utf8'),ts.ScriptTarget.Latest,true);
 const helper=hf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='meetingScopedAttendees')?.getText()??'';
 const code=helper+'\nexport function run(){'+f.slice(start,end)+'\nreturn attendees;}';
 const module={exports:{}};
 vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,context:ctx,userEmail:'owner@example.test',getPersonMemory:()=>({email:chris}),attendees:emails.map(email=>({email})),args:{},logger:{info(){}}});
 return JSON.parse(JSON.stringify(module.exports.run()));
}
test('regression create uses the selected meeting roster',()=>{assert.deepEqual(createRoster([paul]).map(a=>a.email).sort(),[paul,chris].sort());});
test('regression create ambiguous roster writes no invite',()=>{assert.equal(createRoster([chris]).error,'ambiguous_meeting_roster');});
test('control create solo block does not acquire any turn attendee',()=>{assert.deepEqual(createRoster([]),[]);});
test('control legacy single roster still recovers missing attendee',()=>{assert.deepEqual(createRoster([paul],{resolvedMeetingAttendees:[paul,chris]}).map(a=>a.email).sort(),[paul,chris].sort());});

test('a single stale roster cannot add Adam to a booking that names only Paul',()=>{
 const stale={resolvedMeetingAttendees:[adam],resolvedMeetingAttendeeGroups:[{emails:[adam],unresolvedNames:[]}]};
 assert.equal(createRoster([paul],stale).error,'ambiguous_meeting_roster');
 assert.deepEqual(createRoster([chris],stale).map(a=>a.email).sort(),[chris,adam].sort(),'requester-only arguments may recover the known invitee');
 assert.deepEqual(createRoster([paul],{...stale,resolvedMeetingAttendeeGroups:[{emails:[adam],unresolvedNames:['Paul']}]}).map(a=>a.email).sort(),[paul,adam].sort(),'an identified mixed internal/external roster still resolves');
});

const alex = 'alex@example.test';
const elinor = 'elinor@example.test';
const ayalla = 'ayalla@example.test';
const existingMeetingContext = {
 resolvedMeetingAttendees: [alex],
 resolvedMeetingAttendeeGroups: [
  {emails: [alex], unresolvedNames: []},
  {emails: [], unresolvedNames: ['Ayalla']},
 ],
};

for (const role of ['owner', 'colleague']) {
 test(`${role} reschedule uses the full authorized event roster before declaring ambiguity`, async () => {
  const eventAttendees = role === 'owner' ? [alex, elinor] : [alex, elinor, chris];
  const r = await run({
   clean: true, role, requesterEmail: role === 'owner' ? 'owner@example.test' : chris,
   contextOverride: existingMeetingContext,
   argsOverride: {attendee_emails: [alex, elinor], moving_event_ids: ['alex-event']},
   extraMocks: {
    'src/utils/movingEventAttendees.ts': {
     resolveMovingEventAttendees: async () => new Map([
      ['alex-event', {attendees: eventAttendees, categories: [], durationMinutes: 40}],
     ]),
    },
   },
  });
  assert.ok(r.out.slots?.length, JSON.stringify(r.out));
  assert.ok(r.calls.searches.every(call =>
   call.attendeeBusyEmails.includes(alex) && call.attendeeBusyEmails.includes(elinor)));
  assert.ok(r.calls.searches.every(call => !call.attendeeBusyEmails.includes(ayalla)));
 });
}

for (const [name, role, requesterEmail, eventRoster, ids] of [
 ['different event', 'owner', undefined, [ayalla, elinor], ['alex-event']],
 ['unresolved event', 'owner', undefined, null, ['alex-event']],
 ['nonmember requester', 'colleague', 'stranger@example.test', [alex, elinor], ['alex-event']],
 ['multiple event IDs', 'owner', undefined, [alex, elinor], ['alex-event', 'ayalla-event']],
 ['new meeting without an event', 'owner', undefined, [alex, elinor], []],
]) {
 test(`${name} cannot override an ambiguous meeting roster`, async () => {
  const r = await run({
   clean: true, role, requesterEmail,
   contextOverride: existingMeetingContext,
   argsOverride: {attendee_emails: [alex, elinor], moving_event_ids: ids},
   extraMocks: {
    'src/utils/movingEventAttendees.ts': {
     resolveMovingEventAttendees: async () => new Map(eventRoster
      ? [['alex-event', {attendees: eventRoster, categories: [], durationMinutes: 40}]]
      : []),
    },
   },
  });
  assert.equal(r.out.error, 'ambiguous_meeting_roster');
  assert.equal(r.calls.searches.length, 0);
 });
}
module.exports={createRoster};

test('an existing-meeting request cannot silently search a new-meeting default before identification',async()=>{
 const r=await run({clean:true,contextOverride:{meetingRequestId:'existing-request',requestExistingMeeting:true},argsOverride:{duration_minutes:25}});
 assert.equal(r.out.error,'existing_meeting_not_identified');assert.equal(r.calls.searches.length,0);
});

test('an explicit human duration permits a scoped availability check while event identity is unresolved',async()=>{
 const r=await run({clean:true,role:'colleague',meetingsOverride:{allowed_durations:[25,40,55]},contextOverride:{meetingRequestId:'existing-request',requestExistingMeeting:true,requestDurationMinutes:45},
  argsOverride:{duration_minutes:25}});
 assert.ok(r.out.slots.length);assert.equal(r.out.existing_meeting_identity,'unresolved');
 assert.ok(r.calls.searches.every(call=>call.durationMinutes===40));
 assert.equal(r.out.moving_meeting,undefined);
 assert.match(r.out.search_basis,/Identify it before changing/);
});

for (const role of ['owner','colleague']) for (const [label,requestMinutes,expected] of [
 ['preserved existing length',undefined,40],['human changes length',25,25],
]) test(`${role} continued move search: ${label}`,async()=>{
 const r=await run({clean:true,role,requesterEmail:chris,
  contextOverride:{meetingRequestId:'active-move',requestMovingEventId:'existing',requestDurationMinutes:requestMinutes,
   resolvedMeetingAttendees:[chris],resolvedMeetingAttendeeGroups:[{emails:[chris],unresolvedNames:[]}]},
  argsOverride:{attendee_emails:[chris],duration_minutes:25},
  extraMocks:{'src/utils/movingEventAttendees.ts':{resolveMovingEventAttendees:async ids=>{
   assert.deepEqual([...ids],['existing']);return new Map([['existing',{attendees:[chris],durationMinutes:40,categories:[]}]]);
  }}},
 });
 assert.ok(r.calls.searches.length);assert.ok(r.calls.searches.every(call=>call.durationMinutes===expected));
 assert.equal(r.out.moving_meeting.event_id,'existing');assert.equal(r.out.moving_meeting.duration_minutes,expected);
});

test('a continued move rechecks membership before retaining its event or duration',async()=>{
 const r=await run({clean:true,role:'colleague',requesterEmail:'stranger@example.test',
  contextOverride:{meetingRequestId:'active-move',requestMovingEventId:'existing'},
  argsOverride:{attendee_emails:['stranger@example.test'],duration_minutes:25},
  extraMocks:{'src/utils/movingEventAttendees.ts':{resolveMovingEventAttendees:async()=>new Map([
   ['existing',{attendees:[chris],durationMinutes:40,categories:[]}],
  ])}},
 });
 assert.equal(r.out.moving_meeting,undefined);
 assert.ok(r.calls.searches.every(call=>call.durationMinutes===25&&!call.excludeEventIds?.includes('existing')));
});
