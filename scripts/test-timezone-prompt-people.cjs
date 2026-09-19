// Actual buildSystemPromptParts caller with the real people-memory formatter.
// Other prompt inputs are isolated fixtures; no app startup, DB file or network.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const luxon = require('luxon');
const { DateTime, Settings } = luxon;
const root = path.resolve(__dirname, '..');
const snapshot = process.env.INSTRUCTOR_SNAPSHOT;
const wordingSnapshot = process.env.INSTRUCTOR_WORDING_SNAPSHOT;
const modules = new Map();
const noop = () => {};
let rows = [];
let peopleReads = 0;

function sourceFor(rel) {
  const selected = rel === 'src/core/orchestrator/systemPrompt.ts'
    ? snapshot
    : rel === 'src/utils/weTimeResolver.ts'
      ? wordingSnapshot
      : null;
  const prior = selected ? path.join(root, selected, rel) : null;
  return fs.readFileSync(prior && fs.existsSync(prior) ? prior : path.join(root, rel), 'utf8');
}

function load(rel) {
  if (modules.has(rel)) return modules.get(rel).exports;
  const mod = { exports: {} };
  modules.set(rel, mod);
  const js = ts.transpileModule(sourceFor(rel), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const people = () => load('src/db/people.ts');
  const mocks = {
    'src/skills/registry': { getActiveSkills: () => [], getSkillTools: () => [] },
    'src/utils/skillPreferences': { formatSystemPromptPreferenceBlocks: () => '' },
    'src/utils/logger': { __esModule: true, default: { info: noop, warn: noop, debug: noop, error: noop } },
    'src/db/requests': { getAwaitingOwnerRequests: () => [], getOpenRequestsForThread: () => [], getUnrelayedTerminalRequestForThread: () => null },
    'src/core/requests/types': { parseDetails: () => null },
    'src/core/assistantSelf': { formatAssistantSelfForPrompt: () => '' },
    'src/memory/peopleMemory': { formatPeopleCatalogSync: () => '', readPersonMemorySync: () => '' },
    'src/utils/effectiveToday': { getEffectiveToday: profile => DateTime.now().setZone(profile.user.timezone).startOf('day') },
    'src/connections/registry': { listConnections: () => [] },
    'src/db/client': { getDb: () => ({ prepare: () => ({ all: () => { peopleReads++; return rows; } }) }) },
    'src/db/socialSubjects': { getActiveSubjectsForPerson: () => [], getRecentTopicBeats: () => [] },
    'src/db/engagementRank': { isCurrentRankOwnerAuthored: () => false },
    'src/llm/client': { getAnthropicClient: () => { throw new Error('Unexpected model call'); } },
    'src/llm/models': {},
    'src/config': { config: {} },
    'src/config/userProfile': { getTenantWorkdaysForTimezone: () => undefined },
  };
  function req(spec) {
    if (spec === 'luxon') return luxon;
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
    if (resolved === 'src/memory/resolveAttendeeEmails') return load(resolved + '.ts');
    if (resolved === 'src/utils/timezoneConvert') return load('src/utils/timezoneConvert.ts');
    if (resolved === 'src/utils/locationTz' || resolved === 'src/utils/timezoneValidator' || resolved === 'src/utils/workingHoursDefault') return load(resolved + '.ts');
    throw new Error(`Unexpected dependency: ${resolved}`);
  }
  vm.runInNewContext(`(function(require,module,exports){${js}\n})`, { Date, console, Set, Map }, { filename: rel })(req, mod, mod.exports);
  return mod.exports;
}

const trip = (location, from, until) => JSON.stringify({ location, from, until });
const row = overrides => ({
  person_id: overrides.slack_id,
  kind: 'internal',
  name: overrides.name,
  timezone: 'America/New_York',
  timezone_set_by: 'person',
  notes: '[]',
  profile_json: '{}',
  interaction_log: '[]',
  last_seen: '2026-09-14T20:00:00Z',
  ...overrides,
});
const profile = (timezone, social) => ({
  user: { name: 'Owner Example', role: 'Founder', email: 'owner@example.test', slack_user_id: 'UOWNER', timezone, language: 'en' },
  assistant: { name: 'Maelle', persona: 'A warm and concise professional teammate.' },
  schedule: { office_days: { days: ['Monday'] }, home_days: { days: ['Tuesday'] }, day_boundary_hour: '00:00' },
  skills: { social },
  channels: {},
});
function build(timezone, social, focus, role = 'owner') {
  return load('src/core/orchestrator/systemPrompt.ts').buildSystemPromptParts(
    profile(timezone, social), role, role === 'owner' ? 'Owner Example' : 'Colleague', false, focus,
  ).dynamic;
}

test('system prompt passes owner timezone into real current and upcoming travel rendering', () => {
  Settings.now = () => Date.parse('2026-09-14T22:00:00Z');
  rows = [
    row({ slack_id: 'UCURRENT', name: 'Current Contact', currently_traveling: trip('Tokyo', '2026-09-15', '2026-09-18') }),
    row({ slack_id: 'UFUTURE', name: 'Future Contact', currently_traveling: trip('Paris', '2026-09-16', '2026-09-18') }),
  ];
  const prompt = build('Asia/Jerusalem', false);
  assert.match(prompt, /Current Contact .*currently in Tokyo until 2026-09-18/);
  assert.match(prompt, /Future Contact .*upcoming travel to Paris from 2026-09-16 until 2026-09-18/);
});

test('system prompt preserves focus and social controls at the migrated argument positions', () => {
  Settings.now = () => Date.parse('2026-09-14T12:00:00Z');
  rows = [row({ slack_id: 'UFOCUS', name: 'Focus Contact', notes: JSON.stringify([{ date: '2026-09-14', note: 'private social detail' }]) })];
  assert.match(build('UTC', true, new Set(['UFOCUS'])), /private social detail/);
  assert.doesNotMatch(build('UTC', true, new Set()), /private social detail/);
  assert.doesNotMatch(build('UTC', false, new Set(['UFOCUS'])), /private social detail|last social:/);
});

test('colleague prompt keeps the owner contact roster private', () => {
  peopleReads = 0;
  rows = [row({ slack_id: 'UPRIVATE', name: 'Private Contact', notes: JSON.stringify([{ date: '2026-09-14', note: 'owner-only note' }]) })];
  const prompt = build('America/Los_Angeles', true, new Set(['UPRIVATE']), 'colleague');
  assert.equal(peopleReads, 0);
  assert.doesNotMatch(prompt, /Private Contact|owner-only note/);
});

test('dual-clock narration names the dated travel timezone without a present-tense claim', () => {
  const resolver = load('src/utils/weTimeResolver.ts');
  const travel = { isAway: true, effectiveTz: 'America/New_York', location: 'Boston' };
  assert.equal(
    resolver.renderWeDualClock('2026-09-15T21:30:00Z', travel, 'Asia/Jerusalem'),
    'Tue 15 Sep 17:30 EDT your travel timezone / Wed 16 Sep 00:30 your home time',
  );
  assert.equal(
    resolver.renderWeDualClock('2026-09-15T21:30:00Z', travel, 'Asia/Jerusalem', { ownerName: 'Owner' }),
    "Tue 15 Sep 17:30 EDT Owner's travel timezone / Wed 16 Sep 00:30 Owner's home time",
  );
});

// Captured prompt inputs only; these assertions do not simulate model obedience.
function emailPromptCapture(flagged, channel = 'email') {
  rows = [];
  const parts = load('src/core/orchestrator/systemPrompt.ts').buildSystemPromptParts(
    profile('UTC', false), 'owner', 'Owner Example', false, undefined,
    false, false, undefined, 'UOWNER', undefined, undefined, channel,
  );
  const fixtureUser = flagged
    ? "Timezone clarification needed for: Alex Example. The stated timezone is accepted, but its participant mapping is unclear. Ask a concise, forwardable clarification about which person's timezone it is; do not guess an association or include internal notes to the owner.\nForwarded scheduling chain."
    : 'Forwarded scheduling chain with confirmed participant timezones.';
  const user = process.env.EMAIL_ATTRIBUTION_TURNS_DIR && channel === 'email'
    ? JSON.parse(fs.readFileSync(path.join(process.env.EMAIL_ATTRIBUTION_TURNS_DIR, `${flagged ? 'uncertain' : 'certain'}-turn.json`), 'utf8')).userMessage
    : fixtureUser;
  const capture = { ...parts, user };
  if (process.env.EMAIL_ATTRIBUTION_CAPTURE_DIR) {
    fs.writeFileSync(path.join(process.env.EMAIL_ATTRIBUTION_CAPTURE_DIR, `${channel}-${flagged ? 'flagged' : 'ordinary'}.json`), JSON.stringify(capture, null, 2));
  }
  return capture;
}

test('email attribution flag has a forwardable clarification exception in actual prompt', () => {
  const capture = emailPromptCapture(true);
  assert.match(capture.user, /Timezone clarification needed for:/);
  assert.match(capture.dynamic, /except when this turn explicitly flags "Timezone clarification needed for:"/);
  assert.match(capture.dynamic, /With that flag, write one concise, forwardable question asking whose timezone was stated/);
  assert.match(capture.dynamic, /Keep it addressed to the externals\. Otherwise, offer only the slots/);
  assert.match(capture.dynamic, /Slot options must be complete enough to forward untouched/);
});

test('ordinary email preserves external-only slots language and no owner notes', () => {
  const capture = emailPromptCapture(false);
  assert.doesNotMatch(capture.user, /Timezone clarification needed for:/);
  assert.match(capture.dynamic, /Compose ONLY this forwardable text — no note to Owner, no assumptions or questions addressed to him/);
  assert.match(capture.dynamic, /No added offer to help with anything else/);
  assert.match(capture.dynamic, /each candidate time in every attendee's own local zone, the duration, and the subject and context/);
  assert.match(capture.dynamic, /reply in its language \(the externals' own\)/);
});

test('email clarification rule remains absent from Slack and cached prompt', () => {
  const email = emailPromptCapture(true), slack = emailPromptCapture(false, 'slack');
  assert.doesNotMatch(email.static, /Timezone clarification needed for:/);
  assert.doesNotMatch(slack.dynamic, /EMAIL REPLY|Timezone clarification needed for:/);
});
