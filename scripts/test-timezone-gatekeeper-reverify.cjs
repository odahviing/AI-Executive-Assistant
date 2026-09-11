// F3 consumer proof: actual output-floor branch -> real checkSlot/workHours -> real
// hard-block ledger. Only calendar/model/irrelevant rule inputs are fixtures.
// Optional historical mode swaps the two pre-repair scheduling dependencies only.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict'),{test}=require('node:test');
const luxon=require('luxon'),{DateTime,Settings}=luxon,root=path.resolve(__dirname,'..');
const beforeRoot=process.env.TZ_GATEKEEPER_REVERIFY_BEFORE_ROOT;
const captured=new Set(['src/utils/scheduleRules.ts','src/utils/workHours.ts']);
Settings.now=()=>Date.parse('2026-09-11T00:00:00Z');
class Clock extends Date{constructor(...a){super(...(a.length?a:[Settings.now()]));}static now(){return Settings.now();}}
const read=f=>fs.readFileSync(path.join(beforeRoot&&captured.has(f)?beforeRoot:root,f),'utf8');
const gateFile='src/utils/guards/runOutputGates.ts',tree=ts.createSourceFile(gateFile,read(gateFile),ts.ScriptTarget.Latest,true);
const selected=['calendarMutationCompleted','runAvailabilityFloorAndMaybeRewrite'].map(name=>{
 const nodes=tree.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.equal(nodes.length,1,'unique actual '+name);return nodes[0].getText(tree);
});
const gateSource=selected.join('\n')+'\nexports.run=runAvailabilityFloorAndMaybeRewrite;';
const actual=new Set(['src/utils/scheduleRules.ts','src/utils/workHours.ts','src/utils/availabilityGate.ts','src/utils/timezoneConvert.ts','src/utils/dateTimeExtract.ts']);
const sourceCache=new Map(),noop=()=>{},start='2026-09-14T23:45:00+03:00';
function harness(opts={}){
 const profile={user:{name:'Owner Example',email:'owner@example.test',slack_user_id:'UOWNER',timezone:'Asia/Jerusalem'},schedule:{work_hours:Object.fromEntries(['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map(d=>[d,['09:00-23:59']])),office_days:{days:['Monday','Tuesday']},home_days:{days:[]}},meetings:{buffer_minutes:0,allowed_durations:[10,25,50],categories:[]}};
 const rows={'2026-09-14':{timezone:'America/New_York',windows:['09:00-23:59'],isWorkday:true},'2026-09-15':{isWorkday:false},...opts.rows};
 const calls={calendar:[],checks:[],detect:[],rewrite:[],warnings:[]},modules=new Map();
 const logger={info:noop,warn:(...a)=>calls.warnings.push(a),debug:noop,error:noop};
 const mocks={
  'src/db/scheduleOverrides.ts':{getScheduleOverride:(_,d)=>rows[d]??null},
  'src/db.ts':{getPersonMemory:()=>({timezone:'Asia/Jerusalem'})},
  'src/utils/logger.ts':{__esModule:true,default:logger},
  'src/utils/categoryRules.ts':{checkCategorySlot:()=>({allowed:true}),getProfileCategoryByName:()=>null},
  'src/utils/displaySubject.ts':{displaySubject:()=> 'private',PRIVATE_MASK:'private'},
  'src/utils/floatingBlocks.ts':{getFloatingBlocks:()=>[],blockAppliesOnDay:()=>false,isFloatingBlockEvent:()=>false},
  'src/llm/client.ts':{getAnthropicClient:()=>{throw Error('No model calls allowed in deterministic fixture');}},
  'src/llm/models.ts':{},'src/utils/usageLog.ts':{logLlmUsage:noop},
  'src/connectors/graph/calendar.ts':{getOwnerEventsForDecision:async(...a)=>{calls.calendar.push(a);if(opts.offline)throw Error('fixture calendar offline');return opts.events??[];}},
 };
 function load(f){
  if(mocks[f])return mocks[f];if(modules.has(f))return modules.get(f).exports;if(!actual.has(f))throw Error('Unexpected module '+f);
  const mod={exports:{}};modules.set(f,mod);
  if(!sourceCache.has(f))sourceCache.set(f,ts.transpileModule(read(f),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText);
  const req=s=>s==='luxon'?luxon:s.startsWith('.')?load(path.posix.normalize(path.posix.join(path.posix.dirname(f),s))+'.ts'):(()=>{throw Error('Unexpected external '+s);})();
  vm.runInNewContext('(function(require,module,exports){'+sourceCache.get(f)+'\n})',{Date:Clock,console,Set,Map,Buffer,setTimeout,clearTimeout},{filename:f})(req,mod,mod.exports);return mod.exports;
 }
 const ledger=load('src/utils/availabilityGate.ts'),rules=load('src/utils/scheduleRules.ts');
 const gateModule={exports:{}},gateJs=ts.transpileModule(gateSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const req=s=>{
  if(s==='../availabilityGate')return {...ledger,detectAffirmedBlockedSlots:async(_draft,blocks)=>{calls.detect.push(blocks);return opts.notAffirmed?[]:blocks;},rewriteBlockedSlotClaim:async a=>{calls.rewrite.push(a);return opts.rewrite??null;}};
  if(s==='../scheduleRules')return {...rules,checkSlot:a=>{const result=rules.checkSlot(a);calls.checks.push({args:a,result});return result;}};
  return load(path.posix.normalize(path.posix.join('src/utils/guards',s))+'.ts');
 };
 vm.runInNewContext(gateJs,{exports:gateModule.exports,module:gateModule,require:req,Date:Clock,logger,formatForSlack:x=>x});
 const instant=opts.start??start;
 if(!opts.empty)ledger.recordHardBlockedSlot({ownerEmail:profile.user.email,ownerFirst:'Owner',instantIso:instant,durationMin:opts.duration??25,display:'Monday 14 Sep at 23:45',kind:'vacation_or_off_day'});
 return {profile,rows,calls,ledger,run:async()=>{
  const out=await gateModule.exports.run({profile,result:opts.result??{},senderId:opts.owner?'UOWNER':'UCOLLEAGUE',role:opts.owner?'owner':'colleague',channelId:opts.room?'CROOM':'DCOLLEAGUE',threadTs:'1.2'},'The proposed time is available.');
  assert.ok(!calls.warnings.some(a=>/Unexpected|not a function|undefined|No model/.test(JSON.stringify(a))),'fixture dependencies must load, not fail open');
  return out;
 }};
}
test('F3 midnight blackout remains established through real reverify when rewrite vetoes',async()=>{
 const h=harness();await h.run();assert.equal(h.calls.checks.length,1);assert.equal(h.calls.checks[0].result.violation_kind,'vacation_or_off_day');assert.equal(h.calls.rewrite.length,1);assert.equal(h.ledger.freshHardBlockedSlots(h.profile.user.email).length,1);
 assert.equal(h.calls.checks[0].args.slotEndIso,'2026-09-14T21:10:00.000Z');assert.equal(h.calls.checks[0].args.viewer,'other');assert.equal(h.calls.checks[0].args.leadTimeHours,4);
});
test('legitimate fully authorized trip interval clears stale hard block without rewrite',async()=>{
 const h=harness({start:'2026-09-14T23:00:00+03:00'});assert.equal(await h.run(),'The proposed time is available.');assert.equal(h.calls.checks[0].result.passes,true);assert.equal(h.calls.rewrite.length,0);assert.equal(h.ledger.freshHardBlockedSlots(h.profile.user.email).length,0);
});
test('stored ten-minute interval ending before midnight clears despite longer crossing sibling',async()=>{
 const h=harness({duration:10});await h.run();assert.equal(h.calls.checks[0].result.passes,true);assert.equal(h.calls.checks[0].args.slotEndIso,'2026-09-14T20:55:00.000Z');assert.equal(h.ledger.freshHardBlockedSlots(h.profile.user.email).length,0);
});
test('stored fifty-minute interval checks whole duration across blackout',async()=>{
 const h=harness({start:'2026-09-14T23:20:00+03:00',duration:50});await h.run();assert.equal(h.calls.checks[0].result.violation_kind,'vacation_or_off_day');assert.equal(h.calls.checks[0].args.slotEndIso,'2026-09-14T21:10:00.000Z');assert.equal(h.ledger.freshHardBlockedSlots(h.profile.user.email).length,1);
});
test('successful correction clears only after still-blocked slot reaches rewriter',async()=>{
 const h=harness({rewrite:'That time is unavailable.'});assert.equal(await h.run(),'That time is unavailable.');assert.equal(h.calls.rewrite.length,1);assert.equal(h.ledger.freshHardBlockedSlots(h.profile.user.email).length,0);
});
test('calendar outage retains established block without pretending checkSlot ran',async()=>{
 const h=harness({offline:true});await h.run();assert.equal(h.calls.checks.length,0);assert.equal(h.calls.rewrite.length,1);assert.equal(h.ledger.freshHardBlockedSlots(h.profile.user.email).length,1);
});
test('fresh authorized row on next recheck clears formerly blocked interval',async()=>{
 const h=harness();await h.run();assert.equal(h.ledger.freshHardBlockedSlots(h.profile.user.email).length,1);h.rows['2026-09-15']={isWorkday:true,windows:['00:00-01:00']};await h.run();assert.equal(h.calls.checks.at(-1).result.passes,true);assert.equal(h.calls.rewrite.length,1);assert.equal(h.ledger.freshHardBlockedSlots(h.profile.user.email).length,0);
});
test('completed calendar mutation clears ledger before calendar or classifier',async()=>{
 const h=harness({result:{bookingOccurred:true}});await h.run();assert.equal(h.calls.calendar.length+h.calls.detect.length,0);assert.equal(h.ledger.freshHardBlockedSlots(h.profile.user.email).length,0);
});
test('unaffirmed and empty ledgers do not invoke reverify or correction',async()=>{
 for(const opts of [{notAffirmed:true},{empty:true}]){const h=harness(opts);await h.run();assert.equal(h.calls.calendar.length+h.calls.checks.length+h.calls.rewrite.length,0);}
});
test('owner room gets same hard interval truth with no privilege relaxation',async()=>{
 const h=harness({owner:true,room:true});await h.run();assert.equal(h.calls.checks[0].result.violation_kind,'vacation_or_off_day');assert.equal(h.calls.checks[0].args.allowRelaxed,undefined);assert.equal(h.calls.checks[0].args.viewer,'other');assert.equal(h.ledger.freshHardBlockedSlots(h.profile.user.email).length,1);
});
