// Actual callback producer/merge/owner preview/resolver/replay and the exact create/move
// normalization branch. Calendar effects are isolated; no production or model calls.
// TZ_APPROVAL_BEFORE_ROOT selects preserved pre-repair callbacks/resolver only.
const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const luxon=require('luxon'),{DateTime,Settings}=luxon;
const root=path.resolve(__dirname,'..'),beforeRoot=process.env.TZ_APPROVAL_BEFORE_ROOT;
Settings.now=()=>Date.parse('2026-09-11T00:00:00Z');
const captured=new Set(['src/core/approvals/approvalCallbacks.ts','src/core/requests/resolver.ts']);
const actual=new Set([...captured,'src/core/requests/deferredActionReplay.ts','src/core/requests/types.ts','src/utils/weTimeResolver.ts','src/utils/timezoneConvert.ts','src/utils/workHours.ts','src/utils/workingElsewhere.ts','src/utils/textScrubber.ts']);
const read=f=>fs.readFileSync(path.join(beforeRoot&&captured.has(f)?beforeRoot:root,f),'utf8');
const clone=x=>JSON.parse(JSON.stringify(x)),noop=()=>{};
function harness(tool,counter,opts={}){
 const moving=tool==='move_meeting',startKey=moving?'new_start':'start',endKey=moving?'new_end':'end';
 const profile={user:{name:'Owner Example',email:'owner@example.test',slack_user_id:'UOWNER',timezone:'Asia/Jerusalem'},assistant:{name:'Maelle'},schedule:{work_hours:{Monday:['09:00-23:59'],Tuesday:['09:00-18:00']},office_days:{days:['Monday','Tuesday']},home_days:{days:[]}},meetings:{buffer_minutes:0}};
 const overrides={'2026-09-14':{timezone:'America/New_York',windows:['09:00-23:59'],isWorkday:true}};
 const original={tool,args:{subject:'Sync',meeting_subject:'Sync',meeting_id:'event-1',[startKey]:'2026-09-14T16:00:00+03:00',[endKey]:'2026-09-14T16:25:00+03:00',...opts.original}};
 const details=opts.callbacks?{callbacks:{on_approve:original},counter,amended_by:'owner'}:{deferred_action:original,counter,amended_by:'owner'};
 if(opts.runWith)details.callbacks={...(details.callbacks||{}),on_amend:{mode:'run_with_amend'}};
 if(opts.noCounter)delete details.counter;
 let row={id:'req_test',kind:'approval',subkind:'policy_exception',state:'awaiting_owner',owner_user_id:'UOWNER',origin_channel:'DOWNER',origin_thread_ts:'owner.1',owner_dm_channel:'DOWNER',owner_dm_thread_ts:'owner.1',subject:'Sync',details_json:JSON.stringify(details)};
 const executes=[],errors=[],notices=[],modules=new Map();
 if(opts.colleague)Object.assign(row,{state:'awaiting_colleague',requester_slack_id:'UCOLLEAGUE'});
 const logger={info:noop,warn:(...v)=>errors.push(v),error:(...v)=>errors.push(v),debug:noop};
 const update=(_id,data)=>{row={...row,...data,...(data.details?{details_json:JSON.stringify(data.details)}:{})};};
 const mocks={
 'src/db/requests.ts':{getRequest:()=>row,updateRequest:update},
 'src/db/scheduleOverrides.ts':{getScheduleOverride:(_id,date)=>overrides[date]??null,listScheduleOverrides:()=>Object.entries(overrides).map(([date,data])=>({date,...data}))},
 'src/utils/logger.ts':{__esModule:true,default:logger},
 'src/core/requests/closeRequest.ts':{closeRequest:p=>{row.state=p.state;}},
 'src/core/requests/logActivity.ts':{logActivity:noop},
 'src/db/conversations.ts':{appendToConversation:noop},
 'src/core/requests/requesterRelay.ts':{usableRelaySubject:x=>x,requesterRelayLanguage:()=> 'en'},
 'src/utils/attendeeAvailability.ts':{loadAttendeeAvailabilityForEmails:emails=>emails.map(email=>({email,timezone:opts.personTimezone??'Asia/Shanghai'})),attendeeKnownTimezoneForDay:entry=>entry.timezone},'src/llm/models.ts':{},
 'src/connections/registry.ts':{getConnection:()=>({sendDirect:async()=>({ok:true}),postToChannel:async()=>({ok:true})})},
 'src/skills/registry.ts':{executeApprovedSkillTool:async(kind,args,context)=>{
  assert.equal(context.authority,'owner');assert.equal(context.userId,'UOWNER');
  const normalized=await executionNormalization(kind,args,context);
  if(normalized?.error)return {status:'failed',result:normalized};
  executes.push({tool:kind,args:clone(args)});
  return {status:'completed',result:{success:true,meetingId:'event-1',booked_start:normalized[startKey],booked_end:normalized[endKey]}};
 }},
 'src/utils/shadowNotify.ts':{shadowNotify:async()=>{}},
 'src/utils/ownerDailyThread.ts':{postOwnerDecision:async input=>{notices.push(input.text);return {ok:true};}},
 };
 function load(f){if(mocks[f])return mocks[f];if(modules.has(f))return modules.get(f).exports;if(!actual.has(f))throw Error('Unexpected module '+f);
  const module={exports:{}};modules.set(f,module);
  const js=ts.transpileModule(read(f),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const req=s=>s==='luxon'?luxon:s.startsWith('.')?load(path.posix.normalize(path.posix.join(path.posix.dirname(f),s))+'.ts'):s.startsWith('node:')?require(s):(()=>{throw Error('Unexpected external '+s);})();
  vm.runInNewContext('(function(require,module,exports){'+js+'\n})',{Date,console,Set,Map,Buffer,setTimeout,setImmediate},{filename:f})(req,module,module.exports);return module.exports;
 }
 async function executionNormalization(kind,args,context){
  const file=`src/skills/meetings/ops/handlers/${kind==='create_meeting'?'createMeeting':'moveMeeting'}.ts`;
  const tree=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true),marker=kind==='create_meeting'?'tripDisplay':'moveTripDisplay';const found=[];
  function walk(n){if(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText()===marker))found.push(n);ts.forEachChild(n,walk);}walk(tree);assert.equal(found.length,1,'exact actual handler normalization marker');
  const decl=found[0],list=decl.parent.statements,branch=list[list.indexOf(decl)+1];assert(ts.isIfStatement(branch));assert.match(branch.getText(),/resolveStatedInstant/);
  const source=`export async function run(){${decl.getText()}\n${branch.getText()}\nreturn args;}`;
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const module={exports:{}};
  vm.runInNewContext(js,{module,exports:module.exports,args,context,timezone:profile.user.timezone,logger,...load('src/utils/weTimeResolver.ts'),require:s=>{assert.equal(s,'../../../../utils/workingElsewhere');return load('src/utils/workingElsewhere.ts');}});
  return module.exports.run();
 }
 return {profile,startKey,endKey,original,executes,errors,notices,load,row:()=>row,
  preview:()=>load('src/core/approvals/approvalCallbacks.ts').composeOwnerAskText({askText:'Please review Sync.',details:JSON.parse(row.details_json),profile,requestId:row.id}),
  resolve:(verdict)=>load('src/core/requests/resolver.ts').resolveRequest(row.id,verdict??(opts.runWith?{verdict:'amend',counter}:{verdict:'approve'}),{profile,...(opts.colleague?{resolvedByColleague:true,resolvingUserId:'UCOLLEAGUE'}:{})}),
 };
}
const scenarios=[
 {name:'explicit home source wins over start_timezone',counter:{start:'2026-09-14T17:15:00',end:'2026-09-14T17:40:00',stated_zone:'home',start_timezone:'America/Chicago'},utc:'2026-09-14T14:15:00.000Z',minutes:25},
 {name:'explicit IANA alias source applies to full interval',counter:{start:'2026-09-14T17:15:00',end:'2026-09-14T17:40:00',start_timezone:'America/Chicago'},utc:'2026-09-14T22:15:00.000Z',minutes:25},
 {name:'blank stated source falls back to IANA alias',counter:{start:'2026-09-14T17:15:00',end:'2026-09-14T17:40:00',stated_zone:' ',start_timezone:' America/Chicago '},utc:'2026-09-14T22:15:00.000Z',minutes:25},
 {name:'bare trip start alone preserves original elapsed duration',counter:{start:'2026-09-14T17:15:00'},utc:'2026-09-14T21:15:00.000Z',minutes:25},
 {name:'local start plus explicit duration forms coherent interval',counter:{start:'2026-09-14T17:15:00',duration_minutes:45,stated_zone:'local'},utc:'2026-09-14T21:15:00.000Z',minutes:45},
 {name:'explicit amended end remains authoritative',counter:{start:'2026-09-14T17:15:00',end:'2026-09-14T18:10:00',stated_zone:'local'},utc:'2026-09-14T21:15:00.000Z',minutes:55},
 {name:'duration-only amendment preserves explicit original instant',counter:{duration_minutes:45},utc:'2026-09-14T13:00:00.000Z',minutes:45},
 {name:'explicit offset counter survives competing local source unchanged',counter:{start:'2026-09-14T17:15:00+03:00',stated_zone:'local'},utc:'2026-09-14T14:15:00.000Z',minutes:25,exactStart:'2026-09-14T17:15:00+03:00'},
 {name:'explicit offset end and start remain literal',counter:{start:'2026-09-14T17:15:00-04:00',end:'2026-09-14T17:50:00-04:00',stated_zone:'home'},utc:'2026-09-14T21:15:00.000Z',minutes:35,exactStart:'2026-09-14T17:15:00-04:00',exactEnd:'2026-09-14T17:50:00-04:00'},
 {name:'owner run_with_amend shortcut resolves complete trip interval',counter:{start:'2026-09-14T17:15:00',duration_minutes:35},utc:'2026-09-14T21:15:00.000Z',minutes:35,runWith:true},
 {name:'uncountered stored callback preview respects named home source',counter:{start:'2026-09-14T17:15:00',end:'2026-09-14T17:40:00',stated_zone:'home'},utc:'2026-09-14T14:15:00.000Z',minutes:25,noCounter:true},
];
for(const tool of ['create_meeting','move_meeting'])for(const s of scenarios)test(tool+' '+s.name,async()=>{
 const moving=tool==='move_meeting',counter={...s.counter};if(moving){if(counter.start){counter.new_start=counter.start;delete counter.start;}if(counter.end){counter.new_end=counter.end;delete counter.end;}}
 const h=harness(tool,counter,{callbacks:moving,runWith:s.runWith,noCounter:s.noCounter,original:s.noCounter?counter:undefined}),preview=await h.preview(),result=await h.resolve();
 assert.equal(result.ok,true,JSON.stringify({result,errors:h.errors}));assert.equal(h.executes.length,1);const executed=h.executes[0].args,start=executed[h.startKey],end=executed[h.endKey];
 assert.equal(DateTime.fromISO(start).toUTC().toISO(),s.utc);
 assert.equal(DateTime.fromISO(end).diff(DateTime.fromISO(start),'minutes').minutes,s.minutes);
 if(s.exactStart)assert.equal(start,s.exactStart);if(s.exactEnd)assert.equal(end,s.exactEnd);
 const travel=h.load('src/utils/workingElsewhere.ts').getTravelContextForInstant(start,h.profile);
 const rendered=h.load('src/utils/weTimeResolver.ts').renderWeDualClock(start,travel,h.profile.user.timezone,{endIso:end});
 assert(preview.includes(rendered),JSON.stringify({preview,rendered,start,end}));
 assert.equal(h.row().state,'resolved');
});

