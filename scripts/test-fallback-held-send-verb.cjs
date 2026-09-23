// Real orchestrator empty-reply fallback + real turnHelpers summaries; isolated I/O.
// FALLBACK_VERB_BEFORE_DIR selects the preserved orchestrator for fail-before replay.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { DateTime } = require('luxon');
const root = path.resolve(__dirname, '..');
const compiled = new Map();

const held = { scheduled: true, jobId: 'job-1', scheduled_at: '2026-09-21T09:00:00+03:00', _status: 'scheduled_not_sent',
  held_for_recipient_work_hours: true, _note: 'NOT sent yet.' };
const heldSendAt = { scheduled: true, jobId: 'job-2', scheduled_at: '2026-09-21T09:00:00+03:00', _status: 'scheduled_not_sent', _note: 'NOT sent yet.' };
const sent = { ok: true, sent: true, jobId: 'job-3' };
const failed = { ok: false, error: 'connection_not_registered' };
// outreach.ts send_now error/throw after a held copy existed (unconfirmedHeld()).
const unconfirmed = { ok: false, error: 'send_threw', detail: 'socket hang up', delivery_unconfirmed: true, scheduled_copy_cancelled: true };
const msg = (name, result) => ({ name: 'message_colleague', args: { colleague_name: name, colleague_slack_id: `U_${name}`, message: 'heads-up' }, result });

async function run(steps) {
  const unexpected = [], logs = [];
  let modelCalls = 0, executions = 0;
  const profile = { user: { name: 'Owner Person', slack_user_id: 'U_OWNER', timezone: 'Asia/Jerusalem' }, assistant: {} };
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(k => [k, (...a) => logs.push(a)]));
  function load(relative, deps) {
    const filename = relative === 'src/core/orchestrator/index.ts' && process.env.FALLBACK_VERB_BEFORE_DIR
      ? path.resolve(process.env.FALLBACK_VERB_BEFORE_DIR, 'index.before.ts') : path.join(root, relative);
    if (!compiled.has(filename)) compiled.set(filename, ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText);
    const exports = {};
    vm.runInNewContext(compiled.get(filename), { exports, require: name => {
      if (Object.hasOwn(deps, name)) return deps[name];
      unexpected.push(name); throw Error(`Forbidden dependency ${name}`);
    }, Date, Map, Set, structuredClone }, { filename });
    return exports;
  }
  const helpers = load('src/core/orchestrator/turnHelpers.ts', {
    'luxon': { DateTime }, '../../llm/client': { getAnthropicClient: () => ({ messages: { create: async () => { throw Error('no LLM'); } } }) },
    '../../utils/usageLog': { logLlmUsage() {} }, '../../utils/logger': logger,
    '../../utils/attendeeAvailability': { ATTENDEE_REASON_PREFIXES: [] },
  });
  const deps = {
    'node:util': require('node:util'), 'luxon': { DateTime }, '../../utils/logger': logger,
    '../../utils/detectMessageLanguage': { detectMessageLanguage: () => 'English' },
    '../../skills/registry': { WRITE_TOOLS: new Set(), executeSkillTool: async name => {
      const next = steps[executions++]; assert.equal(name, next.name); return structuredClone(next.result);
    } },
    '../../db': { auditLog() {}, recordSocialMoment() {} },
    './turnHelpers': { ...helpers, callClaude: async () => {
      const next = steps[modelCalls++];
      return { stop_reason: next ? 'tool_use' : 'end_turn', content: next
        ? [{ type: 'tool_use', id: `tool-${modelCalls}`, name: next.name, input: structuredClone(next.args) }]
        : [] };
    } },
    './buildTurnContext': { buildTurnContext: async () => ({ messages: [], systemBlocks: [], tools: [], model: 'fixture', maxTokens: 100,
      turnSenderRole: 'owner', turnPersonSlackId: 'U_OWNER', socialActive: false,
      socialClassification: { kind: 'task', conversation_state: 'closing' }, resolvedMeetingAttendees: [],
      availabilityPrecheckToolSummaries: [] }) },
    '../../utils/turnCache': { withTurnCache: fn => fn() },
    '../../utils/rateLimit': { checkAndRecord: () => ({ allowed: true }) },
    '../../utils/toolCallCache': { lookupRecentToolCall: () => null, recordToolCall() {} },
    '../../utils/threadEventLedger': { recordThreadEvent() {}, recordViewedThreadEvents() {}, forgetThreadEvent() {} },
    '../requests/maybeOpenInFlightMeetingRequest': { maybeOpenInFlightMeetingRequest() {} },
    '../requests/colleagueOofReengage': { maybeTrackColleagueOofDeadEnd: async () => {} },
    '../../utils/closeLoopOnOwnerHandled': { closeLoopOnOwnerHandled: async () => ({ scanned: false }) },
  };
  const orchestrator = load('src/core/orchestrator/index.ts', deps);
  const result = await orchestrator.runOrchestrator({ userMessage: 'Give Chris a heads-up', conversationHistory: [],
    threadTs: 'T1', channelId: 'D1', userId: 'U_OWNER', senderRole: 'owner', channel: 'slack',
    authority: 'owner', surface: 'owner_dm', profile });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(unexpected, []);
  assert.equal(executions, steps.length);
  return result.reply;
}

const cases = [
  ['regression: held send (recipient hours) says scheduled, never sent', [msg('Chris', held)], reply => {
    assert.equal(reply, "Done — scheduled the message. Let me know if anything's off.");
  }],
  ['regression: held send (explicit send_at) says scheduled, never sent', [msg('Chris', heldSendAt)], reply => {
    assert.equal(reply, "Done — scheduled the message. Let me know if anything's off.");
  }],
  ['regression: one delivered + one held send names both outcomes', [msg('Dana', sent), msg('Chris', held)], reply => {
    assert.equal(reply, "Done — sent the message and scheduled the message. Let me know if anything's off.");
  }],
  ['regression: unconfirmed send_now never says sent', [msg('Chris', unconfirmed)], reply => {
    assert.equal(reply, "Done — tried to send the message but couldn't confirm it went through. Let me know if anything's off.");
  }],
  ['preserved: immediate delivered send still says sent', [msg('Chris', sent)], reply => {
    assert.equal(reply, "Done — sent the message. Let me know if anything's off.");
  }],
  ['preserved: failed send keeps honest failure fallback', [msg('Chris', failed)], reply => {
    assert.match(reply, /^That didn't go through on my end/);
  }],
];

(async () => {
  let passed = 0, failedCount = 0;
  for (const [name, steps, check] of cases) {
    try {
      const reply = await run(steps);
      check(reply);
      passed++; console.log(`PASS ${name}  -> ${JSON.stringify(reply)}`);
    } catch (e) {
      failedCount++; console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
    }
  }
  console.log(`${passed} passed; ${failedCount} failed`);
  process.exit(failedCount ? 1 : 0);
})();
