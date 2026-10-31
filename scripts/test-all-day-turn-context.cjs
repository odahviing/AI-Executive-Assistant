// Execute the actual owner free-time precheck branch against the real analyzer.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const {DateTime,Settings}=require('luxon');
const {harness}=require('./test-timezone-owner-interval.cjs');
const root=path.resolve(__dirname,'..'),before=process.argv.includes('--before');
const file=before?'artifacts/workshop-verification/batch-20261029/handyman/vacation-context/before/buildTurnContext.ts':'src/core/orchestrator/buildTurnContext.ts';
const ast=ts.createSourceFile(file,fs.readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true),blocks=[];
function visit(n){if(ts.isIfStatement(n)&&n.expression.getText(ast)==='isFreeTimeInquiry && isOwnerPath')blocks.push(n);ts.forEachChild(n,visit);}visit(ast);assert.equal(blocks.length,1);
const branch=ts.transpileModule(`(async()=>{let freeTimePrecheckBlock='';${blocks[0].getText(ast)};return freeTimePrecheckBlock;})()`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const zone='Asia/Jerusalem',day='2026-10-22';
const base={id:'block',subject:'PRIVATE SUBJECT',showAs:'busy',isAllDay:true,isCancelled:false,sensitivity:'normal',categories:[],start:{dateTime:day+'T00:00:00',timeZone:zone},end:{dateTime:'2026-10-23T00:00:00',timeZone:zone},attendees:[]};
async function run(events,options={}){
 const h=harness({}, {realAvailability:true,extraMocks:{'src/utils/displaySubject.ts':{displaySubject:e=>e.subject,isEventPrivate:()=>false}}});h.profile.categories=[];
 const analysis=h.load('src/skills/meetings/ops/analysis.ts');let reads=0;
 const out=await vm.runInNewContext(branch,{isFreeTimeInquiry:options.inquiry!==false,isOwnerPath:options.owner!==false,profile:h.profile,logger:{warn(){}},require:n=>{
  if(n==='luxon')return {DateTime};if(n==='../../skills/meetings/ops')return analysis;
  if(n==='../../connectors/graph/calendar')return {getCalendarEvents:async()=>{reads++;if(options.unavailable)throw Error('offline');return events;}};
  throw Error('unexpected dependency '+n);
 }});return {out,reads};
}
const cases=[];function test(id,fn){cases.push({id,fn});}
test('busy-full-day-is-commitment',async()=>{const {out}=await run([base]);assert.match(out,/all-day commitment/);assert.doesNotMatch(out,/0m free|flagged as BUSY|vacation|out of office/);});
test('tentative-full-day-is-commitment',async()=>assert.match((await run([{...base,showAs:'tentative'}])).out,/all-day commitment/));
test('busy-preserves-real-meeting-count',async()=>{const meeting={...base,id:'meeting',isAllDay:false,start:{dateTime:day+'T11:00:00',timeZone:zone},end:{dateTime:day+'T11:40:00',timeZone:zone},attendees:[{emailAddress:{address:'peer@example.test',name:'Peer'}}]};const {out}=await run([base,meeting]);assert.match(out,/all-day commitment/);assert.match(out,/1 meeting is still booked on it \(40m\)/);});
test('oof-retains-distinct-meaning',async()=>{const {out}=await run([{...base,showAs:'oof'}]);assert.match(out,/out of office all day/);assert.doesNotMatch(out,/all-day commitment/);});
test('ordinary-day-keeps-free-time',async()=>{const {out}=await run([]);assert.match(out,/free during work hours/);assert.doesNotMatch(out,/all-day commitment/);});
test('nonoccupying-markers-keep-free-time',async()=>{for(const event of [{...base,showAs:'free'},{...base,isCancelled:true}])assert.match((await run([event])).out,/free during work hours/);});
test('colleague-room-path-does-not-read-owner-calendar',async()=>{const r=await run([base],{owner:false});assert.equal(r.reads,0);assert.equal(r.out,'');});
test('not-a-free-time-question-no-read',async()=>{const r=await run([base],{inquiry:false});assert.equal(r.reads,0);assert.equal(r.out,'');});
test('unavailable-calendar-no-invented-health',async()=>assert.equal((await run([],{unavailable:true})).out,''));
(async()=>{Settings.now=()=>Date.parse(day+'T06:00:00Z');const results=[];for(const c of cases){try{await c.fn();results.push({id:c.id,status:'pass'});}catch(e){results.push({id:c.id,status:'fail',error:e.message});}}Settings.now=()=>Date.now();const report={phase:before?'before':'after',passed:results.filter(c=>c.status==='pass').length,failed:results.filter(c=>c.status==='fail').length,cases:results};console.log(JSON.stringify(report,null,2));process.exitCode=report.failed?1:0;})();
