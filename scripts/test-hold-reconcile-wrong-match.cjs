/*
 * A slot hold is fulfilled only when its OWN meeting is booked: by the booking
 * Maelle makes on it, or by a timed real commitment with the holder on it that
 * covers the held window on the calendar (owner ruling 2026-09-17: auto-close a
 * hold seen on Outlook). Live incident 2026-09-15T19:47:10Z: Yael's hold
 * (Thu 17 Sep 15:00-15:40, candidate interview) was released
 * 'fulfilled_by_booking' by the background reconcile because the two-week
 * all-day showAs:'free' "Dina - Vacation " marker had Yael as attendee; no
 * booking existed. The owner then booked 15:30 over it with no hold gate, and
 * the brief narrated a confirmed meeting that never happened.
 *
 * Actual modules: src/db/slotHolds.ts (in-memory better-sqlite3 with the real
 * slot_holds schema copied from src/db/client.ts), src/core/background.ts (the
 * 5-min tick captured from a fake setInterval) and the real occupancyRoleOf
 * (src/utils/scheduleRules.ts + floatingBlocks.ts). Tasks runner, materializer,
 * crons, capture pass, people, Graph calendar reads, Connection, category rules,
 * work hours, displaySubject, density and logger are mocked. No network, no
 * production DB, no LLM.
 *
 * node --test-reporter=tap scripts/test-hold-reconcile-wrong-match.cjs [--source-root SNAPSHOT]
 */
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const assert = require('node:assert/strict');
const { test } = require('node:test'), luxon = require('luxon');
const Database = require('better-sqlite3');
const arg = process.argv.indexOf('--source-root');
const root = arg < 0 ? path.resolve(__dirname, '..') : path.resolve(process.argv[arg + 1]);
const noop = () => {};
const loggerMock = { default: { info: noop, warn: noop, error: noop, debug: noop }, __esModule: true };
const OWNER = 'UOWNER', YAEL = 'UYAEL', YAEL_EMAIL = 'yael@reflectiz.com', OWNER_EMAIL = 'owner@reflectiz.com';
const NOW = Date.parse('2026-09-15T19:47:00Z');
// The incident hold, stored exactly as hold_slot stores it (UTC instant).
const HELD_START = '2026-09-17T12:00:00.000Z', HELD_END = '2026-09-17T12:40:00.000Z';
const lunch = { name: 'lunch', preferred_start: '14:30', preferred_end: '16:30', duration_minutes: 40, can_skip: true };
const profile = { user: { name: 'Owner Example', email: OWNER_EMAIL, slack_user_id: OWNER, timezone: 'Asia/Jerusalem' }, assistant: { slack: { bot_token: 'x' } }, meetings: { floating_blocks: [lunch] } };

function freshDb() {
  const db = new Database(':memory:');
  const src = fs.readFileSync(path.join(root, 'src/db/client.ts'), 'utf8');
  const schema = src.slice(src.indexOf('CREATE TABLE IF NOT EXISTS slot_holds'), src.indexOf('idx_slot_holds_expiry ON slot_holds(status, expires_at);') + 'idx_slot_holds_expiry ON slot_holds(status, expires_at);'.length);
  db.exec(schema);
  return db;
}

function loader(mocks) {
  const modules = new Map();
  function load(rel) {
    if (mocks[rel]) return mocks[rel];
    if (modules.has(rel)) return modules.get(rel).exports;
    const filename = rel === 'src/core/background.ts' && process.env.BACKGROUND_SOURCE_FIXTURE
      ? process.env.BACKGROUND_SOURCE_FIXTURE
      : path.join(root, rel);
    const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const mod = { exports: {} }; modules.set(rel, mod);
    const req = s => s === 'luxon' ? luxon : s.startsWith('.') ? load(path.posix.normalize(path.posix.join(path.posix.dirname(rel), s)) + '.ts') : mocks[s] ?? require(s);
    const ctx = { Date: class extends Date { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } }, console, Set, Map, Promise, JSON, Number, String, Object, Array, Error, Math, RegExp, setInterval: mocks.setInterval ?? setInterval, setTimeout, clearTimeout };
    vm.runInNewContext('(function(require,module,exports){' + js + '\n})', ctx, { filename: rel })(req, mod, mod.exports);
    return mod.exports;
  }
  return load;
}

