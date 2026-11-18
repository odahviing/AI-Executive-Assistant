// Actual producer branch -> actual availability loader -> actual precheck.
// Database/calendar/model/slot validator are isolated I/O fixtures; no network.
// Retains the 29 original controls; owner-decision cases add exact-instant and clarification coverage.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
const {DateTime,Settings,IANAZone}=require('luxon');
const root=path.resolve(__dirname,'..');
Settings.now=()=>Date.parse('2026-09-11T12:00:00Z');
const beforeRoot=process.env.TZ_GATEKEEPER_DECISIONS_BEFORE_ROOT;
const producerBeforeRoot=process.env.TZ_GATEKEEPER_PRODUCER_BEFORE_ROOT;
const captured=new Set(['src/utils/availabilityPreCheck.ts','src/core/orchestrator/buildTurnContext.ts']);
const contextBeforeRoot=process.env.TZ_CONTEXT_BEFORE_ROOT;
const cache=new Map(),source=rel=>fs.readFileSync(path.join(contextBeforeRoot&&fs.existsSync(path.join(contextBeforeRoot,rel))?contextBeforeRoot:beforeRoot&&captured.has(rel)?beforeRoot:producerBeforeRoot&&rel==='src/core/orchestrator/buildTurnContext.ts'?producerBeforeRoot:root,rel),'utf8');
function compile(rel){if(!cache.has(rel))cache.set(rel,ts.transpileModule(source(rel),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);return cache.get(rel);}
const producerFile='src/core/orchestrator/buildTurnContext.ts',ast=ts.createSourceFile(producerFile,source(producerFile),ts.ScriptTarget.Latest,true),blocks=[];
function visit(n){if(ts.isIfStatement(n)&&n.expression.getText(ast).includes("input.authority === 'colleague'")&&n.thenStatement.getText(ast).includes('const result = await precheckAvailability('))blocks.push(n);ts.forEachChild(n,visit);}visit(ast);assert.equal(blocks.length,1);
const producer=ts.transpileModule(`(async()=>{let availabilityPrecheckBlock='',requestedSearchWindow,availabilityQuestionDetected=false,availabilityPrecheckToolSummaries=[],availabilityChecks=[],availabilityAlternatives=[];${blocks[0].getText(ast)};return {availabilityChecks,availabilityAlternatives,availabilityPrecheckBlock,requestedSearchWindow,availabilityQuestionDetected,availabilityPrecheckToolSummaries};})()`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const actual=new Set(['src/utils/schedulingClockReply.ts','src/utils/meetingDuration.ts','src/utils/weTimeResolver.ts','src/utils/availabilityPreCheck.ts','src/utils/attendeeAvailability.ts','src/utils/workingHoursDefault.ts','src/utils/locationTz.ts','src/utils/timezoneValidator.ts','src/utils/timezoneConvert.ts','src/utils/dateTimeExtract.ts','src/core/orchestrator/turnHelpers.ts']);
const travel={from:'2026-09-14',until:'2026-09-18',location:'New York'};
async function run(options={}){
 const profile={user:{name:'Owner Fixture',slack_user_id:'UOWNER',email:'owner@example.test',timezone:options.ownerZone||'Asia/Jerusalem'},meetings:{default_meeting_duration:25,allowed_durations:[10,25,50],categories:[]}};
 const person=options.missing?null:{person_id:42,slack_id:'UCOLLEAGUE',email:null,timezone:Object.hasOwn(options,'rawZone')?options.rawZone:'Asia/Jerusalem',profile_json:JSON.stringify({working_hours_structured:{week:require('./fixtures/regular-week.cjs').regularWeek(['Monday','Tuesday','Wednesday','Thursday','Friday'],'07:00','16:00'),source:'manual',timezone:options.hoursZone??'Europe/London'}}),working_hours_auto:JSON.stringify({workdays:['Monday','Tuesday','Wednesday','Thursday','Friday'],hoursStart:'09:00',hoursEnd:'18:00'}),private_notes:'PRIVATE_PERSON_NOTE'};
 const calls={checks:[],forgets:[],records:[],calendar:[],model:0,person:0,stash:[],precheck:[],warnings:[]},modules=new Map(),noop=()=>{};
 const slots=(options.slots??[{wall_clock:'2026-09-15T10:00'}]).map(slot=>options.message===undefined && slot.stated_timezone
   ? {...slot,timezone_quote:slot.timezone_quote??slot.wall_clock+' '+slot.stated_timezone} : slot);
 const fixtureMessage=options.message??slots.map(slot=>slot.wall_clock+' '+(slot.stated_timezone??'')).join(' or ')+'?';
 const mocks={
  'src/utils/workHours.ts':{slotDayMinutes:()=>{throw Error('Work-window evaluation is outside this precheck fixture');}},
  'src/db.ts':{getPersonMemory:()=>{calls.person++;if(options.personError)throw Error('person offline');return person;},getEffectiveTimezoneById:()=>({timezone:Object.hasOwn(options,'homeZone')?options.homeZone:'Asia/Jerusalem'}),getTravelRecordById:()=>options.noTravel?null:(options.travel||travel)},
  'src/config/userProfile.ts':{getTenantWorkdaysForTimezone:()=>['Sunday','Monday','Tuesday','Wednesday','Thursday']},
  'src/config.ts':{config:{}},'src/db/client.ts':{getDb:()=>{throw Error('Unexpected DB query');}},
  'src/utils/logger.ts':{__esModule:true,default:{info:noop,warn:(...a)=>calls.warnings.push(a),error:noop,debug:noop}},
  'src/llm/client.ts':{getAnthropicClient:()=>({messages:{create:async request=>{calls.normalizationPrompt=request.system;calls.model++;if(options.modelError)throw Error('fixture model unavailable');return {content:[{type:'tool_use',name:'normalize_slots',input:{kind:options.kind||'points',slots,search_window:options.searchWindow}}]};}}})},
  'src/llm/models.ts':require('./load-test-models.cjs'),'src/utils/usageLog.ts':{logLlmUsage:noop},
  'src/connectors/graph/calendar.ts':{getOwnerEventsForDecision:async(...a)=>{calls.calendar.push(a);if(options.calendarError)throw Error('calendar offline');return [{subject:'PRIVATE_CALENDAR_SUBJECT'}];}},
  'src/utils/scheduleRules.ts':{OWNER_OVERRIDABLE_KINDS:new Set(['outside_work_hours']),bookingLeadTimeHours:()=>4,checkSlot:a=>{calls.checks.push(a);if(options.secondReadError&&calls.checks.length===2)throw Error('second read offline');const kind=options.check?.(a,calls.checks.length);return kind?{passes:false,violation_kind:kind,subject:'PRIVATE_CALENDAR_SUBJECT'}:{passes:true};}},
  'src/utils/availabilityGate.ts':{armsHardFloor:k=>k==='owner_busy_collision',forgetHardBlockedSlot:(...a)=>calls.forgets.push(a),recordHardBlockedSlot:a=>calls.records.push(a),hardBlockClassPhrase:()=>"Owner's calendar is busy"},
  'src/skills/meetings/nearbyAlternatives.ts':{blockedSlotAlternativesBlock:async()=>({block:'',alternatives:options.alternatives||[]})},
  'src/utils/offeredSlotsStash.ts':{getOfferedSlots:()=>options.offers||[],recordOfferedSlots:a=>calls.stash.push(a)},
 };
 function load(rel){
  if(mocks[rel])return mocks[rel];if(modules.has(rel))return modules.get(rel).exports;if(!actual.has(rel))throw Error('unexpected dependency '+rel);
  const mod={exports:{}};modules.set(rel,mod);const req=s=>s==='luxon'?{DateTime,Settings,IANAZone}:s.startsWith('.')?load(path.posix.normalize(path.posix.join(path.posix.dirname(rel),s))+'.ts'):require(s);
  vm.runInNewContext('(function(require,module,exports){'+compile(rel)+'\n})',{console,Date,Set,Map,setTimeout,clearTimeout},{filename:rel})(req,mod,mod.exports);return mod.exports;
 }
 const input={authority:'colleague',userId:'UCOLLEAGUE',channelId:'DCOLLEAGUE',threadTs:'123.45',...options.input};
 const consumer=load('src/utils/availabilityPreCheck.ts').precheckAvailability;
 const output=await vm.runInNewContext(producer,{DateTime,profile,input,meetingRequest:options.meetingRequest,existingStatusOnly:options.existingStatusOnly===true,existingInviteSubject:options.existingInviteSubject,exactBookingRequested:options.exactBookingRequested===true,holdOnlyWindows:options.holdOnlyWindows,checkRequestedHold:options.checkRequestedHold===true,userMessage:fixtureMessage,namedInternalAttendeeEmails:options.named||[],conversationHistory:options.history||[],logger:mocks['src/utils/logger.ts'].default,require:s=>{
  if(s==='../../utils/availabilityPreCheck')return {precheckAvailability:async a=>{calls.precheck.push(a);const result=await consumer(a);calls.result=result;return result;}};
  if(s==='../../utils/attendeeAvailability'&&options.noEntry)return {loadAttendeeAvailabilityForPerson:()=>undefined};
  return load(path.posix.normalize('src/core/orchestrator/'+s)+'.ts');
 }});
 if(!calls.result&&calls.records.length)throw Error(JSON.stringify(calls.warnings));
 return {calls,output,profile,load,result:calls.result};
}
const cases=[];function test(id,fn){cases.push([id,fn]);}
test('nearby alternatives survive into reply data with their real availability scope',async()=>{
 const h=await run({noTravel:true,alternatives:[{start:'2026-09-15T11:00:00+03:00',end:'2026-09-15T11:25:00+03:00',label:'Tue 15 Sep 11:00–11:25 IDT',presentationZone:'Asia/Jerusalem'}]});
 assert.equal(h.output.availabilityAlternatives.length,1);
 assert.equal(h.output.availabilityAlternatives[0].presentation_local,'Tue 15 Sep 11:00 GMT+3');
 assert.equal(h.output.availabilityAlternatives[0].attendees[0].status,'unknown');
 assert.ok(h.output.availabilityPrecheckToolSummaries.some(line=>line.includes('owner_calendar_only; attendee_availability_not_checked')));
});
function times(h){return h.calls.checks.map(x=>DateTime.fromISO(x.slotStartIso).setZone('Asia/Jerusalem').toFormat("yyyy-MM-dd'T'HH:mm"));}
test('a search window never registers endpoints as offers even if extraction includes clocks',async()=>{
 const h=await run({kind:'search_window',message:'Find 30 minutes between 09:00 and 12:00 CT?',slots:[{wall_clock:'2026-11-17T09:00'},{wall_clock:'2026-11-17T12:00'}]});
 assert.equal(h.result.ran,false);
 assert.equal(h.calls.calendar.length,0);
 assert.equal(h.calls.stash.length,0);
 assert.equal(h.result.toolSummaryLines.length,0);
});
test('bare clock follows the delivered offer clock and carries the meeting length',async()=>{
 const start='2026-09-15T09:00:00Z';
 const h=await run({message:'Tuesday 11:03',noTravel:true,homeZone:'Europe/London',
   history:[{role:'assistant',content:'Tuesday 10:00. Does that work?',toolSummaries:['[find_available_slots dur=10m → 1 slots: offer]']}],
   offers:[{startIso:start,display:'Tuesday 12:00'}],meetingRequest:{duration:{minutes:10}},
   slots:[{wall_clock:'2026-09-15T11:03',stated_timezone:'Asia/Jerusalem'}]});
 assert.equal(h.result.verdicts.length,1);
 assert.equal(Date.parse(h.result.verdicts[0].instantIso),Date.parse('2026-09-15T10:03:00Z'));
 assert.equal(h.result.verdicts[0].durationMin,10);
});
test('ordinary search receives original bounds, length and zone without point evidence',async()=>{
 const searchWindow={start:'2026-11-17T09:00',end:'2026-11-17T12:00',zone:'America/Chicago',requestedMinutes:30};
 const quoted={startQuote:'9',endQuote:'12',zoneQuote:'CT'};
 const h=await run({kind:'search_window',searchWindow:{...searchWindow,...quoted,durationQuote:'30 minutes'},message:'Find 30 minutes tomorrow between 9 and 12 CT?'});
 assert.deepEqual({...h.output.requestedSearchWindow},searchWindow);assert.equal(h.calls.calendar.length,0);
 const unstated=await run({kind:'search_window',searchWindow:{...searchWindow,...quoted,requestedMinutes:1},message:'Tomorrow between 9 and 12 CT?'});
 assert.equal(unstated.output.requestedSearchWindow.requestedMinutes,undefined);
 const malformed=await run({kind:'search_window',searchWindow:{...searchWindow,end:'2026-11-17T05:00'}});
 assert.equal(malformed.output.requestedSearchWindow,undefined);assert.equal(malformed.calls.calendar.length,0);
});

test('a partially stated window cannot manufacture a hard end or clock frame',async()=>{
 const window={start:'2026-10-25T12:30',end:'2026-10-25T23:59',zone:'Asia/Jerusalem'};
 for(const extra of [{},{startQuote:'12:30',endQuote:'23:59',zoneQuote:'Israel'}]){
  const h=await run({kind:'search_window',searchWindow:{...window,...extra},message:'אולי ביום ראשון בין השעות 12:30 עדיפות לכמה שיותר מוקדם'});
  assert.equal(h.output.requestedSearchWindow,undefined);assert.equal(h.calls.calendar.length,0);
 }
});

test('a verified calendar conflict stays blocked while retaining the owner decision path',async()=>{
 const h=await run({noTravel:true,message:'2026-09-15T10:00+03:00?',slots:[{wall_clock:'2026-09-15T10:00+03:00'}],check:()=> 'owner_busy_collision'});
 assert.equal(h.result.verdicts[0].bookable,false);
 assert.equal(h.calls.records.length,1);
 assert.match(h.result.promptBlock,/tracked owner decision/);
 assert.doesNotMatch(h.result.promptBlock,/not something to push through/);
});
test('unclassified prose containing clocks supplies no fallback offers',async()=>{
 const h=await run({modelError:true,message:'Find 30 minutes between 09:00 and 12:00 CT?'});
 assert.equal(h.result.ran,false);assert.equal(h.calls.checks.length,0);
});
test('competing weekdays reach the normalization prompt and both returned dates reach the checker',async()=>{
 const h=await run({ownerZone:'America/New_York',rawZone:'America/New_York',homeZone:'America/New_York',noTravel:true,
  history:[{role:'user',content:'Thursday morning in Boston?'},{role:'assistant',content:'Thursday afternoon or Friday 08:30.'}],
  message:'What about 8:30?',slots:['12','13'].map(day=>({wall_clock:'2026-11-'+day+'T08:30',stated_timezone:'America/New_York'}))});
 assert.match(h.calls.normalizationPrompt,/Thursday morning in Boston/);
 assert.match(h.calls.normalizationPrompt,/check the clock on both plausible dates/);
 assert.deepEqual(h.calls.checks.map(c=>DateTime.fromISO(c.slotStartIso).setZone('America/New_York').toISODate()),['2026-11-12','2026-11-13']);
});
test('travel creates both owner and requester readings from real producer',async()=>{const h=await run();assert.deepEqual(times(h),['2026-09-15T10:00','2026-09-15T17:00']);assert.equal(h.result.verdicts[0].other.zone,'America/New_York');assert.equal(h.calls.person,1);});
test('per-date future travel start end and return resolve independently',async()=>{const h=await run({slots:['13','14','18','19'].map(d=>({wall_clock:`2026-09-${d}T10:00`}))});assert.deepEqual(times(h),['2026-09-13T10:00','2026-09-14T10:00','2026-09-14T17:00','2026-09-18T10:00','2026-09-18T17:00','2026-09-19T10:00']);});
test('current travel does not poison future return home',async()=>{const h=await run({travel:{...travel,from:'2026-09-10',until:'2026-09-14'},slots:[{wall_clock:'2026-09-14T10:00'},{wall_clock:'2026-09-15T10:00'}]});assert.deepEqual(times(h),['2026-09-14T10:00','2026-09-14T17:00','2026-09-15T10:00']);});
test('cross-midnight requester source retains stated-date travel zone and clock',async()=>{const h=await run({slots:[{wall_clock:'2026-09-18T23:00'}]});assert.deepEqual(times(h),['2026-09-18T23:00','2026-09-19T06:00']);assert.match(h.result.promptBlock,/Fri 18 Sep 23:00 EDT/);assert.match(h.result.toolSummaryLines[0],/requester America\/New_York/);});
test('per-date renderer uses travel physical zone not manual hours London',async()=>{const h=await run({slots:[{wall_clock:'2026-09-15T17:00',stated_timezone:'Asia/Jerusalem'},{wall_clock:'2026-09-19T17:00',stated_timezone:'Asia/Jerusalem'}]});assert.match(h.result.toolSummaryLines[0],/10:00 EDT; requester America\/New_York/);assert.doesNotMatch(h.result.toolSummaryLines[0],/London|BST/);assert.doesNotMatch(h.result.toolSummaryLines[1],/\[local:/);});
test('fallback regex uses dated travel for both readings after model failure',async()=>{const h=await run({modelError:true,message:'15/09/2026 10:00?'});assert.deepEqual(times(h),['2026-09-15T10:00','2026-09-15T17:00']);});
test('named attendee bail forgets both dated instants without calendar or model',async()=>{const h=await run({named:['third@example.test'],message:'15/09/2026 10:00?'});assert.equal(h.calls.model+h.calls.calendar.length+h.calls.records.length,0);assert.deepEqual(h.calls.forgets.map(a=>DateTime.fromISO(a[1]).toUTC().toISO()),['2026-09-15T07:00:00.000Z','2026-09-15T14:00:00.000Z']);assert.equal(h.result.ran,false);});
test('alternative presentation resolves its own date and requester provenance',async()=>{const h=await run({alternatives:[{start:'2026-09-15T17:00:00+03:00'},{start:'2026-09-19T17:00:00+03:00'}]});assert.match(h.result.toolSummaryLines[1],/10:00 EDT; requester America\/New_York/);assert.equal((h.result.toolSummaryLines[1].match(/\[local:/g)||[]).length,1);});
test('precheck requester suffix stays distinct from different tool presentation',async()=>{const h=await run({rawZone:'America/New_York',homeZone:'America/New_York',noTravel:true});const summary=h.load('src/core/orchestrator/turnHelpers.ts').summarizeToolCall('find_available_slots',{}, {slots:[{start:'2026-09-15T17:00:00+03:00',end:'2026-09-15T17:25:00+03:00',presentation_local:'Tue 15 Sep 15:00 BST'}]},'Asia/Jerusalem');assert.match(h.result.toolSummaryLines[0],/requester America\/New_York/);assert.match(summary,/\[local: Tue 15 Sep 15:00 BST\]/);assert.doesNotMatch(summary,/requester/);});
test('home date stays one reading',async()=>{const h=await run({noTravel:true});assert.deepEqual(times(h),['2026-09-15T10:00']);assert.equal(h.result.verdicts[0].other,undefined);});
test('missing person retains owner-frame default',async()=>{const h=await run({missing:true});assert.deepEqual(times(h),['2026-09-15T10:00']);});
test('missing shared entry uses validated raw-zone compatibility',async()=>{const h=await run({noEntry:true,rawZone:'America/New_York'});assert.deepEqual(times(h),['2026-09-15T10:00','2026-09-15T17:00']);});
test('invalid raw fallback stays owner-frame',async()=>{const h=await run({noEntry:true,rawZone:'not/a-zone'});assert.deepEqual(times(h),['2026-09-15T10:00']);});
test('explicit source zone wins across travel',async()=>{const h=await run({slots:[{wall_clock:'2026-09-15T10:00',stated_timezone:'Asia/Tokyo'}]});assert.deepEqual(times(h),['2026-09-15T04:00']);assert.equal(h.result.verdicts[0].other,undefined);});
test('invented offsets do not replace copied source wall clock',async()=>{const h=await run({message:'2026-09-15 10:00 Tokyo time?',slots:[{wall_clock:'2026-09-15T10:00-04:00',stated_timezone:'Asia/Tokyo',timezone_quote:'10:00 Tokyo time'}]});assert.deepEqual(times(h),['2026-09-15T04:00']);});
test('owner direct and owner room authority clamp remain excluded',async()=>{for(const input of [{authority:'owner',userId:'UOWNER'},{authority:'colleague',userId:'UOWNER',channelId:'CROOM'}]){const h=await run({input});assert.equal(h.calls.person+h.calls.model+h.calls.calendar.length,0);}});
test('colleague room keeps same scoped precheck and private details withheld',async()=>{const h=await run({input:{channelId:'CROOM'},noTravel:true});assert.equal(h.result.ran,true);assert.ok(h.calls.checks.every(x=>x.viewer==='other'&&x.leadTimeHours===4));assert.doesNotMatch(JSON.stringify(h.output),/PRIVATE_/);assert.equal(h.calls.precheck[0].channelId,'CROOM');});
test('one hard blocked reading with one free cannot arm floor',async()=>{const h=await run({noTravel:true,rawZone:'America/New_York',homeZone:'America/New_York',check:(_,n)=>n===1?'owner_busy_collision':undefined});assert.equal(h.calls.records.length,0);assert.equal(h.calls.forgets.length,2);});
test('both hard readings arm owner-only exact instants with requested duration',async()=>{const h=await run({noTravel:true,rawZone:'America/New_York',homeZone:'America/New_York',slots:[{wall_clock:'2026-09-15T10:00',duration_minutes:50}],check:()=> 'owner_busy_collision'});assert.equal(h.calls.records.length,2);assert.ok(h.calls.checks.every(a=>DateTime.fromISO(a.slotEndIso).diff(DateTime.fromISO(a.slotStartIso),'minutes').minutes===50));assert.ok(h.calls.records.every(a=>!a.display.includes('where they are')));assert.doesNotMatch(h.result.promptBlock,/PRIVATE_/);});
test('soft or free fresh reading forgets old block',async()=>{const h=await run({noTravel:true,check:()=> 'outside_work_hours'});assert.equal(h.calls.records.length,0);assert.equal(h.calls.forgets.length,1);});
test('calendar offline makes no verdict and retry can recover',async()=>{const h=await run({calendarError:true});assert.equal(h.result.ran,false);assert.equal(h.calls.records.length,0);const recovered=await run({noTravel:true});assert.equal(recovered.result.ran,true);});
test('second-reading failure drops whole undecided pair',async()=>{const h=await run({secondReadError:true,rawZone:'America/New_York',homeZone:'America/New_York',noTravel:true});assert.equal(h.result.ran,false);assert.equal(h.calls.records.length,0);});
test('exact standing offer preserves bound date and collapses matched reading',async()=>{const h=await run({rawZone:'America/New_York',homeZone:'America/New_York',noTravel:true,slots:[{wall_clock:'2026-09-15T10:00'}],offers:[{startIso:'2026-09-22T17:00:00+03:00',durationMin:25}]});assert.deepEqual(times(h),['2026-09-22T17:00']);assert.equal(h.result.verdicts[0].other,undefined);});
test('unreadable person produces no availability claim',async()=>{const h=await run({personError:true});assert.equal(h.calls.model+h.calls.calendar.length,0);assert.equal(h.output.availabilityPrecheckBlock,'');});
test('empty turn remains excluded',async()=>{const h=await run({message:' '});assert.equal(h.calls.person+h.calls.model+h.calls.calendar.length,0);});
test('permanent person source wins over conflicting raw passive zone',async()=>{const h=await run({rawZone:'America/New_York',homeZone:'Asia/Jerusalem',noTravel:true});assert.deepEqual(times(h),['2026-09-15T10:00']);assert.equal(h.calls.precheck[0].requesterTimezone,undefined);});
test('travel gap checks both instants with independent maximum duration',async()=>{const h=await run({slots:[{wall_clock:'2026-09-15T10:00',gap_query:true}],check:a=>DateTime.fromISO(a.slotEndIso).diff(DateTime.fromISO(a.slotStartIso),'minutes').minutes>25?'owner_busy_collision':undefined});assert.deepEqual(times(h),['2026-09-15T10:00','2026-09-15T10:00','2026-09-15T17:00','2026-09-15T17:00']);assert.equal(h.result.verdicts[0].maxFreeMinutes,25);assert.equal(h.result.verdicts[0].other.maxFreeMinutes,25);assert.equal(h.calls.records.length,0);});
test('travel newly ambiguous free reading prevents false hard block',async()=>{const h=await run({check:(_,n)=>n===1?'owner_busy_collision':undefined});assert.equal(h.calls.records.length,0);assert.equal(h.calls.forgets.length,2);});
test('travel two established hard readings retain exact owner ledger instants',async()=>{const h=await run({check:()=> 'owner_busy_collision'});assert.deepEqual(h.calls.records.map(a=>DateTime.fromISO(a.instantIso).toUTC().toISO()),['2026-09-15T07:00:00.000Z','2026-09-15T14:00:00.000Z']);assert.doesNotMatch(h.calls.records.map(a=>a.display).join(' '),/EDT|requester/);});
test('destination departure display projects actual owner instant',async()=>{const h=await run({slots:[{wall_clock:'2026-09-14T01:00',stated_timezone:'Asia/Jerusalem'}]});assert.doesNotMatch(h.result.toolSummaryLines[0],/EDT|requester America/);});
test('destination return display retains travel before destination midnight',async()=>{const h=await run({slots:[{wall_clock:'2026-09-19T01:00',stated_timezone:'Asia/Jerusalem'}],alternatives:[{start:'2026-09-19T01:00:00+03:00'}]});assert.match(h.result.promptBlock,/Fri 18 Sep 18:00 EDT/);assert.ok(h.result.toolSummaryLines.every(s=>/requester America\/New_York/.test(s)));});
test('requested bare fold returns clarification through actual producer without calendar or floor',async()=>{const h=await run({slots:[{wall_clock:'2026-11-01T01:30',stated_timezone:'America/New_York'}]});assert.match(h.output.availabilityPrecheckBlock,/occurs twice/);assert.match(h.output.availabilityPrecheckToolSummaries[0],/ambiguous_local_time/);assert.equal(h.calls.checks.length+h.calls.records.length+h.calls.calendar.length,0);assert.equal(h.calls.model,1);assert.equal(h.result.verdicts.length,0);});
test('requested bare gap returns clarification without shifted verdict',async()=>{const h=await run({slots:[{wall_clock:'2027-03-14T02:30',stated_timezone:'America/New_York'}]});assert.match(h.result.promptBlock,/does not occur/);assert.equal(h.calls.checks.length+h.calls.records.length,0);});
test('undecided requester DST reading cannot silently settle on owner',async()=>{const h=await run({noTravel:true,homeZone:'America/New_York',slots:[{wall_clock:'2026-11-01T01:30'}]});assert.match(h.result.promptBlock,/occurs twice/);assert.equal(h.calls.checks.length,0);});
test('regex fallback requested DST reading cannot silently settle on owner',async()=>{const h=await run({modelError:true,noTravel:true,homeZone:'America/New_York',message:'01/11/2026 01:30?'});assert.match(h.result.promptBlock,/occurs twice/);assert.equal(h.calls.checks.length,0);});
test('raw IST uses relevant known requester context',async()=>{const h=await run({noTravel:true,homeZone:'Asia/Kolkata',slots:[{wall_clock:'2026-09-15T10:00',stated_timezone:'IST'}]});assert.deepEqual(times(h),['2026-09-15T07:30']);});
test('unknown person IST clarification cannot borrow owner zone',async()=>{const h=await run({missing:true,slots:[{wall_clock:'2026-09-15T10:00',stated_timezone:'IST'}]});assert.match(h.result.promptBlock,/Which timezone/);assert.equal(h.calls.checks.length,0);});
test('explicit repeated instants preserve both occurrences through checks ledger and grounding',async()=>{for(const offset of ['-04:00','-05:00']){const iso='2026-11-01T01:30'+offset;const h=await run({ownerZone:'America/New_York',homeZone:'America/New_York',noTravel:true,message:iso+'?',slots:[{wall_clock:iso,stated_timezone:'CST'}],check:()=> 'owner_busy_collision'});assert.equal(DateTime.fromISO(h.calls.checks[0].slotStartIso).toMillis(),DateTime.fromISO(iso).toMillis());assert.equal(DateTime.fromISO(h.calls.records[0].instantIso).toMillis(),DateTime.fromISO(iso).toMillis());assert.match(h.result.toolSummaryLines[0],new RegExp(offset));assert.equal(h.calls.records.length,1);}});
test('explicit instant is not rebound to later standing offer',async()=>{const iso='2026-09-15T10:00+03:00';const h=await run({message:iso+'?',slots:[{wall_clock:iso}],offers:[{startIso:'2026-09-22T10:00:00+03:00',durationMin:25}]});assert.deepEqual(times(h),['2026-09-15T10:00']);});
test('incidental alternative fold display does not ask DST question',async()=>{const h=await run({noTravel:true,homeZone:'America/New_York',slots:[{wall_clock:'2026-09-15T17:00',stated_timezone:'Asia/Jerusalem'}],alternatives:[{start:'2026-11-01T01:30:00-05:00'}]});assert.doesNotMatch(h.result.promptBlock,/CLARIFICATION/);assert.match(h.result.toolSummaryLines[1],/01:30 EST/);});
test('third party bail forgets repeated candidates without requesting clarification',async()=>{const h=await run({noTravel:true,homeZone:'America/New_York',named:['third@example.test'],message:'01/11/2026 01:30?'});assert.equal(h.calls.model+h.calls.calendar.length,0);assert.equal(h.result.ran,false);assert.equal(h.calls.forgets.length,3);});
test('explicit fold siblings retain separate verdicts and producer offer instants',async()=>{const a='2026-11-01T01:30-04:00',b='2026-11-01T01:30-05:00';const h=await run({ownerZone:'America/New_York',homeZone:'America/New_York',noTravel:true,message:a+' or '+b+'?',slots:[{wall_clock:a},{wall_clock:b}]});assert.equal(h.result.verdicts.length,2);assert.deepEqual(Array.from(h.calls.stash[0].slots,s=>DateTime.fromISO(s.start).toUTC().toISO()),[DateTime.fromISO(a).toUTC().toISO(),DateTime.fromISO(b).toUTC().toISO()]);});
test('checked slot length enters the offer across an offset change',async()=>{
 const start='2026-11-01T01:50-04:00';
 const h=await run({ownerZone:'America/New_York',homeZone:'America/New_York',noTravel:true,message:start+' for 25 minutes?',slots:[{wall_clock:start,duration_minutes:25}]});
 const offer=h.calls.stash[0].slots[0];
 assert.equal(Date.parse(offer.end)-Date.parse(offer.start),25*60000);
 assert.match(offer.end,/01:15:00.*-05:00$/);
});
test('gap offer ends after the largest verified duration',async()=>{
 const start='2026-09-15T10:00+03:00';
 const h=await run({noTravel:true,message:start+' how much time?',slots:[{wall_clock:start,gap_query:true}]});
 const offer=h.calls.stash[0].slots[0];
 assert.ok(h.result.verdicts[0].maxFreeMinutes>0);
 assert.equal(Date.parse(offer.end)-Date.parse(offer.start),h.result.verdicts[0].maxFreeMinutes*60000);
});
test('a request to hold a prior offer cannot manufacture another via the precheck',async()=>{
 const h=await run({holdOnlyWindows:new Map()});
 assert.equal(h.calls.model,0);
 assert.equal(h.calls.stash.length,0);
});
for(const quote of [undefined,'New York'])test('a fabricated timezone without a current source keeps both clock interpretations: '+String(quote),async()=>{
 const h=await run({message:'16:15 works',slots:[{wall_clock:'2026-09-15T16:15',stated_timezone:'America/New_York',timezone_quote:quote}]});
 assert.equal(h.calls.checks.length,2);assert.ok(h.result.verdicts[0].other);
});
test('existing-event status does not validate its old clock as a new booking',async()=>{
 const h=await run({existingStatusOnly:true,message:'Is my 11:30 call approved?',slots:[{wall_clock:'2026-09-15T11:30',stated_timezone:'America/New_York',timezone_quote:'11:30'}]});
 assert.equal(h.calls.precheck.length,0);assert.equal(h.calls.calendar.length,0);
});

test('a verbatim clock-frame phrase settles the source timezone',async()=>{
 const h=await run({message:'16:15 New York time works',slots:[{wall_clock:'2026-09-15T16:15',stated_timezone:'America/New_York',timezone_quote:'16:15 New York time'}]});
 assert.equal(h.calls.checks.length,1);assert.equal(h.result.verdicts[0].other,undefined);
});
test('the zone on the second clock cannot be applied to the first clock',async()=>{
 const h=await run({message:'מה עם 23:00? זה יהיה 16:00 שעון בוסטון',slots:[{wall_clock:'2026-09-15T23:00',stated_timezone:'America/New_York',timezone_quote:'16:00 שעון בוסטון'}]});
 assert.equal(h.calls.checks.length,2);assert.ok(h.result.verdicts[0].other);
});
if(require.main===module)(async()=>{const results=[];for(const [id,fn]of cases){try{await fn();results.push({id,status:'pass'});console.log('ok - '+id);}catch(e){results.push({id,status:'fail',error:e.stack});console.log('not ok - '+id+'\n'+e.stack);}}const passed=results.filter(x=>x.status==='pass').length,failed=results.length-passed;console.log(`${passed} passed; ${failed} failed`);process.exitCode=failed?1:0;})();
module.exports={run};
