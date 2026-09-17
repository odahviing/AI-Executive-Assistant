/*
 * Attendee whole-day out-of-office is its own rejection reason, end to end.
 * Live incident 2026-09-15T10:02:35Z: the calendar-health overlap auto-move
 * rejected all 286 candidates as attendee_busy_collision for a week Dina was
 * on vacation, and the report could only say "no slot works for everyone".
 *
 * Actual modules: the Graph slot walker (connectors/graph/findAvailableSlots),
 * scheduleRules/workHours/attendeeAvailability, violationLabels, the
 * orchestrator's turnHelpers compact line, and the calendar-health checkHealth
 * + autoMove handlers. Fixtures: Graph reads (free/busy map, owner events),
 * DB, logger, LLM client. No network, no production DB, no LLM.
 *
 * node --test-reporter=tap scripts/test-attendee-out-of-office-label.cjs [--source-root SNAPSHOT]
 */
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const assert = require('node:assert/strict');
const { test } = require('node:test'), luxon = require('luxon'), { DateTime, Settings } = luxon;
const arg = process.argv.indexOf('--source-root');
const root = arg < 0 ? path.resolve(__dirname, '..') : path.resolve(process.argv[arg + 1]);
Settings.now = () => Date.parse('2026-09-15T10:00:00Z');
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [Settings.now()])); } static now() { return Settings.now(); } }
const noop = () => {}, home = 'Asia/Jerusalem';
const OWNER = 'owner@reflectiz.com', DINA = 'dina.s@reflectiz.com';
const plain = x => JSON.parse(JSON.stringify(x));
const loggerMock = { default: { info: noop, warn: noop, error: noop, debug: noop }, __esModule: true };

