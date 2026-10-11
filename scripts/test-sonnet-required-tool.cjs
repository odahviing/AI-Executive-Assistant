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

async function run(steps, force = false, rejectForced = false, options = {}) {
  const requests = [];
  let modelCall = 0;
  let execution = 0;
  const profile = {
    user: { name: 'Owner Person', slack_user_id: 'U_OWNER', email: 'owner@example.test', timezone: 'Asia/Jerusalem' },
    assistant: {},
  };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const deps = {
    'node:util': require('node:util'),
    luxon: { DateTime },
    '../../utils/logger': logger,
    '../../utils/detectMessageLanguage': { detectMessageLanguage: () => 'English' },
    '../../skills/registry': {
      WRITE_TOOLS: new Set(['create_meeting', 'move_meeting', 'update_meeting', 'delete_meeting']),
      executeSkillTool: async name => {
        options.executed = (options.executed || 0) + 1;
        const next = steps[execution++];
        assert.equal(name, next.name);
        return structuredClone(next.result);
      },
    },
    '../../db': { auditLog() {}, recordSocialMoment() {} },
    './turnHelpers': {
      mutationOutcome: result => ({
        ok: !!(result && typeof result === 'object' && (result.success === true || result.ok === true || result.meetingId)),
        eventId: result?.meetingId,
      }),
      summarizeToolCall: name => `[${name}] fixture`,
      summarizeInternalAction: (name, parent) => `[${name}] via ${parent}`,
      callClaude: async params => {
        requests.push(structuredClone(params));
        if (options.providerError) throw Error('provider unavailable');
        if(rejectForced && params.tool_choice?.type === "tool") throw Error("provider rejects forced tools");
        const next = steps[modelCall++];
        return next
          ? { stop_reason: next.stop_reason || 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 'fixture-signature' }, { type: 'tool_use', id: `tool-${modelCall}`, name: next.name, input: structuredClone(next.args ?? {}) }, ...(next.extraTools || [])] }
          : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Health result.' }] };
      },
    },
    './buildTurnContext': {
      buildTurnContext: async () => ({
        messages: [], systemBlocks: [], tools: [{name:"check_calendar_health",input_schema:{type:"object"}}], model: 'fixture', maxTokens: 100,
        turnSenderRole: 'owner', turnPersonSlackId: 'U_OWNER', socialActive: false,
        socialClassification: { kind: 'task', conversation_state: 'closing' },
        resolvedMeetingAttendees: [], availabilityPrecheckToolSummaries: [],
      }),
    },
    '../../utils/turnCache': { withTurnCache: fn => fn() },
    '../../utils/rateLimit': { checkAndRecord: () => ({ allowed: true }) },
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
    forceToolOnFirstTurn: force ? {name:'check_calendar_health'} : undefined, userMessage: 'Run calendar health', conversationHistory: [], threadTs: 'T1', channelId: 'D1',
    userId: 'U_OWNER', senderRole: options.role || 'owner', authority: options.role || 'owner', surface: options.surface || 'owner_dm', channel: 'slack', profile,
  });
  assert.equal(execution, steps.length);
  return { result, requests };
}


test('required tool succeeds without unsupported forced API request',async()=>{const {requests}=await run([{name:'check_calendar_health',result:{vacuous:true}}],true,true);assert.equal(requests.length,2);assert.equal(requests[0].tool_choice,undefined);assert.deepEqual(requests[0].system,requests[1].system);assert.deepEqual(requests[0].tools,requests[1].tools);});
test('missing required tool rejects instead of accepting final prose',async()=>{await assert.rejects(run([],true),/Required first tool/);});
test('wrong required first tool rejects before execution',async()=>{await assert.rejects(run([{name:'get_profile',result:{}}],true),/Required first tool/);});
test('ordinary no-tool answer preserved',async()=>{const {result}=await run([]);assert.equal(result.reply,'Health result.');});
test('complete end_turn tool response executes required first tool',async()=>{const observed={};await run([{name:'check_calendar_health',result:{vacuous:true},stop_reason:'end_turn'}],true,false,observed);assert.equal(observed.executed,1);});
test('ordinary tool loop preserved',async()=>{const {requests}=await run([{name:'check_calendar_health',result:{vacuous:true}}]);assert.equal(requests.length,2);});

test('wrong tool followed by requested tool still rejects before execution',async()=>{await assert.rejects(run([{name:'get_profile',result:{},extraTools:[{type:'tool_use',id:'later',name:'check_calendar_health',input:{}}]}],true),/Required first tool/);});


test('partial required tool rejects with zero executions', async()=>{const observed={};await assert.rejects(run([{name:'check_calendar_health',result:{},stop_reason:'max_tokens'}],true,false,observed),/Required first tool/);assert.equal(observed.executed||0,0);});
test('refused required tool rejects with zero executions', async()=>{const observed={};await assert.rejects(run([{name:'check_calendar_health',result:{},stop_reason:'refusal'}],true,false,observed),/Required first tool/);assert.equal(observed.executed||0,0);});
test('provider unavailable leaves no executed actions',async()=>{const observed={providerError:true};await assert.rejects(run([],true,false,observed),/provider unavailable/);assert.equal(observed.executed||0,0);});
test('thinking signature and append-only messages preserved',async()=>{const {requests}=await run([{name:'check_calendar_health',result:{vacuous:true}}],true);assert.equal(requests[1].messages[0].content[0].signature,'fixture-signature');assert.equal(requests[1].messages[1].role,'user');assert.equal(requests[0].messages.length,0);});
test('colleague DM no-tool response preserved',async()=>{const {result}=await run([],false,false,{role:'colleague',surface:'colleague_dm'});assert.equal(result.reply,'Health result.');});
test('room no-tool response preserved',async()=>{const {result}=await run([],false,false,{role:'colleague',surface:'room'});assert.equal(result.reply,'Health result.');});
