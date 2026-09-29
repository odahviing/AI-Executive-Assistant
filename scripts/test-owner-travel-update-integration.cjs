// Full handleUpdateMeeting -> actual locationSignalsFor/resolveLocation -> actual Graph PATCH builder.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');const {test}=require('node:test'),{createRequire}=require('node:module');
const file=path.join(__dirname,'test-timezone-owner-interval.cjs'),m={exports:{}};
let source=fs.readFileSync(file,'utf8').split('if(require.main===module)')[0];
source=source.replace("'src/utils/resolveLocation.ts':","'unused-location':").replace(' function load(rel){',' Object.assign(mocks,options.extraMocks);\n function load(rel){').replace("if(rel==='src/connectors/graph/calendar.ts')return {...mocks['src/connectors/graph/calendarReads.ts'],","if(rel==='src/connectors/graph/calendar.ts')return {...mocks['src/connectors/graph/calendarReads.ts'],...options.calendar,");
source=source.replace('fs.readFileSync(path.join(root,rel)', 'fs.readFileSync(process.env.OWNER_TRAVEL_BEFORE && rel === "src/skills/meetings/planMeeting.ts" ? path.join(root,process.env.OWNER_TRAVEL_BEFORE,rel) : path.join(root,rel)');
vm.runInNewContext(source,{require:createRequire(file),module:m,exports:m.exports,__dirname,process,console,Date,Buffer,setTimeout,clearTimeout});
async function run({trip=true,away=false,failure=false,unavailable=false,explicit=false}={}){
 const writes=[],calls=[],noop=()=>{},event={id:'fixture',subject:'Fixture',attendees:[{email:'peer@example.test'}],categories:[],startIso:'2026-09-14T12:00:00+03:00',endIso:'2026-09-14T12:25:00+03:00',location:'Old',isOnline:false};
 const extraMocks={
 'src/db/people.ts':{personIdForSlackId:id=>id==='UOWNER'?'owner':null,searchPeopleMemory:()=>[],getTravelRecordById:()=>trip?{from:'2026-09-14',until:'2026-09-14',location:'Boston'}:null,getEffectiveTimezoneById:()=>({})},
 'src/skills/meetings/ops/helpers.ts':{subjectsPlausiblyMatch:(a,b)=>a===b,HANDLER_ERROR_CODE:{}},
 'src/skills/meetings/ops/violationLabels.ts':{},'src/skills/meetings/bookingRequest.ts':{},
 'src/utils/closeMeetingArtifacts.ts':{closeMeetingArtifacts:async()=>calls.push('close')},
 'src/utils/weekdayGuard.ts':{},'src/tasks/skill.ts':{},'src/core/requests/logActivity.ts':{},
 'src/memory/resolveAttendeeEmails.ts':{resolveAttendeeEmail:a=>a},
 'src/db.ts':{auditLog:()=>calls.push('audit'),getPersonMemory:()=>({})},
 'src/utils/displaySubject.ts':{displaySubject:x=>x.subject,subjectViewerFor:()=> 'owner',viewerEmailFor:()=>undefined,isEventPrivate:()=>false},
 'src/connectors/graph/graphClient.ts':{getClient:()=>({api:()=>({patch:async body=>{calls.push('patch');if(failure)throw Error('fixture patch failed');writes.push(body);}})})},
 'src/connectors/graph/calendarCache.ts':{invalidateCalendarCache:noop},'src/config/userProfile.ts':{getProfileByEmail:()=>({user:{slack_user_id:'UOWNER'}})},
 };
 let h;const calendar={getEventType:async()=>{if(unavailable)throw Error('fixture unavailable');return{type:'singleInstance',subject:'Fixture'};},getEventForAttendeeUpdate:async()=>event,updateMeeting:args=>h.load('src/connectors/graph/calendarMutations.ts').updateMeeting(args)};
 h=m.exports.harness(away?{'2026-09-14':{location:'elsewhere',timezone:'America/New_York',isWorkday:true,windows:['00:00-23:59']}}:{},{extraMocks,calendar});
 h.profile.meetings.office_location={full_label:'Fixture office',meeting_room_label:'Fixture room',huddle_label:'Fixture huddle'};
 const args={meeting_id:'fixture',meeting_subject:'Fixture',add_attendees:[{email:'second@example.test'},{email:'third@example.test'}],...(explicit?{location:'Explicit venue'}:{})};
 let result,error;try{result=await h.load('src/skills/meetings/ops/handlers/moveMeeting.ts').handleUpdateMeeting(args,{context:{profile:h.profile,senderRole:'owner',authority:'owner',channel:'slack',userId:'UOWNER',isOwner:true},userEmail:h.profile.user.email,timezone:h.profile.user.timezone});}catch(e){error=e.message;}
 return{result,error,writes,calls,warnings:h.warnings};
}
test('regression full update stale owner trip cannot alter derived Graph venue',async()=>{const a=await run(),b=await run({trip:false});assert.equal(a.error,undefined,JSON.stringify(a));assert.equal(a.result?.success,true,JSON.stringify(a));assert.equal(a.writes.length,1);assert.equal(a.warnings.length,0,JSON.stringify(a.warnings));assert.ok(a.writes[0].location,'derived location must reach Graph PATCH');assert.deepEqual(JSON.parse(JSON.stringify(a.writes)),JSON.parse(JSON.stringify(b.writes)));assert.ok(a.calls.includes('close'));});
test('preserved full update dated away override remains online',async()=>{const x=await run({away:true});assert.equal(x.result?.success,true,JSON.stringify(x));assert.equal(x.writes[0].isOnlineMeeting,true);});
test('preserved explicit venue wins through full update',async()=>{const x=await run({explicit:true});assert.equal(x.result?.success,true,JSON.stringify(x));assert.equal(x.writes[0].location.displayName,'Explicit venue');});
test('preserved failed patch never reports successful update',async()=>{const x=await run({failure:true});assert.equal(x.error,'fixture patch failed');assert.equal(x.calls.includes('close'),false);assert.equal(x.writes.length,0);});
test('preserved unavailable preflight never patches',async()=>{const x=await run({unavailable:true});assert.equal(x.error,'fixture unavailable');assert.equal(x.calls.includes('patch'),false);});