function loader(mocks) {
  const modules = new Map();
  function load(rel) {
    if (mocks[rel]) return mocks[rel];
    if (modules.has(rel)) return modules.get(rel).exports;
    const js = ts.transpileModule(fs.readFileSync(path.join(root, rel), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const mod = { exports: {} }; modules.set(rel, mod);
    const req = s => s === 'luxon' ? luxon : s.startsWith('.') ? load(path.posix.normalize(path.posix.join(path.posix.dirname(rel), s)) + '.ts') : require(s);
    vm.runInNewContext('(function(require,module,exports){' + js + '\n})', { Date: Clock, console, Set, Map, Buffer, setTimeout, clearTimeout, Promise, JSON, RegExp, Number, String, Object, Array, Error, Math }, { filename: rel })(req, mod, mod.exports);
    return mod.exports;
  }
  return load;
}

// ── Walker + labels harness ────────────────────────────────────────────────
function walkerHarness(freeBusy) {
  const profile = { user: { name: 'Owner Example', email: OWNER, slack_user_id: 'UOWNER', timezone: home }, schedule: { work_hours: Object.fromEntries(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'].map(d => [d, ['09:00-18:00']])), office_days: { days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'] }, home_days: { days: [] } }, meetings: { buffer_minutes: 0, allowed_durations: [25, 40, 55], categories: [] } };
  const load = loader({
    'src/db/scheduleOverrides.ts': { getScheduleOverride: () => null, listScheduleOverrides: () => [] },
    'src/utils/logger.ts': loggerMock,
    'src/utils/categoryRules.ts': { checkCategorySlot: () => ({ allowed: true }), getProfileCategoryByName: () => null },
    'src/utils/displaySubject.ts': { displaySubject: () => '', PRIVATE_MASK: 'private' },
    'src/db/people.ts': {},
    'src/db.ts': { getPersonByEmail: email => email === DINA ? { name: 'Dina Shalev' } : null },
    'src/utils/floatingBlocks.ts': { getFloatingBlocks: () => [], blockAppliesOnDay: () => false, isFloatingBlockEvent: () => false },
    'src/utils/calendarDensity.ts': { prefersDensePacking: () => false, densityConfigFromProfile: () => ({}), scoreSlotDensity: () => ({ createsDeadGap: false }) },
    'src/connectors/graph/calendarReads.ts': { getFreeBusyForDecision: async () => freeBusy, getOwnerEventsForDecision: async () => [], isOutageShaped: () => false, CalendarOfflineError: Error },
  });
  const find = (extra = {}) => {
    const diagnosticsOut = {};
    return load('src/connectors/graph/findAvailableSlots.ts').findAvailableSlots({
      userEmail: OWNER, timezone: home, profile, durationMinutes: 40,
      searchFrom: '2026-09-21T09:00:00+03:00', searchTo: '2026-09-24T18:00:00+03:00',
      attendeeBusyEmails: [DINA], autoExpand: false, requestedTimeWindow: null, minBufferHours: 0,
      diagnosticsOut, ...extra,
    }).then(slots => ({ slots, diagnosticsOut }));
  };
  return { load, profile, find };
}
const slot = (start, end, status) => ({ start, end, status, _timezone: home });
const weekOof = { [OWNER]: [], [DINA]: [slot('2026-09-21T00:00:00+03:00', '2026-09-26T00:00:00+03:00', 'oof')] };
const dayOof = { [OWNER]: [], [DINA]: [slot('2026-09-22T00:00:00+03:00', '2026-09-23T00:00:00+03:00', 'oof')] };
const partialOof = { [OWNER]: [], [DINA]: [slot('2026-09-22T09:00:00+03:00', '2026-09-22T12:00:00+03:00', 'oof')] };
const plainBusy = { [OWNER]: [], [DINA]: [slot('2026-09-22T10:00:00+03:00', '2026-09-22T11:00:00+03:00', 'busy')] };
const reasonsOf = diag => Object.keys(diag.rejectedCounts ?? {});
let weekDaySummary;

test('R1 walker: a week-long attendee oof rejects every candidate as attendee_out_of_office, never busy', async () => {
  const { slots, diagnosticsOut } = await walkerHarness(weekOof).find();
  weekDaySummary = diagnosticsOut.daySummary;   // recorded before asserting, so R7 joins whatever THIS tree's walker produced
  assert.equal(slots.length, 0);
  assert.ok(reasonsOf(diagnosticsOut).includes(`attendee_out_of_office:${DINA}`), reasonsOf(diagnosticsOut).join());
  assert.ok(!reasonsOf(diagnosticsOut).includes(`attendee_busy_collision:${DINA}`));
});

test('R2 day_summary: every searched day carries the reason, the blamed attendee and the span end', async () => {
  const { diagnosticsOut } = await walkerHarness(weekOof).find();
  const days = diagnosticsOut.daySummary;
  assert.deepEqual(plain(days.map(d => d.date)), ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24']);
  for (const d of days) {
    assert.equal(d.accepted, 0);
    assert.deepEqual(plain(d.top_reasons), ['attendee_out_of_office']);
    assert.equal(d.blocked_by?.[0]?.email, DINA);
    assert.equal(d.oof_until_display, 'Friday 25 Sep');
  }
});

test('R8 broken_rule join: the one span lookup createMeeting / find_available_slots use keys the attendee reason to the same field', () => {
  assert.ok(weekDaySummary, 'R1 recorded the actual walker day_summary');
  const { oofUntilDisplayFor } = walkerHarness(weekOof).load('src/connectors/graph/findAvailableSlots.ts');
  assert.equal(oofUntilDisplayFor(`attendee_out_of_office:${DINA}`, weekDaySummary, '2026-09-22'), 'Friday 25 Sep');
  assert.equal(oofUntilDisplayFor(`attendee_busy_collision:${DINA}`, weekDaySummary, '2026-09-22'), undefined);
  assert.equal(oofUntilDisplayFor('owner_out_of_office', [{ date: '2026-09-22', accepted: 0, top_reasons: ['owner_out_of_office'], oof_until_display: 'Thursday 24 Sep' }], '2026-09-22'), 'Thursday 24 Sep');
});

test('R3 single-day oof: that day is out_of_office with no span end; the other days still offer slots', async () => {
  const { slots, diagnosticsOut } = await walkerHarness(dayOof).find();
  const tue = diagnosticsOut.daySummary.find(d => d.date === '2026-09-22');
  assert.deepEqual(plain(tue.top_reasons), ['attendee_out_of_office']);
  assert.equal(tue.oof_until_display, undefined);
  assert.ok(slots.length > 0 && slots.every(s => !s.start.startsWith('2026-09-22')));
});

test('R4 tag mode: a kept slot on an oof day is tagged out_of_office, not busy', async () => {
  const { slots } = await walkerHarness(weekOof).find({ tagAttendeeConflicts: true });
  assert.ok(slots.length > 0);
  for (const s of slots) assert.deepEqual(plain(s.attendee_conflicts), [{ email: DINA, reason: 'out_of_office' }]);
});

test('R5 labels: the reject phrase names the span end, the tag line names the person, both name-safe', () => {
  const labels = walkerHarness(weekOof).load('src/skills/meetings/ops/violationLabels.ts');
  assert.equal(labels.humanizeViolationLabel(`attendee_out_of_office:${DINA}`, 'Owner', 'Friday 25 Sep'), 'an attendee is out of office through Friday 25 Sep');
  assert.equal(labels.humanizeViolationLabel(`attendee_out_of_office:${DINA}`, 'Owner'), 'an attendee is out of office that day');
  assert.equal(labels.attendeeConflictLine({ email: DINA, reason: 'out_of_office' }, null), 'Dina is out of office that day');
  assert.equal(labels.attendeeConflictLine({ email: DINA, reason: 'out_of_office' }, DINA), "you're out of office that day");
});

test('R6 compact tool line: the zero-slot turn states the attendee oof reason and its span end', async () => {
  const h = walkerHarness(weekOof);
  const { slots, diagnosticsOut } = await h.find();
  const turn = loader({
    'src/llm/client.ts': { getAnthropicClient: () => ({ messages: { create: async () => { throw Error('LLM forbidden'); } } }) },
    'src/utils/usageLog.ts': { logLlmUsage: noop }, 'src/utils/logger.ts': loggerMock,
    'src/db/scheduleOverrides.ts': { getScheduleOverride: () => null, listScheduleOverrides: () => [] },
  });
  const line = turn('src/core/orchestrator/turnHelpers.ts').summarizeToolCall('find_available_slots',
    { duration_minutes: 40, search_from: '2026-09-21T09:00:00', search_to: '2026-09-24T18:00:00' },
    { slots, day_summary: diagnosticsOut.daySummary }, home);
  assert.match(line, /0 slots reason=attendee_out_of_office \(until Friday 25 Sep\)/, line);
});

test('P1 preserved: a partial-day oof block stays an ordinary busy collision on that day only', async () => {
  const { slots, diagnosticsOut } = await walkerHarness(partialOof).find();
  assert.ok(reasonsOf(diagnosticsOut).includes(`attendee_busy_collision:${DINA}`));
  assert.ok(!reasonsOf(diagnosticsOut).some(r => r.startsWith('attendee_out_of_office')));
  const tue = diagnosticsOut.daySummary.find(d => d.date === '2026-09-22');
  assert.ok(tue.accepted > 0 && tue.attendee_partial_conflicts?.[0]?.email === DINA);
  assert.ok(slots.some(s => s.start.startsWith('2026-09-22T1')));
});

test('P2 preserved: a plain busy block rejects as attendee_busy_collision and its labels are unchanged', async () => {
  const h = walkerHarness(plainBusy);
  const { diagnosticsOut } = await h.find();
  assert.ok(reasonsOf(diagnosticsOut).includes(`attendee_busy_collision:${DINA}`));
  const labels = h.load('src/skills/meetings/ops/violationLabels.ts');
  assert.equal(labels.humanizeViolationLabel(`attendee_busy_collision:${DINA}`, 'Owner'), 'an attendee is already booked then');
  assert.equal(labels.attendeeConflictLine({ email: DINA, reason: 'busy' }, null), "Dina's busy then");
  const { slots } = await h.find({ tagAttendeeConflicts: true });
  const tagged = slots.filter(s => s.start.startsWith('2026-09-22T10'));
  assert.ok(tagged.length > 0 && tagged.every(s => s.attendee_conflicts?.[0]?.reason === 'busy'));
});

// ── Calendar-health overlap auto-move harness (ported from test-calendar-health-audit.cjs) ──
function healthHarness(opts = {}) {
  const rows = [], requestRows = [], calls = [];
  const profile = { user: { name: 'Owner', email: OWNER, slack_user_id: 'owner', timezone: home }, behavior: { calendar_health_mode: 'passive' }, meetings: { floating_blocks: [], protected: [], private_emails: [] }, schedule: { office_days: { days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'] }, home_days: { days: [] } }, categories: [{ name: 'Meeting', description: 'Work' }] };
  const active = () => rows.filter(r => ['awaiting_owner', 'in_progress', 'owner_side'].includes(r.status));
  const db = {
    getActiveCalendarIssues: active, getSuppressedEventIds: () => new Set(), getWaivedFloatingBlockEventIds: () => new Set(),
    dayLevelIssueSyntheticId: (type, date) => `${type}:${date}`,
    buildClusters: (issues, dates) => issues.map(i => ({ ...i, event_date: dates.get(i.event_id) })),
    upsertCluster: (owner, c) => { let row = rows.find(r => r.event_id === c.event_id); if (row) return { action: 'update', row_id: row.id }; row = { ...c, id: `ci_${c.event_id}`, status: 'awaiting_owner', issue_class: c.class }; rows.push(row); return { action: 'insert', row_id: row.id }; },
    markStaleResolved: noop, updateCalendarIssueStatus: () => true, getPersonByEmail: () => null, getCalendarIssueById: id => rows.find(r => r.id === id),
    attachRequestToIssue: noop, auditLog: noop, getDb: () => ({ transaction: fn => () => fn() }),
  };
  const requests = { getRecentlyAutoMovedEventIds: () => new Set(), getRequestsByExternalEventId: () => [], createRequest: p => { const r = { id: `req_${requestRows.length}`, ...p, state: p.state }; requestRows.push(r); return r; }, getRequest: id => requestRows.find(r => r.id === id), getRequestByIdempotencyKey: () => undefined, updateRequest: noop };
  const cal = {
    getOwnerEventsForDecision: async () => opts.events ?? [], getCalendarEvents: async () => opts.events ?? [],
    updateMeeting: async p => { calls.push(['write', p]); }, verifyEventMoved: async () => ({ ok: true }), verifyApprovedCalendarAction: async () => ({ status: 'desired_state_observed' }),
    findAvailableSlots: async p => { calls.push(['slots', p]); if (p.diagnosticsOut && opts.daySummary) p.diagnosticsOut.daySummary = opts.daySummary; return opts.slots ?? []; },
  };
  const fb = { densityCommitments: () => [], getFloatingBlocks: () => [], blockAppliesOnDay: () => true, isFloatingBlockEvent: () => false, floatingBlockSyntheticEventId: (p, name, date) => ({ eventId: `${name}:${date}`, eventEndMs: 0 }), windowMsForDay: (date, time, zone) => DateTime.fromISO(`${date}T${time}`, { zone }).toMillis() };
  const work = { computeHealthCheckWindow: () => ({ startDate: '2026-09-22', endDate: '2026-09-22' }), getEffectiveWorkDay: () => ({ windows: [{ startMin: 540, endMin: 1080 }], hasOverride: false }), formatMinuteOfDay: n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`, totalWorkMinutes: w => w.reduce((n, x) => n + x.endMin - x.startMin, 0) };
  const modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const file = ['meetingProtection', 'attendeeScope'].includes(name) ? path.join(root, 'src/utils', `${name}.ts`) : path.join(root, 'src/skills/calendarHealth', ['checkHealth', 'categoryOps'].includes(name) ? 'handlers' : '', `${name}.ts`);
    const m = { exports: {} }; modules.set(name, m.exports);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const req = spec => {
      if (spec === 'luxon') return luxon;
      if (spec.endsWith('/classify')) return load('classify');
      if (spec.endsWith('/autoMove')) return load('autoMove');
      if (spec.endsWith('/graph/calendar')) return cal;
      if (spec.endsWith('/logger')) return loggerMock;
      if (spec.endsWith('/db') || spec.endsWith('/db/calendarIssues')) return db;
      if (spec.endsWith('/db/requests')) return requests;
      if (spec.endsWith('/displaySubject')) return { displaySubject: e => e.subject };
      if (spec.endsWith('/workHours')) return work;
      if (spec.endsWith('/floatingBlocks')) return fb;
      if (spec.endsWith('/calendarDensity')) return { prefersDensePacking: () => false, densityConfigFromProfile: () => ({}), classifyGap: () => 'break', scoreSlotDensity: () => ({ createsDeadGap: false }) };
      if (spec.endsWith('/meetingProtection')) return load('meetingProtection');
      if (spec === './attendeeScope') return load('attendeeScope');
      if (spec.endsWith('/db/jobs')) return { getOpenRescheduleOutreach: () => [] };
      if (spec.endsWith('/attendeeAvailability')) return { attendeeCheckParams: emails => ({ attendeeEmails: emails }) };
      if (spec.endsWith('/scheduleRules')) return { requiredFreeMinutesForWorkDay: () => 0 };
      if (spec.endsWith('/categoryRules')) return { findCategoryViolations: () => [] };
      if (spec.endsWith('/llm/client')) return { getAnthropicClient: () => { throw Error('Live LLM forbidden'); } };
      if (spec.endsWith('/llm/models')) return { SONNET: {} };
      if (spec.endsWith('/rebalanceFloatingBlocks')) return { rebalanceFloatingBlocksAfterMutation: async () => ({ moved: 0, movedBlockEventIds: [] }) };
      if (spec.endsWith('/closeMeetingArtifacts')) return { closeMeetingArtifacts: async () => ({ correctedColleagueSlackIds: [] }) };
      if (spec.endsWith('/closeRequest')) return { closeRequest: () => ({ ok: true }) };
      if (spec.endsWith('/meetingReschedule')) return { notifyColleagueOfMove: async () => true };
      if (spec.endsWith('/shadowNotify')) return { shadowNotify: async () => {} };
      throw Error(`Forbidden/unmocked dependency: ${spec}`);
    };
    vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(req, m, m.exports);
    modules.set(name, m.exports); return m.exports;
  }
  const context = { profile, channelId: 'owner-dm', userId: 'owner', isOwner: true };
  return { calls, scan: args => load('checkHealth').handleCheckHealth(args ?? {}, { context, profile, userEmail: profile.user.email, timezone: profile.user.timezone, self: { executeToolCall: async () => ({ ok: true }) } }) };
}
const healthEvent = (id, start, end) => ({ id, subject: id, start: { dateTime: start, timeZone: home }, end: { dateTime: end, timeZone: home }, showAs: 'busy', isAllDay: false, isCancelled: false, attendees: [{ emailAddress: { address: DINA, name: 'Dina Shalev' }, status: { response: 'accepted' } }], categories: ['Meeting'] });
const overlapEvents = [healthEvent('Weekly leadership', '2026-09-22T10:00:00', '2026-09-22T11:00:00'), healthEvent('Dina & Idan, BiWeekly', '2026-09-22T10:20:00', '2026-09-22T11:00:00')];

test('R7 calendar health: the overlap auto-move names the out-of-office attendee and her span instead of a blanket no-slot', async () => {
  assert.ok(weekDaySummary, 'R1 recorded the actual walker day_summary');
  const h = healthHarness({ events: overlapEvents, daySummary: weekDaySummary });
  const r = await h.scan({ mode: 'active' });
  const issue = r.issues.find(i => i.type === 'double_booking');
  assert.equal(issue.fix_failed, true);
  assert.equal(h.calls.filter(c => c[0] === 'write').length, 0);
  assert.match(issue.fix_error, /^Dina is out of office through Friday 25 Sep — left for you: skip this occurrence, or tell me to push it to the next one\./, issue.fix_error);
  assert.doesNotMatch(issue.fix_error, /reflectiz\.com/);
  assert.match(r.summary_text, /Dina is out of office through Friday 25 Sep/);
});

test('P3 preserved: an attendee-busy week still reports the generic no-slot line and never moves', async () => {
  const busyWeek = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'].map(date => ({ date, accepted: 0, top_reasons: ['attendee_busy_collision'], blocked_by: [{ email: DINA, slots_blocked: 30 }] }));
  const h = healthHarness({ events: overlapEvents, daySummary: busyWeek });
  const r = await h.scan({ mode: 'active' });
  const issue = r.issues.find(i => i.type === 'double_booking');
  assert.equal(issue.fix_failed, true);
  assert.equal(h.calls.filter(c => c[0] === 'write').length, 0);
  assert.match(issue.fix_error, /^No slot free for everyone this week/);
});
