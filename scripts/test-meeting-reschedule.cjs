// Full production finder and validator, isolated calendar/person IO; no app startup.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),cp=require('node:child_process');
const revIndex=process.argv.indexOf('--revision'),revision=revIndex<0?null:process.argv[revIndex+1];
const sourceRootIndex=process.argv.indexOf('--snapshot');
if(sourceRootIndex>=0)process.env.MATCHMAKER_SNAPSHOT=process.argv[sourceRootIndex+1];
if(revision){
 const snap='artifacts/workshop-verification/meeting-reschedule-20261014/matchmaker/before';
 for(const file of ['src/connectors/graph/findAvailableSlots.ts','src/connectors/graph/calendarReads.ts','src/skills/meetings/planMeeting.ts','src/utils/scheduleRules.ts','src/utils/meetingRoomAvailability.ts']){
  const dest=path.join(__dirname,'..',snap,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,cp.execFileSync('git',['show',revision+':'+file],{encoding:'utf8'}));
 }
 process.env.MATCHMAKER_SNAPSHOT=snap;
}
const {harness}=require('./test-timezone-owner-decisions.cjs');
const {createMoveHarness}=require('./test-yael-meeting-selection.cjs');
const at=clock=>'2026-10-14T'+clock+':00Z';
const selectedSource=file=>fs.readFileSync(process.env.MATCHMAKER_SNAPSHOT&&fs.existsSync(path.join(process.env.MATCHMAKER_SNAPSHOT,file))?path.join(process.env.MATCHMAKER_SNAPSHOT,file):file,'utf8');
function fixture(extra=[]) {
 const h=harness({ownerZone:'UTC',person:{timezone:'UTC'},travel:null,hours:{hoursStart:'00:00',hoursEnd:'24:00'}});
 const event=(id,start,end)=>({id,subject:id,start:{dateTime:at(start),timeZone:'UTC'},end:{dateTime:at(end),timeZone:'UTC'},isAllDay:false,isCancelled:false,isOnlineMeeting:true,showAs:'busy',attendees:[]});
 const source=event('moving','14:00','14:40'),events=[source,...extra.map(e=>event(...e))];
 const reads=h.load('src/connectors/graph/calendarReads.ts');
 reads.getOwnerEventsForDecision=async()=>events;
 reads.getFreeBusyForDecision=async()=>({'owner@example.test':events.map(e=>({start:e.start.dateTime,end:e.end.dateTime,status:'busy'}))});
 const find=(start,end,flags={})=>h.find(at(start),at(end),{excludeEventIds:['moving'],attendeeAvailability:[],...flags});
 return {h,source,events,reads,find};
}
test('A1 regression partial-overlap move is a valid candidate',async()=>assert.equal((await fixture().find('14:15','14:55')).length,1));
test('A1 regression overlap in earlier direction is valid',async()=>assert.equal((await fixture().find('13:45','14:25')).length,1));
test('A2 preserved exact unchanged interval is not advertised',async()=>assert.equal((await fixture().find('14:00','14:40')).length,0));
test('A2 regression same start with changed duration is a real update',async()=>assert.equal((await fixture().find('14:00','14:30')).length,1));
test('preserved unrelated owner event blocks shifted candidate',async()=>assert.equal((await fixture([['other','14:45','15:15']]).find('14:15','14:55')).length,0));
test('preserved nonoverlap move remains available',async()=>assert.equal((await fixture().find('15:00','15:40')).length,1));
test('preserved defrag overlap caller remains valid',async()=>assert.equal((await fixture().find('14:15','14:55',{allowMovingEventOverlap:true})).length,1));
test('preserved exact-time internal caller exemption remains valid',async()=>assert.equal((await fixture().find('14:00','14:40',{allowMovingEventOverlap:true})).length,1));
test('preserved owner override remains a validator decision',()=>{const f=fixture([['other','14:45','15:15']]);const verdict=f.h.load('src/utils/scheduleRules.ts').checkSlot({profile:f.h.profile,slotStartIso:at('14:15'),slotEndIso:at('14:55'),events:f.events,excludeEventIds:['moving'],allowRelaxed:true,category:null,viewer:'owner'});assert.equal(verdict.passes,true);});
test('A18 preserved another occurrence is not excluded with the chosen occurrence',async()=>assert.equal((await fixture([['next-occurrence','15:00','15:40']]).find('15:00','15:40')).length,0));
test('A2 regression explicit unchanged move avoids PATCH and terminal side effects',async()=>{const h=createMoveHarness({owner:true});const r=await h.run({new_start:'2026-10-11T09:00:00+03:00',new_end:'2026-10-11T09:40:00+03:00'});assert.equal(r.unchanged,true);assert.equal(h.state.writes.length,0);assert.equal(h.state.closed.length,0);assert.equal(h.state.activities.length,0);});
test('A13 preserved explicit target writes identified event once',async()=>{const h=createMoveHarness({owner:true});assert.equal((await h.run()).success,true);assert.equal(h.state.writes.length,1);assert.equal(h.state.writes[0].meetingId,h.args.meeting_id);});
function identityFixture({extra=[],offline=false,missingUid=false,stale=false}={}){
 const {DateTime}=require('luxon');
 const source={id:'moving',iCalUId:missingUid?undefined:'occurrence-uid',type:'occurrence',start:{dateTime:at('14:00'),timeZone:'UTC'},end:{dateTime:at('14:40'),timeZone:'UTC'},attendees:[{emailAddress:{address:'person@example.test'}}],isCancelled:false};
 const events=[{...source,id:'attendee-copy',showAs:'busy'},...extra.map(([id,start,end])=>({id,iCalUId:id,type:'singleInstance',start:{dateTime:at(start),timeZone:'UTC'},end:{dateTime:at(end),timeZone:'UTC'},showAs:'busy',isCancelled:false}))];
 const busy={'owner@example.test':[{start:at('14:00'),end:at('14:40'),status:'busy'}],'person@example.test':events.map(e=>({start:e.start.dateTime,end:e.end.dateTime,status:e.showAs}))};
 const getFreeBusy=async()=>structuredClone(busy),requests=[];
 const client={api(url){let req={header(){return req},select(value){requests.push({url,select:value});return req},query(value){requests.push({url,query:value});return req},async get(){if(url.includes('/events/'))return stale?{...source,id:'wrong'}:source;if(offline)throw Error('calendar forbidden');return {value:events};}};return req;}};
 const file='src/connectors/graph/calendarReads.ts',sourceText=revision?cp.execFileSync('git',['show',revision+':'+file],{encoding:'utf8'}):fs.readFileSync(file,'utf8');
 const tree=ts.createSourceFile(file,sourceText,ts.ScriptTarget.Latest,true);
 const fn=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='getFreeBusyForDecision');
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(fn.getText(),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,DateTime,Date,Set,getClient:()=>client,getFreeBusy,toStartOfDayLocal:s=>s,toEndOfDayLocal:s=>s,logger:{warn(){}}});
 return {read:module.exports.getFreeBusyForDecision,requests,source,events};
}
test('A3 regression identity-bearing read preserves attendee double-booking',async()=>{const f=fixture(),i=identityFixture({extra:[['other','14:20','14:25']]});f.reads.getFreeBusyForDecision=i.read;const result=await f.find('14:15','14:55',{attendeeBusyEmails:['person@example.test'],allowMovingEventOverlap:true});assert.equal(result.length,0);});
test('A1 regression attendee self-copy excluded by occurrence identity',async()=>{const f=fixture(),i=identityFixture();f.reads.getFreeBusyForDecision=i.read;const result=await f.find('14:15','14:55',{attendeeBusyEmails:['person@example.test']});assert.equal(result.length,1);});
test('A4 regression missing identity produces unconfirmed availability',async()=>{const i=identityFixture({missingUid:true}),diag={};const busy=await i.read('owner@example.test',['person@example.test'],at('14:15'),at('14:55'),'UTC',diag,['moving']);assert.deepEqual(Array.from(diag.notChecked??[]),['person@example.test']);assert.equal(busy['person@example.test'].length,0);});
test('A21 regression inaccessible attendee identity remains an owner-side option with qualification',async()=>{const f=fixture(),i=identityFixture({offline:true}),diag={};f.reads.getFreeBusyForDecision=i.read;assert.equal((await f.find('14:15','14:55',{attendeeBusyEmails:['person@example.test'],diagnosticsOut:diag})).length,1);assert.deepEqual(Array.from(diag.attendeesNotChecked??[]),['person@example.test']);});
test('A7 preserved separate 14:45 commitment is busy',async()=>{const f=fixture(),i=identityFixture({extra:[['real-later','14:45','15:00']]});f.reads.getFreeBusyForDecision=i.read;assert.equal((await f.find('14:15','14:55',{attendeeBusyEmails:['person@example.test']})).length,0);});
test('A18 regression corresponding occurrence excluded, later occurrence retained',async()=>{const i=identityFixture({extra:[['next-uid','15:00','15:40']]}),busy=await i.read('owner@example.test',['person@example.test'],at('14:00'),at('16:00'),'UTC',{},['moving']);assert.equal(busy['person@example.test'].length,1);assert.equal(Date.parse(busy['person@example.test'][0].start),Date.parse(at('15:00')));});
test('A22 preserved availability payload contains no private event prose',async()=>{const i=identityFixture(),busy=await i.read('owner@example.test',['person@example.test'],at('14:00'),at('16:00'),'UTC',{},['moving']);assert.ok(!JSON.stringify(busy).includes('subject'));assert.ok(i.requests.every(r=>!JSON.stringify(r).includes('body')));});
test('regression stale moving identity is not a busy verdict',async()=>{const i=identityFixture({stale:true});await assert.rejects(i.read('owner@example.test',['person@example.test'],at('14:00'),at('16:00'),'UTC',{},['moving']),/identity is unresolved/);});
test('A16 regression accepted write with lost response reconciles without second PATCH',async()=>{const h=createMoveHarness({owner:true,patchAcceptedResponseLost:true});const r=await h.run();assert.equal(r.success,true);assert.equal(h.state.writes.length,1);assert.equal(h.state.closed.length,1);});
test('A16 regression unreadable readback does not claim completion',async()=>{const h=createMoveHarness({owner:true,readbackUnavailable:true});const r=await h.run();assert.equal(r.success,false);assert.equal(r._calendar_verification,'unavailable');assert.equal(h.state.writes.length,1);assert.equal(h.state.closed.length,0);assert.equal(h.state.activities.length,0);});
test('A7 regression matching start with wrong duration is not complete',async()=>{const h=createMoveHarness({owner:true,endDrift:true});const r=await h.run();assert.equal(r.success,false);assert.equal(r._calendar_verification,'different_state_observed');assert.equal(h.state.closed.length,0);});
function pairFixture(options={}){
 const f=fixture(),checkSlot=f.h.load('src/utils/scheduleRules.ts').checkSlot;
 const event=(id,subject,start,end,email)=>({id,type:'singleInstance',subject,start:{dateTime:at(start),timeZone:'UTC'},end:{dateTime:at(end),timeZone:'UTC'},isAllDay:false,isCancelled:false,isOnlineMeeting:true,showAs:'busy',attendees:[{emailAddress:{name:email,address:email}}],categories:[],location:{displayName:''}});
 const events=[event('oct11','First','11:15','11:55','first@example.test'),event('sep2','Second','14:00','14:40','second@example.test'),...(options.extra??[])];
 let h;h=createMoveHarness({owner:true,events,profile:f.h.profile,viewed:false,mutable:true,respectRelaxed:true,checkSlot,...options,
  plan:p=>{const verdict=checkSlot({profile:p.profile,slotStartIso:p.slotStartIso,slotEndIso:p.slotEndIso,events:p.preloadedEvents??h.events,excludeEventIds:[p.existingEventId],category:null,allowRelaxed:p.allowRelaxed});return {action:'book',category:null,preserveExisting:true,hasConflict:!verdict.passes,overrideNotice:verdict.passes?undefined:verdict.violation_label};}});
 return {h,run:overrides=>h.run({coordinated_moves:[{meeting_id:'oct11',new_start:at('13:30')},{meeting_id:'sep2',new_start:at('14:15')}],...overrides}),event};
}
test('A5 regression complete pair uses replacement calendar and safe dependency order',async()=>{const {h,run}=pairFixture();const r=await run();assert.equal(r.success,true);assert.deepEqual(h.state.writes.map(w=>w.meetingId),['sep2','oct11']);assert.equal(r.outcomes.length,2);assert.equal(h.state.plans[0].participants[0].email,'first@example.test');assert.equal(h.state.plans[1].participants[0].email,'second@example.test');assert.equal(h.state.plans[0].preloadedEvents.find(e=>e.id==='sep2').start.dateTime,at('14:15').replace('Z','.000Z'));});
test('A6 regression colliding new intervals are not a clean plan and do not write',async()=>{const {h,run}=pairFixture();const r=await run({coordinated_moves:[{meeting_id:'oct11',new_start:at('14:00')},{meeting_id:'sep2',new_start:at('14:15')}]});assert.equal(r.success,false);assert.equal(h.state.writes.length,0);});
test('A10 regression unaffected third meeting remains a blocking consequence',async()=>{const initial=pairFixture();const {h,run}=pairFixture({extra:[initial.event('third','Third','14:45','15:30','third@example.test')]});const r=await run();assert.equal(r.success,false);assert.equal(h.state.writes.length,0);});
test('A15 regression first confirmed move remains after second failure',async()=>{const {h,run}=pairFixture({failEvent:'oct11'});const r=await run();assert.equal(r.success,false);assert.equal(r.error,'coordinated_move_incomplete');assert.equal(r.outcomes[0].success,true);assert.equal(r.outcomes[1].success,false);assert.deepEqual(h.state.writes.map(w=>w.meetingId),['sep2']);});
test('A17 regression retry after partial completion skips already confirmed interval',async()=>{const options={failEvent:'oct11'},p=pairFixture(options);await p.run();const updated=p.h.events;const resumed=pairFixture({events:updated});const r=await resumed.run();assert.equal(r.success,true);assert.deepEqual(resumed.h.state.writes.map(w=>w.meetingId),['oct11']);assert.equal(r.outcomes.find(o=>o.meeting_id==='sep2').unchanged,true);});
test('A23 preserved explicit owner override remains possible for coordinated conflict',async()=>{const {h,run}=pairFixture();const r=await run({relaxed:true,coordinated_moves:[{meeting_id:'oct11',new_start:at('14:00')},{meeting_id:'sep2',new_start:at('14:15')}]});assert.equal(r.success,true);assert.equal(h.state.writes.length,2);});
test('A22 regression colleague cannot borrow authority over another event',async()=>{const {h,run}=pairFixture({owner:false});const r=await run();assert.equal(r.error,'not_your_meeting');assert.equal(h.state.writes.length,0);});
async function plannerAttendees(input,read){
 const file='src/skills/meetings/planMeeting.ts',source=revision?cp.execFileSync('git',['show',revision+':'+file],{encoding:'utf8'}):fs.readFileSync(file,'utf8');
 const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),nodes=[];
 (function walk(n){if(ts.isIfStatement(n)&&n.expression.getText()==="initiator === 'owner' && nonOwnerParticipants.length > 0")nodes.push(n);ts.forEachChild(n,walk);})(tree);assert.equal(nodes.length,1);
 const module={exports:{}},code='module.exports=async function(){let attendeeBusyNotice,attendeeBusyLabel,knownAttendeeConflict=false,availabilityUnconfirmed=false;const gates=[];'+nodes[0].getText()+';return {attendeeBusyNotice,knownAttendeeConflict,availabilityUnconfirmed};}';
 vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:()=>({searchPeopleMemory:()=>[]}),DateTime:require('luxon').DateTime,Set,Map,initiator:'owner',intent:'move',nonOwnerParticipants:[{email:'person@example.test'}],ownerEmail:'owner@example.test',profile:fixture().h.profile,input,logger:{info(){},warn(){}},getFreeBusyForDecision:read,loadAttendeeAvailabilityForEmails:()=>[]});
 return module.exports();
}
test('A3 regression mutation does not exclude another event with identical old clocks',async()=>{const i=identityFixture({extra:[['unrelated-same-window','14:00','14:40']]}),r=await plannerAttendees({existingEventId:'moving',slotStartIso:at('14:15'),slotEndIso:at('14:55'),priorSlotStartIso:at('14:00'),priorSlotEndIso:at('14:40')},i.read);assert.ok(r.attendeeBusyNotice?.includes('busy'));});
test('A6 regression actual planner checks shared attendee against other proposed meeting',async()=>{const f=fixture();const other={...f.source,id:'other',attendees:[{emailAddress:{address:'person@example.test'}}],start:{dateTime:at('14:20'),timeZone:'UTC'},end:{dateTime:at('15:00'),timeZone:'UTC'}};const r=await plannerAttendees({existingEventId:'moving',slotStartIso:at('14:15'),slotEndIso:at('14:55'),calendarReplacements:[f.source,other]},async()=>({}));assert.ok(r.attendeeBusyNotice?.includes('busy'));});
test('A21 regression actual planner qualifies unavailable attendee read',async()=>{const r=await plannerAttendees({existingEventId:'moving',slotStartIso:at('14:15'),slotEndIso:at('14:55')},async()=>{throw Error('unavailable')});assert.equal(r.availabilityUnconfirmed,true);assert.ok(r.attendeeBusyNotice?.includes('unconfirmed'));});