function holdsHarness() {
  const db = freshDb();
  const load = loader({ 'src/db/client.ts': { getDb: () => db } });
  const sh = load('src/db/slotHolds.ts');
  const seed = (over = {}) => sh.createSlotHold({ ownerUserId: OWNER, holderSlackId: YAEL, holderName: 'Yael Aharon', subject: 'Interview - Field & Channel Marketing candidate', startIso: HELD_START, endIso: HELD_END, expiresAt: HELD_START, ...over });
  const row = id => db.prepare('SELECT * FROM slot_holds WHERE id = ?').get(id);
  return { db, sh, seed, row };
}

// The background tick, with the calendar showing whatever `calendarEvents` says for the held day.
async function runTick(calendarEvents, { sh, db }) {
  const intervals = [];
  const dms = [];
  const load = loader({
    'src/db/client.ts': { getDb: () => db },
    'src/db/slotHolds.ts': sh,
    'src/db/people.ts': { getPersonMemory: id => id === YAEL ? { email: YAEL_EMAIL } : id === OWNER ? { email: OWNER_EMAIL } : null },
    'src/connectors/graph/calendar.ts': { getCalendarEvents: async () => {
      if (calendarEvents instanceof Error) throw calendarEvents;
      return calendarEvents;
    } },
    'src/connections/registry.ts': { getConnection: () => ({ sendDirect: async (to, text) => { dms.push({ to, text }); } }) },
    'src/tasks/runner.ts': { runDueTasks: async () => {} },
    'src/tasks/routineMaterializer.ts': { materializeRoutineTasks: async () => {}, backfillNullNextRunAt: noop },
    'src/tasks/crons.ts': { ensureBriefingCron: noop, updateBriefingCronChannel: noop },
    'src/memory/capturePass.ts': { runCapturePass: async () => {} },
    'src/utils/categoryRules.ts': { checkCategorySlot: () => ({ allowed: true }), getProfileCategoryByName: () => null },
    'src/utils/displaySubject.ts': { displaySubject: () => '', PRIVATE_MASK: 'private' },
    'src/utils/workHours.ts': { getEffectiveWorkDayForInstant: () => null, ownerWorkSegmentsBetween: () => [] },
    'src/utils/calendarDensity.ts': { findDeadGaps: () => [], alignUpQuarter: x => x, alignDownQuarter: x => x },
    'src/utils/logger.ts': loggerMock,
    '@slack/bolt': {},
    setInterval: fn => { intervals.push(fn); return 0; },
  });
  load('src/core/background.ts').startBackgroundTimer([{ app: {}, name: 'x' }], new Map([[OWNER, profile]]));
  intervals[0]();                       // the 5-min pipeline tick (materialize → runDueTasks → holds)
  await new Promise(r => setTimeout(r, 50));
  return { dms };
}

const yael = [{ emailAddress: { name: 'Yael Aharon', address: YAEL_EMAIL }, status: { response: 'accepted' } }];
const ownerSelf = [{ emailAddress: { name: 'Owner Example', address: OWNER_EMAIL }, status: { response: 'accepted' } }];
const timed = (id, subject, start, end, extra = {}) => ({
  id, subject, isCancelled: false, isAllDay: false, showAs: 'busy', attendees: yael,
  start: { dateTime: start, timeZone: 'Asia/Jerusalem' }, end: { dateTime: end, timeZone: 'Asia/Jerusalem' }, ...extra,
});
// The proven culprit, as read from the owner's live calendar on 2026-09-17.
const dinaVacation = [{
  id: 'ev_dina', subject: 'Dina - Vacation ', isCancelled: false, isAllDay: true, showAs: 'free', attendees: yael,
  start: { dateTime: '2026-09-14T00:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-09-30T00:00:00.0000000', timeZone: 'UTC' },
}, timed('ev_lead', 'Leadership Alignment', '2026-09-17T16:30:00', '2026-09-17T17:10:00')];

