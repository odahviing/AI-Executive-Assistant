// Actual finder -> handler -> compact history -> actual output-gate inputs.
// Isolated calendar and model responses; no network/LLM/writes. Captures prove
// grounding inputs and safe control flow, never model semantic obedience.
const fs=require('fs'),path=require('path'),Module=require('module'),assert=require('assert/strict'),{test}=require('node:test');
function fixture(file,marker,tail,transform=x=>x){const absolute=path.resolve(file),m=new Module(absolute,module);m.filename=absolute;m.paths=Module._nodeModulePaths(path.dirname(absolute));m._compile(transform(fs.readFileSync(absolute,'utf8').split(marker)[0])+tail,absolute);return m.exports;}
const idx=process.argv.indexOf('--source-dir');
if(idx>=0)process.env.SLOT_PRIORITY_BEFORE=path.relative(process.cwd(),path.resolve(process.argv[idx+1]));
const {run}=fixture('scripts/test-garage-recovery-summary.cjs','for(const role','',s=>s.replace("start:'2026-10-06T00:00:00+03:00',end:'2026-10-07T00:00:00+03:00'","start:'2026-10-08T12:40:00+03:00',end:'2026-10-08T14:15:00+03:00'"));
const {harness,ctx,profile}=fixture('scripts/test-gatekeeper-join-summary-action.cjs','for(const [id,extra]','\nmodule.exports={harness,ctx,profile};');
const options={clean:true,busy:true,argsOverride:{search_from:'2026-10-08',search_to:'2026-10-08'},availabilityOverride:[{email:'peer@example.test',timezone:'Asia/Jerusalem',week:require('./fixtures/regular-week.cjs').regularWeek(['Thursday'],'10:00','19:00')}]};
test('an empty shared calendar view cannot become evidence that the owner is free',async()=>{
 const h=harness();
 const summary=h.turn.summarizeToolCall('get_calendar',{start_date:'2026-10-26',end_date:'2026-10-26'},{events:[],_colleague_view:true},profile.user.timezone);
 assert.match(summary,/scope=shared_with_requester_only/);
 assert.match(summary,/not_owner_availability/);
 const full=h.turn.summarizeToolCall('get_calendar',{start_date:'2026-10-26',end_date:'2026-10-26'},[],profile.user.timezone);
 assert.doesNotMatch(full,/shared_with_requester_only/);
});

test('candidate receipt preserves both the owner and attendee rejection reasons',()=>{
 const h=harness();
 const summary=h.turn.summarizeToolCall('find_available_slots',{duration_minutes:25},{mode:'candidate_validation',duration_minutes:25,
  results:[{start:'2026-10-21T13:15:00+03:00',end:'2026-10-21T13:40:00+03:00',available:false,owner_available:false,
   broken_rule:'attendee_busy_collision:einav@example.test',broken_rule_label:'Einav is busy',
   broken_rule_labels:['Einav is busy','in conflict with another meeting on Idan’s calendar']} ]},'Asia/Jerusalem');
 assert.match(summary,/Einav is busy/);assert.match(summary,/in conflict with another meeting on Idan’s calendar/);
 assert.equal(summary.split('Einav is busy').length,2,'the primary reason is not duplicated');
 assert.match(summary,/owner_available=false/);
});
for(const [id,extra,role] of [['owner-dm',{senderId:'UOWNER',role:'owner'},'owner'],['colleague-dm',{},'colleague'],['owner-room',{senderId:'UOWNER',role:'owner',isMpim:true,isOwnerInGroup:true},'colleague'],['colleague-room',{isChannel:true,channelId:'CROOM'},'colleague']])test('rejected-candidates-'+id,async()=>{
 const r=await run({...options,role}),h=harness();assert.ok(r.out.slots.some(s=>s.start.includes('T11:00:')));assert.equal(r.out.day_summary[0].attendee_partial_conflicts[0].slots_blocked,68);
 assert.ok(r.summary.includes('rejected_search_candidates=2026-10-08(peer@example.test:68) (not offered-slot availability)'),r.summary);assert.ok(!r.summary.includes('attendee_partial='));
 const draft='Thursday 11:00 is one of the returned options.';assert.equal(await h.gates.runOutputGates(draft,ctx(r.summary,extra)),draft);assert.ok(h.calls.some(c=>c.messages[0].content.includes(r.summary)));assert.ok(h.events.includes('date'));
});
test('rejected-candidates-restart-history',async()=>{const r=await run(options),h=harness();await h.gates.runOutputGates('Thursday 11:00 is one of the returned options.',ctx('',{result:{toolSummaries:[],availabilityQuestionDetected:true},history:[{role:'assistant',content:r.summary+'\nPrior response.'}]}));assert.ok(h.calls.some(c=>c.messages[0].content.includes('(earlier turn) '+r.summary.slice(0,r.summary.lastIndexOf(']')+1))));assert.ok(r.summary.includes('not offered-slot availability'));});
test('offer-conflicts-remain-attached-to-own-slot', () => {
 const h = harness();
 const summary = h.turn.summarizeToolCall('find_available_slots', {duration_minutes:40}, {
  slots:[
   {start:'2026-10-08T11:00:00+03:00',end:'2026-10-08T11:40:00+03:00',
    attendee_conflicts:[{email:'peer@example.test',reason:'off_hours',assumed:true}]},
   {start:'2026-10-08T14:00:00+03:00',end:'2026-10-08T14:40:00+03:00',
    attendee_status:[{email:'peer@example.test',status:'unknown'}]},
  ],
 }, profile.user.timezone);
 assert.ok(summary.includes(
  '11:00-11:40 Asia/Jerusalem owner_status=available attendee_conflicts=peer@example.test:off_hours(assumed), '
  + '2026-10-08 14:00-14:40 Asia/Jerusalem owner_status=available attendee_status=peer@example.test:unknown'), summary);
});
test('preserved-clean-offers-and-retry',async()=>{const a=await run({clean:true}),b=await run({clean:true});assert.ok(a.out.slots.length);assert.equal(a.summary,b.summary);assert.ok(a.out.slots.every(s=>!s.attendee_conflicts?.length));});
test('preserved-empty-offhours-reason',async()=>{const r=await run({offhours:true});assert.equal(r.out.slots.length,0);assert.ok(r.summary.includes('outside_attendee_work_hours'));});