function roomHelper(read) {
 const file='src/utils/meetingRoomAvailability.ts',source=revision?cp.execFileSync('git',['show',revision+':'+file],{encoding:'utf8'}):fs.readFileSync(file,'utf8'),module={exports:{}};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{module,exports:module.exports,require:id=>id==='luxon'?require('luxon'):id.includes('logger')?{warn(){}}:{getFreeBusyForDecision:read}});
 return module.exports.checkMeetingRoomAvailability;
}
const roomProfile=()=>({...fixture().h.profile,meetings:{...fixture().h.profile.meetings,room_email:'person@example.test'}});
const roomArgs=()=>({profile:roomProfile(),startIso:at('14:15'),endIso:at('14:55'),participantCount:6,existingEventId:'moving'});
test('A19 regression room source copy excluded by identity',async()=>{assert.equal((await roomHelper(identityFixture().read)(roomArgs())).kind,'room_free');});
test('A19 preserved unrelated room commitment remains busy',async()=>{assert.equal((await roomHelper(identityFixture({extra:[['other','14:20','14:30']]}).read)(roomArgs())).kind,'room_busy_too_big');});
test('A19 regression proposed partner room commitment remains busy',async()=>{const f=fixture(),other={...f.source,id:'other',attendees:[{emailAddress:{address:'person@example.test'}}]};assert.equal((await roomHelper(async()=>({}))( {...roomArgs(),calendarReplacements:[other]})).kind,'room_busy_too_big');});
test('A21 regression unresolved room never reported free',async()=>{assert.equal((await roomHelper(async(a,b,c,d,e,diag)=>{diag.unresolved=['person@example.test'];return{};})(roomArgs())).kind,'skip');});
async function plannerRoom(verdict,locationVerdict={kind:'resolved',isOnline:false,location:'Room',addRoomEmail:true}) {
 const file='src/skills/meetings/planMeeting.ts',source=revision?cp.execFileSync('git',['show',revision+':'+file],{encoding:'utf8'}):fs.readFileSync(file,'utf8'),tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),nodes=[];
 (function walk(n){if(ts.isIfStatement(n)&&(n.expression.getText()==="locationVerdict && locationVerdict.kind === 'resolved'"||n.expression.getText()==='addRoomEmail && input.slotStartIso && input.slotEndIso'))nodes.push(n);ts.forEachChild(n,walk);})(tree);assert.equal(nodes.length,2);
 const calls=[],module={exports:{}},code='module.exports=async()=>{let isOnline,location,addRoomEmail,preserveExisting,roomBusyNotice,roomAvailabilityNotice,roomAskText,availabilityUnconfirmed=false;const gates=[];'+nodes.map(n=>n.getText()).join('\n')+';return{availabilityUnconfirmed,roomBusyNotice,roomAvailabilityNotice,preserveExisting,gates};}';
 vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:()=>({checkMeetingRoomAvailability:async p=>{calls.push(p);return verdict;}}),profile:roomProfile(),locationVerdict,input:{slotStartIso:at('14:15'),slotEndIso:at('14:55'),existingEventId:'moving',calendarReplacements:[fixture().source]},participants:[{email:'person@example.test'}],headcount:6,logger:{info(){},warn(){}}});
 return {...await module.exports(),calls};
}
test('A19 regression preserved room venue still checked at new time',async()=>{const r=await plannerRoom({kind:'room_busy_too_big',suggestedAskText:'room conflict'},{kind:'preserve_existing',isOnline:false,location:'Room'});assert.equal(r.calls.length,1);assert.equal(r.calls[0].existingEventId,'moving');assert.equal(r.calls[0].calendarReplacements.length,1);assert.equal(r.gates[0].kind,'room');});
test('A21 regression planner keeps room uncertainty in result',async()=>{const r=await plannerRoom({kind:'skip',reason:'unread'});assert.equal(r.availabilityUnconfirmed,true);assert.match(r.roomAvailabilityNotice,/unconfirmed/);});
test('A19 regression smaller fallback is qualified and replaces old room',async()=>{const r=await plannerRoom({kind:'room_busy_small_fits',smallLabel:'Small'});assert.equal(r.availabilityUnconfirmed,true);assert.equal(r.preserveExisting,false);assert.match(r.roomBusyNotice,/not been checked/);});
test('preserved invalid duplicate pair identity never writes',async()=>{const {h,run}=pairFixture();const r=await run({coordinated_moves:[{meeting_id:'oct11',new_start:at('13:30')},{meeting_id:'oct11',new_start:at('14:15')}]});assert.equal(r.success,false);assert.equal(h.state.writes.length,0);});
test('preserved invalid paired interval never writes',async()=>{const {h,run}=pairFixture();const r=await run({coordinated_moves:[{meeting_id:'oct11',new_start:at('13:30'),new_end:at('13:00')},{meeting_id:'sep2',new_start:at('14:15')}]});assert.equal(r.success,false);assert.equal(h.state.writes.length,0);});
test('preserved coordinated series master never writes',async()=>{const {h,run}=pairFixture();h.events[0].type='seriesMaster';const r=await run();assert.equal(r.success,false);assert.equal(h.state.writes.length,0);});

