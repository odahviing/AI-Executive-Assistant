/* elan-approval-recheck-inperson-20260920 — create_approval's policy_exception
 * re-check (src/tasks/skill.ts) against the REAL validator (utils/scheduleRules.ts,
 * floatingBlocks.ts, workHours.ts) and the REAL owner-ask composer
 * (core/approvals/approvalCallbacks.ts). The 2026-09-20 Tuesday: a colleague's
 * face-to-face ask on the owner's home day; 12:30 is lunch's only room, 13:45 is
 * otherwise clean. Only I/O (calendar read, requests store, Slack, dedup judge,
 * logger) is a fixture; no model, network or production DB.
 *
 * node scripts/test-approval-inperson-recheck.cjs
 * MAELLE_APPROVAL_SOURCE_ROOT=<dir> replays a preserved src/tasks/skill.ts.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const luxon = require('luxon');
const { DateTime, Settings } = luxon;

const root = path.resolve(__dirname, '..');
const sourceRoot = process.env.MAELLE_APPROVAL_SOURCE_ROOT || root;
const laneFiles = new Set(['src/tasks/skill.ts']);
Settings.now = () => Date.parse('2026-09-20T07:04:00Z');
class Clock extends Date { constructor(...a) { super(...(a.length ? a : [Settings.now()])); } static now() { return Settings.now(); } }
const zone = 'Asia/Jerusalem';
const profile = {
  user: { name: 'Idan Cohen', email: 'idan@reflectiz.com', slack_user_id: 'UOWNER', timezone: zone },
  assistant: { name: 'Maelle' },
  schedule: {
    office_days: { days: ['Monday', 'Wednesday', 'Thursday'] },
    home_days: { days: ['Sunday', 'Tuesday'] },
    work_hours: { Sunday: ['09:00-15:30'], Monday: ['10:30-18:15'], Tuesday: ['09:00-15:30', '20:30-23:59'], Wednesday: ['10:30-18:30'], Thursday: ['10:30-18:15'] },
  },
  meetings: {
    physical_meetings_require_office_day: true, buffer_minutes: 0, allowed_durations: [10, 25, 40, 55],
    floating_blocks: [{ name: 'lunch', preferred_start: '11:30', preferred_end: '13:30', duration_minutes: 25, can_skip: true, match_subject_regex: '\\blunch\\b' }],
  },
  categories: [],
};
const ev = (id, subject, start, end) => ({
  id, subject, isCancelled: false, isAllDay: false, showAs: 'busy', categories: [], attendees: [],
  start: { dateTime: start, timeZone: zone }, end: { dateTime: end, timeZone: zone },
});
const events = [
  ev('m', 'Morning block', '2026-09-22T09:00:00', '2026-09-22T11:30:00'),
  ev('a', 'Sync A', '2026-09-22T11:30:00', '2026-09-22T12:30:00'),
  ev('l', 'Lunch', '2026-09-22T12:30:00', '2026-09-22T12:55:00'),
  ev('b', 'Sync B', '2026-09-22T12:55:00', '2026-09-22T13:30:00'),
  ev('c', 'Sync C', '2026-09-22T13:30:00', '2026-09-22T13:45:00'),
];

let passed = 0, failed = 0;
const compiled = new Map();
function harness() {
  const effects = { ownerPosts: [], creates: [], unexpected: [] };
  let row;
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  const mocks = {
    'src/db/requests.ts': {
      getRequest: () => row, updateRequest: (id, data) => { row = { ...row, ...data, ...(data.details ? { details_json: JSON.stringify(data.details) } : {}) }; },
      getAwaitingOwnerRequests: () => [], isKnownRequestThreadAnchor: () => false, getRequestByIdempotencyKey: () => null,
      getRecentOutreachOwnerThread: () => null, buildIdempotencyKey: () => 'key',
      createRequest: args => { effects.creates.push(args); row = { id: 'req_1789887881389_lx5ze', kind: args.kind, subkind: args.subkind, state: args.state, owner_user_id: 'UOWNER', requester_slack_id: args.requesterSlackId, requester_name: args.requesterName, subject: args.subject, description: args.description, details_json: JSON.stringify(args.details), created_at: '2026-09-20 07:04:41' }; return row; },
    },
    'src/core/requests/closeRequest.ts': { closeRequest: () => ({ ok: true }) },
    'src/core/requests/logActivity.ts': { logActivity: noop },
    'src/core/requests/requesterRelay.ts': { isRequesterSendUnconfirmed: () => false, recordRequesterRelayFailure: noop, completeRequesterRelay: noop, relayClosureToRequester: async () => true, usableRelaySubject: x => x, requesterRelayLanguage: () => 'en' },
    'src/db/conversations.ts': { appendToConversation: noop, getConversationHistory: () => [] },
    'src/db/people.ts': { getPersonMemory: () => ({ name: 'Elan Hershcovitz', timezone: zone, timezone_set_by: 'person' }), promoteTimezoneTempById: () => 'applied' },
    'src/db/client.ts': { getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: noop }) }) },
    'src/db/jobs.ts': { createOutreachJob: noop },
    'src/connections/registry.ts': { getConnection: () => ({ sendDirect: async () => ({ ok: true }), postToChannel: async () => ({ ok: true }) }) },
    'src/skills/meetings/ops.ts': { SchedulingSkill: class {} },
    'src/skills/calendarHealth.ts': { CalendarHealthSkill: class {} },
    'src/skills/registry.ts': { executeApprovedSkillTool: async () => ({ status: 'failed', result: {} }) },
    'src/utils/shadowNotify.ts': { shadowNotify: async () => {} },
    'src/connectors/graph/calendarReads.ts': { verifyApprovedCalendarAction: async () => ({ status: 'unavailable' }) },
    'src/connectors/graph/calendar.ts': { getCalendarEvents: async () => events },
    'src/utils/ownerDailyThread.ts': { postOwnerDecision: async args => { effects.ownerPosts.push(args.text); return { ok: true, channel: 'DOWNER', threadTs: 'owner.daily', ts: 'owner.1' }; } },
    'src/utils/logger.ts': { __esModule: true, default: logger, ...logger },
    'src/utils/resolveSlackId.ts': { resolveSlackId: id => ({ slack_id: id, was_hallucinated: false }) },
    'src/llm/models.ts': { MODEL_HAIKU: 'isolated-model' },
    'src/llm/client.ts': { getAnthropicClient: () => ({ messages: { create: async () => ({ content: [{ type: 'text', text: '' }] }) } }) },
    'src/utils/usageLog.ts': { logLlmUsage: noop }, 'src/tasks/briefs.ts': {},
    'src/utils/requestDedup.ts': { judgeRequestDedup: async () => ({ match: 'none' }) },
    'src/utils/closeLoopOnOwnerHandled.ts': {},
    'src/db.ts': { getPendingRequestCountForColleague: () => 0, getMeetingsRequestedBy: () => [] },
    'src/db/scheduleOverrides.ts': { getScheduleOverride: () => null, listScheduleOverrides: () => [] },
    'src/db/calendarIssues.ts': { getSuppressedEventIds: () => new Set() },
    'src/utils/categoryRules.ts': { checkCategorySlot: () => ({ allowed: true }), getProfileCategoryByName: () => null },
    'src/utils/displaySubject.ts': { displaySubject: e => e.subject, PRIVATE_MASK: '[Private]' },
    'src/utils/workingElsewhere.ts': { getTravelContextForInstant: () => undefined },
    'src/utils/weTimeResolver.ts': { StatedTimeClarificationError: class extends Error {}, statedClockPersonContext: () => undefined, statedZoneFromArgs: () => undefined, resolveStatedInstant: input => ({ startIso: input.startIso, endIso: input.endIso }) },
    'src/utils/attendeeAvailability.ts': { loadAttendeeAvailabilityForPerson: (p, fb) => ({ timezone: p?.timezone || fb }), attendeeTzForDay: e => e.timezone },
  };
  const modules = new Map();
  function load(rel) {
    if (Object.hasOwn(mocks, rel)) return mocks[rel];
    if (modules.has(rel)) return modules.get(rel).exports;
    const file = path.join(laneFiles.has(rel) ? sourceRoot : root, rel);
    if (!fs.existsSync(file)) { effects.unexpected.push(rel); throw Error('Unmocked ' + rel); }
    if (!compiled.has(file)) compiled.set(file, ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
    const mod = { exports: {} }; modules.set(rel, mod);
    const req = s => s === 'luxon' ? luxon : ['node:util', 'node:async_hooks', 'node:crypto'].includes(s) ? require(s)
      : s.startsWith('.') ? load(path.posix.normalize(path.posix.join(path.posix.dirname(rel), s)) + '.ts')
      : (() => { effects.unexpected.push(s); throw Error('Blocked external ' + s); })();
    vm.runInNewContext('(function(require,module,exports){' + compiled.get(file) + '\n})', { Date: Clock, Set, Map, setImmediate: noop, setTimeout, clearTimeout, console: undefined }, { filename: rel })(req, mod, mod.exports);
    return mod.exports;
  }
  const skill = load('src/tasks/skill.ts');
  const create = (start, end, isOnline) => new skill.TasksSkill().executeToolCall('create_approval', {
    kind: 'policy_exception',
    ask_text: 'Elan wants 25 min with you on Tuesday for the EmblemHealth scanner report.',
    expires_in_hours: 24,
    payload: {
      subject: 'EmblemHealth scanner report', start, end,
      attendees: [{ email: 'elan@reflectiz.com', name: 'Elan Hershcovitz' }],
      rule: 'would leave no room for one of Idan\'s daily blocks (lunch / break / etc.)', context: 'Elan asked for Tuesday',
      deferred_action: { tool: 'create_meeting', args: { subject: 'EmblemHealth scanner report', start, end, attendees: [{ email: 'elan@reflectiz.com' }], ...(isOnline === undefined ? {} : { is_online: isOnline }) } },
    },
  }, { profile, userId: 'UELAN', authority: 'colleague', senderRole: 'colleague', surface: 'colleague_dm', channelId: 'DELAN', threadTs: 'elan.1' });
  return { create, effects, details: () => JSON.parse(row.details_json) };
}

const cases = [];
const add = (name, fn) => cases.push([name, fn]);
const T = s => `2026-09-22T${s}:00+03:00`;

add('regression: 12:30 in-person on the home day names BOTH lunch and the home-day rule, and the online verdict', async () => {
  const h = harness();
  await h.create(T('12:30'), T('12:55'), false);
  const text = h.effects.ownerPosts.join('\n');
  assert.match(text, /In person, this time breaks:/);
  assert.match(text, /office days/);
  assert.match(text, /Online at the same time would still break:/);
  const inPerson = /In person, this time breaks: ([^\n]*?)\. (?:Online|The same)/.exec(text)?.[1] ?? '';
  assert.match(inPerson, /office days/);
  assert.match(inPerson, /no room for your lunch/);
  const online = /Online at the same time would still break: ([^\n]*)/.exec(text)?.[1] ?? '';
  assert.match(online, /no room for your lunch/);
  assert.doesNotMatch(online, /office days/);
  assert.match(h.details().rule_label, /office days/);
  assert.match(h.details().rule_label, /lunch/);
});
add('regression: 13:45 in-person on the home day is not called clean and offers the online alternative', async () => {
  const h = harness();
  await h.create(T('13:45'), T('14:10'), false);
  const text = h.effects.ownerPosts.join('\n');
  assert.match(text, /In person, this time breaks: in-person meetings are only on your office days/);
  assert.match(text, /The same time works as an online meeting with no rule broken/);
  assert.equal(h.details().rule, 'in_person_on_home_day');
});
add('preserved: an online ask at 12:30 keeps the single lunch reason and no in-person line', async () => {
  const h = harness();
  await h.create(T('12:30'), T('12:55'), true);
  const text = h.effects.ownerPosts.join('\n');
  assert.doesNotMatch(text, /In person/);
  assert.equal(h.details().rule, 'floating_block_overlap');
  assert.doesNotMatch(h.details().rule_label, /office days/);
});
add('preserved: the stored action a tick replays is the exact requested booking', async () => {
  const h = harness();
  await h.create(T('13:45'), T('14:10'), false);
  const action = h.details().deferred_action;
  assert.equal(action.tool, 'create_meeting');
  assert.equal(action.args.start, T('13:45'));
  assert.equal(action.args.is_online, false);
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); passed++; console.log('ok - ' + name); }
    catch (err) { failed++; console.log('not ok - ' + name + '\n  ' + String(err && err.message || err).split('\n').slice(0, 6).join('\n  ')); }
  }
  console.log(`${passed} passed; ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
