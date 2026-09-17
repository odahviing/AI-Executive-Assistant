// Verification only: the actual src/db/requests.ts selection + the actual
// src/core/orchestrator/systemPrompt.ts caller, in an isolated VM. DB rows and
// conversation history are fixtures; no app startup, DB file or network.
//
// Incident 2026-09-16 (Chris Kelley, req_1786971618475_ae5kz): a flag cancelled
// 2026-08-19 in a 1:1 DM was led with as news four weeks later, ahead of an
// unrelated new ask, because the DM's thread key never changes and the terminal
// status relay had no once-only or recency bound.
//
// node --test scripts/test-stale-terminal-request-relay.cjs [--source-root <pre-fix checkout>]
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const luxon = require('luxon');
const { DateTime, Settings } = luxon;

const rootArg = process.argv.indexOf('--source-root');
const root = rootArg < 0 ? path.resolve(__dirname, '..') : path.resolve(process.argv[rootArg + 1]);
const modules = new Map();
const noop = () => {};

// ── fixtures (mutable per test) ─────────────────────────────────────────────
let requestRow = null;   // the thread's newest `requests` row, as getLatestRequestForThread's SELECT would return it
let history = [];        // conversation_threads.context for the thread

const OWNER = 'UOWNER';
const CHRIS = 'U0BAZMDRLM7';
const THREAD = '1786970921.637139';  // the DM's first-message ts — the key for the whole 1:1 relationship
const STATUS = /STATUS OF THE REQUEST IN THIS THREAD/;

