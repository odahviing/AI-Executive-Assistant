// Actual message_colleague (src/skills/outreach.ts), the shared recipient business-time
// spine (responseDeadline / attendeeAvailability / workingHoursDefault), the outreach
// payload bridge (src/db/jobs.ts), the scheduled-send timer (core/requests/runner.ts)
// and the ACTUAL people store (src/db/people.ts) on in-memory SQLite. The Slack
// Connection (collectCoreInfo / sendDirect), the requests-spine row, logger and every
// other neighbour are fixtures; no model, network or production DB is touched.
// OUTREACH_TZ_BEFORE=1 replays src/skills/outreach.ts from the baseline commit.
//
// Invariant under test: colleague-sends-respect-recipient-work-hours for a recipient
// whose people_memory row does not exist (or carries no zone) at send time.
const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { Settings } = require('luxon');

const root = path.resolve(__dirname, '..');
// Optional immutable source snapshot for review; module dependencies still use
// the installed repository libraries and the same isolated fixtures.
const sourceRoot = process.env.OUTREACH_TZ_SOURCE_ROOT || root;
const baseline = 'edd243330307d5dd025e8dc4f7770da24aab16c3';
const before = process.env.OUTREACH_TZ_BEFORE === '1';
const laneFiles = new Set(['src/skills/outreach.ts']);
const actual = new Set([...laneFiles,
  'src/utils/responseDeadline.ts', 'src/utils/attendeeAvailability.ts', 'src/utils/workingHoursDefault.ts',
  'src/utils/timezoneConvert.ts', 'src/utils/weTimeResolver.ts', 'src/utils/workHours.ts', 'src/utils/timezoneValidator.ts',
  'src/core/requests/types.ts', 'src/db/jobs.ts', 'src/db/people.ts', 'src/core/requests/runner.ts',
  'src/core/requests/colleagueOofReengage.ts', 'src/core/approvals/approvalCallbacks.ts',
]);
const compiled = new Map();
const COLLEAGUE = 'UCOLLEAGUE', OWNER = 'UOWNER';
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const IL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
const hours = (workdays) => JSON.stringify({ workdays, hoursStart: '09:00', hoursEnd: '17:00' });

let now = Date.parse('2026-09-14T06:00:00Z');
class Clock extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
Settings.now = () => now;
afterEach(() => { Settings.now = () => now; });

