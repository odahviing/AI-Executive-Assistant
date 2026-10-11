// Real SchedulingSkill -> handler -> finder/checkSlot -> privacy scrub -> history.
// The shared harness isolates calendar/person I/O and freezes the clock.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {run}=require('./test-garage-recovery-summary.cjs');
const {regularWeek}=require('./fixtures/regular-week.cjs');
const {DateTime}=require('luxon');
const peer='peer@example.test',other='other@example.test';
const entry=(email=peer,start='09:00',end='17:00')=>({email,timezone:'Australia/Sydney',week:regularWeek(['Monday','Tuesday','Wednesday','Thursday','Friday'],start,end)});
const base=(extra={})=>({clean:true,busy:true,availabilityOverride:[entry()],argsOverride:{search_from:'2026-10-06',search_to:'2026-10-06'},...extra});
for(const role of ['owner','colleague'])test(`regression ${role} empty recovery reports working hours, decision first`,async()=>{
 const {out,summary}=await run(base({role}));
 assert.equal(out.slots.length,0);assert.ok(out.day_summary.some(d=>d.top_reasons.includes('outside_attendee_work_hours')));
 assert.ok(!out.day_summary.some(d=>d.top_reasons.includes('attendee_busy_collision')));
 assert.match(out._scheduling_decision_note,/choose|which path/);assert.match(out._scheduling_decision_note,/not evidence.*booked solid/);
 assert.equal(out.owner_approval_candidates,undefined);assert.match(summary,/outside_attendee_work_hours/);
});
test('regression explicit ask-owner choice gives bounded approval candidates, never booking authority',async()=>{
 const {out,calls}=await run(base({busy:false,role:'colleague',argsOverride:{search_from:'2026-10-06',search_to:'2026-10-06',owner_hours_exception_requested:true}}));
 assert.equal(out.slots.length,0);assert.ok(out.owner_approval_candidates?.length,JSON.stringify(out));
 assert.match(out._must_be_owner_approval_note,/Do NOT book directly/);
 for(const c of out.owner_approval_candidates){assert.equal(c.broken_rules,undefined);assert.equal(c.less_preferred_label,'requires owner approval');assert.equal(DateTime.fromISO(c.start).setZone('Australia/Sydney').toISODate(),'2026-10-06');}
 const recover=calls.searches.find(c=>c.relaxed&&c.keepWorkHours===false);assert.ok(recover);assert.equal(recover.autoExpand,false);
 // Latest suitable finish before owner's 09:00 start, not the first 01:00 AU-overlap option.
 assert.equal(DateTime.fromISO(out.owner_approval_candidates[0].end).setZone('Asia/Jerusalem').toFormat('HH:mm'),'08:55');
 assert.match(out.owner_approval_candidates[0].presentation_local,/16:15/);
});
test('preserved unchosen exception never relaxes owner hours',async()=>{
 const {out,calls}=await run(base({role:'colleague',busy:false}));assert.equal(out.owner_approval_candidates,undefined);assert.ok(!calls.searches.some(c=>c.relaxed&&c.keepWorkHours===false));
});
test('regression colleague cannot change another attendee hours',async()=>{
 const {out}=await run(base({busy:false,role:'colleague',requesterEmail:other,argsOverride:{search_from:'2026-10-06',search_to:'2026-10-06',attendee_hours:[{email:peer,end:'23:00'}]}}));assert.equal(out.slots.length,0);
});
test('preserved consenting requester specific own window produces normal slots',async()=>{
 const {out}=await run(base({busy:false,role:'colleague',requesterEmail:peer,argsOverride:{search_from:'2026-10-06',search_to:'2026-10-06',attendee_hours:[{email:peer,end:'23:00'}]}}));assert.ok(out.slots?.length,JSON.stringify(out));assert.equal(out.owner_approval_candidates,undefined);
});
test('regression unknown requester identity cannot waive hours',async()=>{
 const {out}=await run(base({busy:false,role:'colleague',argsOverride:{search_from:'2026-10-06',search_to:'2026-10-06',attendee_hours:[{email:peer,end:'23:00'}]}}));assert.equal(out.slots.length,0);
});
test('preserved own consent never waives second attendee',async()=>{
 const {out}=await run(base({busy:false,role:'colleague',requesterEmail:peer,availabilityOverride:[entry(),entry(other)],argsOverride:{search_from:'2026-10-06',search_to:'2026-10-06',attendee_emails:[peer,other],attendee_hours:[{email:peer,end:'23:00'}]}}));assert.equal(out.slots.length,0);
});
test('preserved owner targeted hours statement remains permitted',async()=>{
 const {out}=await run(base({busy:false,argsOverride:{search_from:'2026-10-06',search_to:'2026-10-06',attendee_hours:[{email:peer,end:'23:00'}]}}));assert.ok(out.slots.length);
});
test('preserved no consent persistence and retry stable',async()=>{
 const a=await run(base({busy:false,role:'colleague',requesterEmail:peer,argsOverride:{search_from:'2026-10-06',search_to:'2026-10-06',attendee_hours:[{email:peer,end:'23:00'}]}}));assert.ok(a.out.slots.length);
 const b=await run(base({busy:false,role:'colleague',requesterEmail:peer})),c=await run(base({busy:false,role:'colleague',requesterEmail:peer}));assert.equal(b.out.slots.length,0);assert.equal(JSON.stringify(b.out),JSON.stringify(c.out));
});
for(const role of ['owner','colleague'])test(`regression ${role} unavailable recovery is not empty availability`,async()=>{
 await assert.rejects(()=>run(base({role,recoveryOffline:true})),/fixture calendar unavailable/);
});
test('preserved owner authority in room can state attendee hours without exposing owner protections',async()=>{
 const {out}=await run(base({busy:false,role:'colleague',contextOverride:{authority:'owner',surface:'room'},argsOverride:{search_from:'2026-10-06',search_to:'2026-10-06',attendee_hours:[{email:peer,end:'23:00'}]}}));assert.ok(out.slots.length);assert.ok(out.slots.every(s=>!s.broken_rules));
});
test('regression colleague room has only authenticated self hours authority',async()=>{
 const {out}=await run(base({busy:false,role:'colleague',requesterEmail:other,contextOverride:{authority:'colleague',surface:'room'},argsOverride:{search_from:'2026-10-06',search_to:'2026-10-06',attendee_hours:[{email:peer,end:'23:00'}]}}));assert.equal(out.slots.length,0);
});
test('regression owner exploration candidates remain pending with actual violations',async()=>{
 const {out}=await run(base({busy:false,argsOverride:{search_from:'2026-10-06',search_to:'2026-10-06',owner_hours_exception_requested:true}}));assert.equal(out.slots.length,0);assert.ok(out.owner_approval_candidates.length);assert.ok(out.owner_approval_candidates.every(c=>c.broken_rules.includes('outside_working_hours')));assert.match(out._scheduling_decision_note,/await explicit booking authorization/);
});
test('regression actual approval module accepts selected candidate, rederives hours and persists pending action only',async()=>{
 const {out}=await run(base({busy:false,role:'colleague',argsOverride:{search_from:'2026-10-06',search_to:'2026-10-06',owner_hours_exception_requested:true}}));
 assert.ok(out.owner_approval_candidates?.length);const candidate=out.owner_approval_candidates[0];
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
 const file=path.join(__dirname,'test-approval-inperson-recheck.cjs'),module={exports:{}};
 // Reuse its real TasksSkill/validator/owner-notice loader; substitute only
 // fixture participant identity so the offered and approved attendee match.
 const prefix=fs.readFileSync(file,'utf8').split('const cases = [];')[0].replaceAll('elan@reflectiz.com',peer);
 vm.runInNewContext(prefix+'\nmodule.exports={harness};',{require:createRequire(file),module,__dirname,process,console,Buffer,setTimeout,clearTimeout});
 const h=module.exports.harness();const result=await h.create(candidate.start,candidate.end,true);
 assert.ok(!result.error,JSON.stringify(result));assert.equal(h.effects.creates.length,1);
 assert.equal(h.effects.creates[0].state,'awaiting_owner');const details=h.details();
 assert.equal(details.rule,'outside_working_hours');assert.equal(details.deferred_action.tool,'create_meeting');
 assert.equal(details.deferred_action.args.start,candidate.start);assert.equal(details.deferred_action.args.end,candidate.end);
 assert.equal(details.deferred_action.args.attendees[0].email,peer);
 assert.equal(h.effects.unexpected.length,0);assert.ok(h.effects.ownerPosts.length);
 const invalid=module.exports.harness();const refusal=await invalid.create(undefined,candidate.end,true);
 assert.equal(refusal.error,'missing_required_field');assert.equal(invalid.effects.creates.length,0);
});
test('preserved choice does not waive in-person home-day rule',async()=>{
 const {out}=await run(base({busy:false,inPersonHome:true,role:'colleague',argsOverride:{search_from:'2026-10-06',search_to:'2026-10-06',meeting_mode:'in_person',owner_hours_exception_requested:true}}));
 assert.equal(out.slots.length,0);assert.equal(out.owner_approval_candidates,undefined);
});
test('regression exploration permission cannot combine with relaxed to make bookable offers',async()=>{
 const {out}=await run(base({busy:false,argsOverride:{search_from:'2026-10-06',search_to:'2026-10-06',relaxed:true,owner_hours_exception_requested:true}}));assert.equal(out.slots.length,0);assert.ok(out.owner_approval_candidates?.length);
});
test('preserved owner exact named off-hours override still returns named candidate',async()=>{
 const {out}=await run(base({busy:false,argsOverride:{duration_minutes:25,relaxed:true,candidate_slots:[{start:'2026-10-06T12:00:00+03:00'}]}}));
 assert.ok(out.results?.length,JSON.stringify(out));assert.equal(out.results[0].available,true);assert.equal(out.results[0].start,'2026-10-06T12:00:00.000+03:00');
});