function load(rel) {
  if (modules.has(rel)) return modules.get(rel).exports;
  const mod = { exports: {} };
  modules.set(rel, mod);
  const js = ts.transpileModule(fs.readFileSync(path.join(root, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const people = () => load('src/db/people.ts');
  const mocks = {
    'src/skills/registry': { getActiveSkills: () => [], getSkillTools: () => [] },
    'src/utils/skillPreferences': { formatSystemPromptPreferenceBlocks: () => '' },
    'src/utils/logger': { __esModule: true, default: { info: noop, warn: noop, debug: noop, error: noop } },
    'src/core/requests/types': { parseDetails: () => null, APPROVAL_SUBKINDS: [], FREEFORM_OWNER_ASK_SUBKIND: 'freeform_owner_ask' },
    'src/core/requests/activityRevertibility': { ACTIVITY_REVERTIBILITY: {} },
    'src/core/assistantSelf': { formatAssistantSelfForPrompt: () => '' },
    'src/memory/peopleMemory': { formatPeopleCatalogSync: () => '', readPersonMemorySync: () => '' },
    'src/utils/effectiveToday': { getEffectiveToday: profile => DateTime.now().setZone(profile.user.timezone).startOf('day') },
    'src/connections/registry': { listConnections: () => [] },
    'src/db/conversations': { getConversationHistory: threadTs => (threadTs === THREAD ? history : []) },
    'src/db/client': {
      getDb: () => ({
        prepare: sql => ({
          all: () => [],
          get: (...args) => {
            if (!/FROM requests/.test(sql)) return undefined;
            assert.match(sql, /origin_thread_ts = \?/, 'thread-scoped lookup');
            assert.deepEqual(args, [OWNER, THREAD]);
            return requestRow ?? undefined;
          },
        }),
      }),
    },
    'src/db/socialSubjects': { getActiveSubjectsForPerson: () => [], getRecentTopicBeats: () => [] },
    'src/db/engagementRank': { isCurrentRankOwnerAuthored: () => false },
    'src/llm/client': { getAnthropicClient: () => { throw new Error('Unexpected model call'); } },
    'src/llm/models': {},
    'src/config': { config: {} },
    'src/config/userProfile': { getTenantWorkdaysForTimezone: () => undefined },
  };
  function req(spec) {
    if (spec === 'luxon') return luxon;
    if (spec === 'crypto') return require('node:crypto');
    const resolved = spec.startsWith('.')
      ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec))
      : spec;
    if (resolved === 'src/db') return {
      ...people(),
      formatPreferencesCatalog: () => '',
      formatThreadPeopleBlock: () => '',
      getPersonMemory: () => null,
    };
    if (Object.hasOwn(mocks, resolved)) return mocks[resolved];
    if (resolved === 'src/db/requests') return load('src/db/requests.ts');
    if (resolved === 'src/memory/resolveAttendeeEmails') return load(resolved + '.ts');
    if (resolved === 'src/utils/timezoneConvert') return load('src/utils/timezoneConvert.ts');
    if (resolved === 'src/utils/locationTz' || resolved === 'src/utils/timezoneValidator' || resolved === 'src/utils/workingHoursDefault') return load(resolved + '.ts');
    throw new Error(`Unexpected dependency: ${resolved}`);
  }
  vm.runInNewContext(`(function(require,module,exports){${js}\n})`, { Date, console, Set, Map, Number }, { filename: rel })(req, mod, mod.exports);
  return mod.exports;
}

const profile = {
  user: { name: 'Idan Example', role: 'Founder', email: 'owner@example.test', slack_user_id: OWNER, timezone: 'Asia/Jerusalem', language: 'en' },
  assistant: { name: 'Maelle', persona: 'A warm and concise professional teammate.' },
  schedule: { office_days: { days: ['Monday'] }, home_days: { days: ['Tuesday'] }, day_boundary_hour: '00:00' },
  skills: {},
  channels: {},
};

/** Colleague (Chris) typing in his own 1:1 DM thread, unless `senderId` says the owner is. */
function colleaguePrompt(senderId = CHRIS) {
  return load('src/core/orchestrator/systemPrompt.ts').buildSystemPromptParts(
    profile, 'colleague', 'Chris Kelley', false, undefined, false, false, THREAD, senderId, undefined, undefined, 'slack', 'colleague',
  ).dynamic;
}

const NOW = '2026-09-16T13:24:16.000Z';  // the incident turn
const secs = iso => (Date.parse(iso) / 1000).toFixed(6);
const row = overrides => ({
  id: 'req_1786971618475_ae5kz', owner_user_id: OWNER, kind: 'reminder', subkind: 'freeform_owner_flag',
  state: 'cancelled', subject: 'Needs your read: Interview with Paul Kammerezelt this week',
  requester_slack_id: CHRIS, requester_name: 'Chris Kelley', origin_thread_ts: THREAD, origin_channel: 'D0BKUQ7E21Y',
  created_at: '2026-08-17 13:00:18', updated_at: '2026-08-19 05:34:23', closed_at: '2026-08-19T05:34:23.324Z',
  closure_reason: 'owner_cancel_task_tool', requester_notified_at: null, details_json: null, outcome_json: null,
  ...overrides,
});
/** Chris's real thread shape: an exchange on 08-17, silence, then a new ask on 09-16. */
const incidentHistory = () => [
  { role: 'user', content: 'Hello again - could Idan do a 30 minute interview some night this week?', ts: THREAD },
  { role: 'assistant', content: "Nothing's opening up this week. Who's the candidate?", ts: '1786971054.211000' },
  { role: 'user', content: 'the candidate is new, Paul Kammerezelt', ts: '1786971599.915199' },
  { role: 'assistant', content: "I'll take it to Idan with a real time attached.", ts: '1786971664.890000' },
  { role: 'user', content: 'hello - would Idan be able to meet with an interview candidate tomorrow at 1030 my time?', ts: secs(NOW) },
];

test.beforeEach(() => { Settings.now = () => Date.parse(NOW); requestRow = null; history = []; });

// ── regressions (fail before the fix) ───────────────────────────────────────

test('R1 · incident: a four-week-old cancelled flag, never relayed, is not led with in a 1:1 DM', () => {
  requestRow = row();
  history = incidentHistory();
  assert.doesNotMatch(colleaguePrompt(), STATUS);
  assert.doesNotMatch(colleaguePrompt(), /Paul Kammerezelt/);
});

test('R2 · once only: a fresh closure Maelle has already replied after is not repeated', () => {
  requestRow = row({ closed_at: '2026-09-16T11:00:00.000Z', updated_at: '2026-09-16 11:00:00' });
  history = [
    { role: 'user', content: 'any update?', ts: secs('2026-09-16T10:00:00Z') },
    { role: 'assistant', content: 'That ask was cancelled, nothing pending with Idan.', ts: secs('2026-09-16T12:00:00Z') },  // the reply that carried the status
    { role: 'user', content: 'ok thanks. separate thing — can he do Thursday?', ts: secs(NOW) },
  ];
  assert.doesNotMatch(colleaguePrompt(), STATUS);
});

test('R3 · already relayed: a closure the spine confirmed it told the requester about is not re-announced', () => {
  requestRow = row({ state: 'resolved', closed_at: '2026-09-16T12:00:00.000Z', requester_notified_at: '2026-09-16T12:00:01.000Z' });
  history = [
    { role: 'user', content: 'can he do Tuesday 3pm?', ts: secs('2026-09-16T09:00:00Z') },
    { role: 'assistant', content: "I'll check with Idan.", ts: secs('2026-09-16T09:00:30Z') },
    { role: 'assistant', content: 'Idan said yes to Tuesday 3pm.' },  // notifyRequesterOfDecision's history append carries no ts
    { role: 'user', content: 'great, thanks!', ts: secs(NOW) },
  ];
  assert.doesNotMatch(colleaguePrompt(), STATUS);
});

test('R4 · the prompt and the social-directive gate read one selection', () => {
  const requests = load('src/db/requests.ts');
  assert.equal(typeof requests.getUnrelayedTerminalRequestForThread, 'function');
  requestRow = row();
  history = incidentHistory();
  assert.equal(requests.getUnrelayedTerminalRequestForThread(OWNER, THREAD), null);
  requestRow = row({ closed_at: '2026-09-16T12:00:00.000Z' });
  assert.equal(requests.getUnrelayedTerminalRequestForThread(OWNER, THREAD)?.id, 'req_1786971618475_ae5kz');
  const turnContext = fs.readFileSync(path.join(root, 'src/core/orchestrator/buildTurnContext.ts'), 'utf8');
  assert.match(turnContext, /getUnrelayedTerminalRequestForThread\(profile\.user\.slack_user_id, threadTs\)/);
  assert.doesNotMatch(turnContext, /getLatestRequestForThread/);
});

// ── preserved (pass before and after) ───────────────────────────────────────

test('P1 · gh#179 shape: a colleague coming back after a fresh, never-relayed cancellation still hears the honest status', () => {
  requestRow = row({ closed_at: '2026-09-16T12:00:00.000Z', updated_at: '2026-09-16 12:00:00' });
  history = [
    { role: 'user', content: 'can he do Tuesday 3pm?', ts: secs('2026-09-15T09:00:00Z') },
    { role: 'assistant', content: "I'll check with Idan.", ts: secs('2026-09-15T09:00:30Z') },
    { role: 'user', content: 'any update?', ts: secs(NOW) },
  ];
  const prompt = colleaguePrompt();
  assert.match(prompt, STATUS);
  assert.match(prompt, /is CLOSED: it was cancelled\. Nothing is pending with Idan/);
});

test('P2 · a fresh resolved request the requester was never told about renders the RESOLVED status', () => {
  requestRow = row({ kind: 'approval', subkind: 'freeform', state: 'resolved', closed_at: '2026-09-16T12:00:00.000Z', subject: 'Tuesday 3pm with Sarah' });
  history = [
    { role: 'user', content: 'can he do Tuesday 3pm?', ts: secs('2026-09-15T09:00:00Z') },
    { role: 'assistant', content: "I'll check with Idan.", ts: secs('2026-09-15T09:00:30Z') },
    { role: 'user', content: 'any update?', ts: secs(NOW) },
  ];
  assert.match(colleaguePrompt(), /"Tuesday 3pm with Sarah" was RESOLVED by Idan/);
});

test('P3 · a still-open newest row renders no terminal status (the open-request sections own it)', () => {
  requestRow = row({ state: 'awaiting_owner', closed_at: null, closure_reason: null });
  history = incidentHistory();
  assert.doesNotMatch(colleaguePrompt(), STATUS);
});

test('P4 · a thread that never carried a request renders nothing', () => {
  requestRow = null;
  history = incidentHistory();
  assert.doesNotMatch(colleaguePrompt(), STATUS);
});

test('P5 · the authenticated owner never receives colleague-facing status text', () => {
  requestRow = row({ closed_at: '2026-09-16T12:00:00.000Z' });
  history = [{ role: 'user', content: 'status?', ts: secs(NOW) }];
  assert.doesNotMatch(colleaguePrompt(OWNER), STATUS);
});

test('P6 · legacy history with no reply timestamps cannot bound the closure — the status still renders', () => {
  requestRow = row({ closed_at: '2026-09-16T12:00:00.000Z' });
  history = [
    { role: 'user', content: 'can he do Tuesday 3pm?' },
    { role: 'assistant', content: "I'll check with Idan." },
    { role: 'user', content: 'any update?' },
  ];
  assert.match(colleaguePrompt(), STATUS);
});
