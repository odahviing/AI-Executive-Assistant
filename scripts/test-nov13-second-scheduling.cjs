const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const { harness } = require('./test-timezone-owner-interval.cjs');
const { regularWeek } = require('./fixtures/regular-week.cjs');
const section = process.argv[process.argv.indexOf('--section') + 1];
function check(group, name, callback) {
  if (require.main === module && (!process.argv.includes('--section') || group === section)) test(group + ' / ' + name, callback);
}
const zone = 'Asia/Jerusalem';
const at = clock => '2026-10-06T' + clock + ':00+03:00';
const email = 'guest@outside.test', peer = 'peer@example.test', room = 'conference@example.test';
const anchor = { id:'anchor', type:'singleInstance', subject:'Fixture appointment', isCancelled:false, end:{dateTime:at('12:00'),timeZone:zone} };
function fixture({ source = anchor, availability = [], roster = [peer], location, existing = false, resourceBusy = false, peerBusy=false, unknownResource=false, collected = {}, role='owner', surface='owner_dm' } = {}) {
  const read = async () => { if(source instanceof Error) throw source; return source; };
  const g = {
    getCalendarEvents:async () => { const e=await read(); return e?[e]:[]; },
    getEventEndInstant:async () => { const e=await read(); return e && !e.isCancelled && e.type !== 'seriesMaster' ? {end:DateTime.fromISO(e.end.dateTime),subject:e.subject}:null; },
    getFreeBusyForDecision:async (_mail,emails,_s,_e,_tz,diag)=>{if(collected.providerDown)throw Error("fixture provider unavailable");if(unknownResource&&emails.includes(room))diag.notChecked=[room];return Object.fromEntries(emails.map(e=>[e,((e===room&&resourceBusy)||(e===peer&&peerBusy))?[{start:at('10:00'),end:at('11:00'),status:'busy'}]:[]]));},
    getOwnerEventsForDecision:async()=>[], firstRejectReason:d=>Object.keys(d??{})[0], oofUntilDisplayFor:()=>undefined,
    GraphPermissionError:class extends Error{},CalendarOfflineError:class extends Error{},isOutageShaped:()=>false,
  };
  const h=harness({}, {realAvailability:true,extraMocks:{
    'src/connectors/graph/calendarReads.ts':g,
    'src/skills/meetings/bookingRequest.ts':{grantRelaxed:()=>({relaxed:false})},
    'src/utils/displaySubject.ts':{subjectViewerFor:()=> 'owner', viewerEmailFor:()=>null, displaySubject:e=>e.subject},
    'src/skills/meetings/ops/analysis.ts':{},'src/db/slotHolds.ts':{getActiveSlotHolds:()=>[]},
    'src/utils/offeredSlotsStash.ts':{getOfferedSlots:()=>[],getOfferedSearchFingerprint:()=>null,recordOfferedSlots:a=>(collected.offers??=[]).push(...a.slots)},
    'src/skills/meetings/ops/violationLabels.ts':{humanizeViolationLabel:k=>k,attendeeFirstName:e=>e,attendeeConflictLine:c=>c.email},
    'src/db.ts':{listSchedulingContacts:()=>[],getPersonMemory:()=>null},
  }});
  h.profile.meetings.room_email=room;
  h.profile.meetings.office_location={meeting_room_label:'Main Room'};
  h.profile.meetings.work_hours_per_free_hour=0;
  const avail=h.load('src/utils/attendeeAvailability.ts');
  avail.loadAttendeeAvailabilityForEmails=emails=>availability.filter(a=>emails.includes(a.email));
  const realLocation=h.load('src/utils/resolveLocation.ts',true);
  Object.assign(h.load('src/utils/resolveLocation.ts'),realLocation);
  const context={channelId:'fixture',threadTs:'fixture',userId:'UOWNER',profile:h.profile,authority:role,senderRole:role,channel:'slack',surface};
  const plan=async extra=>h.load('src/skills/meetings/planMeeting.ts').planMeeting({profile:h.profile,initiator:role,intent:existing?'move':'new_booking',subject:'Visit',
    participants:roster.map(email=>({email})),slotStartIso:at('10:00'),slotEndIso:at('10:25'),preloadedEvents:[],viewer:'owner',isOnlineHint:existing?undefined:false,
    locationHint:location, ...(existing?{existingEventId:'moving',priorSlotStartIso:at('14:00'),existingEventLocation:'Main Room',existingEventIsOnline:true,existingEventCategories:['Meeting']}:{}),...extra});
  const search=async extra=>h.load('src/skills/meetings/ops/handlers/findAvailableSlots.ts').handleFindAvailableSlots({search_from:at('09:00'),search_to:at('17:00'),duration_minutes:25,meeting_mode:'online',...extra},
    {context,userEmail:h.profile.user.email,timezone:zone,relaxedGrant:{relaxed:false},isOwnerPath:role==='owner'});
  return {h,plan,search,collected};
}
const hours = (email,start,end,assumed=false) => ({email,timezone:zone,assumed,week:regularWeek(['Tuesday'],start,end)});
check('hours','known external hours participate in write decision',async()=>{
  const f=fixture({roster:[email],availability:[hours(email,'15:00','18:00')]});
  const r=await f.plan(); assert.equal(r.action,'confirm_override'); assert.match(JSON.stringify(r),/guest.*working hours/);
});
check('hours','every attendee outside their window appears',async()=>{
  const f=fixture({roster:[peer,'other@example.test'],availability:[hours(peer,'15:00','18:00'),hours('other@example.test','16:00','18:00')]});
  const r=await f.plan(); assert.equal(r.action,'confirm_override');assert.match(r.suggestedAskText,/peer/);assert.match(r.suggestedAskText,/other/);
});
check('hours','available attendees remain bookable',async()=>{
  const f=fixture({roster:[peer,email],availability:[hours(peer,'09:00','18:00'),hours(email,'09:00','18:00')]}); assert.equal((await f.plan()).action,'book');
});
check('room','configured label reserves the actual resource',async()=>{
  const r=await fixture({location:' mAIN ROOM ',roster:[email,peer]}).plan();assert.equal(r.action,'book');assert.equal(r.addRoomEmail,true);
});
check('room','explicit resource with a venue is checked for a large meeting',async()=>{
  const r=await fixture({location:'Other venue text',roster:[room,email,peer,'a@example.test','b@example.test','c@example.test'],resourceBusy:true}).plan();
  assert.equal(r.action,'room_unavailable_large');
});
check('room','hybrid room retained on a move is checked at destination',async()=>{
  const r=await fixture({existing:true,roster:[room,email,peer,'a@example.test','b@example.test','c@example.test'],resourceBusy:true}).plan();assert.equal(r.action,'room_unavailable_large');
});
check('room','unmapped free-text venue alone never invites a resource',async()=>{
  const r=await fixture({location:'Other venue text',roster:[email]}).plan();assert.equal(r.action,'book');assert.ok(!r.addRoomEmail);assert.equal(r.location,'Other venue text');
});
function createOrder(source) {
  const file='src/skills/meetings/ops/handlers/createMeeting.ts';
  const root=path.resolve(__dirname,'..',process.env.SLOT_PRIORITY_BEFORE??'');
  const tree=ts.createSourceFile(file,fs.readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true);
  let decl;
  (function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText()==='mustBeAfterId')decl=n;ts.forEachChild(n,visit);})(tree);
  const statement=decl.parent.parent,branch=statement.parent.statements[statement.parent.statements.indexOf(statement)+1];
  const code=ts.transpileModule('export async function run(args){'+statement.getText()+'\n'+branch.getText()+'\nreturn {wouldWrite:true};}',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const m={exports:{}};
  vm.runInNewContext(code,{module:m,exports:m.exports,DateTime,userEmail:'owner@example.test',timezone:zone,context:{profile:{}},viewerEmail:null,
    subjectViewerFor:()=> 'owner',displaySubject:e=>e.subject,getEventEndInstant:async()=>{if(source instanceof Error)throw source;return source;},logger:{warn(){},info(){}}});
  return m.exports.run;
}
for(const [label,source] of [['missing',null],['read failure',Error('fixture offline')]]){
  check('unresolved','search refuses '+label,async()=>{const r=await fixture({source}).search({must_be_after_event_id:'anchor'});assert.equal(r.error,'anchor_event_not_found');assert.ok(!r.slots?.length);});
  check('unresolved','create refuses '+label,async()=>{const r=await createOrder(source)({start:at('12:15'),must_be_after_event_id:'anchor'});assert.equal(r.error,'anchor_event_not_found');assert.ok(!r.wouldWrite);});
}
check('unresolved','aligned create after known end can proceed',async()=>{const r=await createOrder({end:DateTime.fromISO(at('12:00')),subject:'Fixture'})({start:at('12:00'),must_be_after_event_id:'anchor'});assert.equal(r.wouldWrite,true);});
check('unresolved','ordinary unanchored search still offers slots',async()=>{const r=await fixture({source:null}).search({});assert.ok(r.slots?.length??r.length);});
check('exact','candidate and offer stash honor predecessor',async()=>{
  const f=fixture(); const r=await f.search({must_be_after_event_id:'anchor',candidate_slots:[{start:at('10:00')},{start:at('12:00')}]});
  assert.deepEqual(Array.from(r.results,x=>x.available),[false,true]);assert.equal(f.collected.offers.length,1);
});
check('exact','preferred before predecessor is unavailable',async()=>{
  const f=fixture(); const r=await f.search({must_be_after_event_id:'anchor',preferred_slot:at('10:00')});
  assert.equal(r.preferred_slot_status.available,false);assert.ok(!f.collected.offers.some(s=>Date.parse(s.start)===Date.parse(at('10:00'))));
});
check('exact','exact candidates without an order constraint keep their answer',async()=>{const f=fixture();const r=await f.search({candidate_slots:[{start:at('10:00')}]});assert.equal(r.results[0].available,true);});
check('room','unknown explicitly booked resource remains unconfirmed',async()=>{
 const r=await fixture({location:'Main Room',unknownResource:true}).plan();assert.equal(r.action,'book');assert.ok(r.availabilityUnconfirmed);
});
check('room','colleague in shared room uses resource check without owner override',async()=>{
 const r=await fixture({role:'colleague',surface:'room',location:'Main Room',roster:[room,email,peer,'a@example.test','b@example.test','c@example.test'],resourceBusy:true}).plan();assert.equal(r.action,'room_unavailable_large');
});
check('hours','conditional external unavailability is private on colleague surface',async()=>{
 const r=await fixture({role:'colleague',surface:'room',roster:[email],availability:[hours(email,'15:00','18:00')]}).plan({requireAttendeeAvailability:true});
 assert.equal(r.action,'attendee_condition_unmet');assert.doesNotMatch(r.suggestedAskText,/guest@|working hours/);
});
check('hours','fixed work frame remains independently authoritative for a visitor',async()=>{
 const entry={...hours(email,'09:00','17:00',true),workingHoursTimezone:'America/New_York'};
 const r=await fixture({roster:[email],availability:[entry]}).plan();assert.equal(r.action,'confirm_override');assert.match(r.suggestedAskText,/working hours/);assert.doesNotMatch(r.suggestedAskText,/guess/);
});
check('hours','unspecified external hours do not create a verified hours conflict',async()=>{
 const f=fixture({roster:[email]});const r=await f.plan();assert.equal(r.action,'book');
});
check('unresolved','shared-room failed anchor read returns no private subject or offers',async()=>{
 const r=await fixture({source:null,role:'colleague',surface:'room'}).search({must_be_after_event_id:'private-id'});
 assert.equal(r.error,'anchor_event_not_found');assert.doesNotMatch(JSON.stringify(r),/private-id|Fixture appointment/);
});
check('exact','shared room early preferred cannot become an offer even if relaxed requested',async()=>{
 const f=fixture({role:'colleague',surface:'room'});const r=await f.search({must_be_after_event_id:'anchor',preferred_slot:at('10:00'),relaxed:true});assert.equal(r.preferred_slot_status.available,false);
});function providerEnd(event){
 const file='src/connectors/graph/calendarReads.ts', root=path.resolve(__dirname,'..',process.env.SLOT_PRIORITY_BEFORE??'');
 const tree=ts.createSourceFile(file,fs.readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true);
 const def=tree.statements.find(n=>n.name?.text==='getEventEndInstant'), m={exports:{}};
 const provider={api(){return this;},header(){return this;},select(fields){this.fields=fields;return this;},async get(){return Object.fromEntries(Object.entries(event).filter(([k])=>this.fields.split(',').includes(k)));}};
 const code=ts.transpileModule(def.getText(),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{exports:m.exports,module:m,DateTime,getClient:()=>provider,logger:{warn(){}}});
 return m.exports.getEventEndInstant('owner@example.test','id',zone);
}
for(const [label,extra] of [['cancelled',{isCancelled:true}],['master',{type:'seriesMaster'}]]){
 check('unresolved','provider '+label+' is not a usable predecessor', async()=>assert.equal(await providerEnd({...anchor,...extra}),null));
}
check('unresolved','provider occurrence keeps real end and sensitivity',async()=>{
 const r=await providerEnd({...anchor,type:'occurrence',sensitivity:'private'});assert.equal(r.end.toMillis(),Date.parse(at('12:00')));assert.equal(r.sensitivity,'private');
});
check('exact','spread cannot expand a window ending before its predecessor',async()=>{
 const f=fixture();const r=await f.search({must_be_after_event_id:'anchor',time_window_is_hard:true,search_from:at('09:00'),search_to:at('11:30')});assert.ok(!r.slots?.length&&!r.length);
});check('hours','independently busy attendee also retains their known off-hours fact',async()=>{
 const f=fixture({roster:[peer],peerBusy:true,availability:[hours(peer,'15:00','18:00')]});
 const r=await f.plan();assert.equal(r.action,'confirm_override');assert.match(r.suggestedAskText,/busy/);assert.match(r.suggestedAskText,/working hours/);
});
module.exports = {fixture, email, peer, room, at, hours};
