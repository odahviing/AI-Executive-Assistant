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
  if (process.env.HANDYMAN_BEFORE && relative === orchestratorPath) return fs.readFileSync(process.env.HANDYMAN_BEFORE, 'utf8');
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

async function run(steps, extra = {}) {
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
      executeSkillTool: async (name, args, context) => {
        const next = steps[execution++];
        assert.equal(name, next.name); next.inspect?.(context);
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
      callClaude: async () => {
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
    userMessage: 'Run calendar health', conversationHistory: [], threadTs: 'T1', channelId: 'D1',
    userId: 'U_OWNER', senderRole: 'owner', authority: 'owner', surface: 'owner_dm', channel: 'slack', profile, ...extra,
  });
  assert.equal(execution, steps.length);
  return result;
}

module.exports = { run };

for (const [name, extra, expected] of [
  ['explicit live owner', {interactive:true}, true],
  ['default live owner', {}, true],
  ['scheduled routine', {interactive:false}, false],
  ['scheduled research', {interactive:false, channel:'email'}, false],
  ['colleague live', {senderRole:'colleague',authority:'colleague',surface:'colleague_dm'}, true],
  ['room live', {surface:'room'}, true],
]) test(name + ' reaches actual tool dispatch on each round', async () => {
  const inspect = context => { assert.equal(context.interactive, expected); assert.equal(context.currentUserMessage, 'Run calendar health'); };
  await run([{name:'check_calendar_health',result:{vacuous:true},inspect},{name:'check_calendar_health',result:{vacuous:true},inspect}], extra);
});
test('legitimate tool execution and reply preserved without transport', async () => {
  const result = await run([{name:'check_calendar_health',result:{vacuous:true}, inspect(context) { assert.equal(context.authority,'owner'); assert.equal(context.surface,'owner_dm'); }}]);
  assert.equal(result.healthCheckVacuous,true);
});

const heading = '[Thread participant: Alex <alex@directory.test>]';
const caption = 'Use the other address for Alex.';
const attachment = '[Attached file: notes.txt]\nContact: alex@document.test';
const framed = [heading, caption, attachment].join('\n');
for (const [name, input, expected] of [
  ['framed Slack request', { rawUserMessage: caption, typedUserMessage: caption }, caption],
  ['empty caption', { rawUserMessage: attachment, typedUserMessage: '' }, ''],
  ['transport omitted literal text', { rawUserMessage: attachment }, ''],
  ['only model text is available', {}, ''],
  ['typed mailto survives exactly', { typedUserMessage: 'Use <mailto:Alex@New.test|Alex@New.test>.' }, 'Use <mailto:Alex@New.test|Alex@New.test>.'],
]) test(name + ' provides only explicitly typed text to approval replacement', async () => {
  await run([{ name: 'resolve_approval', result: {}, inspect(context) {
    assert.equal(context.currentUserMessage, framed);
    assert.equal(context.typedUserMessage, expected);
  } }], { userMessage: framed, extraInstruction: 'A tool retry mentioned alex@retry.test', ...input });
});

test('direct legacy context remains unknown through registry dispatch', async () => {
  const filename = 'src/skills/registry.ts';
  const source = read(filename);
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const fn = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'executeSkillTool');
  assert.ok(fn);
  const registry = compile(`
    const logger = {info(){},warn(){},error(){}};
    const CHANNEL_TOOL_CLAMP = {};
    const getActiveSkills = () => [];
    const CORE_MODULES = [{name:'fixture',executeToolCall: async (name,args,context) => ({same: context === args.original, interactive:context.interactive})}];
    ${fn.getText(tree)}
  `, {}, filename);
  const context = {senderRole:'owner',authority:'owner',surface:'owner_dm',channel:'slack',profile:{}};
  const result = await registry.executeSkillTool('check_calendar_health', {original:context}, context);
  assert.equal(result.same,true);
  assert.equal(result.interactive,undefined);
  assert.equal(Object.hasOwn(context,'interactive'),false);
});
