/* Actual approval creation/resolver/replay/close/relay/runner and move handler.
 * Domain IO is an isolated mutable calendar, never Graph. Restart serializes
 * both the request row and calendar to a temporary SQLite file, closes it and
 * creates fresh module instances. MAELLE_COORDINATED_BEFORE overlays saved sources.
 */
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),os=require('node:os');
const Database=require('better-sqlite3');
const {DateTime}=require('luxon');
const ts=require('typescript');
const root=path.resolve(__dirname,'..');
// Reuse the existing lifecycle isolation inventory, with every changed double
// explicit below. No production side effect is reachable through this loader.
let source=fs.readFileSync(path.join(__dirname,'test-approval-bounce.cjs'),'utf8').split('function due(h)')[0];
function replace(from,to){assert.ok(source.includes(from),from);source=source.replace(from,to);}
replace("process.env.MAELLE_BOUNCE_SOURCE_ROOT||root","process.env.MAELLE_COORDINATED_BEFORE||root");
replace("timezone:'UTC'},assistant", "timezone:'UTC',email:'owner@example.test'},assistant");
replace('function harness(o={}){',`function harness(o={}){
 class Clock extends Date { constructor(...a){super(...(a.length?a:[Date.parse(o.now||'2026-10-14T12:00:00Z')]));} static now(){return Date.parse(o.now||'2026-10-14T12:00:00Z');} }
 const calendar=o.calendar; let sourceReads=0;
`);
replace("{Date,Set,Map,setImmediate}","{Date:Clock,Set,Map,setImmediate}");
replace("createRequest:()=>row", "createRequest:p=>{row={...row,state:p.state,details_json:JSON.stringify(p.details)};return row;}");
replace("'src/utils/workHours.ts':{", "'src/utils/workHours.ts':{getEffectiveWorkDay:()=>({isAway:false,timezone:'UTC'}),");
replace("effects.executes.push({tool,args,context});return o.execution||{status:'completed',result:{success:true,meetingId:'event'}};",`effects.executes.push(clone({tool,args,context}));
 if(!o.execute)return o.execution||{status:'completed',result:{success:true,meetingId:'event'}};
 const result=await o.execute(tool,args,context);return {status:result.success===true?'completed':'failed',result};`);
replace("verifyApprovedCalendarAction:async()=>{effects.checks++;return o.verification||{status:'unavailable',reason:'missing_exact_event_id'};}",`verifyApprovedCalendarAction:async p=>{effects.checks++;
 if(o.verification){const result=typeof o.verification==='function'?o.verification(p):o.verification;if(result)return result;}
 const e=calendar?.find(e=>e.id===p.args.meeting_id);
 if(!e)return {status:'different_state_observed',reason:'event_absent'};
 const match=Date.parse(e.start.dateTime)===Date.parse(p.args.new_start)&&Date.parse(e.end.dateTime)===Date.parse(p.args.new_end);
 return {status:match?'desired_state_observed':'different_state_observed',reason:match?'approved_fields_match':'approved_fields_differ',...(match?{result:{meetingId:e.id,_calendar_verification:'desired_state_observed'}}:{})};}`);
replace("'src/connectors/graph/calendarReads.ts':",`'src/connectors/graph/calendar.ts':{verifyEventDeleted:async()=>false,getEventType:async(_email,id)=>{
  sourceReads++;
  const e=calendar?.find(e=>e.id===id);if(!e||o.sourceUnavailable)throw Error('calendar unavailable');
  if(sourceReads>2&&o.remainingSourceUnavailable)throw Error('calendar unavailable');
  return readEventTypeFixture(sourceReads>2&&o.remainingSource?{...e,...o.remainingSource}:e)(_email,id);}},
 'src/connectors/graph/calendarReads.ts':`);
