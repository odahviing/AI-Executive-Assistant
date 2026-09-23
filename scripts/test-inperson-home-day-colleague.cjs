/*
 * elan-inperson-home-day-approval-20260920 (1A) + elan-override-slot-before-compliant-20260920 (1B).
 *
 * The 2026-09-20 Tuesday: a colleague asks for a face-to-face meeting on the
 * owner's home day. 12:30 is the only room left for lunch; 13:45 is otherwise
 * clean. Proves, with the real validator + walker (scheduleRules.ts,
 * connectors/graph/findAvailableSlots.ts, floatingBlocks.ts, workHours.ts) and
 * AST-selected production branches of the two handlers:
 *   - every relaxed candidate carries EVERY rule it breaks (walker broken_rules);
 *   - the must-be approval payload tells the truth and offers the remote option;
 *   - create_meeting's colleague Guard B refuses in-person on a home day and
 *     says what the same time needs online;
 *   - an office-day in-person request and a remote booking still book;
 *   - the owner's approved replay path is unchanged.
 * Only I/O (owner events, free/busy, overrides, logger, categories, subjects) is a fixture.
 *
 * node scripts/test-inperson-home-day-colleague.cjs [--source-root SNAPSHOT]
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const luxon = require('luxon');
const { DateTime, Settings } = luxon;

const repo = path.resolve(__dirname, '..');
const arg = process.argv.indexOf('--source-root');
const snapshot = arg < 0 ? repo : path.resolve(process.argv[arg + 1]);
const read = rel => fs.readFileSync(fs.existsSync(path.join(snapshot, rel)) ? path.join(snapshot, rel) : path.join(repo, rel), 'utf8');

Settings.now = () => Date.parse('2026-09-20T07:04:00Z');
class Clock extends Date { constructor(...a) { super(...(a.length ? a : [Settings.now()])); } static now() { return Settings.now(); } }
const zone = 'Asia/Jerusalem';
const noop = () => {};
const logger = { info: noop, warn: noop, error: noop, debug: noop };

const profile = {
  user: { name: 'Idan Cohen', email: 'idan@reflectiz.com', slack_user_id: 'UOWNER', timezone: zone },
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
// Tuesday 22 Sep: the lunch window 11:30–13:30 has exactly one 25-min gap (12:30), holding lunch.
// As on the day (owner_busy_collision from 09:00), the morning is taken and 13:45
// is the first slot after 12:30.
const events = [
  ev('m', 'Morning block', '2026-09-22T09:00:00', '2026-09-22T11:30:00'),
  ev('c', 'Sync C', '2026-09-22T13:30:00', '2026-09-22T13:45:00'),
  ev('a', 'Sync A', '2026-09-22T11:30:00', '2026-09-22T12:30:00'),
  ev('l', 'Lunch', '2026-09-22T12:30:00', '2026-09-22T12:55:00'),
  ev('b', 'Sync B', '2026-09-22T12:55:00', '2026-09-22T13:30:00'),
];

// DB-read counters (brief (c): measured, not estimated).
const reads = { override: 0, suppressed: 0 };
function loader() {
  const modules = new Map();
  const mocks = {
    'src/utils/logger.ts': { default: logger, ...logger, __esModule: true },
    'src/db/scheduleOverrides.ts': { getScheduleOverride: () => { reads.override++; return null; }, listScheduleOverrides: () => [] },
    'src/db/calendarIssues.ts': { getSuppressedEventIds: () => { reads.suppressed++; return new Set(); } },
    'src/utils/categoryRules.ts': { checkCategorySlot: () => ({ allowed: true }), getProfileCategoryByName: () => null },
    'src/utils/displaySubject.ts': { displaySubject: e => e.subject, PRIVATE_MASK: '[Private]' },
    'src/connectors/graph/calendarReads.ts': {
      getFreeBusyForDecision: async () => ({}), getOwnerEventsForDecision: async () => events,
      isOutageShaped: () => false, CalendarOfflineError: class CalendarOfflineError extends Error {},
    },
    'src/utils/attendeeAvailability.ts': {
      attendeeWorkSegmentsBetween: () => [], tzTempDifferingForDay: () => undefined,
      ATTENDEE_REASON_PREFIXES: ['attendee_busy_collision', 'outside_attendee_work_hours', 'attendee_out_of_office'],
    },
    'src/db/people.ts': {},
  };
  function load(rel) {
    if (mocks[rel]) return mocks[rel];
    if (modules.has(rel)) return modules.get(rel).exports;
    const js = ts.transpileModule(read(rel), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const mod = { exports: {} }; modules.set(rel, mod);
    const req = s => s === 'luxon' ? luxon : s.startsWith('.') ? load(path.posix.normalize(path.posix.join(path.posix.dirname(rel), s)) + '.ts') : (() => { throw Error('Unexpected module ' + s); })();
    vm.runInNewContext('(function(require,module,exports){' + js + '\n})', { Date: Clock, console, Set, Map, setTimeout, clearTimeout }, { filename: rel })(req, mod, mod.exports);
    return mod.exports;
  }
  return load;
}
const load = loader();
const walker = load('src/connectors/graph/findAvailableSlots.ts');
const rules = load('src/utils/scheduleRules.ts');
const find = extra => walker.findAvailableSlots({ userEmail: profile.user.email, timezone: zone, profile, durationMinutes: 25, autoExpand: false, ...extra });

// ── AST helpers for handler branches ─────────────────────────────────────
const sources = new Map();
const sf = rel => { if (!sources.has(rel)) sources.set(rel, ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true)); return sources.get(rel); };
const collect = (node, pred) => { const hits = []; (function v(n) { if (pred(n)) hits.push(n); ts.forEachChild(n, v); })(node); return hits; };
const one = (hits, label) => { if (hits.length !== 1) throw Error(`${label}: missing/ambiguous AST anchor (${hits.length})`); return hits[0]; };
function compileFn(body, bindings) {
  const js = ts.transpileModule(`module.exports = async function run() { ${body} };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { ...bindings, module: mod, exports: mod.exports, console, Date: Clock }, { filename: 'branch.ts' });
  return mod.exports;
}
const calReads = sf('src/connectors/graph/calendarReads.ts');
const fnText = name => one(collect(calReads, n => ts.isFunctionDeclaration(n) && n.name?.text === name), name).getText().replace(/^export /, '');
const spread = compileFn(`${fnText('slotZonedStart')}\n${fnText('slotLocalDay')}\n${fnText('pickSpreadSlots')}\nreturn { pickSpreadSlots };`, { DateTime });

const HANDLER = 'src/skills/meetings/ops/handlers/findAvailableSlots.ts';
const mustBeIf = one(collect(sf(HANDLER), n => ts.isIfStatement(n) && n.expression.getText() === 'mustBe && relaxedRecoverySlots.length > 0'), 'must-be branch');
async function mustBeResult(relaxedRecoverySlots) {
  const { pickSpreadSlots } = await spread();
  const run = compileFn(`${mustBeIf.getText()}\nreturn null;`, {
    mustBe: true, relaxedRecoverySlots, timezone: zone, offerCount: 8, args: { duration_minutes: 25 },
    context: { profile }, DateTime, strictDaySummary: [], require: () => ({ pickSpreadSlots }),
    compareByRulePriority: rules.compareByRulePriority ?? (() => 0),
  });
  return run();
}

const CREATE = 'src/skills/meetings/ops/handlers/createMeeting.ts';
const guardSrc = sf(CREATE);
const runSlotCheckDecl = one(collect(guardSrc, n => ts.isVariableStatement(n) && n.getText().includes('const runSlotCheck =')), 'Guard B runSlotCheck');
const remoteIf = collect(guardSrc, n => ts.isIfStatement(n) && n.expression.getText().startsWith("inPersonRequested && brokenRule === 'wrong_day_type'"));
const firstRejectReason = walker.firstRejectReason;
// Runs Guard B's own single-slot check (the production arrow) for the colleague's
// create_meeting args, then its remote-same-time branch when present.
async function guardB(startLocal, isOnline, { remoteThrows = false } = {}) {
  const fromIso = DateTime.fromISO(startLocal, { zone }).toISO();
  const toIso = DateTime.fromISO(startLocal, { zone }).plus({ minutes: 25 }).toISO();
  const diagnostics = {};
  const bindings = {
    findAvailableSlots: find, userEmail: profile.user.email, timezone: zone, durationMin: 25,
    attendeeCheckParams: () => ({}), otherRequiredAttendeeEmails: [], args: { is_online: isOnline },
    context: { profile }, subjectViewerFor: () => 'other', viewerEmail: undefined, diagnostics,
    inPersonRequested: isOnline === false, fromIso, toIso, startMs: DateTime.fromISO(fromIso).toMillis(), DateTime,
    firstRejectReason, labelFor: r => `label:${r}`, CalendarOfflineError: class extends Error {}, logger,
  };
  // The call exactly as the handler makes it (post-fix signature; pre-fix ignores the arguments).
  const verdict = await compileFn(`${runSlotCheckDecl.getText()}
    const requestedMode = inPersonRequested ? 'in_person' : undefined;
    const slots = await runSlotCheck({ from: fromIso, to: toIso }, requestedMode, diagnostics);
    return { slots, runSlotCheck };`, bindings)();
  const matched = verdict.slots.some(s => Math.abs(DateTime.fromISO(s.start).toMillis() - bindings.startMs) <= 60_000);
  const brokenRule = firstRejectReason(diagnostics.rejectedCounts);
  let remoteSameTime;
  if (!matched && remoteIf.length === 1) {
    remoteSameTime = await compileFn(`let remoteSameTime;\n${remoteIf[0].getText()}\nreturn remoteSameTime;`,
      { ...bindings, brokenRule, runSlotCheck: remoteThrows
        ? async () => { throw new Error('fixture free/busy fault on the remote re-check'); }
        : verdict.runSlotCheck })();
  }
  return { matched, brokenRule, remoteSameTime };
}

let passed = 0, failed = 0;
async function check(kind, name, fn) {
  try { await fn(); passed++; console.log(`ok ${kind} ${name}`); }
  catch (e) { failed++; console.log(`not ok ${kind} ${name} — ${e.message}`); }
}
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(`${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };
const ok = (c, m) => { if (!c) throw Error(m); };
const at = (slots, hhmm) => slots.find(s => DateTime.fromISO(s.start).setZone(zone).toFormat('HH:mm') === hhmm);

(async () => {
  const tuesday = { searchFrom: '2026-09-22T09:00:00+03:00', searchTo: '2026-09-22T15:30:00+03:00', meetingMode: 'in_person' };
  const strict = await find({ ...tuesday, relaxed: false, minBufferHours: 4 });
  reads.override = 0; reads.suppressed = 0;
  const relaxed = await find({ ...tuesday, relaxed: true, keepWorkHours: true, minBufferHours: 4, viewer: 'other' });
  console.log(`# measure relaxed-pass DB reads (7-candidate fixture, ${relaxed.length} accepted): getScheduleOverride=${reads.override} getSuppressedEventIds=${reads.suppressed}`);

  await check('preserved', 'strict-in-person-search-finds-nothing-on-the-home-day', () => eq(strict.length, 0, 'strict slots'));
  await check('preserved', 'relaxed-recovery-surfaces-both-12:30-and-13:45', () => ok(at(relaxed, '12:30') && at(relaxed, '13:45'), 'both candidates present'));
  await check('regression', 'relaxed-12:30-lists-both-bends', () => eq(at(relaxed, '12:30').broken_rules, ['in_person_on_home_day', 'floating_block_overlap'], '12:30 broken_rules'));
  await check('regression', 'relaxed-13:45-lists-only-the-home-day', () => eq(at(relaxed, '13:45').broken_rules, ['in_person_on_home_day'], '13:45 broken_rules'));

  const mustBe = await mustBeResult(relaxed);
  const cand = hhmm => mustBe.owner_approval_candidates.find(c => DateTime.fromISO(c.start).setZone(zone).toFormat('HH:mm') === hhmm);
  await check('preserved', 'must-be-still-returns-owner-approval-candidates-only', () => { eq(mustBe.slots, [], 'slots'); ok(mustBe.owner_approval_candidates.length >= 2, 'candidates'); });
  const hhmm = c => DateTime.fromISO(c.start).setZone(zone).toFormat('HH:mm');
  await check('regression', 'rule-priority-ranks-later-lesser-bend-before-earlier-override', () => {
    const order = mustBe.owner_approval_candidates.map(hhmm);
    ok(order.indexOf('13:45') < order.indexOf('12:30'), `13:45 must precede 12:30, got ${order.join(',')}`);
    ok(/rule-priority order/.test(mustBe._must_be_owner_approval_note) && /propose the FIRST one/.test(mustBe._must_be_owner_approval_note), 'note states the priority order');
  });
  await check('preserved', 'equal-bends-stay-in-time-order', () => {
    const same = mustBe.owner_approval_candidates.filter(c => JSON.stringify(c.broken_rules ?? null) === JSON.stringify(cand('13:45')?.broken_rules ?? null));
    const ms = same.map(c => Date.parse(c.start));
    ok(ms.length >= 2, 'need two equal-bend candidates');
    eq(ms, [...ms].sort((a, b) => a - b), 'chronological among equal bends');
  });
  await check('regression', 'broken-rules-come-in-checkSlot-ladder-order', () => {
    // lead time (0b) + in person (1b) + lunch (6): peeled in the validator's own order.
    const r = rules.brokenOwnerRules({ profile, slotStartIso: '2026-09-22T12:30:00+03:00', slotEndIso: '2026-09-22T12:55:00+03:00', category: null, events, inPersonRequested: true, leadTimeHours: 72 });
    eq(r, ['within_lead_time', 'in_person_on_home_day', 'floating_block_overlap'], 'ladder order');
    eq(rules.compareByRulePriority(['floating_block_overlap'], ['within_lead_time']) < 0, true, 'lunch-only before lead-time-only');
  });
  await check('regression', 'must-be-candidate-carries-its-rules-and-lunch-flag', () => {
    eq(cand('12:30')?.broken_rules, ['in_person_on_home_day', 'floating_block_overlap'], '12:30');
    eq(cand('12:30')?.disturbs_floating_block, true, '12:30 disturbs lunch');
    eq(cand('13:45')?.broken_rules, ['in_person_on_home_day'], '13:45');
  });
  await check('regression', 'must-be-note-names-no-false-mechanism-and-offers-remote', () => {
    const note = mustBe._must_be_owner_approval_note;
    ok(!/focus \/ buffer \/ booking lead-time/.test(note), 'false mechanism list still present');
    ok(/Tue 22 Sep 13:45–14:10/.test(note) && /online meeting with no approval/.test(note), 'remote option for 13:45 not offered');
    ok(!/12:30–12:55 works/.test(note), '12:30 offered as remote-clean');
  });
  const lunchOnly = relaxed.filter(s => DateTime.fromISO(s.start).setZone(zone).toFormat('HH:mm') === '12:30');
  const noCompliant = await mustBeResult(lunchOnly);
  await check('regression', 'no-compliant-option-control-escalates-with-both-rules-and-no-remote-offer', () => {
    eq(noCompliant.owner_approval_candidates.map(c => c.broken_rules), [['in_person_on_home_day', 'floating_block_overlap']], 'rules');
    ok(!/online meeting with no approval/.test(noCompliant._must_be_owner_approval_note), 'remote offered with nothing remote-clean');
  });

  const g1230 = await guardB('2026-09-22T12:30', false);
  const g1345 = await guardB('2026-09-22T13:45', false);
  await check('regression', 'guardB-refuses-in-person-13:45-on-home-day', () => { eq(g1345.matched, false, 'booked'); eq(g1345.brokenRule, 'wrong_day_type', 'reason'); });
  await check('regression', 'guardB-13:45-says-online-same-time-is-bookable', () => eq(g1345.remoteSameTime, { bookable: true }, 'remote'));
  await check('regression', 'guardB-12:30-names-home-day-and-lunch', () => {
    eq(g1230.brokenRule, 'wrong_day_type', 'first reason');
    eq(g1230.remoteSameTime?.broken_rule, 'floating_block_no_room', 'remote still breaks lunch');
  });
  await check('regression', 'guardB-remote-recheck-unavailable-still-refuses-in-person', async () => {
    const g = await guardB('2026-09-22T13:45', false, { remoteThrows: true });
    eq([g.matched, g.brokenRule, g.remoteSameTime], [false, 'wrong_day_type', undefined], 'refused without the remote fact');
  });
  await check('preserved', 'guardB-off-day-refusal-never-claims-in-person-was-the-reason', async () => {
    // Thu 23:45 runs into Friday (not a workday): rule 1 refuses under wrong_day_type.
    const g = await guardB('2026-09-24T23:45', false);
    eq([g.matched, g.brokenRule, g.remoteSameTime], [false, 'wrong_day_type', undefined], 'off-day refusal');
  });
  const recoveryCall = collect(sf(HANDLER), n => ts.isVariableDeclaration(n) === false && ts.isBinaryExpression(n)
    && n.left.getText() === 'relaxedRecoverySlots' && n.right.getText().startsWith('await findAvailableSlots('));
  const recoveryLead = mustBeFlag => {
    const call = one(recoveryCall, 'relaxed recovery call').right.expression;
    const prop = call.arguments[0].properties.find(p => p.name?.getText() === 'minBufferHours');
    if (!prop) return undefined;
    return vm.runInNewContext(ts.transpileModule(prop.initializer.getText(), {}).outputText, { mustBe: mustBeFlag, leadHours: 4 });
  };
  await check('preserved', 'owner-relaxed-recovery-passes-no-lead-time', () => eq(recoveryLead(false), undefined, 'owner recovery lead'));
  await check('regression', 'colleague-must-be-recovery-passes-colleague-lead-time', () => eq(recoveryLead(true), 4, 'must-be recovery lead'));
  await check('preserved', 'owner-relaxed-label-inside-1h-window-is-not-too-soon', async () => {
    // Now = Sun 20 Sep 10:04 local. An owner relaxed in-person search on his home
    // Sunday, with no lead time (the owner recovery above): 10:30 is inside 1h.
    const s = await find({ searchFrom: '2026-09-20T10:30:00+03:00', searchTo: '2026-09-20T12:00:00+03:00', meetingMode: 'in_person', relaxed: true, keepWorkHours: true, viewer: 'owner' });
    const inside = at(s, '10:30'), outside = at(s, '11:30');
    ok(inside && outside, 'both slots returned');
    ok(!/too soon/.test(inside.broken_rule_label || ''), 'inside-window label says too soon');
    ok(!(inside.broken_rules || []).includes('within_lead_time'), 'inside-window lists within_lead_time');
    eq(inside.broken_rule_label === undefined, outside.broken_rule_label === undefined, 'inside and outside labelled alike');
  });
  await check('preserved', 'guardB-office-day-in-person-books-without-escalation', async () => {
    const g = await guardB('2026-09-23T13:45', false);
    eq([g.matched, g.remoteSameTime], [true, undefined], 'Wednesday in person');
  });
  await check('preserved', 'guardB-remote-13:45-books-directly', async () => {
    const g = await guardB('2026-09-22T13:45', true);
    eq(g.matched, true, 'online 13:45');
  });
  await check('preserved', 'guardB-12:30-still-refused-for-lunch-when-remote', async () => {
    const g = await guardB('2026-09-22T12:30', true);
    eq([g.matched, g.brokenRule], [false, 'floating_block_no_room'], 'remote 12:30');
  });
  await check('preserved', 'owner-approved-replay-books-remote-or-in-person-13:45', () => {
    const base = { profile, slotStartIso: '2026-09-22T13:45:00+03:00', slotEndIso: '2026-09-22T14:10:00+03:00', category: null, events, viewer: 'owner' };
    eq(rules.checkSlot({ ...base, inPersonRequested: false }).passes, true, 'remote replay');
    eq(rules.checkSlot({ ...base, inPersonRequested: true, allowRelaxed: true }).passes, true, 'approved in-person replay');
  });

  console.log(`${passed} passed; ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log(`not ok harness — ${e.stack}`); console.log(`${passed} passed; ${failed + 1} failed`); process.exit(1); });
