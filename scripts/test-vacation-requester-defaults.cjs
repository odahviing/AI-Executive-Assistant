// Actual analyzer and AST-selected attendance/membership branches; I/O is isolated.
// BEFORE_SOURCE points at the retained pre-edit source overlay, never a live database.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {test}=require('node:test'),assert=require('node:assert/strict');
if(process.env.BEFORE_SOURCE)process.env.SLOT_PRIORITY_BEFORE=process.env.BEFORE_SOURCE;
const {harness}=require('./test-timezone-owner-interval.cjs');
const root=path.resolve(__dirname,'..'),date='2026-11-02',zone='Asia/Jerusalem';
const file='src/skills/meetings/ops/handlers/findAvailableSlots.ts';
function source(){return fs.readFileSync(path.join(root,process.env.BEFORE_SOURCE||'',file),'utf8');}
function branches(){const text=source(),tree=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);let attendance,membership;
 function walk(n){if(ts.isIfStatement(n)) {const condition=n.expression.getText(tree);
  if(condition.startsWith('!isOwnerInitiatedSearch && context.userId'))attendance=n;
  if(condition==='!isOwnerInitiatedSearch'&&n.thenStatement.getText(tree).includes('const onOwnRoster'))membership=n;
 } ts.forEachChild(n,walk);}walk(tree);assert.ok(attendance&&membership);assert.ok(membership.pos<attendance.pos);
 return {attendance:attendance.getText(tree),membership:membership.thenStatement.getText(tree)};
}
async function normalize({emails=['peer@test','optional@test'],flag,owner=false,user='UASK',email='ask@test',throwLookup=false,spineOwner=null}={}){
 const b=branches(),state={attendeeEmails:[...emails],args:{requester_is_attending:flag,requester_slack_id:'FORGED'},isOwnerInitiatedSearch:owner,
 context:{userId:user,profile:{user:{slack_user_id:'UOWNER'}}},getPersonMemory:id=>{assert.equal(id,user);if(throwLookup)throw Error('offline');return email?{email}:null;},
 logger:{info(){},warn(){}},movingIdsForAttendees:['foreign','own'],rosterById:new Map([['foreign',{attendees:['secret@test']}],['own',{attendees:['ask@test']}]]),
 qualifyingIds:[],excludeEventIdsForSearch:undefined,userEmail:'owner@test',require:()=>({findMeetingOwner:async()=>({requesterSlackId:spineOwner})})};
 // Membership uses the stored event roster BEFORE attendance normalization.
 const code='(async()=>{'+(owner?'':b.membership)+b.attendance+';return {emails:attendeeEmails,ids:qualifyingIds};})()';
 return JSON.parse(JSON.stringify(await vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,state)));
}
test('requester omitted from search defaults to attending with every required and optional person retained',async()=>{
 const r=await normalize();assert.deepEqual(r.emails,['peer@test','optional@test','ask@test']);assert.deepEqual(r.ids,['own']);
});
test('explicit attending also adds missing authenticated requester',async()=>assert.ok((await normalize({flag:true})).emails.includes('ask@test')));
test('explicit nonattendance removes only requester and does not authorize foreign event',async()=>{
 const r=await normalize({flag:false,emails:['ASK@test','peer@test','optional@test']});assert.deepEqual(r.emails,['peer@test','optional@test']);assert.deepEqual(r.ids,['own']);
});
test('owner search never injects sender and requester spoof cannot grant membership',async()=>{
 assert.deepEqual((await normalize({owner:true})).emails,['peer@test','optional@test']);
 assert.deepEqual((await normalize({email:'unrelated@test'})).ids,[]);
});
test('missing requester email preserves list and cannot grant membership',async()=>{
 const r=await normalize({email:null});assert.deepEqual(r.emails,['peer@test','optional@test']);assert.deepEqual(r.ids,[]);
});
test('explicit organizer requires durable spine identity for foreign event access',async()=>{
 assert.deepEqual((await normalize({flag:false,spineOwner:'UASK'})).ids,['foreign','own']);
 assert.deepEqual((await normalize({flag:false,spineOwner:'FORGED'})).ids,['own']);
});
test('existing requester is not duplicated on retry',async()=>{
 const r=await normalize({emails:['ASK@test','peer@test','optional@test']});assert.deepEqual(r.emails,['ASK@test','peer@test','optional@test']);
});
test('unavailable requester lookup cannot grant foreign event access',async()=>{
 await assert.rejects(normalize({throwLookup:true}),/offline/);
});
function analyze(extra={},appointments=[],range=date){
 const event={id:'block',subject:'Vacation',showAs:'busy',isAllDay:true,isCancelled:false,sensitivity:'normal',categories:[],attendees:[],
 start:{dateTime:date+'T00:00:00',timeZone:zone},end:{dateTime:'2026-11-05T00:00:00',timeZone:zone},...extra};
 const h=harness({}, {extraMocks:{'src/utils/floatingBlocks.ts':{getFloatingBlocks:()=>[{name:'lunch',preferred_start:'12:00',preferred_end:'14:00',duration_minutes:25,can_skip:false}],blockAppliesOnDay:()=>true,isFloatingBlockEvent:()=>false},
 'src/utils/displaySubject.ts':{displaySubject:e=>e.sensitivity==='private'?'[Private]':e.subject,isEventPrivate:e=>e.sensitivity==='private'}}});
 h.profile.categories=[];h.profile.meetings.work_hours_per_free_hour=4;
 const m=h.load('src/skills/meetings/ops/analysis.ts');return m.analyzeCalendar(m.processCalendarEvents([event,...appointments],h.profile.user.email,h.profile.user.name,zone,h.profile,'owner'),range,range,h.profile)[0];
}
test('all-day Busy suppresses workload and lunch deficiencies without claiming vacation',()=>{
 const d=analyze();assert.ok(!d.issues.some(i=>['no_buffer','missing_floating_block'].includes(i.type)));assert.equal(d.allDayBusy,true);assert.equal(d.outOfOfficeAllDay,undefined);assert.equal(d.stats.freeMinInWorkHours,0);
});
test('all-day OOF suppresses lunch deficiency and retains OOF fact',()=>{
 const d=analyze({showAs:'oof'});assert.ok(!d.issues.some(i=>i.type==='missing_floating_block'));assert.equal(d.outOfOfficeAllDay,true);
});
test('multi-day Busy suppresses middle-day quality warning with exclusive end',()=>{
 assert.ok(!analyze({},[],'2026-11-04').issues.some(i=>i.type==='missing_floating_block'));
 assert.ok(analyze({},[],'2026-11-05').issues.some(i=>i.type==='missing_floating_block'));
});
test('ordinary timed busy retains genuine overload and missing lunch warnings',()=>{
 const d=analyze({isAllDay:false,start:{dateTime:date+'T09:00:00',timeZone:zone},end:{dateTime:date+'T23:59:00',timeZone:zone}});
 assert.ok(d.issues.some(i=>i.type==='no_buffer'));assert.ok(d.issues.some(i=>i.type==='missing_floating_block'));
});
test('free cancelled and working-elsewhere markers retain normal lunch policy',()=>{
 for(const e of [{showAs:'free'},{isCancelled:true},{showAs:'workingElsewhere'}])assert.ok(analyze(e).issues.some(i=>i.type==='missing_floating_block'));
});
test('full-day commitment retains real appointment and overlap, masks private subject',()=>{
 const meeting={id:'real',subject:'Real appointment',showAs:'busy',isAllDay:false,isCancelled:false,sensitivity:'normal',categories:[],attendees:[{emailAddress:{address:'peer@test',name:'Peer'}}],start:{dateTime:date+'T11:00:00',timeZone:zone},end:{dateTime:date+'T12:00:00',timeZone:zone}};
 const d=analyze({subject:'SECRET',sensitivity:'private'},[meeting]);assert.ok(d.events.some(e=>e.id==='real'));assert.ok(d.issues.some(i=>i.type==='overlap'));assert.ok(!JSON.stringify(d).includes('SECRET'));
});