test('R1 tick: the Dina-Vacation shape (all-day showAs:free with the holder) does NOT release the hold; the owner-book gate still sees it', async () => {
  const h = holdsHarness();
  const hold = h.seed();
  await runTick(dinaVacation, h);
  assert.equal(h.row(hold.id).status, 'active', 'hold must stay active — nobody booked it');
  assert.equal(h.row(hold.id).closure_reason, null);
  // The incident's 22:05Z owner booking at 15:30 must hit the hold gate.
  const gate = h.sh.getActiveHoldOverlapping(OWNER, '2026-09-17T15:30:00+03:00', '2026-09-17T16:10:00+03:00');
  assert.equal(gate?.id, hold.id);
  assert.deepEqual(h.sh.getRecentlyFulfilledHolds(OWNER, 24), [], 'the brief must not narrate a fulfilled hold');
});

test('R5 tick: a timed busy meeting with the holder merely brushing the window (14:30-15:15) does NOT release; nor do timed free / working-elsewhere covers', async () => {
  const h = holdsHarness();
  const hold = h.seed();
  await runTick([timed('ev_brush', 'Marketing sync', '2026-09-17T14:30:00', '2026-09-17T15:15:00')], h);
  assert.equal(h.row(hold.id).status, 'active');
  await runTick([timed('ev_we', 'WFH', '2026-09-17T09:00:00', '2026-09-17T18:00:00', { showAs: 'workingElsewhere' }), timed('ev_free', 'Hold', '2026-09-17T15:00:00', '2026-09-17T15:40:00', { showAs: 'free' })], h);
  assert.equal(h.row(hold.id).status, 'active');
});

test('P3 tick: a timed busy meeting with the holder COVERING the window releases it fulfilled_by_booking, whatever its subject', async () => {
  const h = holdsHarness();
  const hold = h.seed();
  await runTick([timed('ev_real', 'Leah - interview', '2026-09-17T15:00:00', '2026-09-17T15:40:00')], h);
  assert.equal(h.row(hold.id).status, 'released');
  assert.equal(h.row(hold.id).closure_reason, 'fulfilled_by_booking');
  assert.deepEqual(h.sh.getRecentlyFulfilledHolds(OWNER, 24).map(r => r.id), [hold.id]);
});

test('P4 tick: the same-subject invite sent a little shifted (15:10-15:50, overlap only) releases it', async () => {
  const h = holdsHarness();
  const hold = h.seed();
  await runTick([timed('ev_shift', ' interview - field & channel   marketing candidate', '2026-09-17T15:10:00', '2026-09-17T15:50:00')], h);
  assert.equal(h.row(hold.id).closure_reason, 'fulfilled_by_booking');
});

test('P5 profile-aware reconcile: lunch with another person is fixed and can fulfil that person\'s hold', async () => {
  const h = holdsHarness();
  const hold = h.seed();
  await runTick([timed('ev_shared_lunch', 'Lunch', '2026-09-17T15:00:00', '2026-09-17T15:40:00')], h);
  assert.equal(h.row(hold.id).status, 'released');
  assert.equal(h.row(hold.id).closure_reason, 'fulfilled_by_booking');
});

test('R6 profile-aware reconcile: solo or owner-self lunch cannot fulfil an unrelated hold', async () => {
  const solo = holdsHarness();
  const soloHold = solo.seed();
  await runTick([timed('ev_solo_lunch', 'Lunch', '2026-09-17T15:00:00', '2026-09-17T15:40:00', { attendees: [] })], solo);
  assert.equal(solo.row(soloHold.id).status, 'active');

  const self = holdsHarness();
  const selfHold = self.seed({ holderSlackId: OWNER, holderName: 'Owner Example' });
  await runTick([timed('ev_self_lunch', 'Lunch', '2026-09-17T15:00:00', '2026-09-17T15:40:00', { attendees: ownerSelf })], self);
  assert.equal(self.row(selfHold.id).status, 'active');
  assert.equal(self.row(selfHold.id).closure_reason, null);
});

test('P6 profile-aware reconcile: a regular owner-self meeting still fulfils the owner hold', async () => {
  const h = holdsHarness();
  const hold = h.seed({ holderSlackId: OWNER, holderName: 'Owner Example' });
  await runTick([timed('ev_owner_meeting', 'Project review', '2026-09-17T15:00:00', '2026-09-17T15:40:00', { attendees: ownerSelf })], h);
  assert.equal(h.row(hold.id).status, 'released');
  assert.equal(h.row(hold.id).closure_reason, 'fulfilled_by_booking');
});