function compile(rel) {
  if (!compiled.has(rel)) {
    const source = before && laneFiles.has(rel)
      ? cp.execFileSync('git', ['show', `${baseline}:${rel}`], { cwd: root, encoding: 'utf8' })
      : fs.readFileSync(path.join(sourceRoot, rel), 'utf8');
    const exported = rel === 'src/core/requests/runner.ts' ? source + '\nexport { runSendScheduledOutreach };' : source;
    compiled.set(rel, ts.transpileModule(exported, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
  }
  return compiled.get(rel);
}

function harness(options = {}) {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE people_memory(
    person_id TEXT PRIMARY KEY, slack_id TEXT UNIQUE, name TEXT, email TEXT, kind TEXT, source TEXT,
    timezone TEXT, timezone_set_by TEXT, timezone_temp TEXT, state TEXT, state_set_by TEXT,
    name_set_by TEXT, name_he TEXT, name_he_set_by TEXT, email_set_by TEXT,
    gender TEXT NOT NULL DEFAULT 'unknown', gender_set_by TEXT, gender_confirmed INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '[]', profile_json TEXT NOT NULL DEFAULT '{}', interaction_log TEXT NOT NULL DEFAULT '[]',
    social_topics TEXT NOT NULL DEFAULT '[]', working_hours_auto TEXT, currently_traveling TEXT,
    is_vip INTEGER NOT NULL DEFAULT 0, engagement_rank INTEGER NOT NULL DEFAULT 2, proactive_pending INTEGER NOT NULL DEFAULT 0,
    last_inbound_lang TEXT, last_inbound_lang_at TEXT, last_social_at TEXT, last_initiated_at TEXT, last_social_capture_unknown_at TEXT,
    last_seen TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const insert = row => sqlite.prepare(`INSERT INTO people_memory(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(k => '@' + k).join(',')})`).run(row);
  if (options.person) insert({ person_id: `p_${COLLEAGUE}`, slack_id: COLLEAGUE, name: 'Colleague', kind: 'internal', source: 'slack', last_seen: '2026-09-01 00:00:00', ...options.person });

  const profile = {
    user: { name: 'Owner Example', slack_user_id: OWNER, email: 'owner@example.com', timezone: 'Asia/Jerusalem' },
    assistant: { name: 'Maelle' },
    schedule: { work_hours: Object.fromEntries(IL_DAYS.map(day => [day, ['09:00-17:00']])), office_days: { days: IL_DAYS }, home_days: { days: [] } },
  };
  let row, job;
  const sends = [], coreCalls = [], logs = [], closures = [], modules = new Map();
  const sendResults = [...(options.sendResults ?? [])];
  const noop = () => {};
  // The requests-spine row: one in-memory object, the way test-timezone-registrar-deadline.cjs holds it.
  const update = (id, data) => {
    row = { ...row, ...data };
    for (const [k, v] of Object.entries({ nextCheckAt: 'next_check_at', nextCheckHandler: 'next_check_handler', originChannel: 'origin_channel', originThreadTs: 'origin_thread_ts' })) if (Object.hasOwn(data, k)) row[v] = data[k];
    if (data.details) row.details_json = JSON.stringify(data.details);
  };
  const requests = {
    getOpenRequestsForColleague: () => [], getAwaitingOwnerRequests: () => options.pendingApproval ? [{ id: 'req_approval', kind: 'approval', requester_slack_id: COLLEAGUE, owner_dm_thread_ts: 'owner.1' }] : [], getRequest: () => row, getRequestByIdempotencyKey: () => undefined,
    buildIdempotencyKey: () => 'key', getDueRequests: () => row ? [row] : [], updateRequest: update,
    createRequest: p => { row = { id: 'req_test', owner_user_id: p.ownerUserId, target_slack_id: p.targetSlackId, target_name: p.targetName, kind: p.kind, state: p.state, phase: p.phase, subject: p.subject, description: p.description, origin_channel: p.originChannel, origin_thread_ts: p.originThreadTs, next_check_at: p.nextCheckAt, next_check_handler: p.nextCheckHandler, details_json: JSON.stringify(p.details) }; return row; },
  };
  // outreach_jobs is payload held in memory; every people_memory statement runs on the real store.
  const jobStatement = sql => ({
    run: p => { if (sql.includes('INSERT INTO outreach_jobs')) job = JSON.parse(JSON.stringify(p)); else if (sql.includes('UPDATE outreach_jobs')) job = { ...job, ...p }; else throw Error('Unhandled SQL ' + sql); },
    get: () => job,
  });
  const db = { prepare: sql => sql.includes('outreach_jobs') ? jobStatement(sql) : sqlite.prepare(sql), transaction: fn => fn, exec: sql => sqlite.exec(sql) };
  const send = async (id, body, opts) => {
    sends.push({ id, body, opts });
    const result = sendResults.shift();
    if (result instanceof Error) throw result;
    return result ?? (options.userNotFound ? { ok: false, reason: 'user_not_found' } : { ok: true, ref: id.startsWith('C') ? id : 'DCOLLEAGUE', ts: 'out.1' });
  };
  const conn = {
    collectCoreInfo: async ref => {
      coreCalls.push(ref);
      if (options.readThrows) throw Error('ratelimited');
      if (options.userNotFound) return null;
      return Object.hasOwn(options, 'coreInfo') ? options.coreInfo : { timezone: 'America/New_York', displayName: 'Colleague Slack', email: 'colleague@example.com' };
    },
    sendDirect: send,
    postToChannel: send,
    resolveDirectChannelId: async () => 'DOWNER',
  };
  if (options.noCoreMethod) delete conn.collectCoreInfo;
  const mocks = {
    'src/db/client.ts': { getDb: () => db },
    'src/db/requests.ts': requests,
    'src/db/socialSubjects.ts': { getActiveSubjectsForPerson: () => [], getRecentTopicBeats: () => [] },
    'src/db/engagementRank.ts': { isCurrentRankOwnerAuthored: () => false },
    'src/memory/resolveAttendeeEmails.ts': { nameGenuinelyMatches: () => false },
    'src/memory/peopleMemory.ts': { mergePersonMdFiles: noop },
    'src/config/userProfile.ts': { getTenantWorkdaysForTimezone: tz => tz === 'Asia/Jerusalem' ? IL_DAYS : undefined },
    'src/utils/locationTz.ts': { inferTimezoneFromStateStatic: () => undefined },
    'src/utils/logger.ts': { __esModule: true, default: Object.fromEntries(['info', 'debug', 'warn', 'error'].map(k => [k, (...a) => logs.push([k, ...a])])) },
    'src/connections/registry.ts': { getConnection: () => options.noConnection ? undefined : conn },
    // Capture the real callers' close requests; terminal persistence/cascade is
    // outside this harness and is not claimed as exercised here.
    'src/core/requests/closeRequest.ts': { closeRequest: p => { closures.push(p); if (row) row.state = p.state; } },
    'src/core/requests/resolver.ts': { withRequestLock: (_id, fn) => fn(), closeUnconfirmedExecution: noop },
    'src/core/requests/logActivity.ts': { logActivity: noop },
    'src/utils/threadActivity.ts': { reactActivityComplete: async () => {} },
    'src/utils/resolveSlackId.ts': { resolveSlackId: id => ({ slack_id: id, was_hallucinated: false }) },
    'src/utils/ownerDailyThread.ts': { postOwnerDecision: async () => ({ ok: true }) },
    'src/db/scheduleOverrides.ts': { getScheduleOverride: () => undefined },
    'src/utils/workingElsewhere.ts': { getTravelContextForInstant: () => ({ isAway: false, effectiveTz: profile.user.timezone, location: '' }) },
    'src/utils/scheduleRules.ts': {}, 'src/connectors/graph/calendarReads.ts': {}, 'src/connectors/graph/calendar.ts': {},
    'src/llm/client.ts': { getAnthropicClient: () => ({ messages: { create: async () => ({ content: [{ text: '' }] }) } }) }, 'src/llm/models.ts': {},
    'src/utils/shadowNotify.ts': { shadowNotify: async () => {} }, 'src/utils/extractJson.ts': {},
    'src/core/requests/requesterRelay.ts': { relayClosureToRequester: async () => {}, usableRelaySubject: x => typeof x === 'string' ? x : '', requesterRelayLanguage: () => 'en', completeRequesterRelay: noop, isRequesterSendUnconfirmed: () => false, recordRequesterRelayFailure: noop, retryRequesterRelay: async () => {} },
    'src/core/requests/deferredActionReplay.ts': {}, 'src/utils/textScrubber.ts': { INTERNAL_WORK_ITEM_ID_RE: /req_\w+/ },
    'src/db/conversations.ts': { appendToConversation: noop, getConversationHistory: () => [] }, 'src/utils/usageLog.ts': {},
    'src/connectors/slack/recentOutboundContext.ts': {}, 'src/connections/slack/formatting.ts': { formatForSlack: x => x },
  };
  function load(rel) {
    if (rel === 'src/db.ts') return { ...load('src/db/people.ts'), ...load('src/db/jobs.ts'), getOutreachJobsByColleague: () => job ? [job] : [], logEvent: noop, appendToConversation: noop };
    if (Object.hasOwn(mocks, rel)) return mocks[rel];
    if (modules.has(rel)) return modules.get(rel).exports;
    if (!actual.has(rel)) throw Error('Unhandled module ' + rel);
    const mod = { exports: {} };
    modules.set(rel, mod);
    const req = s => s === 'luxon' ? require('luxon') : s === '@anthropic-ai/sdk' ? {} : s.startsWith('.') ? load(path.posix.normalize(path.posix.join(path.posix.dirname(rel), s)) + '.ts') : require(s);
    vm.runInNewContext('(function(require,module,exports){' + compile(rel) + '\n})', { Date: Clock, console, Set, Map, Buffer, setTimeout, Promise, Error, JSON }, { filename: rel })(req, mod, mod.exports);
    return mod.exports;
  }
  const tool = async (args = {}) => new (load('src/skills/outreach.ts').OutreachCoreSkill)().executeToolCall('message_colleague',
    { colleague_slack_id: COLLEAGUE, colleague_name: 'Colleague', message: 'Approved message', await_reply: true, ...args },
    { profile, userId: OWNER, authority: 'owner', channelId: 'DOWNER', threadTs: 'owner.1', surface: 'owner_dm', ...options.context });
  const person = () => sqlite.prepare('SELECT * FROM people_memory WHERE slack_id = ?').get(COLLEAGUE);
  const fire = () => load('src/core/requests/runner.ts').runSendScheduledOutreach(row, profile);
  return { tool, fire, person, sends, coreCalls, logs, closures, row: () => row, job: () => job, restart: () => modules.clear(), setNow: iso => { now = Date.parse(iso); } };
}

const NY_DEADLINE_FROM_MON_0600Z = '2026-09-16T21:00:00.000Z'; // 24 business hours, 09:00-17:00 America/New_York
const NY_WORK_START_MON = '2026-09-14T13:00:00.000Z';           // Monday 09:00 EDT

// ── never-engaged recipient (no people_memory row at send time) ─────────────
test('regression: never-engaged recipient — scheduled send floors to the Slack zone and the engagement creates an auto-tier row', async () => {
  const h = harness();
  h.setNow('2026-09-14T06:00Z');
  const r = await h.tool({ send_at: '2026-09-14T09:00:00' }); // owner-local 09:00 = 06:00Z = 02:00 EDT
  assert.equal(r.scheduled_at, NY_WORK_START_MON);
  assert.equal(h.row().next_check_at, NY_WORK_START_MON);
  assert.equal(h.job().colleague_tz, null);
  assert.equal(h.sends.length, 0);
  assert.deepEqual(h.coreCalls, [COLLEAGUE]);
  const p = h.person();
  assert.equal(p?.timezone, 'America/New_York');
  assert.equal(p?.timezone_set_by, 'auto');
  assert.equal(p?.name, 'Colleague Slack');
  assert.equal(p?.email, 'colleague@example.com');
  assert.equal(JSON.parse(p?.working_hours_auto ?? 'null')?.hoursStart, '09:00');
});
test('regression: never-engaged recipient — immediate awaited send arms the reply deadline in the recipient\'s zone', async () => {
  const h = harness();
  h.setNow('2026-09-14T06:00Z');
  const r = await h.tool();
  assert.equal(r.ok, true);
  assert.equal(h.sends.length, 1);
  assert.equal(h.job().reply_deadline, NY_DEADLINE_FROM_MON_0600Z);
  assert.equal(h.row().next_check_at, NY_DEADLINE_FROM_MON_0600Z);
  assert.equal(h.row().next_check_handler, 'outreach_expiry');
  assert.equal(h.person()?.timezone, 'America/New_York');
});
test('regression: never-engaged recipient — the scheduled timer fires at the recipient\'s work start and arms their deadline', async () => {
  const h = harness();
  h.setNow('2026-09-11T06:00Z');
  await h.tool({ send_at: '2026-09-14T09:00:00' });
  h.setNow('2026-09-14T06:00Z');
  await h.fire();
  assert.equal(h.sends.length, 0);
  assert.equal(h.row().next_check_at, NY_WORK_START_MON);
  h.setNow('2026-09-14T13:00Z');
  await h.fire();
  assert.equal(h.sends.length, 1);
  assert.equal(h.row().next_check_at, NY_DEADLINE_FROM_MON_0600Z);
  assert.equal(h.row().state, 'awaiting_colleague');
});
test('regression: scheduled channel post for a never-engaged recipient floors to their zone too', async () => {
  const h = harness();
  h.setNow('2026-09-14T06:00Z');
  const r = await h.tool({ send_at: '2026-09-14T09:00:00', channel_id: 'CROOM', channel_name: 'room' });
  assert.equal(r.scheduled_at, NY_WORK_START_MON);
  assert.equal(h.person()?.timezone, 'America/New_York');
});

// ── known recipient: the store's ranking governs, the read never stomps ─────
test('preserved: known recipient with a stated zone — the Slack reading moves neither the zone nor the schedule', async () => {
  const h = harness({ person: { timezone: 'Asia/Jerusalem', timezone_set_by: 'person', name_set_by: 'person', working_hours_auto: hours(IL_DAYS) } });
  h.setNow('2026-09-14T06:00Z');
  const r = await h.tool({ send_at: '2026-09-14T10:00:00' }); // 10:00 Jerusalem — inside their stored hours
  assert.equal(r.scheduled_at, '2026-09-14T07:00:00.000Z');
  const p = h.person();
  assert.equal(p.timezone, 'Asia/Jerusalem');
  assert.equal(p.timezone_set_by, 'person');
  assert.equal(p.timezone_temp, null);
  assert.equal(p.name, 'Colleague');
});
test('preserved: known recipient — the reply deadline runs in the stored zone regardless of the tool\'s colleague_tz', async () => {
  const h = harness({ person: { timezone: 'America/New_York', timezone_set_by: 'person', working_hours_auto: hours(WEEKDAYS) } });
  h.setNow('2026-09-14T06:00Z');
  const r = await h.tool({ colleague_tz: 'Asia/Jerusalem' });
  assert.equal(r.ok, true);
  assert.equal(h.job().reply_deadline, NY_DEADLINE_FROM_MON_0600Z);
});
test('regression: known auto-tier recipient — a differing Slack reading diverts to timezone_temp; the permanent zone still governs', async () => {
  const h = harness({ person: { timezone: 'Asia/Jerusalem', timezone_set_by: 'auto', working_hours_auto: hours(IL_DAYS) } });
  h.setNow('2026-09-14T06:00Z');
  const r = await h.tool({ send_at: '2026-09-14T10:00:00' });
  assert.equal(r.scheduled_at, '2026-09-14T07:00:00.000Z');
  const p = h.person();
  assert.equal(p.timezone, 'Asia/Jerusalem');
  const temp = JSON.parse(p.timezone_temp ?? 'null');
  assert.equal(temp?.value, 'America/New_York');
  assert.equal(temp?.source, 'slack');
});
test('regression: a Slack read with no tz retires a stale slack-sourced temp reading and fabricates no zone', async () => {
  const h = harness({
    person: { timezone: 'Asia/Jerusalem', timezone_set_by: 'auto', working_hours_auto: hours(IL_DAYS), timezone_temp: JSON.stringify({ value: 'America/New_York', expiresAt: '2026-09-20', source: 'slack', since: '2026-09-10', lastSeen: '2026-09-13' }) },
    coreInfo: { displayName: 'Colleague Slack' },
  });
  h.setNow('2026-09-14T06:00Z');
  const r = await h.tool({ send_at: '2026-09-14T10:00:00' });
  assert.equal(r.scheduled_at, '2026-09-14T07:00:00.000Z');
  const p = h.person();
  assert.equal(p.timezone, 'Asia/Jerusalem');
  assert.equal(p.timezone_temp, null);
});

// ── the read is unavailable, or Slack says the ref does not exist ───────────
test('preserved: profile read failure — the send still schedules on the tool zone and no zone is fabricated', async () => {
  const h = harness({ readThrows: true });
  h.setNow('2026-09-14T06:00Z');
  const r = await h.tool({ colleague_tz: 'America/New_York', send_at: '2026-09-14T09:00:00' });
  assert.equal(r.scheduled_at, NY_WORK_START_MON);
  assert.equal(h.person()?.timezone ?? null, null);
  assert.equal(h.sends.length, 0);
});
test('preserved: no Connection registered — the schedule still records, nothing is read', async () => {
  const h = harness({ noConnection: true });
  h.setNow('2026-09-14T06:00Z');
  const r = await h.tool({ colleague_tz: 'America/New_York', send_at: '2026-09-14T09:00:00' });
  assert.equal(r.scheduled_at, NY_WORK_START_MON);
  assert.equal(h.coreCalls.length, 0);
  assert.equal(h.person()?.timezone ?? null, null);
});
test('regression: Slack confirms the ref does not resolve — no row is minted and the send fails as before', async () => {
  const h = harness({ userNotFound: true });
  h.setNow('2026-09-14T06:00Z');
  const r = await h.tool({ await_reply: false });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'user_not_found');
  assert.equal(h.person(), undefined);
});

// ── the owner's immediate relay is never floored (R10) ──────────────────────
test('preserved: immediate owner relay outside recipient hours still sends now', async () => {
  const h = harness();
  h.setNow('2026-09-14T06:00Z');
  const r = await h.tool({ await_reply: false });
  assert.equal(r.ok, true);
  assert.equal(h.sends.length, 1);
  assert.equal(h.row().state, 'resolved');
});

test('preserved: unavailable profile keeps a stored zone and temp reading through the scheduled send', async () => {
  const temp = JSON.stringify({ value: 'Europe/London', expiresAt: '2026-09-20', source: 'slack', since: '2026-09-10', lastSeen: '2026-09-13' });
  const h = harness({ readThrows: true, person: { timezone: 'America/New_York', timezone_set_by: 'auto', timezone_temp: temp, working_hours_auto: hours(WEEKDAYS) } });
  h.setNow('2026-09-14T06:00Z');
  const r = await h.tool({ send_at: '2026-09-14T09:00:00' });
  assert.equal(r.scheduled_at, NY_WORK_START_MON);
  assert.equal(h.person().timezone_temp, temp);
  h.setNow(NY_WORK_START_MON);
  await h.fire();
  assert.equal(h.sends.length, 1);
  assert.equal(h.row().next_check_handler, 'outreach_expiry');
  assert.equal(h.row().next_check_at, NY_DEADLINE_FROM_MON_0600Z);
});

test('preserved: missing optional core-info capability uses fallback recipient hours and sends at the timer', async () => {
  const h = harness({ noCoreMethod: true });
  h.setNow('2026-09-14T06:00Z');
  const r = await h.tool({ colleague_tz: 'America/New_York', send_at: '2026-09-14T09:00:00', await_reply: false });
  assert.equal(r.scheduled_at, NY_WORK_START_MON);
  assert.equal(h.person()?.timezone ?? null, null);
  h.setNow(NY_WORK_START_MON);
  await h.fire();
  assert.equal(h.sends.length, 1);
  assert.equal(h.row().state, 'resolved');
  assert.equal(h.row().next_check_handler, null);
});

test('preserved: unavailable profile with no tool zone retains the owner-zone fallback without inventing a timezone', async () => {
  const h = harness({ readThrows: true });
  h.setNow('2026-09-14T00:00Z');
  const r = await h.tool({ send_at: '2026-09-14T04:00:00' });
  assert.equal(r.scheduled_at, '2026-09-14T06:00:00.000Z');
  assert.equal(h.person()?.timezone ?? null, null);
  assert.equal(h.sends.length, 0);
});

test('preserved: immediate Connection failure cancels the paired request without a delivery stamp', async () => {
  const h = harness({ sendResults: [{ ok: false, reason: 'cannot_dm' }] });
  const r = await h.tool();
  assert.equal(r.ok, false);
  assert.equal(r.error, 'cannot_dm');
  assert.equal(h.row().state, 'cancelled');
  assert.equal(h.job().sent_at, null);
  assert.equal(h.sends.length, 1);
});

test('preserved: missing Connection cancels immediate outreach without sending', async () => {
  const h = harness({ noConnection: true });
  const r = await h.tool();
  assert.equal(r.error, 'connection_not_registered');
  assert.equal(h.row().state, 'cancelled');
  assert.equal(h.sends.length, 0);
  assert.equal(h.coreCalls.length, 0);
});

test('preserved: scheduled soft failure survives module restart and sends only at the recipient next work window', async () => {
  const h = harness({ person: { timezone: 'America/New_York', timezone_set_by: 'person', working_hours_auto: hours(WEEKDAYS) }, sendResults: [{ ok: false, reason: 'ratelimited' }] });
  h.setNow('2026-09-14T06:00Z');
  await h.tool({ send_at: '2026-09-14T23:59:00', await_reply: false }); // 16:59 EDT
  h.setNow('2026-09-14T20:59:00Z');
  assert.equal(await h.fire(), 'rearmed');
  assert.equal(h.row().next_check_at, '2026-09-14T21:09:00.000Z');
  assert.equal(JSON.parse(h.row().details_json).send_attempts, 1);
  assert.equal(h.job().sent_at, null);
  h.restart();
  h.setNow('2026-09-14T21:09:00Z');
  assert.equal(await h.fire(), 'rearmed');
  assert.equal(h.row().next_check_at, '2026-09-15T13:00:00.000Z');
  assert.equal(h.sends.length, 1);
  h.setNow('2026-09-15T13:00:00Z');
  assert.equal(await h.fire(), 'closed');
  assert.equal(h.sends.length, 2);
  assert.equal(h.row().state, 'resolved');
  assert.equal(h.row().next_check_handler, null);
});

test('preserved: scheduled repeated explicit failures close after three attempts and notify the asker', async () => {
  const h = harness({ person: { timezone: 'America/New_York', timezone_set_by: 'person', working_hours_auto: hours(WEEKDAYS) }, sendResults: Array.from({ length: 3 }, () => ({ ok: false, reason: 'cannot_dm' })) });
  h.setNow('2026-09-14T06:00Z');
  await h.tool({ send_at: '2026-09-14T16:00:00' });
  for (const t of ['13:00', '13:10', '13:30']) {
    h.setNow(`2026-09-14T${t}:00Z`);
    await h.fire();
  }
  assert.equal(h.sends.length, 4);
  assert.equal(h.sends[3].id, 'DOWNER');
  assert.equal(h.sends[3].opts.threadTs, 'owner.1');
  assert.equal(h.row().state, 'cancelled');
  assert.equal(h.job().sent_at, null);
  assert.equal(h.closures.length, 1);
  assert.equal(h.closures[0].closureReason, 'scheduled_send_failed');
});

test('regression: scheduled room post retains attachments through restart and completes at recipient hours', async () => {
  const h = harness({ context: { authority: 'colleague', surface: 'room', channelId: 'CORIGIN' } });
  h.setNow('2026-09-14T06:00Z');
  const r = await h.tool({ send_at: '2026-09-14T09:00:00', channel_id: 'CROOM', attachments: [{ slack_file_url: 'https://slack.test/file', filename: 'agenda.pdf' }] });
  assert.equal(r.scheduled_at, NY_WORK_START_MON);
  h.restart();
  h.setNow(NY_WORK_START_MON);
  await h.fire();
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].id, 'CROOM');
  assert.equal(h.sends[0].body, '<@UCOLLEAGUE> Approved message');
  assert.equal(h.sends[0].opts.attachments[0].sourceUrl, 'https://slack.test/file');
  assert.equal(h.row().state, 'resolved');
  assert.equal(h.job().await_reply, 0);
});

test('preserved: rejected approval-context outreach does not collect a profile or create a person or request', async () => {
  const h = harness({ pendingApproval: true });
  const r = await h.tool();
  assert.equal(r.error, 'pending_approval_from_this_colleague');
  assert.equal(h.coreCalls.length, 0);
  assert.equal(h.person(), undefined);
  assert.equal(h.row(), undefined);
  assert.equal(h.sends.length, 0);
});

test('preserved: invalid send time does not collect a profile or create a person or request', async () => {
  const h = harness();
  const r = await h.tool({ send_at: 'invalid' });
  assert.equal(r.ok, false);
  assert.equal(h.coreCalls.length, 0);
  assert.equal(h.person(), undefined);
  assert.equal(h.row(), undefined);
});