test('zero openings retain checked bounds, named attendee constraints and explicit full-day busy facts',()=>{
 const h=harness();const line=h.turn.summarizeToolCall('find_available_slots',{duration_minutes:25},{slots:[],
  search_outcome:{from:'2026-10-29T18:15:00+02:00',to:'2026-11-05T23:59:59+02:00'},day_summary:[
   {date:'2026-10-29',accepted:0,top_reasons:['outside_attendee_work_hours'],blocked_by:[{email:'oran@example.test',slots_blocked:23}]},
   {date:'2026-11-01',accepted:0,top_reasons:['owner_busy_collision'],owner_all_day_busy:true},
   {date:'2026-11-02',accepted:0,top_reasons:['owner_busy_collision']},
  ]},profile.user.timezone);
 assert.match(line,/2026-10-29T18:15→2026-11-05T23:59/);
 assert.match(line,/attendee_blocked=2026-10-29\(oran@example.test:23/);
 assert.match(line,/owner_all_day_busy=2026-11-01/);assert.doesNotMatch(line,/owner_all_day_busy=2026-11-02/);
});

test('specific attendee busy result carries its booker-choice meaning into the guard receipt',()=>{
 const h=harness();const line=h.turn.summarizeToolCall('find_available_slots',{duration_minutes:40},{mode:'candidate_validation',results:[
  {start:'2026-11-10T12:15:00-05:00',end:'2026-11-10T12:55:00-05:00',available:false,owner_available:true,broken_rule:'attendee_busy_collision:craig@example.test'},
 ]},'America/New_York');
 assert.match(line,/attendee_conflict_can_be_accepted_by_booker/);
 const hours=h.turn.summarizeToolCall('find_available_slots',{}, {mode:'candidate_validation',results:[{available:false,owner_available:true,broken_rule:'outside_attendee_work_hours:craig@example.test'}]},'America/New_York');
 assert.doesNotMatch(hours,/attendee_conflict_can_be_accepted_by_booker/);
});
test('queued message receipt retains pending delivery without claiming replay completion', () => {
 const h = harness();
 const summary = h.turn.summarizeToolCall('resolve_approval', {}, {
  ok:true, state:'resolved', effect:'approved — message scheduled and awaiting delivery',
 }, profile.user.timezone);
 assert.match(summary,/message scheduled and awaiting delivery/);
 assert.doesNotMatch(summary,/replayed the approved action/);
});

test('a delivered queue notice is distinct from delivery of the requested message', () => {
 const h = harness();
 const summary = h.turn.summarizeToolCall('resolve_approval', {}, {
  ok:true,state:'resolved',effect:'approved — message scheduled and awaiting delivery',
  requester_notify_outcome:'sent',requester_notice:'message_pending',
 }, profile.user.timezone);
 assert.match(summary,/sent — requester told the message is awaiting delivery/);
 assert.doesNotMatch(summary,/requester notified \(relay confirmed\)/);
});
test('preserved-unavailable-calendar',async()=>assert.rejects(run({offline:true}),/fixture calendar unavailable/));
test('preserved-unknown-attendee-result',async()=>{const r=await run({unknown:true});assert.ok(r.out.attendees_not_checked.includes('peer@example.test'));assert.ok(!r.summary.includes('calendars_read=peer@example.test'));});
test('preserved-unavailable-gate-safe-miss',async()=>{const h=harness({unavailable:true}),r=await run({clean:true}),draft='Thursday 11:00 is an option.';assert.equal(await h.gates.runOutputGates(draft,ctx(r.summary)),draft);});
