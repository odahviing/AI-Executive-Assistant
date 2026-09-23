// Actual Graph reader, move-plan consumer, room-notice branch and PATCH builder.
// Isolated provider fixtures; no application, DB, model or network calls.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript'),luxon=require('luxon'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),i=process.argv.indexOf('--source-revision'),rev=i<0?null:process.argv[i+1];
const read=f=>rev?cp.execFileSync('git',['show',`${rev}:${f}`],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,f),'utf8');
function nodes(f,p){const out=[],tree=ts.createSourceFile(f,read(f),ts.ScriptTarget.Latest,true);(function walk(n){if(p(n))out.push(n);ts.forEachChild(n,walk);})(tree);return out;}
function one(a){assert.equal(a.length,1);return a[0];}
function compile(src,globals={},deps={}){const m={exports:{}};vm.runInNewContext(ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{...globals,module:m,exports:m.exports,require:n=>{if(n in deps)return deps[n];throw Error('Unexpected dependency '+n);}});return m.exports;}
const move='src/skills/meetings/ops/handlers/moveMeeting.ts',logger={info(){},warn(){},error(){}};
const book=one(nodes(move,n=>ts.isIfStatement(n)&&n.expression.getText()==="movePlan.action === 'book'")).getText();
const patchCall=one(nodes(move,n=>ts.isCallExpression(n)&&n.expression.getText()==='updateMeeting'&&n.arguments[0]?.getText().includes('location: movePlanLocation'))).getText();
const reader=one(nodes('src/connectors/graph/calendarReads.ts',n=>ts.isFunctionDeclaration(n)&&n.name?.text==='getEventForAttendeeUpdate')).getText();
const notice=one(nodes(move,n=>ts.isIfStatement(n)&&n.expression.getText()==="roomVerdict.kind === 'room_busy_small_fits'"&&n.getText().includes('ownerRoomBusyNotice'))).getText();
const venueLookup=one(nodes('src/skills/meetings/planMeeting.ts',n=>ts.isIfStatement(n)&&n.expression.getText().includes('locationVerdict')&&n.expression.getText().includes('isCompanyLocation'))).getText();
const saveVenue=one(nodes('src/skills/meetings/ops/handlers/createMeeting.ts',n=>ts.isIfStatement(n)&&n.expression.getText().includes('context.profile.skills')&&n.expression.getText().includes('planLocation'))).getText();
const createRoom=one(nodes('src/skills/meetings/ops/handlers/createMeeting.ts',n=>ts.isIfStatement(n)&&n.expression.getText()==='planAddRoomEmail && context.profile.meetings.room_email')).getText();
function createRoomRoster(addRoomEmail,emails){const attendees=emails.map(email=>({email}));compile(createRoom,{attendees,plan:{addRoomEmail},planAddRoomEmail:addRoomEmail===true,planLocation:'Meeting Room',context:{profile}});return attendees;}
function saveLocation(location){const saves=[];compile(saveVenue,{context:{profile:{skills:{venue:true},meetings:{},user:{slack_user_id:'owner'}}},planLocation:location,logger},{'../../../../db/venues':{isCompanyLocation:s=>['Office','Huddle','Microsoft Teams Meeting'].includes(s)},'../../../venue':{saveOrBumpVenueOnBook:x=>saves.push(x)},'../../../../utils/resolveLocation':{isPhoneLocationString:s=>s.startsWith('+')}});return saves;}
function travel(online,location){const fn=compile(`module.exports=()=>{let venueTravelMinutes;${venueLookup}\nreturn venueTravelMinutes;};`,{profile:{skills:{venue:true},user:{slack_user_id:'owner'},meetings:{office_location:{}}},locationVerdict:{kind:'resolved',location,isOnline:online},isPhoneLocationString:s=>s.startsWith('+'),isCompanyLocation:s=>['Office','Microsoft Teams Meeting','Huddle'].includes(s),getVenueTravelTimeMinutes:()=>45});return fn();}
let persisted,attempts,mode='success';
const mutations=compile(read('src/connectors/graph/calendarMutations.ts'),{}, {
 luxon,'../../utils/logger':{default:logger,__esModule:true},'../../db':{auditLog(){}},'../../config/userProfile':{getProfileByEmail:()=>({user:{slack_user_id:'owner'}})},'./calendarReads':{},'./calendarCache':{invalidateCalendarCache(){}},'./graphClient':{getClient:()=>({api:()=>({async patch(body){attempts.push(body);if(mode==='failure')throw Error('503');Object.assign(persisted,JSON.parse(JSON.stringify(body)));if(mode==='unknown')throw Error('response lost');}})})},
});
const getEvent=compile(reader+'\nmodule.exports=getEventForAttendeeUpdate;', {logger,getClient:()=>({api:()=>({select(){return this;},async get(){return persisted;}})}),eventPartAsInstant:x=>x?.dateTime});
const profile={user:{email:'owner@example.test',timezone:'UTC'},meetings:{room_email:'room@example.test'},categories:[]};
function attendee(email,type='required'){return{emailAddress:{address:email,name:email},type};}
async function run(plan,roster,options={}){
 persisted={attendees:roster,categories:[],location:{displayName:'Old'},isOnlineMeeting:true};attempts=[];mode=options.mode??'success';
 const execute=async()=>{const movingEvent=await getEvent(profile.user.email,'event');const fn=compile(`module.exports=async()=>{let movePlanLocation,movePlanIsOnline,movePlanCategories,movePlanPreserveExisting=false,movePlanOverrideNotice,movePlanAttendees;${book}\nawait ${patchCall};};`,{movePlan:plan,moveAttendees:movingEvent.attendees,existingLocation:movingEvent.location,context:{profile},existingCats:[],userEmail:profile.user.email,timezone:'UTC',args:{meeting_id:'event'},effectiveStart:'2026-09-25T10:00:00Z',effectiveEnd:'2026-09-25T10:25:00Z',preMoveIsAllDay:false,preMoveEventType:'singleInstance',updateMeeting:mutations.updateMeeting});await fn();};
 let error;try{await execute();}catch(e){error=e.message;}
 if(options.retry){mode='success';await execute();}
 return {persisted,attempts,error};
}
const home={action:'book',location:'Huddle',isOnline:false},office={action:'book',location:'Meeting Room',isOnline:true,addRoomEmail:true};
let passed=0,failed=0;
async function check(id,fn){try{await fn();passed++;console.log('ok '+id);}catch(e){failed++;console.log('not ok '+id+': '+e.message);}}
(async()=>{
 await check('regression create-busy-fallback-removes-preadded-room',()=>assert.equal(createRoomRoster(false,['room@example.test','person@example.test']).length,1));
 await check('preserved create-room-free-keeps-one-invitation',()=>assert.equal(createRoomRoster(true,['room@example.test','person@example.test']).length,2));
 await check('regression phone-dial-is-not-saved-as-place',()=>assert.equal(saveLocation('+972555123456').length,0));
 await check('preserved outside-place-is-saved',()=>assert.equal(saveLocation('Cafe, Street 1').length,1));
 await check('preserved company-huddle-not-saved',()=>{for(const location of ['Office','Huddle','Microsoft Teams Meeting',''])assert.equal(saveLocation(location).length,0);});
 await check('regression hybrid-outside-venue-keeps-saved-travel',()=>assert.equal(travel(true,'Cafe, Street 1'),45));
 await check('preserved physical-outside-venue-travel',()=>assert.equal(travel(false,'Cafe, Street 1'),45));
 await check('preserved remote-company-phone-have-no-venue-travel',()=>{for(const location of ['','Office','Microsoft Teams Meeting','Huddle','+972555123456'])assert.equal(travel(true,location),undefined);});
 await check('regression move-home-to-office-adds-room',async()=>{const r=await run(office,[attendee('person@example.test')]);assert.ok(r.persisted.attendees.some(a=>a.emailAddress.address==='room@example.test'));});
 await check('regression move-office-to-home-releases-room',async()=>{const r=await run(home,[attendee('person@example.test'),attendee('room@example.test','resource')]);assert.equal(r.persisted.attendees.length,1);});
 await check('regression unrelated-resource-type-preserved',async()=>{const r=await run(office,[attendee('projector@example.test','resource')]);assert.equal(r.persisted.attendees.find(a=>a.emailAddress.address==='projector@example.test').type,'resource');assert.ok(r.attempts[0].attendees);});
 await check('regression graph-reader-writer-retains-resource',async()=>{persisted={attendees:[attendee('projector@example.test','resource')],categories:[]};attempts=[];mode='success';const event=await getEvent('owner@example.test','event');await mutations.updateMeeting({userEmail:'owner@example.test',timezone:'UTC',meetingId:'event',attendees:event.attendees});assert.equal(persisted.attendees[0].type,'resource');});
 await check('preserved same-day-venue-and-roster-untouched',async()=>{const r=await run({...office,preserveExisting:true},[attendee('room@example.test','resource')]);assert.equal(r.attempts[0].attendees,undefined);assert.equal(r.attempts[0].location,undefined);});
 await check('preserved existing-room-not-duplicated',async()=>{const r=await run(office,[attendee('room@example.test','resource')]);assert.equal(r.persisted.attendees.length,1);assert.equal(r.persisted.attendees[0].type,'resource');});
 await check('preserved optional-human-retained',async()=>{const r=await run(office,[attendee('person@example.test','optional')]);assert.equal(r.persisted.attendees[0].type,'optional');});
 await check('preserved no-resource-change-no-roster-patch',async()=>{const r=await run(home,[attendee('person@example.test')]);assert.equal(r.attempts[0].attendees,undefined);});
 await check('preserved explicit-existing-label-keeps-room',async()=>{const r=await run({...home,location:'Old'},[attendee('room@example.test','resource')]);assert.equal(r.attempts[0].attendees,undefined);assert.equal(r.persisted.attendees.length,1);});
 await check('preserved failed-patch-leaves-state',async()=>{const r=await run(office,[],{mode:'failure'});assert.equal(r.error,'503');assert.equal(r.persisted.attendees.length,0);});
 await check('regression unknown-completion-retry-keeps-one-room',async()=>{const r=await run(office,[],{mode:'unknown',retry:true});assert.equal(r.error,'response lost');assert.equal(r.persisted.attendees.filter(a=>a.emailAddress.address==='room@example.test').length,1);});
 await check('regression small-room-not-claimed-free',async()=>{const fn=compile(`module.exports=()=>{let mergedAttendees=[{email:'room@example.test'},{email:'person@example.test'}],ownerRoomBusyNotice;${notice}\nreturn{ownerRoomBusyNotice,mergedAttendees};};`,{roomVerdict:{kind:'room_busy_small_fits',smallLabel:'Small Office'},roomEmailLc:'room@example.test',logger,args:{meeting_id:'event'},postEditParticipantCount:4});const r=fn();assert.ok(!r.ownerRoomBusyNotice.includes('is free'));assert.match(r.ownerRoomBusyNotice,/not checked|unverified/);assert.equal(r.mergedAttendees.length,1);});
 await check('preserved large-group-keeps-busy-notice',async()=>{const fn=compile(`module.exports=()=>{let mergedAttendees=[{email:'room@example.test'}],ownerRoomBusyNotice;${notice}\nreturn{ownerRoomBusyNotice,mergedAttendees};};`,{roomVerdict:{kind:'room_busy_too_big'},roomEmailLc:'room@example.test',logger,args:{meeting_id:'event'},postEditParticipantCount:6});const r=fn();assert.match(r.ownerRoomBusyNotice,/already taken/);assert.equal(r.mergedAttendees.length,0);});
 console.log(JSON.stringify({passed,failed,revision:rev??'working-tree'}));process.exitCode=failed?1:0;
})();
