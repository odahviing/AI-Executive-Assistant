// Owner rulings 4-7: production modules with isolated Graph and SQLite; no live writes.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'artifacts/workshop-verification/core-review-20260919/owner-floating');
const before=process.argv.includes('--before');
const fixtureCode=fs.readFileSync(path.join(__dirname,'test-floating-object-core-review.cjs'),'utf8').split('(async () => {')[0]
 .replace("core-review-20260919/matchmaker-floating","core-review-20260919/owner-floating");
const m={exports:{}};
vm.runInThisContext(`(function(require,module,exports,__dirname){${fixtureCode}\nmodule.exports={compile,source,rebalanceHarness,run,dry,block,event,profile,floating,density,DateTime,zone,date,logger,health};})`)(require,m,m.exports,__dirname);
const {compile,source,rebalanceHarness,run,dry,block,event,profile,floating,density,DateTime,zone,date,logger,health}=m.exports;
const results=[];
async function test(id,fn){try{await fn();results.push({id,status:'pass'});}catch(e){results.push({id,status:'fail',error:e.stack});}}
const human=(e,email='colleague@test.invalid')=>({...e,attendees:[{emailAddress:{address:email,name:'Colleague'},status:{response:'accepted'}}]});
function fn(file,name){const sf=ts.createSourceFile(file,source(file),ts.ScriptTarget.Latest,true);let found;function walk(n){if(ts.isFunctionDeclaration(n)&&n.name?.text===name)found=n.getText(sf);ts.forEachChild(n,walk);}walk(sf);assert.ok(found,name);return found;}
function occupancy(e,p,suppressed=new Set()){
 return compile(`${fn('src/utils/scheduleRules.ts','occupancyRoleOf')}\nexports.run=occupancyRoleOf;`,n=>{throw Error(n)}).run;
}
// AST extraction supplies the exact imports used by the actual production predicate.
function role(e,p,suppressed=new Set()){
 const code=`const {DateTime,isFloatingBlockEvent,isMovableFloatingBlockEvent}=require('bindings');${fn('src/utils/scheduleRules.ts','occupancyRoleOf')}\nexports.run=occupancyRoleOf;`;
 return compile(code,n=>({DateTime,...floating})).run(e,p.meetings.floating_blocks,zone,p,suppressed);
}
function rule6(p,events){
 const sf=ts.createSourceFile('rules.ts',source('src/utils/scheduleRules.ts'),ts.ScriptTarget.Latest,true);let loop;
 function walk(n){if(ts.isForOfStatement(n)&&n.expression.getText(sf)==='floatingBlockDefs')loop=n;ts.forEachChild(n,walk);}walk(sf);
 return compile(`exports.run=function(d){const {DateTime,blockAppliesOnDay,busyForBlockWindow,isFloatingBlockEvent,blockSizedToEvent,hasOtherHumanAttendee}=d.fb;const {input,profile}=d;const suppressedFloatingIds=new Set(),floatingBlockDefs=profile.meetings.floating_blocks,slotStart=DateTime.fromISO('${date}T11:00',{zone:'${zone}'}),slotEnd=DateTime.fromISO('${date}T14:00',{zone:'${zone}'}),tz='${zone}',dayName='Sunday',excludeSet=new Set(),whose='your',slotFacts={};${loop.getText(sf)}return {passes:true};}`,()=>{}).run({fb:{...floating,DateTime},profile:p,input:{events,isFloatingBlock:false}});
}
const Database=require('better-sqlite3');
function storeDb(snapshot){
 const db=snapshot?new Database(snapshot):new Database(':memory:');
 if(!snapshot)db.exec(`CREATE TABLE calendar_issues(id TEXT PRIMARY KEY,owner_user_id TEXT,event_id TEXT,peer_event_id TEXT,event_date TEXT,event_end_ms INTEGER,issue_class TEXT,axis TEXT,status TEXT,notes TEXT,request_id TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(owner_user_id,event_id,axis));`);
 const load=()=>compile(source('src/db/calendarIssues.ts'),n=>{assert.equal(n,'./client');return {getDb:()=>db}});
 return {db,mod:load(),insert(id,eventId,status='dismissed',axis='conflict',issue='overlap'){db.prepare('INSERT INTO calendar_issues(id,owner_user_id,event_id,event_date,event_end_ms,issue_class,axis,status) VALUES(?,?,?,?,?,?,?,?)').run(id,'owner',eventId,date,1,issue,axis,status)}};
}
(async()=>{
 for(const name of ['lunch','coffee','focus']){
  await test(`attendee-${name}-rebalance-never-writes`,async()=>{const h=rebalanceHarness();await run(h,[block(name)],[human(event(name,'12:00','12:30')),event('meeting','12:00','13:00')]);assert.equal(h.writes.length,0);});
  await test(`attendee-${name}-still-counts-requirement`,()=>{assert.equal(rule6(profile([block(name)]),[human(event(name,'12:00','12:30'))]).passes,true);});
  await test(`attendee-${name}-occupancy-fixed`,()=>{assert.equal(role(human(event(name,'12:00','12:30')),profile([block(name)])),'commitment');});
 }
 await test('legitimate-solo-rebalance-in-range',async()=>{const h=rebalanceHarness();await run(h,[block('lunch')],[event('lunch','12:00','12:30'),event('meeting','12:00','13:00')]);assert.equal(h.writes.length,1);});
 await test('legitimate-owner-self-attendee-remains-solo',async()=>{const h=rebalanceHarness();await run(h,[block('coffee')],[human(event('coffee','12:00','12:30'),'owner@test.invalid'),event('meeting','12:00','13:00')]);assert.equal(h.writes.length,1);});
 await test('legitimate-room-resource-remains-solo',async()=>{const h=rebalanceHarness(),e=human(event('lunch','12:00','12:30'));e.attendees[0].type='resource';await run(h,[block('lunch')],[e,event('meeting','12:00','13:00')]);assert.equal(h.writes.length,1);});
 await test('density-fixed-human-block-remains-busy',()=>{assert.equal(floating.densityCommitments([human(event('lunch','12:00','12:30'))],profile([block('lunch')]),{floatingBlocksAsNeighbours:false}).length,1);});
 await test('density-solo-inrange-elastic-control',()=>{assert.equal(floating.densityCommitments([event('lunch','12:00','12:30')],profile([block('lunch')]),{floatingBlocksAsNeighbours:false}).length,0);});
 await test('duplicate-instance-remains-busy-never-disappears',()=>{const a=event('lunch','11:00','11:30'),b={...event('lunch','11:30','12:00'),id:'other-lunch'};const r=floating.findBlockDestination([a,b],block('lunch','11:00','12:00',30),date,zone,new Set([a.id]),{start:DateTime.fromISO(`${date}T11:00`,{zone}).toMillis(),end:DateTime.fromISO(`${date}T11:30`,{zone}).toMillis()});assert.equal(r.aligned,null);});
 await test('rejected-block-no-move-no-repeat-question-after-restart',async()=>{for(let i=0;i<2;i++){const h=rebalanceHarness({suppressed:['lunch']});await run(h,[block('lunch')],[event('lunch','12:00','12:30'),event('meeting','12:00','13:00')]);assert.equal(h.writes.length,0);assert.equal(h.shadows.length,0);}});
 await test('rejected-block-occupancy-kept-busy',()=>assert.equal(role(event('lunch','12:00','12:30'),profile([block('lunch')]),new Set(['lunch'])),'commitment'));
 await test('different-event-after-rejection-can-move',async()=>{const h=rebalanceHarness({suppressed:['old-lunch']});await run(h,[block('lunch')],[event('lunch','12:00','12:30'),event('meeting','12:00','13:00')]);assert.equal(h.writes.length,1);});
 await test('chain-vacated-earlier-block-slot-not-used',async()=>{
  const h=rebalanceHarness(),blocks=[block('lunch','11:00','13:00'),block('coffee','11:30','12:30')];
  const events=[event('lunch','11:30','12:00'),event('coffee','12:00','12:30'),event('meeting','12:00','12:30')];
  // Dense consolidation could move lunch first, but coffee must not depend on that vacated range.
  const p=profile(blocks);p.meetings.packing_preference='dense';
  const r=await h.rebalanceFloatingBlocksAfterMutation({profile:p,affectedSlotIso:`${date}T12:00:00+03:00`,ownerSlackId:'owner',preloadedDayEvents:[...events,event('anchor','10:00','11:15')],consolidateDense:true});
  assert.equal(h.writes.some(w=>w.meetingId==='coffee'),false);assert.equal(r.overlapping,1);assert.ok(r.ownerQuestions?.length);
 });
 await test('unresolved-block-question-reaches-health-result',async()=>{const h=health.harness({blocks:[],rebalanceResult:{moved:0,movedBlockEventIds:[],ownerQuestions:[{eventId:'block',peerEventId:'other',blockName:'lunch',description:'Would you like to rearrange these events?'}]}});const r=await h.scan({mode:'active'});assert.ok(r.issues.some(i=>i.eventIds?.includes('block')&&i.suggestion?.includes('rearrange')));assert.equal(r.vacuous,false);});
 for(const status of ['dismissed','approved']) await test(`durable-${status}-reader-and-restart-no-expiry`,()=>{let h=storeDb();h.insert('a','lunch',status);assert.ok(h.mod.getSuppressedEventIds('owner').has('lunch'));const saved=h.db.serialize();h.db.close();h=storeDb(saved);assert.ok(h.mod.getSuppressedEventIds('owner').has('lunch'));assert.equal(h.mod.getSuppressedEventIds('other').size,0);h.db.close();});
 await test('durable-waived-day-survives-expiry-only-same-day',()=>{const h=storeDb();h.insert('a','floating-lunch-2026-10-04','dismissed','conflict','missing_floating_block');const ids=h.mod.getWaivedFloatingBlockEventIds('owner');assert.ok(ids.has('floating-lunch-2026-10-04'));assert.equal(ids.has('floating-lunch-2026-10-05'),false);h.db.close();});
 await test('durable-upsert-does-not-reopen-expired-rejection',()=>{const h=storeDb();h.insert('a','lunch');const r=h.mod.upsertCluster('owner',{events:new Set(['lunch']),anchor_class:'overlap',anchor_event_id:'lunch',event_date:date,event_end_ms:Date.now()+86400000});assert.equal(r.action,'suppressed');h.db.close();});
 await test('resolved-expired-control-and-independent-question',()=>{const h=storeDb();h.insert('a','lunch','resolved');h.insert('b','other','dismissed');assert.equal(h.mod.getSuppressedEventIds('owner').has('lunch'),false);assert.equal(h.mod.getSuppressedEventIds('owner','missing_category').has('other'),false);h.db.close();});
 await test('approve-writes-permanent-existing-sentinel',()=>{const h=storeDb();h.insert('a','lunch','awaiting_owner');assert.equal(h.mod.updateCalendarIssueStatus('a','approved'),true);assert.equal(h.db.prepare('SELECT event_end_ms FROM calendar_issues WHERE id=?').get('a').event_end_ms,Number.MAX_SAFE_INTEGER);h.db.close();});
 await test('fixed-human-block-health-autofix-never-writes',async()=>{const h=health.harness({blocks:[block('movable')]});const r=await h.move();assert.equal(h.calls.filter(c=>c[0]==='write').length,0);assert.equal(r.issue.fixed,undefined);assert.ok(r.issue.suggestion);});
 for(const kind of ['auto_move','move_meeting']) await test(`owner-correction-${kind}-durable`,async()=>{
  const src=source('src/skills/meetings/ops/handlers/moveMeeting.ts'),writes=[];
  const rec={subkind:kind,initiated_by_role:'system',outcome_json:JSON.stringify({new_start:`${date}T12:00:00+03:00`,new_end:`${date}T12:30:00+03:00`})};
  const req=n=>n.endsWith('/db/requests')?{getLatestAutomaticMoveForEvent:()=>rec,getRecentlyAutoMovedEventIds:()=>new Set(kind==='auto_move'?['lunch']:[])}:{dismissOverlapIssue:a=>writes.push(a),DISMISSAL_NEVER_EXPIRES:Number.MAX_SAFE_INTEGER,OWNER_UNDO_SUPPRESSION_HOURS:24};
  if(src.includes('export async function recordOwnerAutoMoveCorrection')) {
   const code=`const {DateTime}=require('luxon');${fn('src/skills/meetings/ops/handlers/moveMeeting.ts','recordOwnerAutoMoveCorrection')}exports.run=recordOwnerAutoMoveCorrection;`;
   await compile(code,n=>n==='luxon'?{DateTime}:req(n)).run({ownerUserId:'owner',eventId:'lunch',priorStart:`${date}T12:00:00+03:00`,priorEnd:`${date}T12:30:00+03:00`,newStart:`${date}T13:00:00+03:00`,newEnd:`${date}T13:30:00+03:00`,timezone:zone});
  } else {
   const sf=ts.createSourceFile('move.ts',src,ts.ScriptTarget.Latest,true);let body;
   function walk(n){if(ts.isIfStatement(n)&&n.expression.getText(sf)==="context.senderRole === 'owner'"&&n.getText(sf).includes('getRecentlyAutoMovedEventIds'))body=n.getText(sf);ts.forEachChild(n,walk);}walk(sf);assert.ok(body);
   await compile(`exports.run=async function(){const context={senderRole:'owner',profile:{user:{slack_user_id:'owner'}}},args={meeting_id:'lunch'},timezone='${zone}',effectiveStart='${date}T13:00:00+03:00',effectiveEnd='${date}T13:30:00+03:00';const {DateTime,logger}=require('bindings');${body}}`,n=>n==='bindings'?{DateTime,logger}:req(n)).run();
  }
  assert.equal(writes.length,1);assert.equal(writes[0].eventEndMs,Number.MAX_SAFE_INTEGER);
 });
 await test('owner-correction-changed-calendar-is-different-control',async()=>{
  const src=source('src/skills/meetings/ops/handlers/moveMeeting.ts');if(!src.includes('export async function recordOwnerAutoMoveCorrection')) {
   const sf=ts.createSourceFile('move.ts',src,ts.ScriptTarget.Latest,true);let body;function walk(n){if(ts.isIfStatement(n)&&n.expression.getText(sf)==="context.senderRole === 'owner'"&&n.getText(sf).includes('getRecentlyAutoMovedEventIds'))body=n.getText(sf);ts.forEachChild(n,walk);}walk(sf);assert.ok(body);const writes=[];
   await compile(`exports.run=async function(){const context={senderRole:'owner',profile:{user:{slack_user_id:'owner'}}},args={meeting_id:'lunch'},timezone='${zone}',effectiveStart='${date}T13:00:00+03:00',effectiveEnd='${date}T13:30:00+03:00';const {DateTime,logger}=require('bindings');${body}}`,n=>n==='bindings'?{DateTime,logger}:n.endsWith('/requests')?{getRecentlyAutoMovedEventIds:()=>new Set()}:{dismissOverlapIssue:a=>writes.push(a)}).run();assert.equal(writes.length,0);return;
  }
  const writes=[],rec={outcome_json:JSON.stringify({new_start:`${date}T11:00:00+03:00`,new_end:`${date}T11:30:00+03:00`})};
  const mod=compile(`const {DateTime}=require('luxon');${fn('src/skills/meetings/ops/handlers/moveMeeting.ts','recordOwnerAutoMoveCorrection')}exports.run=recordOwnerAutoMoveCorrection;`,n=>n==='luxon'?{DateTime}:n.endsWith('/requests')?{getLatestAutomaticMoveForEvent:()=>rec}:{dismissOverlapIssue:a=>writes.push(a)});
  await mod.run({ownerUserId:'owner',eventId:'lunch',priorStart:`${date}T12:00:00+03:00`,priorEnd:`${date}T12:30:00+03:00`,newStart:`${date}T13:00:00+03:00`,newEnd:`${date}T13:30:00+03:00`,timezone:zone});assert.equal(writes.length,0);
 });
 for(const actor of ['system','owner']) await test(`revert-floating-${actor}-decision`,async()=>{
  const sf=ts.createSourceFile('revert.ts',source('src/skills/meetings/ops/handlers/calendarReads.ts'),ts.ScriptTarget.Latest,true);let branch;
  function walk(n){if(ts.isIfStatement(n)&&n.expression.getText(sf).includes("rec.subkind === 'auto_move'")&&n.thenStatement.getText(sf).includes('dismissOverlapIssue'))branch=n.getText(sf);ts.forEachChild(n,walk);}walk(sf);assert.ok(branch);
  const writes=[];await compile(`exports.run=async function(){let rejectionRecorded=false,rejectionStorageFailed=false;const rec={subkind:'move_meeting',initiated_by_role:'${actor}'},oc={},ownerUserId='owner',eventId='lunch',originalStart='${date}T12:00:00+03:00',timezone='${zone}';const {DateTime,logger}=require('bindings');${branch}}`,n=>n==='bindings'?{DateTime,logger}:{dismissOverlapIssue:a=>writes.push(a),DISMISSAL_NEVER_EXPIRES:Number.MAX_SAFE_INTEGER}).run();assert.equal(writes.length,actor==='system'?1:0);
 });
 await test('automatic-meeting-chain-needs-owner-no-calendar-write',async()=>{
  const e=health.event('lunch','2026-09-14T12:00','2026-09-14T12:30'),h=health.harness({blocks:[block('lunch')],events:[e]});const r=await h.move();assert.equal(h.calls.filter(c=>c[0]==='write').length,0);assert.ok(r.issue.suggestion?.includes('another calendar event'));assert.equal(r.issue.fix_failed,undefined);
 });
 for(const variant of ['human','solo','dismissed']) await test(`search-busy-carving-${variant}`,()=>{
  const sf=ts.createSourceFile('search.ts',source('src/connectors/graph/findAvailableSlots.ts'),ts.ScriptTarget.Latest,true);let rangeIf,poolLoop;
  function walk(n){if(ts.isIfStatement(n)&&n.expression.getText(sf)==='floatingBlocks.length > 0 && ownerEventsForFb.length > 0')rangeIf=n.getText(sf);if(ts.isForOfStatement(n)&&n.expression.getText(sf)==='ownerEventsForFb'&&n.getText(sf).includes('readdPool.push'))poolLoop=n.getText(sf);ts.forEachChild(n,walk);}walk(sf);assert.ok(rangeIf);assert.ok(poolLoop);
  const e=variant==='human'?human(event('lunch','12:00','12:30')):event('lunch','12:00','12:30'),p=profile([block('lunch')]);
  const r=compile(`exports.run=function(d){const {DateTime,fb,profile,ownerEventsForFb,suppressedFloatingIds}=d;const floatingBlocks=profile.meetings.floating_blocks,params={timezone:'${zone}'},blockRanges=[],readdPool=[],excludeIdSet=new Set();${rangeIf}${poolLoop}return {blockRanges,readdPool};}`,()=>{}).run({DateTime,fb:floating,profile:p,ownerEventsForFb:[e],suppressedFloatingIds:new Set(variant==='dismissed'?['lunch']:[])});
  assert.equal(r.blockRanges.length,variant==='solo'?1:0);assert.equal(r.readdPool.length,variant==='solo'?0:1);
 });
 for(const variant of ['human','solo','dismissed','chain']) await test(`join-actual-mover-${variant}`,async()=>{
  const src=source('src/skills/meetings.ts'),start=src.indexOf('const joinDayName ='),decision=src.indexOf('if (joinCheck.passes) {',start),tail=src.indexOf('const movesLine =',decision);
  const runJoin=compile(`exports.run=async function(d){const {DateTime,fb,profile,events,timezone,dayStr,meetingStartMs,meetingEndMs,evTime,floatingBlocks,logger,updateMeeting,userEmail,suppressedFloatingIds}=d;const timeStr='12:00';${src.slice(start,decision)}${src.slice(decision+'if (joinCheck.passes) {'.length,tail)}return movesDone;}`,()=>({logRebalanceMoveActivity:()=>{}})).run;
  const writes=[],p=profile(variant==='chain'?['lunch','coffee','focus'].map(n=>block(n)):[block('lunch')]);p.behavior={calendar_health_mode:'active'};const e=variant==='human'?human(event('lunch','12:00','12:30')):event('lunch','12:00','12:30');
  const joinResult=await runJoin({DateTime,fb:floating,profile:p,events:variant==='chain'?[event('lunch','12:00','12:30'),event('coffee','12:30','13:00'),event('focus','13:00','13:30'),event('busy','11:30','12:00')]:[e],timezone:zone,dayStr:date,meetingStartMs:DateTime.fromISO(`${date}T12:00`,{zone}).toMillis(),meetingEndMs:DateTime.fromISO(`${date}T${variant==='chain'?'13:30':'13:00'}`,{zone}).toMillis(),evTime:t=>DateTime.fromISO(t.dateTime,{zone:t.timeZone}),floatingBlocks:p.meetings.floating_blocks,logger,userEmail:p.user.email,suppressedFloatingIds:new Set(variant==='dismissed'?['lunch']:[]),updateMeeting:async w=>writes.push(w)});assert.equal(writes.length,variant==='solo'?1:variant==='chain'?2:0);if(variant==='chain'){assert.equal(joinResult.can_join,false);assert.equal(joinResult.needs_owner_decision,true);assert.equal(joinResult.blocks_moved.length,2);}
 });
 await test('different-axis-question-survives-rejected-conflict',()=>{const h=storeDb();h.insert('a','lunch','dismissed');h.insert('q','lunch','awaiting_owner','question','missing_category');assert.equal(h.mod.getSuppressedEventIds('owner','missing_category').has('lunch'),false);assert.equal(h.db.prepare('SELECT status FROM calendar_issues WHERE id=?').get('q').status,'awaiting_owner');h.db.close();});
 await test('post-write-compliance-counts-fixed-attendee-object',()=>{
  const production=fn('src/utils/verifyScheduledOutcome.ts','checkCompliance');
  const mod=compile(`const {DateTime,...fb}=require('bindings');const {getFloatingBlocks,isFloatingBlockEvent,hasOtherHumanAttendee,blockAppliesOnDay,windowMsForDay,findAlignedSlotForBlock}=fb;${production}exports.run=checkCompliance;`,n=>n==='bindings'?{DateTime,...floating}:{getEffectiveWorkDayForInstant:()=>({hasOverride:false,windows:[{startMin:540,endMin:1080}]}),ownerWorkSegmentsBetween:()=>[{effectiveDay:{isWorkday:true,windows:[{startMin:540,endMin:1080}]},fitsWorkHours:true}]});
  const issue=mod.run(event('meeting','11:00','14:00'),[human(event('lunch','12:00','12:30'))],profile([block('lunch')]));assert.equal(issue.some(x=>x.includes('no room')),false);
 });
 for(const file of ['createMeeting','moveMeeting'])for(const actor of ['owner','colleague'])await test(`unresolved-${file}-question-${actor}-privacy`,async()=>{
  const src=source(`src/skills/meetings/ops/handlers/${file}.ts`),sf=ts.createSourceFile('op.ts',src,ts.ScriptTarget.Latest,true);let attempt;
  function walk(n){if(ts.isTryStatement(n)&&n.tryBlock.getText(sf).includes('rebalanceFloatingBlocksAfterMutation')&&!n.tryBlock.getText(sf).includes('planMeeting')){if(!attempt||n.getText(sf).length<attempt.length)attempt=n.getText(sf);}ts.forEachChild(n,walk);}walk(sf);assert.ok(attempt);
  const hasOutput=src.includes('floating_block_questions: floatingBlockQuestions');
  const value=await compile(`exports.run=async function(){const context={senderRole:'${actor}',profile:{user:{slack_user_id:'owner'}}},args={start:'${date}T12:00:00+03:00'},effectiveStart=args.start,logger={warn(){}};let blocksMoved=[],floatingBlockQuestions=[];${attempt}return {success:true,...(blocksMoved.length?{blocks_moved:blocksMoved}:{}),${hasOutput?'...(floatingBlockQuestions.length?{floating_block_questions:floatingBlockQuestions}:{})':''}};}`,()=>({rebalanceFloatingBlocksAfterMutation:async()=>({moves:['moved coffee'],ownerQuestions:[{description:'Private owner question'}]})})).run();
  assert.equal(value.success,true);assert.equal(value.floating_block_questions?.length??0,actor==='owner'?1:0);assert.equal(value.blocks_moved.length,1);
 });
 await test('correction-storage-unavailable-does-not-fail-calendar-success',async()=>{
  const src=source('src/skills/meetings/ops/handlers/moveMeeting.ts');
  if(!src.includes('export async function recordOwnerAutoMoveCorrection')) {
    const sf=ts.createSourceFile('move.ts',src,ts.ScriptTarget.Latest,true);let body;function walk(n){if(ts.isIfStatement(n)&&n.expression.getText(sf)==="context.senderRole === 'owner'"&&n.getText(sf).includes('getRecentlyAutoMovedEventIds'))body=n.getText(sf);ts.forEachChild(n,walk);}walk(sf);
    await compile(`exports.run=async function(){const context={senderRole:'owner',profile:{user:{slack_user_id:'owner'}}},args={meeting_id:'lunch'};const {logger}=require('bindings');${body}}`,n=>n==='bindings'?{logger}:{getRecentlyAutoMovedEventIds:()=>{throw Error('unavailable')}}).run();return;
  }
  const mod=compile(`const {DateTime}=require('luxon');${fn('src/skills/meetings/ops/handlers/moveMeeting.ts','recordOwnerAutoMoveCorrection')}exports.run=recordOwnerAutoMoveCorrection;`,n=>n==='luxon'?{DateTime}:{getLatestAutomaticMoveForEvent:()=>{throw Error('unavailable')}});
  assert.equal(await mod.run({ownerUserId:'owner',eventId:'lunch',priorStart:`${date}T12:00:00+03:00`,priorEnd:`${date}T12:30:00+03:00`,newStart:`${date}T13:00:00+03:00`,newEnd:`${date}T13:30:00+03:00`,timezone:zone}),false);
 });
 for(const kind of ['human','solo']) await test(`explicit-owner-move-${kind}-uses-correct-path`,()=>{
  const file='src/skills/meetings/ops/handlers/moveMeeting.ts',sf=ts.createSourceFile(file,source(file),ts.ScriptTarget.Latest,true);let declaration;
  function walk(n){if(ts.isVariableDeclaration(n)&&n.name.getText(sf)==='matchedBlock'&&n.getText(sf).includes('movingEvent'))declaration=n.getText(sf);ts.forEachChild(n,walk);}walk(sf);assert.ok(declaration);
  const result=compile(`exports.run=function(d){const {movingEvent,blocks,fb,context}=d;const ${declaration};return matchedBlock;}`,()=>{}).run({movingEvent:kind==='human'?human(event('lunch','12:00','12:30')):event('lunch','12:00','12:30'),blocks:[block('lunch')],fb:floating,context:{profile:profile([block('lunch')])}});assert.equal(result?.name??null,kind==='human'?null:'lunch');
 });
 const report={attempt:'owner-floating-1',snapshot:before?'preserved before':'working tree',passed:results.filter(x=>x.status==='pass').length,failed:results.filter(x=>x.status==='fail').length,results};
 fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,before?'before-results.json':'after-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));process.exitCode=report.failed?1:0;
})();
