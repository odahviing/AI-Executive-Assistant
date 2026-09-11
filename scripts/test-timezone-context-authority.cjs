// F1: actual stored-person loader -> shared context -> callback/create/move and
// actual turn-context producer -> precheck. No fabricated availability entries.
const {test}=require('node:test'),assert=require('node:assert/strict'),{DateTime}=require('luxon');
const {harness}=require('./test-timezone-owner-decisions.cjs'),{run:precheck}=require('./test-timezone-gatekeeper-precheck.cjs');
for(const c of [{zone:'Asia/Kolkata',utc:'2026-09-15T04:30:00.000Z'},{zone:'Asia/Jerusalem',utc:'2026-09-15T07:00:00.000Z'}]) {
 const travel={from:'2026-09-14',until:'2026-09-16',location:c.zone};
 test('travel-only '+c.zone+' resolves callback and actual create/move despite assumed base',async()=>{
  const h=harness({person:{timezone:undefined},travel}),entry=h.entries()[0];assert.equal(entry.assumed,true);
  for(const kind of ['create','move']){
   const sk=kind==='create'?'start':'new_start',ek=kind==='create'?'end':'new_end';
   const args={[sk]:'2026-09-15T10:00:00',[ek]:'2026-09-15T10:25:00',stated_zone:'IST',attendees:[h.person.email],subject:'Sync',meeting_subject:'Sync'};
   const preview=await h.load('src/core/approvals/approvalCallbacks.ts').composeOwnerAskText({askText:'Please review.',details:{deferred_action:{tool:kind+'_meeting',args}},profile:h.profile,requestId:'req_test'});
   const result=await h.handler(kind,{...args});assert.equal(result.error,undefined,JSON.stringify(result));assert.equal(DateTime.fromISO(result.args[sk]).toUTC().toISO(),c.utc);
   assert.doesNotMatch(preview,/Before this can run/);assert.match(preview,new RegExp(DateTime.fromISO(c.utc).setZone(h.profile.user.timezone).toFormat('HH:mm')));
  }
  assert.equal(entry.assumed,true,'dated authority must not upgrade assumed base globally');
 });
 test('travel-only '+c.zone+' resolves actual stored-person precheck',async()=>{
  const h=await precheck({rawZone:null,homeZone:null,travel,slots:[{wall_clock:'2026-09-15T10:00',stated_timezone:'IST'}]});
  assert.equal(h.calls.person,1);assert.equal(h.calls.precheck[0].requesterAvailability.assumed,true);assert.equal(h.calls.checks.length,1,JSON.stringify(h.result));assert.equal(DateTime.fromISO(h.calls.checks[0].slotStartIso).toUTC().toISO(),c.utc);
  assert.doesNotMatch(h.result.promptBlock,/Which timezone/);
 });
}
test('travel-only person before and after trip still clarifies in create and precheck',async()=>{
 for(const zone of ['Asia/Kolkata','Asia/Jerusalem'])for(const day of ['13','17']){
  const travel={from:'2026-09-14',until:'2026-09-16',location:zone},wall=`2026-09-${day}T10:00:00`;
  const h=harness({person:{timezone:undefined},travel}),r=await h.handler('create',{start:wall,stated_zone:'IST',attendees:[h.person.email]});assert.equal(r.error,'stated_time_clarification');
  const p=await precheck({rawZone:null,homeZone:null,travel,slots:[{wall_clock:wall,stated_timezone:'IST'}]});assert.equal(p.calls.checks.length,0);assert.match(p.result.promptBlock,/Which timezone/);
 }
});
test('fixed work-hours frame alone never establishes physical IST context',async()=>{
 const h=harness({person:{timezone:undefined},travel:null,hours:{timezone:'Asia/Kolkata'}}),r=await h.handler('create',{start:'2026-09-15T10:00:00',stated_zone:'IST',attendees:[h.person.email]});assert.equal(r.error,'stated_time_clarification');
 const p=await precheck({rawZone:null,homeZone:null,noTravel:true,hoursZone:'Asia/Kolkata',slots:[{wall_clock:'2026-09-15T10:00',stated_timezone:'IST'}]});assert.equal(p.calls.checks.length,0);assert.match(p.result.promptBlock,/Which timezone/);
});
test('known permanent zone remains context without a trip',async()=>{
 const h=harness({person:{timezone:'Asia/Kolkata'},travel:null}),r=await h.handler('create',{start:'2026-09-15T10:00:00',stated_zone:'IST',attendees:[h.person.email]});assert.equal(DateTime.fromISO(r.args.start).toUTC().toISO(),'2026-09-15T04:30:00.000Z');
 const p=await precheck({rawZone:'Asia/Kolkata',homeZone:'Asia/Kolkata',noTravel:true,slots:[{wall_clock:'2026-09-15T10:00',stated_timezone:'IST'}]});assert.equal(DateTime.fromISO(p.calls.checks[0].slotStartIso).toUTC().toISO(),'2026-09-15T04:30:00.000Z');
});