replace("tools:()=>new(load('src/tasks/skill.ts').TasksSkill)().getTools(profile),",`tools:()=>new(load('src/tasks/skill.ts').TasksSkill)().getTools(profile),
 create:payload=>new(load('src/tasks/skill.ts').TasksSkill)().executeToolCall('create_approval',{kind:'policy_exception',payload,ask_text:'Move the agreed pair',expires_in_hours:48},{profile,userId:'OWNER',authority:'owner',senderRole:'owner',surface:'owner_dm',channel:'slack',channelId:'DOWNER',threadTs:'owner.root'}),
 freeze:args=>load('src/core/requests/deferredActionReplay.ts').canonicalizeCoordinatedMoveArgs(args,profile),
 amend:(args,counter)=>load('src/core/approvals/approvalCallbacks.ts').mergeAmendIntoApprove({tool:'move_meeting',args},counter,profile),
`);
// Exercise the actual exact-ID/type guard and Graph clock normalization. Only
// Graph's response payload/transport is doubled; no source metadata is fabricated.
const readerFile='src/connectors/graph/calendarReads.ts';
const readerAst=ts.createSourceFile(readerFile,fs.readFileSync(path.join(root,readerFile),'utf8'),ts.ScriptTarget.Latest,true);
const readerCode=['eventPartAsInstant','getEventType'].map(name=>{
 const fn=readerAst.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(fn,name);return fn.getText(readerAst);
}).join('\n');
source+='\nfunction readEventTypeFixture(event){const m={exports:{}};const chain={api(){return this;},select(){return this;},async get(){return event;}};vm.runInNewContext('+JSON.stringify(ts.transpileModule(readerCode,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)+',{module:m,exports:m.exports,DateTime,logger:{warn(){}},getClient:()=>chain});return m.exports.getEventType;}';
const fixtureModule=new Module(__filename+'.fixture',module);fixtureModule.filename=__filename;fixtureModule.paths=module.paths;
fixtureModule._compile(source+'\nmodule.exports=harness;',__filename);
const lifecycle=fixtureModule.exports;
// Actual handler + checkSlot, reusing the Matchmaker IO inventory and profile.
let pairs=fs.readFileSync(path.join(__dirname,'test-meeting-reschedule.cjs'),'utf8');
const pairModule=new Module(__filename+'.pairs',module);pairModule.filename=__filename;pairModule.paths=module.paths;
const originalRequire=pairModule.require.bind(pairModule);
// The reused handler fixture defaults to an identity display double. This
// lifecycle fixture also checks room payloads, so use the real privacy helper.
const displayFile=path.join(root,'src/utils/displaySubject.ts'),displayModule=new Module(displayFile,module);
displayModule.filename=displayFile;displayModule.paths=module.paths;
displayModule.require=spec=>{assert.equal(spec,'../db');return {getPersonMemory:()=>null};};
displayModule._compile(ts.transpileModule(fs.readFileSync(displayFile,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,displayFile);
const moveFile=path.join(__dirname,'test-yael-meeting-selection.cjs'),moveModule=new Module(moveFile,module);
moveModule.filename=moveFile;moveModule.paths=module.paths;const moveRequire=moveModule.require.bind(moveModule);
moveModule.require=spec=>spec==='actual-display-fixture'?displayModule.exports:moveRequire(spec);
const moveSource=fs.readFileSync(moveFile,'utf8');assert.ok(moveSource.includes('displaySubject:e=>e.subject'));
moveModule._compile(moveSource.replace('displaySubject:e=>e.subject',"displaySubject:require('actual-display-fixture').displaySubject"),moveFile);
pairModule.require=spec=>spec==='node:test'?{test(){}}:spec==='./test-yael-meeting-selection.cjs'?moveModule.exports:originalRequire(spec);
pairModule._compile(pairs+'\nmodule.exports={pairFixture};',__filename);
const pairFixture=pairModule.exports.pairFixture;
const at=t=>'2026-10-14T'+t+':00Z';
const plan=()=>({coordinated_moves:[{meeting_id:'oct11',new_start:at('13:30'),new_end:at('14:10')},{meeting_id:'sep2',new_start:at('14:15'),new_end:at('14:55')}]});
const details=args=>JSON.stringify({deferred_action:{tool:'move_meeting',args}});
function fixture(o={}){
 const p=pairFixture(o);
 const h=lifecycle({...o,calendar:p.h.events,row:{details_json:details(o.args||plan()),expires_at:'2026-10-16T12:00:00Z',...o.row},
 execute:async(tool,args,context)=>{assert.equal(tool,'move_meeting');Object.assign(p.h.ctx.context,{...context,profile:p.h.ctx.context.profile});return p.h.run({...args,meeting_id:args.meeting_id,meeting_subject:args.meeting_subject,new_start:args.new_start,new_end:args.new_end});}});
 return {h,p};
}
function durableRestart(f,o={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'maelle-pair-')),file=path.join(dir,'fixture.db');
 let db=new Database(file);db.exec('CREATE TABLE fixture (row_json TEXT, calendar_json TEXT)');
 db.prepare('INSERT INTO fixture VALUES (?,?)').run(JSON.stringify(f.h.row()),JSON.stringify(f.p.h.events));db.close();
 db=new Database(file);const saved=db.prepare('SELECT * FROM fixture').get();db.close();fs.rmSync(dir,{recursive:true,force:true});
 return fixture({...o,row:JSON.parse(saved.row_json),events:JSON.parse(saved.calendar_json)});
}
test('C01 full exact pair executes with real handler and closes/relays once',async()=>{
 const f=fixture();const r=await f.h.resolve();assert.equal(r.ok,true,JSON.stringify({r,plans:f.p.h.state.plans,warnings:f.p.h.state.warnings}));assert.equal(r.outcomes.length,2);assert.equal(f.h.row().state,'resolved');
 assert.equal(JSON.parse(f.h.row().outcome_json).outcomes.length,2);assert.deepEqual(f.p.h.state.writes.map(w=>w.meetingId),['sep2','oct11']);
 assert.match(f.h.effects.sends[0].body,/every meeting.*agreed time/);await f.h.resolve();assert.equal(f.h.effects.sends.length,1);assert.equal(f.h.effects.executes.length,1);f.h.check();
});
test('C02 preserved singular approved replay keeps existing authority',async()=>{
 const h=lifecycle();const r=await h.resolve();assert.equal(r.ok,true);assert.equal(h.effects.executes.length,1);assert.equal(h.effects.executes[0].args.relaxed,true);h.check();
});
test('C03 exact pair freezes omitted ends and offset instants before mutation',async()=>{
 const f=fixture({args:{coordinated_moves:[{meeting_id:'oct11',new_start:'2026-10-14T16:30:00+03:00'},{meeting_id:'sep2',new_start:at('14:15')}]}});
 const r=await f.h.resolve();assert.equal(r.ok,true);const frozen=JSON.parse(f.h.row().details_json).deferred_action.args.coordinated_moves;
 assert.equal(Date.parse(frozen[0].new_end)-Date.parse(frozen[0].new_start),40*60000);assert.ok(frozen.every(m=>m.new_end));f.h.check();
});
test('C04 A14 calendar conflict introduced after proposal blocks writes and keeps decision',async()=>{
 const f=fixture();f.h.update(f.h.row().id,{details:{deferred_action:{tool:'move_meeting',args:plan()}}});
 f.p.h.events.push(f.p.event('third','PRIVATE THIRD','14:45','15:30','third@example.test'));
 const r=await f.h.resolve();assert.equal(r.ok,false);assert.equal(f.p.h.state.writes.length,0);assert.equal(f.h.row().state,'awaiting_owner');
 assert.equal(f.h.effects.sends.length,0);assert.equal(f.h.effects.executes[0].args.relaxed,undefined);assert.equal(r.outcomes.length,2);f.h.check();
});
test('C05 A15 explicit second failure retains achieved state and durable exact plan',async()=>{
 const f=fixture({failEvent:'oct11'});const r=await f.h.resolve();assert.equal(r.ok,false);assert.equal(r.outcomes.filter(o=>o.success).length,1);assert.equal(f.h.row().state,'awaiting_owner');
 assert.ok(f.h.row().next_check_handler);assert.equal(f.h.effects.sends.length,0);
 const restarted=durableRestart(f);const r2=await restarted.h.resolve();assert.equal(r2.ok,true);assert.deepEqual(restarted.p.h.state.writes.map(w=>w.meetingId),['oct11']);
 assert.equal(restarted.h.effects.sends.length,1);f.h.check();restarted.h.check();
});
test('C06 A17 restart after achieved target reconciles before future validation',async()=>{
 const args={coordinated_moves:[{meeting_id:'oct11',new_start:at('12:30'),new_end:at('13:10')},{meeting_id:'sep2',new_start:at('15:00'),new_end:at('15:40')}]};
 const f=fixture({args,failEvent:'sep2'});await f.h.resolve();assert.deepEqual(f.p.h.state.writes.map(w=>w.meetingId),['oct11']);
 const restarted=durableRestart(f,{now:at('14:20')});const r=await restarted.h.resolve();assert.equal(r.ok,true);assert.deepEqual(restarted.p.h.state.writes.map(w=>w.meetingId),['sep2']);
 assert.equal(restarted.h.effects.executes[0].args.meeting_id,'sep2');assert.equal(restarted.h.effects.sends.length,1);assert.equal(r.outcomes.find(o=>o.meeting_id==='oct11').unchanged,true);restarted.h.check();
});
test('C07 all already achieved after target closes by observation with no tool or mutation',async()=>{
 const f=fixture();await f.h.resolve();const row={...f.h.row(),state:'awaiting_owner',requester_notified_at:null,outcome_json:null};
 const resumed=fixture({row,events:f.p.h.events,now:at('16:00')});const r=await resumed.h.resolve();assert.equal(r.ok,true);assert.equal(resumed.h.effects.executes.length,0);assert.equal(resumed.p.h.state.writes.length,0);assert.ok(r.outcomes.every(o=>o.unchanged));resumed.h.check();
});
test('C08 unknown read never repeats mutation and terminal notice preserves uncertainty',async()=>{
 const f=fixture({verification:{status:'unavailable',reason:'calendar_read_failed'}});const r=await f.h.resolve();assert.equal(r.ok,false);assert.equal(r.state,'resolved');assert.equal(f.h.effects.executes.length,0);
 assert.equal(r.outcomes.length,2);assert.match(f.h.effects.sends[0].body,/not fully confirmed/);assert.equal(f.h.effects.owner.length,1);assert.equal(f.h.row().next_check_handler,null);await f.h.resolve();assert.equal(f.h.effects.sends.length,1);f.h.check();
});
test('C09 occurrence identity rejects duplicate and series before writes',async()=>{
 const duplicate=fixture({args:{coordinated_moves:[plan().coordinated_moves[0],plan().coordinated_moves[0]]}});
 assert.equal((await duplicate.h.resolve()).effect,'approve_needs_exact_plan');duplicate.h.check();
 const f=fixture();
 f.p.h.events[0].type='seriesMaster';const r=await f.h.resolve();assert.equal(r.ok,false);assert.equal(f.h.effects.executes.length,0);assert.equal(f.h.effects.sends.length,0);f.h.check();
});
test('C10 room replay keeps room context and requester terminal payload excludes private calendar prose',async()=>{
 const f=fixture({room:true,row:{origin_channel:'CROOM',origin_is_mpim:1}});const r=await f.h.resolve();assert.equal(r.ok,true);assert.equal(f.h.effects.executes[0].context.isMpim,true);
 assert.equal(f.h.effects.sends[0].id,'CROOM');assert.ok(!f.h.effects.sends[0].body.includes('First'));assert.ok(!f.h.effects.sends[0].body.includes('Second'));f.h.check();
});
test('C11 partial outcome expiry tells both sides incomplete not unanswered',async()=>{
 const f=fixture({failEvent:'oct11'});await f.h.resolve();f.h.update(f.h.row().id,{nextCheckAt:'2020-01-01T00:00:00Z'});await f.h.sweep();
 assert.equal(f.h.row().state,'resolved');assert.match(f.h.effects.sends[0].body,/not fully confirmed/);assert.equal(f.h.effects.owner.length,1);assert.equal(f.h.effects.executes.length,1);f.h.check();
});
test('C12 partial future target elapsed never mutates or claims nothing happened',async()=>{
 const f=fixture({failEvent:'oct11'});await f.h.resolve();const resumed=durableRestart(f,{now:at('16:00')});const r=await resumed.h.resolve();assert.equal(r.ok,false);assert.equal(r.effect,'coordinated_move_elapsed');assert.equal(resumed.h.effects.executes.length,0);assert.equal(r.outcomes.filter(o=>o.success).length,1);resumed.h.check();
});
test('C13 full coordinated override is preserved only when explicitly stored',async()=>{
 const f=fixture({args:{...plan(),relaxed:true}});const r=await f.h.resolve();assert.equal(r.ok,true);assert.equal(f.h.effects.executes[0].args.relaxed,true);f.h.check();
});
test('C14 pair amendment cannot silently apply a singular counter',()=>{
 const f=fixture();assert.throws(()=>f.h.amend(plan(),{new_start:at('16:00')}),/complete/);
 const changed=plan();changed.coordinated_moves[1].new_start=at('15:00');changed.coordinated_moves[1].new_end=at('15:40');
 assert.deepEqual(JSON.parse(JSON.stringify(f.h.amend(plan(),changed).args)),changed);f.h.check();
});
test('C15 owner preview represents both full intervals without internal IDs',async()=>{
 const f=fixture();const text=await f.h.ask();assert.ok(text.includes('13:30')&&text.includes('14:10')&&text.includes('14:15')&&text.includes('14:55'));assert.ok(!text.includes('oct11'));f.h.check();
});
test('C16 creation freezes both complete intervals before persisting owner ask',async()=>{
 const f=fixture();const args=plan();for(const m of args.coordinated_moves)delete m.new_end;
 const r=await f.h.create({rule:'attendee_conflict',subject:'Agreed pair',deferred_action:{tool:'move_meeting',args}});
 assert.ok(!r.error,JSON.stringify(r));assert.ok(JSON.parse(f.h.row().details_json).deferred_action.args.coordinated_moves.every(m=>m.new_end));f.h.check();
});
test('C17 source unavailable keeps pending request without a mutation',async()=>{
 const f=fixture({sourceUnavailable:true});const r=await f.h.resolve();assert.equal(r.ok,false);assert.equal(f.h.row().state,'awaiting_owner');assert.equal(f.h.effects.executes.length,0);f.h.check();
});
test('C18 ambiguous DST fold remains pending for clarification',async()=>{
 const f=fixture({args:{stated_zone:'America/New_York',coordinated_moves:[{meeting_id:'oct11',new_start:'2026-11-01T01:30:00'},{meeting_id:'sep2',new_start:'2026-11-01T03:00:00'}]}});
 const r=await f.h.resolve();assert.equal(r.ok,false);assert.ok(r.time_clarification,JSON.stringify(r));assert.equal(f.h.row().state,'awaiting_owner');assert.equal(f.h.effects.executes.length,0);f.h.check();
});
test('C19 failed terminal delivery survives restart without repeated move',async()=>{
 const f=fixture({delivery:'failed'});const r=await f.h.resolve();assert.equal(r.ok,true);assert.equal(r.requester_notify_outcome,'failed');
 const resumed=durableRestart(f);resumed.h.update(resumed.h.row().id,{nextCheckAt:'2020-01-01T00:00:00Z'});await resumed.h.sweep();
 assert.equal(resumed.h.effects.executes.length,0);assert.equal(resumed.p.h.state.writes.length,0);assert.equal(resumed.h.effects.sends.length,1);assert.equal(resumed.h.effects.sends[0].body,f.h.effects.sends[0].body);resumed.h.check();
});
test('C20 colleague acceptance gets safe terminal result without pair calendar details',async()=>{
 const f=fixture({row:{state:'awaiting_colleague'}});const r=await f.h.resolve({verdict:'approve'},{resolvedByColleague:true,resolvingUserId:'COLLEAGUE'});
 assert.equal(r.ok,true);assert.equal(r.outcomes,undefined);assert.equal(f.h.effects.sends.length,1);f.h.check();
});
test('C21 lost write response observes desired pair state without second PATCH',async()=>{
 const f=fixture({patchAcceptedResponseLost:true});const r=await f.h.resolve();assert.equal(r.ok,true);assert.equal(f.p.h.state.writes.length,2);assert.ok(r.outcomes.every(o=>o._write_response_lost));f.h.check();
});
test('C22 partial write then unavailable readback closes with per-event evidence and no retry',async()=>{
 let f;f=fixture({failEvent:'oct11',verification:p=>f?.p.h.state.writes.length&&p.args.meeting_id==='oct11'?{status:'unavailable',reason:'calendar_read_failed'}:undefined});
 const r=await f.h.resolve();assert.equal(r.ok,false);assert.equal(r.state,'resolved');assert.equal(r.outcomes.find(o=>o.meeting_id==='sep2').success,true);
 assert.equal(r.outcomes.find(o=>o.meeting_id==='oct11')._calendar_verification,'unavailable');assert.deepEqual(f.p.h.state.writes.map(w=>w.meetingId),['sep2']);assert.equal(f.h.effects.sends.length,1);assert.equal(f.h.row().next_check_handler,null);
 const resumed=durableRestart(f);await resumed.h.resolve();assert.equal(resumed.h.effects.executes.length,0);assert.equal(resumed.h.effects.sends.length,0);f.h.check();resumed.h.check();
});

test('C23 remaining-only restart supplies exact current subject to real singular guard without exposing internal subject',async()=>{
 const f=fixture({failEvent:'oct11'});await f.h.resolve();
 f.p.h.events.find(e=>e.id==='oct11').sensitivity='private';
 const resumed=durableRestart(f,{room:true,row:{...f.h.row(),origin_channel:'CROOM',origin_is_mpim:1}});
 const r=await resumed.h.resolve();assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(resumed.h.effects.executes[0].args.meeting_subject,'First');
 assert.deepEqual(resumed.p.h.state.writes.map(w=>w.meetingId),['oct11']);
 assert.doesNotMatch(JSON.stringify(r),/meeting_subject/);assert.doesNotMatch(JSON.stringify(r.outcomes),/First|Second/);
 assert.doesNotMatch(resumed.h.effects.sends[0].body,/First|Second/);
 assert.ok(JSON.parse(resumed.h.row().details_json).deferred_action.args.coordinated_moves.every(m=>!('meeting_subject' in m)));
 resumed.h.check();
});
for(const [label,options] of [
 ['wrong identity',{remainingSource:{id:'other-event'}}],['missing identity',{remainingSource:{id:undefined}}],
 ['unavailable',{remainingSourceUnavailable:true}],['missing subject',{remainingSource:{subject:undefined}}],
 ['blank subject',{remainingSource:{subject:'  '}}],['series master',{remainingSource:{type:'seriesMaster'}}],
])test('C24 remaining-only '+label+' cannot dispatch or claim a write',async()=>{
 const f=fixture({failEvent:'oct11'});await f.h.resolve();const resumed=durableRestart(f,options);const r=await resumed.h.resolve();
 assert.equal(r.ok,false);assert.equal(resumed.h.effects.executes.length,0);assert.equal(resumed.p.h.state.writes.length,0);
 assert.equal(r.state,'resolved');assert.equal(r.outcomes.find(o=>o.meeting_id==='oct11')._calendar_verification,'unavailable');
 assert.equal(r.outcomes.find(o=>o.meeting_id==='sep2').success,true);assert.doesNotMatch(JSON.stringify(r),/meeting_subject|other-event/);
 assert.match(resumed.h.effects.owner[0],/outcome unconfirmed/);assert.equal(resumed.h.effects.sends.length,1);resumed.h.check();
});
