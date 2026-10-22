// Actual move write/readback branch -> real SQLite receipt -> actual health scan.
// External Graph is an isolated stateful fixture. Quote semantics are NOT tested.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const Database=require('better-sqlite3'),{DateTime}=require('luxon');
const root=path.resolve(__dirname,'..'),before=process.argv.includes('--before');
const base=path.join(root,'artifacts/workshop-verification/owner-exceptions-20261022/attempt2/before');
const health=require('./test-calendar-health-audit.cjs');
const files={move:'src/skills/meetings/ops/handlers/moveMeeting.ts',store:'src/db/calendarIssues.ts',health:'src/skills/calendarHealth/handlers/checkHealth.ts'};
const source=k=>fs.readFileSync(before?path.join(base,path.basename(files[k])):path.join(root,files[k]),'utf8');
const compile=(s,req,bindings={})=>{const m={exports:{}};vm.runInNewContext(ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{require:req,module:m,exports:m.exports,...bindings});return m.exports;};
const log={info(){},warn(){},error(){}};
const category=compile(fs.readFileSync(path.join(root,'src/utils/categoryRules.ts'),'utf8'),n=>n==='luxon'?{DateTime}:n.endsWith('/logger')?{default:log}:{});
const sf=ts.createSourceFile('move.ts',source('move'),ts.ScriptTarget.Latest,true);
const all=[];(function walk(n){all.push(n);ts.forEachChild(n,walk)})(sf);
const declaration=all.find(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(sf)==='moveWriteError'));
const statements=declaration.parent.statements,first=statements.indexOf(declaration);
const last=statements.findIndex((n,i)=>i>first&&ts.isExpressionStatement(n)&&n.getText(sf).startsWith('await closeMeetingArtifacts('));
assert.ok(first>=0&&last>first,'real post-move branch anchors');
const branch=statements.slice(first,last+1+(statements[last+1]?.getText(sf).includes('recordAcceptedMoveExceptions')?1:0)).map(n=>n.getText(sf)).join('\n');
const helper=all.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='recordAcceptedMoveExceptions')?.getText(sf)||'';
const unchanged=all.find(n=>ts.isIfStatement(n)&&n.expression.getText(sf).startsWith('preMoveStartIso && preMoveEndIso')&&n.thenStatement.getText(sf).includes('unchanged: true'));
assert.ok(unchanged,'actual idempotent unchanged branch');
const day='2026-09-14',start=`${day}T10:00:00+03:00`,end=`${day}T10:40:00+03:00`;
const ev=(id,s='10:00',e='10:40')=>({...health.event(id,`${day}T${s}:00`,`${day}T${e}:00`),categories:['Weekly']});
const disclosure='Wednesday is a fourth Weekly and overlaps the webinar for ten minutes.';
const acceptance='Choose that offered time.';
const common={event_id:'moved',start,end,disclosure_quote:disclosure,acceptance_quote:acceptance};
const overlap={...common,kind:'overlap',peer_event_id:'webinar',overlap_start:`${day}T10:30:00+03:00`,overlap_end:end};
const cat={...common,kind:'category_limit',category:'Weekly',rule_broken:'per_day',window_start:day,accepted_count:4,rule_value:3};
function fixture(opts={}){
 let db=new Database(':memory:');
 db.exec('CREATE TABLE calendar_issues(id TEXT PRIMARY KEY,owner_user_id TEXT,event_id TEXT,peer_event_id TEXT,event_date TEXT,event_end_ms INTEGER,issue_class TEXT,axis TEXT,status TEXT,notes TEXT,request_id TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(owner_user_id,event_id,axis))');
 let store=compile(source('store'),n=>{assert.equal(n,'./client');return {getDb:()=>db}});
 const events=[ev('moved','09:00','09:40'),{...ev('webinar','10:30','11:00'),categories:['Meeting']},ev('two','12:00','12:40'),ev('three','13:00','13:40'),ev('four','14:00','14:40')];
 const h=health.harness({events,issueStore:new Proxy({},{}),categoryRules:category,healthSource:source('health')});
 h.profile.categories=[{name:'Weekly',limits:{per_day:3}},{name:'Meeting'}];
 const context={profile:h.profile,senderRole:'owner',authority:'owner',surface:'owner_dm',userId:'owner',interactive:true,
   currentUserMessage:acceptance,conversationHistory:[{role:'assistant',content:`[unshown tool finding]\n${disclosure}`,toolSummaries:['[unshown tool finding]']}]};
 Object.assign(context,opts.context??{});
 const args={meeting_id:'moved',accepted_exceptions:JSON.parse(JSON.stringify(opts.facts??[overlap,cat]))};
 let writes=0;
 const cal={getOwnerEventsForDecision:async()=>{if(opts.readFail)throw Error('unavailable');return events;},
  verifyApprovedCalendarAction:async()=>({status:opts.verify??'desired_state_observed'}),
  updateMeeting:async()=>{writes++;if(!opts.noApply){events[0].start.dateTime=start;events[0].end.dateTime=end;}if(opts.writeThrow)throw Error('response lost');}};
 const req=n=>n==='luxon'?{DateTime}:n.endsWith('/graph/calendar')?cal:n.endsWith('/categoryRules')?category:n.endsWith('/db/calendarIssues')?store:(()=>{throw Error(n)})();
 const bindings={DateTime,logger:log,args,context,ctx:{context,timezone:'Asia/Jerusalem',userEmail:h.profile.user.email},timezone:'Asia/Jerusalem',userEmail:h.profile.user.email,
  effectiveStart:start,effectiveEnd:end,preMoveIsAllDay:false,preMoveEventType:'occurrence',movePlanLocation:undefined,movePlanIsOnline:undefined,movePlanCategories:undefined,movePlanAttendees:undefined,
  getBefore:()=>events[0],updateMeeting:cal.updateMeeting,closeMeetingArtifacts:async()=>store.resolveCalendarIssuesForMeeting('owner','moved')};
 const run=compile(`${helper}\nexports.run=async function(){let ownerDecisionWarning;const preMoveStartIso=getBefore().start.dateTime,preMoveEndIso=getBefore().end.dateTime;${unchanged.getText(sf)}\n${branch}\nreturn {success:true,warning:ownerDecisionWarning};};`,req,bindings).run;
 const scan=async(mode='passive')=>{
   const hh=health.harness({events,issueStore:store,categoryRules:category,healthSource:source('health')});hh.profile.categories=h.profile.categories;
   const result=await hh.scan({mode});return {result,calls:hh.calls};
 };
 return {args,context,events,run,scan,get db(){return db},get store(){return store},get writes(){return writes},
   restart(){const snapshot=db.serialize();db.close();db=new Database(snapshot);store=compile(source('store'),n=>({getDb:()=>db}));},close(){db.close()}};
}
let passed=0,failed=0;
async function check(name,fn){let h;try{h=fixture();await fn(h);passed++;console.log('ok '+name);}catch(e){failed++;console.log('not ok '+name+': '+e.stack);}finally{h?.close();}}
const kinds=r=>r.result.issues.filter(i=>['double_booking','category_limit_exceeded'].includes(i.type));
(async()=>{
 await check('regression confirmed selected move suppresses both accepted facts in active health',async h=>{assert.equal((await h.run()).success,true);const r=await h.scan('active');assert.equal(kinds(r).length,0);assert.equal(r.calls.filter(c=>c[0]==='write').length,0);assert.equal(h.db.prepare("SELECT count(*) n FROM calendar_issues WHERE status='approved'").get().n,2);});
 await check('regression durable restart and idempotent receipt retry',async h=>{await h.run();h.restart();assert.equal(kinds(await h.scan()).length,0);assert.equal((await h.run()).unchanged,true);assert.equal(h.writes,1);assert.equal(h.db.prepare("SELECT count(*) n FROM calendar_issues WHERE status='approved'").get().n,2);});
 await check('regression failed receipt write retries unchanged event without second mutation',async h=>{h.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON calendar_issues BEGIN SELECT RAISE(ABORT,'fixture failure'); END");const first=await h.run();assert.equal(first.success,true);assert.ok(first.warning);assert.equal(h.db.prepare('SELECT count(*) n FROM calendar_issues').get().n,0);h.db.exec('DROP TRIGGER reject_receipt');assert.equal((await h.run()).unchanged,true);assert.equal(h.writes,1);assert.equal(kinds(await h.scan()).length,0);});
 await check('regression pre-existing cluster closure cannot hide worsened conditions',async h=>{h.db.prepare("INSERT INTO calendar_issues(id,owner_user_id,event_id,event_date,event_end_ms,issue_class,axis,status) VALUES('old','owner','moved',?,?,'overlap','conflict','awaiting_owner')").run(day,Number.MAX_SAFE_INTEGER);await h.run();assert.equal(h.store.getSuppressedEventIds('owner').has('moved'),false);h.events[1].start.dateTime=`${day}T10:20:00`;h.events.push(ev('fifth','15:00','15:40'));assert.equal(kinds(await h.scan()).length,2);});
 await check('legitimate undisclosed move remains visible',async h=>{h.args.accepted_exceptions=[];await h.run();assert.equal(kinds(await h.scan()).length,2);});
 for(const [name,change]of [['colleague',{senderRole:'colleague',authority:'colleague'}],['room',{surface:'room'}],['synthetic',{interactive:false}],['unknown-interactivity',{interactive:undefined}],['wrong-user',{userId:'other'}],['no-current-owner-acceptance',{currentUserMessage:'Check feasibility only.'}],['no-prior-disclosure',{conversationHistory:[]}],['unproven-legacy-history',{conversationHistory:[{role:'assistant',content:disclosure}]}],['tool-finding-only',{conversationHistory:[{role:'assistant',content:`${disclosure}\nOther response.`,toolSummaries:[disclosure]}]}]])
  await check(name+' never suppresses',async h=>{Object.assign(h.context,change);await h.run();assert.equal(kinds(await h.scan()).length,2);});
 for(const [name,change]of [['missing-overlap-peer',{peer_event_id:undefined}],['wrong-peer',{peer_event_id:'different'}],['longer-than-disclosed',{overlap_start:`${day}T10:35:00+03:00`}],['wrong-occurrence',{event_id:'another'}],['wrong-destination',{end:`${day}T10:45:00+03:00`}],['naive-clock',{start:`${day}T10:00:00`}],['unsupported-kind',{kind:'busy_day'}]])
  await check(name+' remains detectable',async h=>{h.args.accepted_exceptions=[{...overlap,...change}];await h.run();assert.equal(kinds(await h.scan()).length,2);});
 await check('regression only disclosed overlap suppresses; category still raised',async h=>{h.args.accepted_exceptions=[overlap];await h.run();assert.deepEqual(kinds(await h.scan()).map(i=>i.type),['category_limit_exceeded']);});
 await check('regression only disclosed category suppresses; overlap still raised',async h=>{h.args.accepted_exceptions=[cat];await h.run();assert.deepEqual(kinds(await h.scan()).map(i=>i.type),['double_booking']);});
 await check('new peer remains detectable after acceptance',async h=>{await h.run();h.events.push({...ev('new-peer','10:35','11:00'),categories:['Meeting']});assert.ok(kinds(await h.scan()).some(i=>i.type==='double_booking'&&i.eventIds.includes('new-peer')));});
 await check('longer overlap remains detectable after acceptance',async h=>{await h.run();h.events[1].start.dateTime=`${day}T10:20:00`;assert.ok(kinds(await h.scan()).some(i=>i.type==='double_booking'));});
 await check('regression shorter overlap remains accepted',async h=>{await h.run();h.events[1].start.dateTime=`${day}T10:35:00`;assert.equal(kinds(await h.scan()).length,0);});
 await check('fifth weekly remains detectable',async h=>{await h.run();h.events.push(ev('fifth','15:00','15:40'));assert.ok(kinds(await h.scan()).some(i=>i.type==='category_limit_exceeded'));});
 await check('later occurrence remains detectable',async h=>{await h.run();h.events[0].id='next-occurrence';assert.equal(kinds(await h.scan()).length,2);});
 await check('changed destination remains detectable',async h=>{await h.run();h.events[0].start.dateTime=`${day}T10:05:00`;assert.equal(kinds(await h.scan()).length,2);});
 await check('wrong category window or count never suppresses',async h=>{h.args.accepted_exceptions=[{...cat,accepted_count:5},{...cat,window_start:'2026-09-15'}];await h.run();assert.equal(kinds(await h.scan()).length,2);});
 await check('regression weekly window binds independently',async h=>{h.context.profile.categories[0].limits={per_week:3};h.args.accepted_exceptions=[{...cat,rule_broken:'per_week'},overlap];await h.run();assert.equal(kinds(await h.scan()).length,0);});
 await check('permanent dismissal survives acceptance store independently',async h=>{h.store.dismissOverlapIssue({ownerUserId:'owner',eventId:'moved',eventDate:day,eventEndMs:Number.MAX_SAFE_INTEGER,notes:'permanent rejection'});await h.run();assert.ok(h.store.getSuppressedEventIds('owner').has('moved'));assert.equal(h.db.prepare("SELECT status FROM calendar_issues WHERE event_id='moved'").get().status,'dismissed');});
 for(const [name,options]of [['failed-write',{noApply:true,writeThrow:true,verify:'different_state_observed'}],['ambiguous-readback',{writeThrow:true,verify:'unavailable'}],['changed-state',{verify:'different_state_observed'}]]){
  const h=fixture(options);try{await check(name+' records no acceptance',async()=>{assert.equal((await h.run()).success,false);assert.equal(h.db.prepare("SELECT count(*) n FROM calendar_issues WHERE status='approved'").get().n,0)});}finally{h.close();}
 }
 {const h=fixture({writeThrow:true});try{await check('regression lost response confirmed by readback records acceptance',async()=>{assert.equal((await h.run()).success,true);assert.equal(kinds(await h.scan()).length,0);assert.equal(h.writes,1)});}finally{h.close();}}
 {const h=fixture({readFail:true});try{await check('unavailable condition snapshot warns without acceptance',async()=>{const r=await h.run();assert.equal(r.success,true);if(!before)assert.ok(r.warning);assert.equal(h.db.prepare("SELECT count(*) n FROM calendar_issues WHERE status='approved'").get().n,0)});}finally{h.close();}}
 console.log(`${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
})();