for(const tool of ['create_meeting','move_meeting']) {
 const moving=tool==='move_meeting',sk=moving?'new_start':'start',ek=moving?'new_end':'end';
 for(const c of [
  {name:'fold callback',start:'2026-11-01T01:30:00',end:'2026-11-01T01:55:00',zone:'America/New_York',noCounter:true},
  {name:'gap counter merge',start:'2026-03-08T02:30:00',zone:'America/New_York'},
  {name:'ambiguous abbreviation callback',start:'2026-09-14T10:00:00',end:'2026-09-14T10:25:00',zone:'CST',noCounter:true},
  {name:'gap explicit counter end',start:'2026-03-08T01:30:00',end:'2026-03-08T02:15:00',zone:'America/New_York'},
 ])test(tool+' clarification '+c.name,async()=>{
  const counter={[sk]:c.start,...(c.end?{[ek]:c.end}:{}),stated_zone:c.zone};
  const h=harness(tool,counter,{noCounter:c.noCounter,original:c.noCounter?counter:undefined}),preview=await h.preview();
  assert.match(preview,/Before this can run:/);assert.doesNotMatch(preview,/If yes → I'll (book|move)/);
  const r=await h.resolve();assert.equal(r.ok,false);assert.equal(r.effect,'approve_needs_time_clarification');assert.equal(r.time_clarification.error,'stated_time_clarification');assert.match(r.reason,/No action was executed/);assert.equal(h.executes.length,0);assert.equal(h.row().state,'awaiting_owner');
 });
 test(tool+' clarified explicit interval can replace ambiguous stored interval',async()=>{
  const h=harness(tool,{[sk]:'2026-11-01T01:30:00-05:00',[ek]:'2026-11-01T01:55:00-05:00'},{original:{[sk]:'2026-11-01T01:30:00',[ek]:'2026-11-01T01:55:00',stated_zone:'America/New_York'}});
  const r=await h.resolve();assert.equal(r.ok,true);assert.equal(h.executes.length,1);assert.equal(h.executes[0].args[sk],'2026-11-01T01:30:00-05:00');assert.equal(h.row().state,'resolved');
 });
 test(tool+' known participant abbreviation matches callback preview and execution',async()=>{
  const args={[sk]:'2026-09-14T10:00:00',[ek]:'2026-09-14T10:25:00',stated_zone:'CST',attendees:[{email:'colleague@example.test'}]};
  const h=harness(tool,{}, {noCounter:true,original:args}),preview=await h.preview(),r=await h.resolve();
  assert.equal(r.ok,true);assert.equal(h.executes.length,1);assert.equal(DateTime.fromISO(h.executes[0].args[sk]).toUTC().toISO(),'2026-09-14T02:00:00.000Z');assert.doesNotMatch(preview,/Before this can run:/);
 });
}

test('colleague accepts ambiguous stored clock: pending owner clarification, no replay or private choices',async()=>{const h=harness('create_meeting',{}, {colleague:true,noCounter:true,original:{start:'2026-11-01T01:30:00',end:'2026-11-01T01:55:00',stated_zone:'America/New_York'}});const r=await h.resolve();assert.equal(r.ok,false);assert.equal(r.effect,'approve_needs_time_clarification');assert.equal(h.row().state,'awaiting_owner');assert.equal(r.time_clarification,undefined);assert.equal(h.executes.length,0);assert.doesNotMatch(r.reason,/unconfirmed|retry/);});
test('owner counter relay does not offer unresolved bare end to requester',async()=>{const h=harness('create_meeting',{});const r=await h.resolve({verdict:'amend',counter:{start:'2026-03-08T01:30:00',end:'2026-03-08T02:15:00',stated_zone:'America/New_York'}});assert.equal(r.ok,false);assert.equal(r.effect,'approve_needs_time_clarification');assert.equal(h.row().state,'awaiting_owner');assert.equal(h.executes.length,0);});

test('colleague ambiguous counter history stays raw while owner sees clarification',async()=>{const h=harness('create_meeting',{}, {colleague:true,noCounter:true});const r=await h.resolve({verdict:'amend',counter:{start:'2026-03-08T02:30:00',end:'2026-03-08T03:00:00',stated_zone:'America/New_York'}});assert.equal(r.ok,true);assert.equal(h.row().state,'awaiting_owner');assert.equal(h.executes.length,0);assert.match(h.notices[0],/2026-03-08T02:30:00/);assert.match(h.notices[0],/Before this can run:/);assert.doesNotMatch(h.notices[0],/If yes → I'll book/);});
