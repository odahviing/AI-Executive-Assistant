const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),vm=require('vm'),{createRequire}=require('module');
const f=path.join(__dirname,'test-timezone-owner-interval.cjs'),m={exports:{}};
let source=fs.readFileSync(f,'utf8').split('if(require.main===module)')[0].replace(' function load(rel){',' Object.assign(mocks,options.extraMocks);\n function load(rel){').replace("if(rel==='src/connectors/graph/calendar.ts')return {...mocks['src/connectors/graph/calendarReads.ts'],","if(rel==='src/connectors/graph/calendar.ts')return {...mocks['src/connectors/graph/calendarReads.ts'],...options.calendar,");
source=source.replace('fs.readFileSync(path.join(root,rel)', 'fs.readFileSync(process.env.EMAIL_MECHANICS_BEFORE && rel === "src/skills/meetings/ops.ts" ? path.join(root,process.env.EMAIL_MECHANICS_BEFORE,rel) : path.join(root,rel)');
vm.runInNewContext(source,{require:createRequire(f),module:m,exports:m.exports,__dirname,process,console,Date,Buffer,setTimeout,clearTimeout});
async function run({channel="email",clean=false,offline=false,candidate=false,preferred=false,relaxed=true,overrideRows={},ownerEvents=[]}={}){const h=m.exports.harness(overrideRows, {offline,calendar:{oofUntilDisplayFor:()=>undefined,GraphPermissionError:class GraphPermissionError extends Error{},firstRejectReason:(...a)=>h.load('src/connectors/graph/findAvailableSlots.ts').firstRejectReason(...a)},extraMocks:{
 'src/skills/meetings/ops/analysis.ts':{},'src/skills/meetings/ops/handlers/createMeeting.ts':{},'src/skills/meetings/ops/handlers/moveMeeting.ts':{},'src/skills/meetings/ops/handlers/calendarReads.ts':{},
 'src/skills/meetings/ops/violationLabels.ts':{humanizeViolationLabel:x=>x},
 'src/skills/meetings/bookingRequest.ts':{grantRelaxed:()=>({relaxed})},
 'src/db/slotHolds.ts':{getActiveSlotHolds:()=>[]},'src/utils/offeredSlotsStash.ts':{getOfferedSlots:()=>[],getOfferedSearchFingerprint:()=>null,recordOfferedSlots:()=>{}},
 'src/db.ts':{getPersonMemory:()=>({})},
 'src/utils/displaySubject.ts':{subjectViewerFor:()=> 'owner',viewerEmailFor:()=>undefined},
 'src/utils/attendeeAvailability.ts':{ATTENDEE_REASON_PREFIXES:[],loadAttendeeAvailabilityForEmails:()=>[],attendeeTzForDay:e=>e.timezone,singleAttendeePresentationZone:()=>undefined},
 'src/connectors/graph/calendarReads.ts':{getFreeBusyForDecision:async()=>({}),getOwnerEventsForDecision:async()=>{if(offline)throw Error('fixture calendar unavailable');return ownerEvents;},isOutageShaped:()=>false,CalendarOfflineError:Error},
 }});Object.assign(h.load('src/utils/displaySubject.ts'),h.load('src/utils/displaySubject.ts',true));h.profile.meetings.work_hours_per_free_hour=clean?0:1;
 const context={profile:h.profile,channel,senderRole:'owner',surface:'owner_dm',authority:'owner',userId:'UOWNER',channelId:'email-fixture',threadTs:'fixture'};
 const args={search_from:'2026-09-14T12:00:00+03:00',search_to:'2026-09-14T12:25:00+03:00',time_window_is_hard:true,duration_minutes:25,meeting_mode:'online',relaxed,...(candidate?{candidate_slots:[{start:'2026-09-14T12:00:00+03:00'}]}:{})};
 if(preferred){args.search_to='2026-09-15T12:25:00+03:00';args.preferred_slot='2026-09-14T12:00:00+03:00';}
 const out=await new(h.load('src/skills/meetings/ops.ts').SchedulingSkill)().executeToolCall('find_available_slots',args,context);
 return {out,warnings:h.warnings,summary:h.load('src/core/orchestrator/turnHelpers.ts').summarizeToolCall('find_available_slots',args,out,h.profile.user.timezone)};}

