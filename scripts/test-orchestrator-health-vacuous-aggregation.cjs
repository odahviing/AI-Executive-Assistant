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

async function run(steps) {
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
    userId: 'U_OWNER', senderRole: 'owner', authority: 'owner', surface: 'owner_dm', channel: 'slack', profile,
  });
  assert.equal(execution, steps.length);
  return result;
}

const health = result => ({ name: 'check_calendar_health', result });

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