for(const field of ['meeting_id','meeting_subject','new_start'])for(const value of [undefined,'   ',123])test('singular input requires nonblank '+field+' '+String(value),async()=>{const h=createMoveHarness({owner:true});const r=await h.run({[field]:value});assert.equal(r.error,'invalid_move_arguments');assert.ok(r.missing_fields.includes(field));assert.equal(h.state.writes.length,0);assert.equal(h.state.closed.length,0);assert.equal(h.state.plans.length,0);});
for(const value of [null,{},'not-a-plan'])test('malformed coordinated envelope never falls into singular move '+JSON.stringify(value),async()=>{const h=createMoveHarness({owner:true});const r=await h.run({coordinated_moves:value});assert.equal(r.success,false);assert.equal(r.error,'incomplete_move_plan');assert.equal(h.state.writes.length,0);assert.equal(h.state.plans.length,0);});
for(const [field,value]of [['meeting_id',' '],['new_start',' '],['new_end',123],['new_end','']])test('malformed coordinated item rejects '+field+' '+JSON.stringify(value),async()=>{const {h,run}=pairFixture();const r=await run({coordinated_moves:[{meeting_id:'oct11',new_start:at('13:30'),[field]:value},{meeting_id:'sep2',new_start:at('14:15')}]});assert.equal(r.success,false);assert.equal(r.error,'invalid_move_plan');assert.equal(h.state.writes.length,0);});
test('preserved singular omitted end retains source duration',async()=>{const h=createMoveHarness({owner:true});const r=await h.run({new_end:undefined});assert.equal(r.success,true);assert.equal(h.state.writes.length,1);assert.equal(Date.parse(h.state.writes[0].end)-Date.parse(h.state.writes[0].start),40*60000);});
function searchEntry(checkCoordinatedMoves) {
 const file='src/skills/meetings/ops/handlers/findAvailableSlots.ts',tree=ts.createSourceFile(file,selectedSource(file),ts.ScriptTarget.Latest,true);
 const handler=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='handleFindAvailableSlots');
 const block=handler.body.statements[0];assert.ok(ts.isIfStatement(block),'real coordinated-search entry');
 const module={exports:{}},code='module.exports=async(args,ctx)=>{'+block.getText()+';return {ordinarySearch:true};}';
 vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:()=>({checkCoordinatedMoves})});
 return module.exports;
}
for(const value of [null,{},'not-a-plan'])test('malformed coordinated search never falls through '+JSON.stringify(value),async()=>{const {h}=pairFixture();const r=await searchEntry(h.checkCoordinated)({coordinated_moves:value},h.ctx);assert.equal(r.error,'incomplete_move_plan');assert.equal(r.ordinarySearch,undefined);assert.equal(h.state.writes.length,0);});
test('preserved complete coordinated discovery returns projected results without writes or internal subjects',async()=>{const {h}=pairFixture();const r=await searchEntry(h.checkCoordinated)({coordinated_moves:[{meeting_id:'oct11',new_start:at('13:30')},{meeting_id:'sep2',new_start:at('14:15')}]},h.ctx);assert.equal(r.available,true);assert.equal(r.results.length,2);assert.equal(r.moves,undefined);assert.equal(h.state.writes.length,0);});
test('preserved undefined coordinated sentinel retains singular search route',async()=>assert.equal((await searchEntry(()=>assert.fail('unexpected coordinated read'))({coordinated_moves:undefined},{})).ordinarySearch,true));
test('preserved ordinary search keeps omitted duration mode and attendee defaults',async()=>{
 const Module=require('node:module'),file=path.resolve('scripts/test-garage-recovery-summary.cjs'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
 m._compile(fs.readFileSync(file,'utf8').split('for(const role')[0],file);
 const {out}=await m.exports.run({clean:true,argsOverride:{duration_minutes:undefined,meeting_mode:undefined,attendee_emails:undefined}});
 assert.ok(out.slots.length);assert.ok(Date.parse(out.slots[0].end)>Date.parse(out.slots[0].start));assert.equal(out.error,undefined);
});
