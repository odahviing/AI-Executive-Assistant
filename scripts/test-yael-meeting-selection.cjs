// Actual move handler + viewed ledger + sibling finder. All external IO is
// isolated fixture IO; the planner returns explicit decisions, never an LLM.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const {DateTime}=require('luxon');
const root=path.resolve(__dirname,'..');
const revArg=process.argv.indexOf('--revision');
const revision=revArg<0?null:process.argv[revArg+1];
const read=file=>revision?cp.execFileSync('git',['show',`${revision}:${file}`],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,file),'utf8');
function compile(code,requireFn,bindings={}){const module={exports:{}};vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:requireFn,...bindings});return module.exports;}
function declaration(file,name){const source=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true);const matches=source.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.equal(matches.length,1);return matches[0].getText();}
const subject='Yael & Idan - Weekly',selectedId='oct11',oldId='sep2';
function createMoveHarness(opts={}){
 const ledger=compile(read('src/utils/threadEventLedger.ts'),()=>assert.fail('ledger dependency'));
 const state={writes:[],closed:[],audits:[],activities:[],warnings:[],plans:[],slotChecks:[]};
 const roster=opts.roster??[{email:'yael@example.test',name:'Yael',optional:false}];
 const events=[{id:selectedId,type:'occurrence',seriesMasterId:'new-series',subject,start:{dateTime:'2026-10-11T06:00:00Z',timeZone:'UTC'},attendees:roster.map(a=>({emailAddress:{address:a.email}}))},
 {id:oldId,type:'exception',seriesMasterId:opts.sameSeries?'new-series':'old-series',subject,start:{dateTime:'2026-09-02T10:15:00Z',timeZone:'UTC'},attendees:[{emailAddress:{address:opts.uniqueAsker?'other@example.test':'yael@example.test'}}]},
 {id:'sep14',type:'exception',seriesMasterId:opts.sameSeries?'new-series':'old-series',subject,start:{dateTime:'2026-09-14T14:45:00Z',timeZone:'UTC'},attendees:[{emailAddress:{address:opts.uniqueAsker?'other@example.test':'yael@example.test'}}]}];
 const getCalendarEvents=async()=>events;
 const finder=compile(declaration('src/connectors/graph/calendarReads.ts','findSameSubjectSiblings'),()=>{}, {DateTime,getCalendarEvents}).findSameSubjectSiblings;
 const profile={user:{name:'Idan Cohen',email:'owner@example.test',slack_user_id:'OWNER',timezone:'Asia/Jerusalem'},meetings:{},categories:[],scheduling:{}};
 const ctx={context:{profile,userId:opts.owner?'OWNER':'YAEL',authority:opts.owner?'owner':'colleague',senderRole:opts.owner?'owner':'colleague',surface:opts.room?'room':opts.owner?'owner_dm':'colleague_dm',threadTs:'thread',channelId:'channel',channel:'slack'},userEmail:profile.user.email,timezone:profile.user.timezone};
 const args={meeting_id:selectedId,meeting_subject:subject,new_start:'2026-10-13T09:00:00+03:00',new_end:'2026-10-13T09:40:00+03:00',start_is_explicit:true,...opts.args};
 const noop=()=>undefined;
 class CalendarOfflineError extends Error{}
 class StatedTimeClarificationError extends Error{}
 const stubs={
  ...ledger,DateTime,CalendarOfflineError,StatedTimeClarificationError,
  default:{info:noop,warn:(...a)=>state.warnings.push(a),error:noop},
  getCalendarEvents,findSameSubjectSiblings:finder,
  getEventType:async(_email,id)=>{if(opts.readFailure||!events.some(e=>e.id===id))throw Error('event unavailable');const e=events.find(e=>e.id===id);return {...e,subject:opts.actualSubject??e.subject,type:opts.type??e.type,startDateTime:opts.liveStart??e.start.dateTime,endDateTime:'2026-10-11T06:40:00Z'};},
  getEventForAttendeeUpdate:async()=>opts.missingAttendees?null:{attendees:roster,startIso:'2026-10-11T06:00:00Z',endIso:'2026-10-11T06:40:00Z',categories:[],location:'Office',isOnline:false},
  findMeetingOwner:async()=>({ownerIsOrganizer:!opts.otherOrganizer,organizerEmail:opts.otherOrganizer?'other@example.test':'owner@example.test',requesterSlackId:opts.requester?'YAEL':undefined}),
  getPersonMemory:()=>({email:'yael@example.test',name:'Yael'}),
  getTravelContextForInstant:()=>({isAway:false,effectiveTz:'Asia/Jerusalem'}),statedZoneFromArgs:()=>undefined,
  resolveStatedInstant:p=>({startIso:p.startIso,endIso:p.endIso}),
  displaySubject:e=>e.subject,subjectViewerFor:()=>opts.owner&&!opts.room?'owner':'colleague',viewerEmailFor:()=>opts.room?null:'yael@example.test',isEventPrivate:e=>e.sensitivity==='private',
  subjectsPlausiblyMatch:(a,b)=>a===b,attendeeCheckParams:()=>({}),
  findAvailableSlots:async p=>{state.slotChecks.push(p);if(opts.offline)throw new CalendarOfflineError('offline');if(opts.ruleViolation){p.diagnosticsOut.rejectedCounts={category_per_day:1};return [];}return [{start:p.searchFrom,attendee_conflicts:opts.attendeeBusy?[{email:'other@example.test',reason:'busy'}]:[]}];},
  firstRejectReason:()=> 'category_per_day',humanizeViolationLabel:()=> 'category limit',HANDLER_ERROR_CODE:{NOT_RULE_COMPLIANT:'not_rule_compliant',MEETING_ROOM_UNAVAILABLE_LARGE_MEETING:'meeting_room_unavailable_large_meeting'},
  attendeeConflictRefusal:()=>({success:false,error:'attendee_conflict'}),bookedOverAttendeesNote:()=> 'other is busy',
  checkIntendedWeekday:()=>({ok:true}),wasOfferedSlot:()=>false,getFloatingBlocks:()=>[],hasOtherHumanAttendee:()=>roster.length>0,openQuestionsField:()=>({}),
  grantRelaxed:(_a,c)=>({relaxed:c.authority==='owner',relaxedReason:undefined}),
  planMeeting:async p=>{state.plans.push(p);if(opts.planFailure)throw Error('planner unavailable');if(opts.plan)return opts.plan(p);return {action:opts.roomUnavailable?'room_unavailable_large':'book',preserveExisting:true};},
  getActiveHoldOverlapping:()=>null,updateMeeting:async p=>{if(opts.patchFailure)throw Error('patch failed');state.writes.push(p);},
  verifyEventMoved:async()=>opts.unconfirmed?{ok:false,reason:'not_found'}:{ok:true},
  closeMeetingArtifacts:async p=>state.closed.push(p),getLatestAutomaticMoveForEvent:()=>null,
  auditLog:p=>state.audits.push(p),logActivity:p=>state.activities.push(p),resolveActivityTargetIdentity:()=>({}),
  shadowNotify:async()=>{},computeVacatedSlot:()=>undefined,rebalanceFloatingBlocksAfterMutation:async p=>typeof opts.rebalance==='function'?opts.rebalance(p):opts.rebalance??({moves:[]}),presentationLocalFieldFor:()=>({}),clearOfferedSlots:noop,renderWeDualClock:s=>s,
 };
 const dependencies=new Proxy(stubs,{get(target,name){if(name==='then')return undefined;if(name in target)return target[name];return (...a)=>{throw Error('UNMOCKED '+String(name));};}});
 const mod=compile(read('src/skills/meetings/ops/handlers/moveMeeting.ts')+'\nexport { checkSameSubjectCollision };',id=>id==='luxon'?{DateTime}:dependencies);
 function viewed(ids=[selectedId]){ledger.recordViewedThreadEvents('thread',ids.map(id=>{const e=events.find(e=>e.id===id);return {eventId:id,subject:e.subject,dateIso:DateTime.fromISO(e.start.dateTime).setZone(ctx.timezone).toISODate()};}));}
 if(opts.viewed!==false)viewed(opts.viewedIds);
 return {ledger,state,events,ctx,args,viewed,collision:()=>mod.checkSameSubjectCollision({...args},ctx,{toolName:'update_meeting',actionPhrase:'updating it'}),async run(overrides={}){const result=await mod.handleMoveMeeting({...args,...overrides},ctx);assert.ok(!JSON.stringify(state.warnings).includes('UNMOCKED'),JSON.stringify(state.warnings));return result;}};
}
module.exports={createMoveHarness};
if(require.main===module){let passed=0,failed=0;const outcomes=[];async function check(id,kind,fn){try{await fn();passed++;outcomes.push({id,kind,result:'pass'});console.log('ok '+id);}catch(e){failed++;outcomes.push({id,kind,result:'fail',error:e.stack});console.log('not ok '+id+': '+e.stack);}}
 (async()=>{
  await check('exact-dated-occurrence-with-old-series','regression',async()=>{const h=createMoveHarness();const r=await h.run();assert.equal(r.success,true);assert.equal(h.state.writes[0].meetingId,selectedId);assert.equal(h.state.writes[0].start,h.args.new_start);assert.equal(h.state.closed.length,1);});
  await check('broad-ambiguity-fresh-dated-read-converges','regression',async()=>{const h=createMoveHarness({viewedIds:[selectedId,oldId]});assert.equal((await h.run()).error,'ambiguous_meeting_subject');h.viewed();assert.equal((await h.run()).success,true);assert.equal(h.state.writes.length,1);assert.equal(h.ledger.getViewedThreadEvents('thread').length,2);});
  await check('same-series-control','preserved',async()=>assert.equal((await createMoveHarness({sameSeries:true,viewed:false}).run()).success,true));
  await check('owner-authority-control','preserved',async()=>assert.equal((await createMoveHarness({owner:true,viewed:false}).run()).success,true));
  await check('owner-room-authority-control','preserved',async()=>assert.equal((await createMoveHarness({owner:true,room:true,viewed:false}).run()).success,true));
  await check('only-selected-attendee-control','preserved',async()=>assert.equal((await createMoveHarness({uniqueAsker:true,viewed:false}).run()).success,true));
  await check('genuine-broad-ambiguity','preserved',async()=>{const h=createMoveHarness({viewedIds:[selectedId,oldId]});assert.equal((await h.run()).error,'ambiguous_meeting_subject');assert.equal(h.state.writes.length,0);});
  await check('restart-no-provenance-refuses','preserved',async()=>assert.equal((await createMoveHarness({viewed:false}).run()).error,'ambiguous_meeting_subject'));
  await check('stale-source-date-refuses','preserved',async()=>assert.equal((await createMoveHarness({liveStart:'2026-10-12T06:00:00Z'}).run()).error,'ambiguous_meeting_subject'));
  await check('missing-event-id-no-write','preserved',async()=>{const h=createMoveHarness({args:{meeting_id:'missing'}});await assert.rejects(h.run());assert.equal(h.state.writes.length,0);});
  await check('unavailable-event-no-write','preserved',async()=>{const h=createMoveHarness({readFailure:true});await assert.rejects(h.run());assert.equal(h.state.writes.length,0);});
  // These controls isolate downstream authority from the old subject defect.
  for(const [id,options,expected] of [
   ['nonattendee-no-authority',{roster:[]},'not_your_meeting'],
   ['requester-needs-owner',{roster:[],requester:true},'requester_move_needs_owner'],
   ['external-attendee-owner-decision',{roster:[{email:'yael@example.test'},{email:'guest@external.test'}]},'external_attendee_unverifiable'],
   ['attendee-load-unavailable',{missingAttendees:true},'attendee_check_failed'],
   ['other-attendee-conflict',{attendeeBusy:true},'attendee_conflict'],
   ['rule-approval-bound-id',{ruleViolation:true},'not_rule_compliant'],
   ['room-unavailable',{roomUnavailable:true},'meeting_room_unavailable_large_meeting'],
  ])await check(id,'preserved',async()=>{const h=createMoveHarness({...options,sameSeries:true});const r=await h.run();assert.equal(r.error??r.reason,expected);assert.equal(h.state.writes.length,0);if(r._deferred_action_hint)assert.equal(r._deferred_action_hint.args.meeting_id,selectedId);});
  await check('colleague-room-selection','regression',async()=>assert.equal((await createMoveHarness({room:true}).run()).success,true));
  await check('confirmed-attendee-conflict','preserved',async()=>assert.equal((await createMoveHarness({sameSeries:true,attendeeBusy:true,args:{confirm_attendee_conflict:true}}).run()).success,true));
  for(const [id,opt] of [['planner-unavailable','planFailure'],['calendar-offline','offline'],['patch-failed','patchFailure']])await check(id,'preserved',async()=>{const h=createMoveHarness({sameSeries:true,[opt]:true});await assert.rejects(h.run());assert.equal(h.state.closed.length,0);assert.equal(h.state.writes.length,0);});
  await check('unknown-patch-does-not-close','preserved',async()=>{const h=createMoveHarness({sameSeries:true,unconfirmed:true});assert.equal((await h.run()).error,'moved_but_missing');assert.equal(h.state.writes.length,1);assert.equal(h.state.closed.length,0);assert.equal(h.state.audits.length,0);});
  await check('update-dated-selection','regression',async()=>assert.equal(await createMoveHarness().collision(),null));
  await check('update-real-ambiguity','preserved',async()=>assert.equal((await createMoveHarness({viewedIds:[selectedId,oldId]}).collision()).error,'ambiguous_meeting_subject'));
  await check('same-day-distinct-candidates','preserved',async()=>{const h=createMoveHarness({viewed:false});h.events[1].start.dateTime=h.events[0].start.dateTime;h.viewed([selectedId,oldId]);assert.equal((await h.run()).error,'ambiguous_meeting_subject');});
  await check('capped-read-cannot-prove-uniqueness','preserved',async()=>{const h=createMoveHarness({viewed:false});h.ledger.recordViewedThreadEvents('thread',[{eventId:selectedId,subject,dateIso:'2026-10-11'},...Array.from({length:21},(_,i)=>({eventId:'other'+i,subject:'Other',dateIso:'2026-10-12'}))]);assert.equal((await h.run()).error,'ambiguous_meeting_subject');});
  await check('capped-read-deletion-cannot-prove-uniqueness','preserved',async()=>{const h=createMoveHarness({viewed:false});h.ledger.recordViewedThreadEvents('thread',[{eventId:selectedId,subject,dateIso:'2026-10-11'},...Array.from({length:21},(_,i)=>({eventId:'other'+i,subject:'Other',dateIso:'2026-10-12'}))]);h.ledger.forgetThreadEvent('thread','other0');assert.equal((await h.run()).error,'ambiguous_meeting_subject');});
  await check('capped-then-narrow-read-converges','regression',async()=>{const h=createMoveHarness({viewed:false});h.ledger.recordViewedThreadEvents('thread',Array.from({length:21},(_,i)=>({eventId:'other'+i,subject:'Other',dateIso:'2026-10-01'})));h.viewed();assert.equal((await h.run()).success,true);});
  await check('private-sibling-not-disclosed','preserved',async()=>{const h=createMoveHarness({viewed:false,uniqueAsker:true});for(const e of h.events.slice(1))e.sensitivity='private';assert.equal((await h.run()).success,true);});
  console.log(JSON.stringify({revision:revision??'working-tree',passed,failed,cases:outcomes}));process.exitCode=failed?1:0;
 })();
}