test('regression full handler and engine owner email relaxed search removes focus mechanics',async()=>{const x=await run();assert.equal(x.warnings.length,0,JSON.stringify(x.warnings));assert.equal(x.out.length,1);assert.equal(x.out[0].broken_rule_label,undefined);assert.equal(x.out[0].broken_rules,undefined);assert.equal(x.out[0].less_preferred_label,'requires confirmation');assert.equal(x.out[0].start,'2026-09-14T12:00:00.000+03:00');});
test('regression full candidate validation removes focus reason but keeps rejection',async()=>{const x=await run({candidate:true,relaxed:false});assert.equal(x.warnings.length,0,JSON.stringify(x.warnings));assert.equal(x.out.results[0].available,false);assert.equal(x.out.results[0].broken_rule_label,undefined);});
test('preserved full owner DM has focus diagnostics',async()=>{const x=await run({channel:'slack'});assert.equal(x.warnings.length,0,JSON.stringify(x.warnings));assert.ok(x.out[0].broken_rules.includes('focus_time_floor'));assert.ok(x.out[0].broken_rule_label);});
test('preserved full clean email search keeps legitimate slot',async()=>{const x=await run({clean:true,relaxed:false});assert.equal(x.warnings.length,0,JSON.stringify(x.warnings));assert.equal(x.out.length,1);assert.equal(x.out[0].start,'2026-09-14T12:00:00.000+03:00');assert.equal(x.out[0].less_preferred_label,undefined);});
test('preserved full unavailable calendar cannot produce offers',async()=>{await assert.rejects(()=>run({offline:true}),/fixture calendar unavailable/);});

const awayEvent=showAs=>({id:'away',subject:'PRIVATE absence subject',sensitivity:'private',categories:[],isAllDay:true,isCancelled:false,showAs,start:{dateTime:'2026-09-14T00:00:00',timeZone:'Asia/Jerusalem'},end:{dateTime:'2026-09-15T00:00:00',timeZone:'Asia/Jerusalem'}});
const leadership={...awayEvent('busy'),id:'leadership',subject:'Leadership keep',isAllDay:false,start:{dateTime:'2026-09-14T16:30:00',timeZone:'Asia/Jerusalem'},end:{dateTime:'2026-09-14T17:10:00',timeZone:'Asia/Jerusalem'}};
for(const candidate of [false,true])for(const reason of ['vacation_or_off_day','owner_out_of_office'])test('regression real email '+(candidate?'candidate':'day summary')+' preserves '+reason+' into compact history',async()=>{
 const events=[awayEvent(reason==='owner_out_of_office'?'oof':'busy'),structuredClone(leadership)],before=JSON.stringify(events);
 const x=await run({clean:true,relaxed:false,candidate,ownerEvents:events,overrideRows:reason==='vacation_or_off_day'?{'2026-09-14':{isWorkday:false,note:'PRIVATE absence note'}}:{}});
 assert.equal(x.warnings.length,0,JSON.stringify(x.warnings));
 if(candidate){assert.equal(x.out.results[0].available,false);assert.equal(x.out.results[0].broken_rule,reason);assert.match(x.summary,/owner.*(?:off|out of office)/);}
 else {assert.ok(x.out.day_summary[0].top_reasons.includes(reason));assert.ok(x.summary.includes('off_days=2026-09-14('+reason));}
 assert.doesNotMatch(JSON.stringify(x),/PRIVATE absence|Leadership keep/);
 assert.equal(JSON.stringify(events),before,'existing Leadership and calendar events unchanged');
});
test('control real Busy-only email remains occupancy without an off-day assertion',async()=>{
 const x=await run({clean:true,relaxed:false,ownerEvents:[awayEvent('busy'),structuredClone(leadership)]});
 assert.equal(x.out.slots.length,0);assert.equal(x.out.day_summary[0].owner_all_day_busy,true);
 assert.equal(x.out.day_summary[0].top_reasons,undefined);assert.ok(!x.summary.includes('off_days='));
});
test('regression real preferred off-day survives beside legitimate offers and into history',async()=>{
 const x=await run({clean:true,relaxed:false,preferred:true,overrideRows:{'2026-09-14':{isWorkday:false}}});
 assert.ok(x.out.slots.length);assert.equal(x.out.preferred_slot_status.available,false);assert.equal(x.out.preferred_slot_status.broken_rule,'vacation_or_off_day');
 assert.match(x.summary,/preferred .*owner has this date off/);assert.ok(x.summary.includes('off_days=2026-09-14(vacation_or_off_day'));
});