test('P7 unavailable calendar leaves the hold open for a later reconciliation', async () => {
  const h = holdsHarness();
  const hold = h.seed();
  await runTick(new Error('isolated Graph outage'), h);
  assert.equal(h.row(hold.id).status, 'active');
  assert.equal(h.row(hold.id).closure_reason, null);
});

test('R2 explicit release matches the slot as an instant (owner-local offset form vs stored UTC)', () => {
  const h = holdsHarness();
  const hold = h.seed();
  const other = h.seed({ startIso: '2026-09-17T13:00:00.000Z', endIso: '2026-09-17T13:40:00.000Z' });
  const released = h.sh.releaseHoldsForOwner(OWNER, { startIso: '2026-09-17T15:00:00+03:00' }, 'owner_cancelled');
  assert.deepEqual(released.map(r => r.id), [hold.id]);
  assert.equal(h.row(hold.id).status, 'released');
  assert.equal(h.row(other.id).status, 'active');
});

test('R3 the owner booking over the held window (override_hold, 15:30 start inside 15:00-15:40) releases it as slot_booked', () => {
  const h = holdsHarness();
  const hold = h.seed();
  const untouched = h.seed({ startIso: '2026-09-17T14:00:00.000Z', endIso: '2026-09-17T14:40:00.000Z' });   // 17:00 local, outside the booking
  const cleared = h.sh.releaseHoldsTakenByBooking(OWNER, '2026-09-17T15:30:00+03:00', '2026-09-17T16:10:00+03:00', OWNER);
  assert.deepEqual(cleared.map(r => r.id), [hold.id]);
  assert.equal(h.row(hold.id).closure_reason, 'slot_booked');
  assert.equal(h.row(untouched.id).status, 'active');
  assert.deepEqual(h.sh.getRecentlyFulfilledHolds(OWNER, 24), []);
});

test('R4 the holder confirming their own held slot through Maelle is a fulfilment; the brief sees it', () => {
  const h = holdsHarness();
  const hold = h.seed();
  const cleared = h.sh.releaseHoldsTakenByBooking(OWNER, '2026-09-17T15:00:00+03:00', '2026-09-17T15:40:00+03:00', YAEL);
  assert.deepEqual(cleared.map(r => r.id), [hold.id]);
  assert.equal(h.row(hold.id).closure_reason, 'fulfilled_by_booking');
  assert.deepEqual(h.sh.getRecentlyFulfilledHolds(OWNER, 24).map(r => r.id), [hold.id]);
  // A booking elsewhere that day touches nothing.
  const again = h.seed();
  assert.deepEqual(h.sh.releaseHoldsTakenByBooking(OWNER, '2026-09-17T16:00:00+03:00', '2026-09-17T16:40:00+03:00', YAEL), []);
  assert.equal(h.row(again.id).status, 'active');
});

test('P1 colleague release with the UTC-normalized start (hold_slot path) still releases only that holder\'s hold at that instant', () => {
  const h = holdsHarness();
  const hold = h.seed();
  const someoneElse = h.seed({ holderSlackId: 'UOTHER', holderName: 'Other' });
  const released = h.sh.releaseHoldsForOwner(OWNER, { holderSlackId: YAEL, startIso: HELD_START }, 'colleague_released');
  assert.deepEqual(released.map(r => r.id), [hold.id]);
  assert.equal(h.row(hold.id).status, 'released');
  assert.equal(h.row(someoneElse.id).status, 'active');
});

test('P2 tick with no overlapping event leaves the hold active; a due hold still expires with the holder DM', async () => {
  const h = holdsHarness();
  const live = h.seed();
  const due = h.seed({ startIso: '2026-09-16T12:00:00.000Z', endIso: '2026-09-16T12:40:00.000Z', expiresAt: '2026-09-14T12:00:00.000Z' });
  const { dms } = await runTick([], h);
  assert.equal(h.row(live.id).status, 'active');
  assert.equal(h.row(due.id).status, 'expired');
  assert.equal(h.row(due.id).closure_reason, 'expired');
  assert.equal(dms.length, 1);
  assert.equal(dms[0].to, YAEL);
  assert.match(dms[0].text, /Freed up the/);
});
