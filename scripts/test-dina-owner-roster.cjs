// Actual complete planner and move handler. Calendar/freebusy/rule decisions
// are explicit fixtures; rebalance executes actual placement code with fixture
// Graph writes. No live IO or model calls.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const luxon=require('luxon');
const {createMoveHarness}=require('./test-yael-meeting-selection.cjs');
const root=path.resolve(__dirname,'..'),revAt=process.argv.indexOf('--revision'),revision=revAt<0?null:process.argv[revAt+1];
function rebalanceFixture(){
 const logger={info(){},warn(){},error(){}},writes=[];
 function load(file,deps){const m={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{module:m,exports:m.exports,require:n=>{if(n==='luxon')return luxon;if(n in deps)return deps[n];throw Error('unmocked '+n);}});return m.exports;}
 const density=load('src/utils/calendarDensity.ts',{});
 const floating=load('src/utils/floatingBlocks.ts',{'./calendarDensity':density,'./logger':{__esModule:true,default:logger}});
 const rebalance=load('src/utils/rebalanceFloatingBlocks.ts',{'./floatingBlocks':floating,'./calendarDensity':density,'./workHours':{getEffectiveWorkDay:()=>({hasOverride:false})},'./logger':{__esModule:true,default:logger},'../core/requests/logActivity':{logActivity(){}},'../db/calendarIssues':{getSuppressedEventIds:()=>new Set()},'./shadowNotify':{shadowNotify:async()=>{}},'../connectors/graph/calendar':{updateMeeting:async p=>writes.push(p)}});
 const ev=(id,start,end)=>({id,subject:id,start:{dateTime:'2026-10-13T'+start+':00',timeZone:'Asia/Jerusalem'},end:{dateTime:'2026-10-13T'+end+':00',timeZone:'Asia/Jerusalem'},showAs:'busy',categories:[],attendees:[]});
 return {writes,run:async p=>{const r=await rebalance.rebalanceFloatingBlocksAfterMutation({...p,profile:{...p.profile,schedule:{home_days:{days:['Tuesday']},office_days:{days:[]}},meetings:{floating_blocks:[{name:'lunch',preferred_start:'11:30',preferred_end:'13:30',duration_minutes:25,can_skip:true}]}},preloadedDayEvents:[ev('lunch','11:30','11:55'),ev('Dina meeting','11:00','11:40')]});assert.equal(r.moved,1);assert.equal(r.overlapping,0);assert.equal(luxon.DateTime.fromISO(writes[0].start).setZone('Asia/Jerusalem').toFormat('HH:mm'),'11:45');return r;}};
}
function planner(opts={}){
 const file='src/skills/meetings/planMeeting.ts',code=revision?cp.execFileSync('git',['show',`${revision}:${file}`],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,file),'utf8');
 const state={freebusy:[],rules:[],categoryRosters:[],warnings:[]};
 const nop=()=>{};
 const own='owner@example.test',peer='yael@example.test';
 const stubs={DateTime:luxon.DateTime,default:{info:nop,warn:(...a)=>state.warnings.push(a),error:nop},
 findMeetingOwner:async()=>({ownerIsOrganizer:true}),searchPeopleMemory:()=>[],getTravelRecordById:()=>null,getEffectiveTimezoneById:()=>({timezone:'Asia/Jerusalem'}),personIdForSlackId:()=>null,
 getEffectiveWorkDayForInstant:()=>({location:'home'}),
 detectCategory:async p=>{state.categoryRosters.push(p.attendees);return {category:'Weekly',reason:'fixture'};},
 resolveLocation:()=>({kind:'preserve_existing',location:'Office',isOnline:false,reasoning:'fixture'}),
 profileDualClock:()=>s=>s,bookingLeadTimeHours:()=>0,
 getOwnerEventsForDecision:async()=>[],
 checkSlot:p=>{state.rules.push(p);return opts.ownerConflict?{passes:true,level:'unfiltered',overCommitment:{subject:'Real commitment',window:'11:00–11:40',attendeeCount:1}}:{passes:true,level:'free'};},
 getFreeBusyForDecision:async(_own,emails)=>{state.freebusy.push([...emails]);return Object.fromEntries(emails.map(e=>[e,(e===own||opts.peerBusy)?[{start:'2026-10-13T11:30:00+03:00',end:'2026-10-13T11:55:00+03:00',status:'busy'}]:[]]));},
 loadAttendeeAvailabilityForEmails:()=>[],subjectViewerFor:()=> 'owner',
 };
 const deps=new Proxy(stubs,{get(t,k){if(k==='then')return undefined;if(k in t)return t[k];return ()=>{throw Error('UNMOCKED '+String(k));};}});
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:id=>id==='luxon'?luxon:deps});
 const profile={user:{email:own,name:'Idan Cohen',timezone:'Asia/Jerusalem',slack_user_id:'OWNER'},meetings:{},categories:[]};
 const input={profile,intent:'move',initiator:'owner',participants:[{email:own,name:'Idan'},{email:peer,name:'Dina'}],subject:'Dina & Idan - BiWeekly',slotStartIso:'2026-10-13T11:00:00+03:00',slotEndIso:'2026-10-13T11:40:00+03:00',existingEventId:'oct11',priorSlotStartIso:'2026-10-08T08:00:00Z',priorSlotEndIso:'2026-10-08T08:40:00Z',existingEventCategories:['Weekly'],preloadedEvents:[],viewer:'owner'};
 return {state,input,async plan(p=input){const r=await module.exports.planMeeting(p);assert.ok(!JSON.stringify(state.warnings).includes('UNMOCKED'),JSON.stringify(state.warnings));return r;}};
}
module.exports={planner};
if(require.main===module){let passed=0,failed=0;const cases=[];async function check(id,kind,fn){try{await fn();passed++;cases.push({id,kind,result:'pass'});console.log('ok '+id);}catch(e){failed++;cases.push({id,kind,result:'fail',error:e.stack});console.log('not ok '+id+': '+e.stack);}}
(async()=>{
 await check('owner-email-roster-not-an-attendee-conflict','regression',async()=>{const h=planner();const r=await h.plan();assert.equal(r.action,'book');assert.equal(r.overrideNotice,undefined);assert.deepEqual(h.state.freebusy,[['yael@example.test']]);assert.equal(h.state.rules.length,1);});
 await check('real-move-cleared-lunch-no-stale-busy-notice','regression',async()=>{const p=planner(),rebalance=rebalanceFixture();const h=createMoveHarness({owner:true,roster:[{email:'owner@example.test',name:'Idan'},{email:'yael@example.test',name:'Dina'}],plan:p.plan,rebalance:rebalance.run,args:{new_start:'2026-10-13T11:00:00+03:00',new_end:'2026-10-13T11:40:00+03:00'}});const r=await h.run();assert.equal(r.success,true);assert.equal(r._attendee_busy_note,undefined);assert.equal(r.blocks_moved[0],'moved lunch 11:30→11:45');assert.equal(h.state.writes.length,1);assert.equal(h.state.closed.length,1);assert.equal(rebalance.writes.length,1);});
 await check('genuine-peer-conflict-remains','preserved',async()=>{const h=planner({peerBusy:true});h.input.participants[0].isOwner=true;const r=await h.plan();assert.ok(r.overrideNotice.includes('yael is busy'));});
 await check('genuine-owner-commitment-remains','preserved',async()=>{const h=planner({ownerConflict:true});h.input.participants[0].isOwner=true;const r=await h.plan();assert.ok(r.overrideNotice.includes('Real commitment'));assert.equal(r.level,'unfiltered');});
 await check('already-normalized-owner-remains-clean','preserved',async()=>{const h=planner();h.input.participants[0].isOwner=true;assert.equal((await h.plan()).overrideNotice,undefined);});
 await check('missing-owner-is-injected','preserved',async()=>{const h=planner();h.input.participants=h.input.participants.slice(1);assert.equal((await h.plan()).overrideNotice,undefined);});
 await check('case-insensitive-owner-email-normalized','regression',async()=>{const h=planner();h.input.participants[0].email='OWNER@EXAMPLE.TEST';assert.equal((await h.plan()).overrideNotice,undefined);});
 await check('fresh-booking-owner-roster-no-false-confirm','regression',async()=>{const h=planner();h.input.intent='new_booking';assert.equal((await h.plan()).action,'book');assert.equal(h.state.categoryRosters[0].find(p=>p.email==='owner@example.test').isOwner,true);});
 await check('colleague-initiator-no-owner-authority-grant','preserved',async()=>{const h=planner();h.input.initiator='colleague';await h.plan();assert.equal(h.state.freebusy.length,0);assert.equal(h.state.rules[0].allowRelaxed,false);});
 console.log(JSON.stringify({revision:revision??'working-tree',passed,failed,cases}));process.exitCode=failed?1:0;
})();}
