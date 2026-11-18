// Real orchestrator tool loop plus the AST-selected routine silence decision.
// No model, transport, database, calendar, or production write.
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');
const { DateTime } = require('luxon');

const root = path.resolve(__dirname, '..');
const revisionArg = process.argv.indexOf('--source-revision');
const revision = revisionArg < 0 ? null : process.argv[revisionArg + 1];
const orchestratorPath = 'src/core/orchestrator/index.ts';

function read(relative) {
  if (process.env.ORCHESTRATOR_BEFORE_ROOT && relative===orchestratorPath) return fs.readFileSync(path.join(process.env.ORCHESTRATOR_BEFORE_ROOT,relative),'utf8');
  if (!revision || relative !== orchestratorPath) return fs.readFileSync(path.join(root, relative), 'utf8');
  return cp.execFileSync('git', ['show', `${revision}:${relative}`], { cwd: root, encoding: 'utf8' });
}

function compile(source, deps, filename) {
  const exports = {};
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(js, {
    exports,
    require(name) {
      if (Object.hasOwn(deps, name)) return deps[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
    Date,
    Map,
    Set,
    structuredClone,
  }, { filename });
  return exports;
}

async function run(steps, options = {}) {
  let modelCall = 0;
  let execution = 0;
  const profile = {
    user: { name: 'Owner Person', slack_user_id: 'U_OWNER', email: 'owner@example.test', timezone: 'Asia/Jerusalem' },
    assistant: {},
    meetings: {offered_slot_count:8,allowed_durations:[10,25,40,55]},
  };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const deps = {
    'node:util': require('node:util'),
    luxon: { DateTime },
    '../../utils/logger': logger,
    '../../skills/meetings/bookingRequest':{requestSearchAddresses:()=>[]},
    '../../utils/detectMessageLanguage': { detectMessageLanguage: () => 'English' },
    '../../skills/registry': {
      WRITE_TOOLS: new Set(['create_meeting', 'move_meeting', 'update_meeting', 'delete_meeting', 'create_approval']),
      executeSkillTool: async (name,args) => {
        const next = steps[execution++];
        assert.equal(name, next.name);
        await options.onExecute?.(name,args);
        return structuredClone(next.result);
      },
    },
    '../../db': { auditLog() {}, recordSocialMoment() {} },
    './turnHelpers': {
      mutationOutcome: result => ({
        ok: !!(result && typeof result === 'object' && (result.success === true || result.ok === true || result.meetingId)),
        eventId: result?.meetingId,
        changed: result?.unchanged !== true,
      }),
      summarizeToolCall: name => `[${name}] fixture`,
      summarizeInternalAction: (name, parent) => `[${name}] via ${parent}`,
      callClaude: async request => {
        await options.onModel?.(request);
        if (options.responses) {
          return options.responses[modelCall++] ?? {stop_reason:'end_turn',content:[{type:'text',text:'Ready to answer.'}]};
        }
        const next = steps[modelCall++];
        return next
          ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tool-${modelCall}`, name: next.name, input: structuredClone(next.args ?? {}) }] }
          : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Health result.' }] };
      },
    },
    './buildTurnContext': {
      buildTurnContext: async () => ({
        messages: [], systemBlocks: [], tools: [], model: 'fixture', maxTokens: 100,
        turnSenderRole: 'owner', turnPersonSlackId: 'U_OWNER', socialActive: false,
        socialClassification: { kind: 'task', conversation_state: 'closing' },
        resolvedMeetingAttendees: [], availabilityPrecheckToolSummaries: [],
        ...options.context,
      }),
    },
    './schedulingOptions': compile(read('src/core/orchestrator/schedulingOptions.ts'),{luxon:{DateTime}},'schedulingOptions'),
    './schedulingFinish': {schedulingFinishTool:()=>({name:'finish_scheduling',description:'Return answer',input_schema:{type:'object',properties:{}}})},
    '../../utils/turnCache': { withTurnCache: fn => fn() },
    '../../utils/rateLimit': { checkAndRecord: () => ({ allowed: options.rateAllowed !== false,resetInMs:120000 }) },
    '../../utils/toolCallCache': { lookupRecentToolCall: () => null, recordToolCall() {} },
    '../../utils/offeredSlotsStash': { clearOfferedSlots() {} },
    '../../utils/threadEventLedger': { recordThreadEvent() {}, recordViewedThreadEvents() {}, forgetThreadEvent() {} },
    '../requests/maybeOpenInFlightMeetingRequest': { maybeOpenInFlightMeetingRequest() {} },
    '../requests/colleagueOofReengage': { maybeTrackColleagueOofDeadEnd: async () => {} },
    '../../utils/closeLoopOnOwnerHandled': { closeLoopOnOwnerHandled: async () => ({ scanned: false }) },
    '../social/logEngagement': { adjustRankFromColleagueResponse() {} },
    '../social/stateMachine': { directiveForProactiveSlot: () => ({ mode: 'none' }) },
  };
  const orchestrator = compile(read(orchestratorPath), deps, orchestratorPath);
  const result = await orchestrator.runOrchestrator({
    userMessage: 'Run calendar health', conversationHistory: [], threadTs: 'T1', channelId: 'D1',
    userId: 'U_OWNER', senderRole: 'owner', authority: 'owner', surface: 'owner_dm', channel: 'slack', profile,
    ...options.input,
  });
  assert.equal(execution, options.expectedExecutions ?? steps.length);
  return result;
}

test('superseded model response cannot dispatch a calendar write',async()=>{
 const controller=new AbortController();let writes=0,reservations=0;
 await assert.rejects(run([{name:'create_meeting',result:{success:true,meetingId:'event'}}],{
  onModel:()=>controller.abort(),onExecute:()=>writes++,
  input:{signal:controller.signal,onWriteExecuted:()=>reservations++},
 }),{name:'AbortError'});
 assert.equal(writes,0);assert.equal(reservations,0);
});

test('superseded read in a model batch cannot dispatch its following write',async()=>{
 const controller=new AbortController(),executed=[];
 await assert.rejects(run([{name:'get_calendar',result:{events:[]}},{name:'create_meeting',result:{success:true,meetingId:'event'}}],{
  responses:[{stop_reason:'tool_use',content:[{type:'tool_use',id:'read',name:'get_calendar',input:{}},{type:'tool_use',id:'write',name:'create_meeting',input:{}}]}],
  onExecute:name=>{executed.push(name);if(name==='get_calendar')controller.abort();},input:{signal:controller.signal},
 }),{name:'AbortError'});
 assert.deepEqual(executed,['get_calendar']);
});

test('rejected write reservation cannot be swallowed before dispatch',async()=>{
 let writes=0;const rejection=Object.assign(Error('aborted_for_merge'),{name:'AbortError'});
 await assert.rejects(run([{name:'create_meeting',result:{success:true,meetingId:'event'}}],{
  onExecute:()=>writes++,input:{onWriteExecuted:()=>{throw rejection;}},
 }),err=>err===rejection);
 assert.equal(writes,0);
});

test('active write preserves its successful execution receipt',async()=>{
 let reservations=0;const r=await run([{name:'create_meeting',result:{success:true,meetingId:'event'}}],{
  input:{signal:new AbortController().signal,onWriteExecuted:()=>reservations++},
 });assert.equal(reservations,1);assert.ok(r.mutationActions.some(a=>a.ok&&a.eventId==='event'));
});

test('Ayala race: actual queue cancels a waiting model without an orphan booking',async()=>{
 const {harness}=require('./test-slack-thread-boundaries.cjs');
 let release;const pending=new Promise(resolve=>{release=resolve;});let writes=0;
 const h=harness({orchestrator:async(p,n)=>{
  const {profile:ignored,...input}=p;
  if(n===1)return run([{name:'create_meeting',result:{success:true,meetingId:'event'}}],{input,onModel:()=>pending,onExecute:()=>writes++});
  return run([],{input,responses:[{stop_reason:'end_turn',content:[{type:'text',text:'Stopped.'}]}]});
 }});
 await h.turn({text:'Book 12:30'});await h.fire();
 await h.turn({text:'Stop',ts:'102.000001'});release();
 await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
 assert.equal(writes,0);assert.equal(h.posts.length,0);
 await h.fire();assert.equal(h.runs.length,2);assert.equal(h.posts.length,1);
 assert.ok(h.runs[1].userMessage.includes('Stop'));assert.equal(writes,0);
});

test('queue follow-up after write reservation retains the completed booking',async()=>{
 const {harness}=require('./test-slack-thread-boundaries.cjs');
 let release;const pending=new Promise(resolve=>{release=resolve;});let writes=0;
 const h=harness({orchestrator:async(p,n)=>{
  const {profile:ignored,...input}=p;
  if(n===1)return run([{name:'create_meeting',result:{success:true,meetingId:'event'}}],{input,onExecute:async()=>{writes++;await pending;},
   responses:[{stop_reason:'tool_use',content:[{type:'tool_use',id:'book',name:'create_meeting',input:{}}]},{stop_reason:'end_turn',content:[{type:'text',text:'Booked Friday 12:30.'}]}]});
  return run([],{input,responses:[{stop_reason:'end_turn',content:[{type:'text',text:'No further actions.'}]}]});
 }});
 await h.turn({text:'Book 12:30'});await h.fire();assert.equal(writes,1);
 await h.turn({text:'Stop',ts:'102.000001'});release();
 await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));await h.fire();
 assert.equal(writes,1);assert.equal(h.runs.length,2);assert.equal(h.posts.length,2);
 assert.ok(h.runs[1].conversationHistory.some(m=>m.content.includes('Booked Friday 12:30.')));
 assert.equal(h.runs[1].userMessage,'Stop');
});

for(const name of ['create_meeting','move_meeting'])test(name+' keeps the checked conflict interval for final calendar truth',async()=>{
 const start='2026-11-10T10:50:00-05:00',end='2026-11-10T11:30:00-05:00';
 const result={success:false,error:'attendee_conflict',owner_available:true,requested_start:start,requested_end:end,
  attendee_conflicts:[{email:'scott@example.test',reason:'busy',line:'Scott is busy'}],_attendee_busy_note:'Scott is busy'};
 const r=await run([{name,args:{},result}]);
 const facts=r.calendarFacts.find(f=>f.tool===name);assert.ok(facts);
 assert.equal(facts.owner_available,true);assert.equal(facts.requested_start,start);assert.equal(facts.requested_end,end);
 assert.equal(facts.attendee_conflicts[0].email,'scott@example.test');assert.equal(facts.attendee_conflicts[0].reason,'busy');
});
test('an unperformed booking cannot fabricate checked availability',async()=>{
 const r=await run([{name:'create_meeting',args:{},result:{success:false,error:'attendee_missing_email'}}]);
 assert.equal(r.calendarFacts.length,0);
});

test('a successful invitation cannot enter a create-cancel retry loop',async()=>{
 const call=(id,name,input)=>({stop_reason:'tool_use',content:[{type:'tool_use',id,name,input}]});
 const r=await run([{name:'create_meeting',args:{subject:'Sync'},result:{success:true,meetingId:'new-event'}},{name:'get_calendar',result:{events:[]}}],{
  responses:[call('a','create_meeting',{subject:'Sync'}),call('b','delete_meeting',{meeting_id:'new-event'}),call('c','get_calendar',{})],
 });
 assert.equal(r.bookingOccurred,true);
 assert.ok(r.toolSummaries.some(line=>line.includes('new invitation retained')));
 assert.equal(r.mutationActions.filter(a=>a.tool==='delete_meeting').length,0);
});
test('the requested cancellation of an existing event remains available',async()=>{
 const r=await run([{name:'delete_meeting',args:{meeting_id:'old-event'},result:{success:true,deleted:'Old meeting'}}]);
 assert.equal(r.mutationActions[0].tool,'delete_meeting');assert.equal(r.mutationActions[0].ok,true);
});

const health = result => ({ name: 'check_calendar_health', result });

test('explicit consultation checks pending state before creating a complete owner question', async () => {
  const requested='Can you check with him whether Tuesday at 17:00 Israel time works?';
  const question='Elan asks to move the customer success meeting to Tuesday 17 November, 17:00 Israel / 10:00 Boston, for 25 minutes. Can that work?';
  const calls=[];
  await run([
    {name:'list_pending_approvals',result:{requests:[]}},
    {name:'create_approval',result:{ok:true}},
  ],{
    input:{userMessage:requested,typedUserMessage:requested,userId:'U_PEER',senderRole:'colleague',authority:'colleague',surface:'colleague_dm'},
    context:{consultOwnerQuote:requested,consultBackground:'Customer success, 25 minutes.',tools:[{name:'list_pending_approvals'},{name:'create_approval'}],blockedWriteTools:new Set(['create_meeting'])},
    responses:[
      {stop_reason:'tool_use',content:[{type:'tool_use',id:'pending',name:'list_pending_approvals',input:{}}]},
      {stop_reason:'tool_use',content:[{type:'tool_use',id:'ask',name:'create_approval',input:{kind:'freeform',ask_text:question,payload:{subject:'Customer success',question}}}]},
    ],
    onExecute:(name,args)=>calls.push({name,args}),
  });
  assert.deepEqual(calls.map(call=>call.name),['list_pending_approvals','create_approval']);
  assert.equal(calls[1].args.ask_text,question);
});

test('consultation about an already pending meeting does not synthesize a duplicate approval', async () => {
  await run([{name:'list_pending_approvals',result:{requests:[{subject:'Customer success',state:'awaiting_owner'}]}}],{
    input:{userMessage:'Can you ask him?',typedUserMessage:'Can you ask him?'},
    context:{consultOwnerQuote:'Can you ask him?',tools:[{name:'list_pending_approvals'},{name:'create_approval'}],blockedWriteTools:new Set()},
    responses:[{stop_reason:'tool_use',content:[{type:'tool_use',id:'pending',name:'list_pending_approvals',input:{}}]}],
  });
});

for (const question of ['Please ask the owner whether this can move.', 'תבדקי מול עידן אם אפשר להזיז את הפגישה.'])
test('explicit consultation cannot finish after only a calendar read: '+question,async()=>{
 let calls=0;
 await run([
  {name:'get_calendar',result:{events:[]}},
  {name:'create_approval',result:{ok:true}},
 ],{
  input:{userMessage:question,typedUserMessage:question,senderRole:'colleague',authority:'colleague',surface:'colleague_dm'},
  context:{consultOwnerQuote:question,tools:[{name:'get_calendar'},{name:'create_approval'}]},
  responses:[
   {stop_reason:'tool_use',content:[{type:'tool_use',id:'read',name:'get_calendar',input:{}}]},
   {stop_reason:'end_turn',content:[{type:'text',text:'There is no shared event. Can you ask him?'}]},
   {stop_reason:'tool_use',content:[{type:'tool_use',id:'consult',name:'create_approval',input:{kind:'freeform',ask_text:question,payload:{question}}}]},
  ],onModel:()=>calls++,
 });
 assert.equal(calls,4,'one bounded completion retry uses the existing planner and approval handler');
});

test('a failed consultation is not retried indefinitely',async()=>{
 let calls=0;
 await run([{name:'create_approval',result:{ok:false,error:'delivery_failed'}}],{
  context:{consultOwnerQuote:'Please ask the owner.',tools:[{name:'create_approval'}]},
  onModel:()=>calls++,
 });
 assert.equal(calls,2);
});

test('no explicit consultation leaves a read-only answer complete',async()=>{
 let calls=0;
 await run([{name:'get_calendar',result:{events:[]}}],{
  context:{tools:[{name:'get_calendar'},{name:'create_approval'}]},onModel:()=>calls++,
 });
 assert.equal(calls,2);
});

test('resolving a person before the slot check cannot make an exact booking request complete',async()=>{
 let calls=0;
 await run([{name:'get_person_memory',result:{found:true}},{name:'find_available_slots',result:{slots:[]}},{name:'create_meeting',result:{error:'not_rule_compliant'}}],{
  context:{exactBookingRequested:true,tools:[{name:'get_person_memory'},{name:'find_available_slots'},{name:'create_meeting'}]},
  responses:[
   {stop_reason:'tool_use',content:[{type:'tool_use',id:'person',name:'get_person_memory',input:{}}]},
   {stop_reason:'tool_use',content:[{type:'tool_use',id:'slot',name:'find_available_slots',input:{}}]},
   {stop_reason:'end_turn',content:[{type:'text',text:'Would you like me to book?'}]},
   {stop_reason:'tool_use',content:[{type:'tool_use',id:'book',name:'create_meeting',input:{}}]},
  ],onModel:()=>calls++,
 });assert.equal(calls,5);
});

test('an unselected appointment with a concrete missing-detail answer is not redrafted as a booking',async()=>{
 let calls=0;const text='You are on the requested attendee list. Nothing is booked yet. Which time and which Daniel?';
 const r=await run([],{input:{userMessage:'Add me to this meeting',typedUserMessage:'Add me to this meeting'},
 context:{exactBookingRequested:true,meetingRequest:{requestId:'r',original:'Arrange PPC',updates:[],bookingInstruction:'Add me to this meeting'},tools:[{name:'create_meeting'}]},
 responses:[{stop_reason:'tool_use',content:[{type:'tool_use',id:'done',name:'finish_scheduling',input:{parts:[{kind:'blocked',text,options:[]}]}}]}],onModel:()=>calls++});
 assert.equal(calls,1);assert.equal(r.reply,text);assert.equal(r.bookingOccurred,false);
});

test('a health inspection without a listed decision does not force an issue mutation or redraft',async()=>{
 let calls=0;const text='The category needs a decision. The calendar still contains duplicate entries.';
 const r=await run([{name:'check_calendar_health',result:{issues:[{id:12,type:'uncategorized'}]}}],{
 input:{userMessage:'Check again. Any issues?',typedUserMessage:'Check again. Any issues?'},
 context:{calendarOperations:[{operation:'issue',quote:'Any issues?'}],ownerSettings:{},tools:[{name:'check_calendar_health'},{name:'manage_calendar_issue'}]},
 responses:[{stop_reason:'tool_use',content:[{type:'tool_use',id:'read',name:'check_calendar_health',input:{}}]},
 {stop_reason:'tool_use',content:[{type:'tool_use',id:'done',name:'finish_scheduling',input:{parts:[{kind:'outcome',text,options:[]}]}}]}],onModel:()=>calls++});
 assert.equal(calls,2);assert.equal(r.reply,text);
});

test('acknowledging a calendar issue requires recording the decision, not another list',async()=>{
 let calls=0;
 await run([{name:'manage_calendar_issue',result:{issues:[{id:12}]}},{name:'manage_calendar_issue',result:{ok:true}}],{
  context:{calendarOperations:[{operation:'issue',quote:'Its ok'}],tools:[{name:'manage_calendar_issue'}]},
  responses:[
   {stop_reason:'tool_use',content:[{type:'tool_use',id:'list',name:'manage_calendar_issue',input:{action:'list'}}]},
   {stop_reason:'end_turn',content:[{type:'text',text:'I will leave it as is. What about lunch?'}]},
   {stop_reason:'tool_use',content:[{type:'tool_use',id:'decision',name:'manage_calendar_issue',input:{action:'update',issue_id:12,status:'dismissed'}}]},
  ],onModel:()=>calls++,
 });assert.equal(calls,4);
});

for(const blocked of [false,true])test('ordinary scheduling reply uses only the operational planner: '+blocked,async()=>{
 let calls=0;const r=await run([{name:'get_calendar',result:{events:[]}}],{input:{surface:'colleague_dm',authority:'colleague',senderRole:'colleague',userId:'U_PEER',userMessage:'Please cancel our weekly while I am away.',typedUserMessage:'Please cancel our weekly while I am away.'},context:{tools:[{name:'get_calendar'},{name:'create_approval'}],blockedWriteTools:new Set(blocked?['create_approval']:[])},onModel:()=>calls++});
 assert.equal(calls,2);assert.equal(r.reply,'Health result.');
});

test('finding an existing meeting does not satisfy the requested search for a new day', async () => {
  const requested='Please move our Wednesday meeting to Thursday.';
  let compositions=0;
  await run([
    {name:'get_calendar',result:{events:[]}},
    {name:'find_available_slots',result:{slots:[]}},
  ], {
    input:{userMessage:requested,typedUserMessage:requested},
    context:{searchBeforeReply:requested,tools:[{name:'get_calendar'},{name:'find_available_slots'}]},
    responses:[
      {stop_reason:'tool_use',content:[{type:'tool_use',id:'original',name:'get_calendar',input:{}}]},
      {stop_reason:'end_turn',content:[{type:'text',text:'I will check Thursday.'}]},
      {stop_reason:'tool_use',content:[{type:'tool_use',id:'new-day',name:'find_available_slots',input:{}}]},
    ],
    compose:()=>{compositions++;return {reply:'Thursday has no opening; I can ask the owner.'};},
  });
  assert.equal(compositions,0,'the planner answers without another writer');
});

test('one necessary lookup leaves the next different authorized operation available', async () => {
  let compositions=0;
  let plannerCalls=0;
  await run([
    {name:'get_calendar',result:{events:[]}},
    {name:'get_person_memory',result:{found:true,timezone:'America/New_York'}},
    {name:'find_available_slots',result:{slots:[]}},
  ], {
    input:{userMessage:'Find a new time with my colleague.',typedUserMessage:'Find a new time with my colleague.'},
    context:{tools:[{name:'get_calendar'},{name:'get_person_memory'},{name:'find_available_slots'}]},
    onModel:()=>plannerCalls++,
    compose:()=>{compositions++;return {reply:'I checked the requested day.'};},
  });
  assert.equal(compositions,0);
  assert.equal(plannerCalls,4,'the one planner runs all three reads before answering');
});

test('a completed planner answer is not sent through a second writer',async()=>{
 let calls=0;const r=await run([{name:'create_meeting',result:{success:true,id:'scott-event'}}],{input:{userMessage:'Try booking Scott again.',typedUserMessage:'Try booking Scott again.'},onModel:()=>calls++,responses:[{stop_reason:'tool_use',content:[{type:'tool_use',id:'book',name:'create_meeting',input:{}}]},{stop_reason:'end_turn',content:[{type:'text',text:'Scott is booked.'}]}]});
 assert.equal(r.reply,'Scott is booked.');assert.equal(calls,2);
});

test('the final allowed tool result uses the receipt fallback without another model call',async()=>{
 let calls=0;const steps=[...Array.from({length:9},()=>({name:'get_calendar',result:{events:[]}})),{name:'create_meeting',result:{success:true,id:'confirmed',booked_location:'Big meeting room',booked_online:false}}];
 const r=await run(steps,{input:{userMessage:'Book the requested meeting.',typedUserMessage:'Book the requested meeting.'},onModel:()=>calls++});
 assert.equal(calls,10);assert.match(r.reply,/booked the meeting/);assert.equal(r.toolSummaries.length,10);assert.equal(r.bookingOccurred,true);
});

test('tool budget exhaustion never invents a tracked owner escalation or an extra writer',async()=>{
 let calls=0;const r=await run([{name:'find_available_slots',result:{slots:[]}}],{rateAllowed:false,expectedExecutions:0,input:{userMessage:'Find a time.',typedUserMessage:'Find a time.',senderRole:'colleague',authority:'colleague',surface:'colleague_dm',userId:'U_PEER'},onModel:()=>calls++});
 assert.equal(calls,1);assert.ok(r.toolSummaries.some(line=>line.includes('not executed')));assert.ok(r.toolSummaries.every(line=>!line.includes('deferred to owner')));assert.doesNotMatch(r.reply,/booked|sent.*owner/i);
});

test('existing identity and failed search inputs stay available to the same planner',async()=>{
 let captured;const args={attendee_emails:['alex@example.test','elinor@example.test'],moving_event_ids:['event-alex'],search_from:'2026-11-16',search_to:'2026-11-20'};
 await run([{name:'get_calendar',result:[{id:'event-alex',subject:'Customer status'}]},{name:'find_available_slots',args,result:{error:'ambiguous_meeting_roster'}}],{input:{userMessage:'Find options to move this meeting.',typedUserMessage:'Find options to move this meeting.'},onModel:request=>captured=structuredClone(request.messages)});
 const text=JSON.stringify(captured);assert.ok(text.includes('event-alex'));assert.ok(text.includes('ambiguous_meeting_roster'));assert.ok(text.includes('2026-11-20'));
});

test('owner category rules reach the final planner response',async()=>{
 const rules={allowed_durations:[10,25,40,55],categories:[{name:'Interview',limits:{per_day:2}}]};let captured;
 await run([{name:'get_person_memory',result:{found:true,owner_meeting_rules:rules}}],{input:{userMessage:'Do I have a limit of two interviews?',typedUserMessage:'Do I have a limit of two interviews?'},onModel:r=>captured=structuredClone(r.messages)});
 const results=captured.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='tool_result').map(b=>JSON.parse(b.content));
 assert.deepEqual(results.at(-1).owner_meeting_rules,rules);
});

test('owner policy evidence stays outside shared-surface reply composition', async () => {
  let captured;
  const result=await run([{name:'get_person_memory',result:{found:true,owner_meeting_rules:{categories:[{name:'Private category'}]}}}], {
    input:{surface:'room',userMessage:'A policy question',typedUserMessage:'A policy question'},
    onCompose: input => { captured=input; },
  });
  assert.equal(captured,undefined);
  assert.ok(result.calendarFacts.every(item=>item.owner_meeting_rules===undefined));
});

test('looking up the recipient of a draft does not reroute the writing result through the scheduling formatter',async()=>{
 let composed=false;
 const r=await run([{name:'get_person_memory',result:{found:true,name:'Oran'}}],{
  input:{userMessage:'Revise the post for Oran and show it.',typedUserMessage:'Revise the post for Oran and show it.'},
  onCompose:()=>composed=true,
 });assert.equal(composed,false);assert.notEqual(r.reply,'Recorded outcome.');
});

function routineDecision() {
  const file = 'src/tasks/dispatchers/routine.ts';
  const tree = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const declarations = [];
  function walk(node) {
    if (ts.isVariableStatement(node)) {
      const names = node.declarationList.declarations.map(d => d.name.getText());
      if (names.includes('vacuousRoutineRun') || names.includes('isSilent')) declarations.push(node.getText());
    }
    ts.forEachChild(node, walk);
  }
  walk(tree);
  assert.equal(declarations.length, 2);
  return compile(`exports.decide = result => { const cleaned = 'visible'; const rawReply = 'visible'; ${declarations.join('\n')} return {vacuousRoutineRun,isSilent}; }`, {}, file).decide;
}

const decide = routineDecision();

test('quiet then nonquiet health result prevents routine silence', async () => {
  const result = await run([health({ vacuous: true }), health({ vacuous: false, issues: [{ type: 'overlap' }] })]);
  assert.equal(result.healthCheckVacuous, undefined);
  assert.equal(decide(result).isSilent, false);
});

test('nonquiet then quiet health result prevents routine silence', async () => {
  const result = await run([health({ vacuous: false, issues: [{ type: 'overlap' }] }), health({ vacuous: true })]);
  assert.equal(result.healthCheckVacuous, undefined);
  assert.equal(decide(result).isSilent, false);
});

test('quiet then error health result prevents routine silence', async () => {
  const result = await run([health({ vacuous: true }), health({ error: 'calendar unavailable' })]);
  assert.equal(result.healthCheckVacuous, undefined);
  assert.equal(decide(result).isSilent, false);
});

test('error then quiet health result prevents routine silence', async () => {
  const result = await run([health({ error: 'calendar unavailable' }), health({ vacuous: true })]);
  assert.equal(result.healthCheckVacuous, undefined);
  assert.equal(decide(result).isSilent, false);
});

test('all quiet health checks remain eligible for silence', async () => {
  const result = await run([health({ vacuous: true }), health({ vacuous: true })]);
  assert.equal(result.healthCheckVacuous, true);
  assert.equal(decide(result).isSilent, true);
});

test('explicit quiet horizon additions remain eligible despite internal action evidence', async () => {
  const result = await run([health({ vacuous: true, internal_actions: [{ tool: 'book_floating_block', detail: 'final horizon date' }] })]);
  assert.equal(result.healthCheckVacuous, true);
  assert.equal(decide(result).isSilent, true);
});

test('nonquiet internal actions prevent silence', async () => {
  const result = await run([health({ vacuous: false, internal_actions: [{ tool: 'move_meeting', detail: 'material repair' }] })]);
  assert.equal(result.healthCheckVacuous, undefined);
  assert.equal(decide(result).isSilent, false);
});

test('quiet health plus booking preserves booking safeguard', async () => {
  const result = await run([
    health({ vacuous: true }),
    { name: 'create_meeting', args: { subject: 'Fixture' }, result: { success: true, id: 'event-1' } },
  ]);
  assert.equal(result.healthCheckVacuous, true);
  assert.equal(result.bookingOccurred, true);
  assert.equal(decide(result).isSilent, false);
});

test('quiet health plus mutation preserves mutation safeguard', async () => {
  const result = await run([
    health({ vacuous: true }),
    { name: 'move_meeting', args: { meeting_id: 'event-1' }, result: { success: true, meetingId: 'event-1' } },
  ]);
  assert.equal(result.healthCheckVacuous, true);
  assert.equal(result.mutationActions.length, 1);
  assert.equal(decide(result).isSilent, false);
});

test('turn with no health check never earns vacuous silence', async () => {
  const result = await run([{ name: 'get_calendar', result: { events: [] } }]);
  assert.equal(result.healthCheckVacuous, undefined);
  assert.equal(decide(result).isSilent, false);
});

test('conditional availability survives a model attempt to disable it',async()=>{
 let actual;
 await run([{name:'move_meeting',args:{meeting_id:'old',require_attendee_availability:false},result:{success:false,error:'attendee_condition_unmet'}}],{
  context:{requireAttendeeAvailability:true},onExecute:(name,args)=>{actual=args;}
 });
 assert.equal(actual.require_attendee_availability,true);
});

test('the planner retains the scoped conflict and booker decision',async()=>{
 let captured;await run([{name:'create_meeting',result:{success:false,error:'attendee_conflict',needs_confirmation:true,_attendee_busy_note:'Onn is busy then',message:'Onn is busy then. Book anyway?'}}],{input:{userMessage:'Book 10:30',typedUserMessage:'Book 10:30',authority:'colleague',senderRole:'colleague',surface:'colleague_dm',userId:'UPEER'},onModel:r=>captured=structuredClone(r.messages)});
 const result=captured.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='tool_result').map(b=>JSON.parse(b.content)).at(-1);
 assert.equal(result._attendee_busy_note,'Onn is busy then');assert.equal(result.needs_confirmation,true);assert.equal(result.message,'Onn is busy then. Book anyway?');
});
test('category writes retain their event and final categories after the calendar read',async()=>{
 let captured;await run([{name:'get_calendar',result:{events:[{id:'event-1',subject:'Project review',categories:[]}]}},{name:'set_event_category',args:{event_id:'event-1',categories:['Meeting']},result:{updated:true,event_id:'event-1',categories:['Meeting']}}],{onModel:r=>captured=structuredClone(r.messages)});
 const results=captured.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='tool_result').map(b=>JSON.parse(b.content));
 assert.equal(results[0].events[0].categories.length,0);assert.equal(results.at(-1).event_id,'event-1');assert.deepEqual(results.at(-1).categories,['Meeting']);
});

test('execution model finishes once and preserves identity after confirmed booking',async()=>{
 const request={requestId:'r1',ownerId:'U_OWNER',requesterId:'U_OWNER',channelId:'D1',threadTs:'T1',original:'Book Alex',updates:[],participantBindings:[{name:'Alex',identifier:'alex@external.test',quote:'alex@external.test'}]};
 let calls=0,composed=0;const tool=(id,name,input)=>({stop_reason:'tool_use',content:[{type:'tool_use',id,name,input}]});
 const r=await run([{name:'create_meeting',result:{success:true,meetingId:'new-id'}}],{input:{userMessage:'Book Alex',typedUserMessage:'Book Alex'},context:{meetingRequest:request},onModel:()=>calls++,onCompose:()=>composed++,responses:[tool('a','create_meeting',{}),tool('b','finish_scheduling',{parts:[{text:'Booked Alex for Thursday at 11:00.'}],unfinished:[]})]});
 assert.equal(r.reply,'Booked Alex for Thursday at 11:00.');assert.equal(calls,2);assert.equal(composed,0);assert.equal(r.meetingRequest.hasConfirmedBooking,true);assert.equal(r.meetingRequest.participantBindings[0].identifier,'alex@external.test');
});
test('finisher cannot claim the outcome of simultaneous operations before their results',async()=>{
 let calls=0;const r=await run([{name:'create_meeting',result:{success:false,error:'unavailable'}}],{input:{userMessage:'Book Alex',typedUserMessage:'Book Alex'},context:{meetingRequest:{original:'Book Alex',updates:[]}},onModel:request=>{calls++;if(calls===2)assert.ok(request.messages.at(-1).content.some(b=>b.tool_use_id==='early'&&b.is_error));},responses:[{stop_reason:'tool_use',content:[{type:'tool_use',id:'action',name:'create_meeting',input:{}},{type:'tool_use',id:'early',name:'finish_scheduling',input:{parts:[{text:'Booked.'}],unfinished:[]}}]},{stop_reason:'tool_use',content:[{type:'tool_use',id:'done',name:'finish_scheduling',input:{parts:[{text:'The invite could not be sent.'}],unfinished:[{request:'Book Alex',reason:'Calendar operation failed.'}]}}]}]});assert.equal(r.reply,'The invite could not be sent.');assert.equal(calls,2);assert.equal(r.bookingOccurred,false);
});

test('an exact candidate refusal persists its full conflict set for the next assent',async()=>{
 const start='2026-11-18T10:30:00-05:00',end='2026-11-18T11:25:00-05:00';
 const conflicts=[{email:'onn@example.test',reason:'busy',line:'Onn is busy'},{email:'peer@example.test',reason:'busy',line:'You are busy'}];
 const request={requestId:'request',original:'Find 10:30',updates:[]};
 const r=await run([{name:'find_available_slots',result:{mode:'candidate_validation',results:[{start,end,available:false,owner_available:true,attendee_conflicts:conflicts}]}}],{
 input:{userMessage:'10:30-11:25',typedUserMessage:'10:30-11:25',authority:'colleague',senderRole:'colleague',surface:'colleague_dm',userId:'UPEER'},context:{meetingRequest:request}
 });
 assert.deepEqual(JSON.parse(JSON.stringify(r.meetingRequest.conflictOptions)),[{start,end,conflicts:conflicts.map(({email,reason})=>({email,reason}))}]);
});

for(const selected of [true,false])test('a previous ambiguous clock uses the current source-bound zone without another judge: '+selected,async()=>{
 const receipt='[availability_precheck 2026-10-29T13:30:00-04:00 America/New_York dur=25m: bookable | same clock read in Asia/Jerusalem: 2026-10-29T07:30:00-04:00 America/New_York dur=25m: not bookable]';
 let calls=0;const text=selected?'13:30 Boston time':'25 minutes';
 const r=await run([{name:'create_meeting',args:{start:'2026-10-29T13:30:00-04:00'},result:{success:true,id:'confirmed'}}],{
  expectedExecutions:selected?1:0,
  input:{userMessage:text,typedUserMessage:text,authority:'colleague',senderRole:'colleague',surface:'colleague_dm',userId:'U_PEER',conversationHistory:[{role:'assistant',content:'Do you mean Boston or Israel time?',toolSummaries:[receipt]}]},
  context:{meetingRequest:{original:'Book 13:30',updates:[],clockZone:{quote:'Boston',zone:'America/New_York'}}},onModel:()=>calls++,
 });
 assert.equal(calls,selected?2:1);assert.equal(r.bookingOccurred===true,selected);
 if(!selected)assert.match(r.reply,/13:30/);
});
