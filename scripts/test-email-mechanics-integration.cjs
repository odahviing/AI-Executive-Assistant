const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),vm=require('vm'),{createRequire}=require('module');
const f=path.join(__dirname,'test-timezone-owner-interval.cjs'),m={exports:{}};
let source=fs.readFileSync(f,'utf8').split('if(require.main===module)')[0].replace(' function load(rel){',' Object.assign(mocks,options.extraMocks);\n function load(rel){').replace("if(rel==='src/connectors/graph/calendar.ts')return {...mocks['src/connectors/graph/calendarReads.ts'],","if(rel==='src/connectors/graph/calendar.ts')return {...mocks['src/connectors/graph/calendarReads.ts'],...options.calendar,");
source=source.replace('fs.readFileSync(path.join(root,rel)', 'fs.readFileSync(process.env.EMAIL_MECHANICS_BEFORE && rel === "src/skills/meetings/ops.ts" ? path.join(root,process.env.EMAIL_MECHANICS_BEFORE,rel) : path.join(root,rel)');
vm.runInNewContext(source,{require:createRequire(f),module:m,exports:m.exports,__dirname,process,console,Date,Buffer,setTimeout,clearTimeout});
async function run({channel="email",clean=false,offline=false,candidate=false,relaxed=true}={}){const h=m.exports.harness({}, {offline,calendar:{oofUntilDisplayFor:()=>undefined,GraphPermissionError:class GraphPermissionError extends Error{},firstRejectReason:d=>Object.keys(d??{})[0]},extraMocks:{
 'src/skills/meetings/ops/analysis.ts':{},'src/skills/meetings/ops/handlers/createMeeting.ts':{},'src/skills/meetings/ops/handlers/moveMeeting.ts':{},'src/skills/meetings/ops/handlers/calendarReads.ts':{},
 'src/skills/meetings/ops/violationLabels.ts':{humanizeViolationLabel:x=>x},
 'src/skills/meetings/bookingRequest.ts':{grantRelaxed:()=>({relaxed})},
 'src/db/slotHolds.ts':{getActiveSlotHolds:()=>[]},'src/utils/offeredSlotsStash.ts':{getOfferedSlots:()=>[],getOfferedSearchFingerprint:()=>null,recordOfferedSlots:()=>{}},
 'src/db.ts':{getPersonMemory:()=>({})},
 'src/utils/displaySubject.ts':{subjectViewerFor:()=> 'owner',viewerEmailFor:()=>undefined},
 'src/utils/attendeeAvailability.ts':{ATTENDEE_REASON_PREFIXES:[],loadAttendeeAvailabilityForEmails:()=>[],attendeeTzForDay:e=>e.timezone,singleAttendeePresentationZone:()=>undefined},
 }});h.profile.meetings.work_hours_per_free_hour=clean?0:1;
 const context={profile:h.profile,channel,senderRole:'owner',userId:'UOWNER',channelId:'email-fixture',threadTs:'fixture'};
 const out=await new(h.load('src/skills/meetings/ops.ts').SchedulingSkill)().executeToolCall('find_available_slots',{search_from:'2026-09-14T12:00:00+03:00',search_to:'2026-09-14T12:25:00+03:00',time_window_is_hard:true,duration_minutes:25,meeting_mode:'online',relaxed,...(candidate?{candidate_slots:[{start:'2026-09-14T12:00:00+03:00'}]}:{})},context);return {out,warnings:h.warnings};}

test('regression full handler and engine owner email relaxed search removes focus mechanics',async()=>{const x=await run();assert.equal(x.warnings.length,0,JSON.stringify(x.warnings));assert.equal(x.out.length,1);assert.equal(x.out[0].broken_rule_label,undefined);assert.equal(x.out[0].broken_rules,undefined);assert.equal(x.out[0].less_preferred_label,'requires confirmation');assert.equal(x.out[0].start,'2026-09-14T12:00:00.000+03:00');});
test('regression full candidate validation removes focus reason but keeps rejection',async()=>{const x=await run({candidate:true,relaxed:false});assert.equal(x.warnings.length,0,JSON.stringify(x.warnings));assert.equal(x.out.results[0].available,false);assert.equal(x.out.results[0].broken_rule_label,undefined);});
test('preserved full owner DM has focus diagnostics',async()=>{const x=await run({channel:'slack'});assert.equal(x.warnings.length,0,JSON.stringify(x.warnings));assert.ok(x.out[0].broken_rules.includes('focus_time_floor'));assert.ok(x.out[0].broken_rule_label);});
test('preserved full clean email search keeps legitimate slot',async()=>{const x=await run({clean:true,relaxed:false});assert.equal(x.warnings.length,0,JSON.stringify(x.warnings));assert.equal(x.out.length,1);assert.equal(x.out[0].start,'2026-09-14T12:00:00.000+03:00');assert.equal(x.out[0].less_preferred_label,undefined);});
test('preserved full unavailable calendar cannot produce offers',async()=>{await assert.rejects(()=>run({offline:true}),/fixture calendar unavailable/);});



