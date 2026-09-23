/*
 * Isolated branch integration for the 2026-09-14 location batch:
 *   L2. in-person on a non-office day is ONE checkSlot rule (1b), driven by
 *       `physical_meetings_require_office_day`, soft / owner-overridable; the
 *       search walker no longer hard-clamps home days.
 *   L3. create_meeting's Graph `location` is `plan.location` only — no second
 *       `is_online` decision drops the venue the tree chose.
 *   L4. update_meeting's shape re-evaluation feeds resolveLocation the SAME
 *       party-shape signals create/move do (locationSignalsFor) and returns
 *       the same `location_mode_unspecified` refusal on the ask verdict.
 *   L6. a move of a Private / Logistic event keeps its owner-stated venue.
 *   L7. planMeeting's "did the day type flip" reads the EFFECTIVE day.
 *   L9. dead schema keys / dead request args / the re-literalled Huddle.
 * Owner-ruled 2026-09-15 (three minimal edits, not a rewrite):
 *   A.  forced-physical (is_online=false, no venue named) keeps the venue AND
 *       isOnline=true so Graph attaches the Teams link; phone / Huddle / the
 *       ≥4 room branch unchanged.
 *   B.  office day + external in a DIFFERENT zone asks the owner too when an
 *       internal remainder could meet onsite (owner path only; colleague path
 *       still books online), while an owner/external one-to-one is online
 *       without asking where the owner sits alone.
 *   C.  the meeting-room mailbox never counts as a person — ONE head-count
 *       (participantHeadcount) for create/move and update_meeting's counts.
 *
 * Production modules and AST-selected production branches are compiled from
 * source; no copied logic, no app bootstrap, no network/DB/LLM.
 * Run with --source-root <pre-fix checkout> to see the guarded cases fail.
 *
 * node scripts/test-location-rules-and-venue.cjs [--source-root SNAPSHOT]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const luxon = require('luxon');
const { DateTime } = luxon;
const { test } = require('node:test');

const rootArg = process.argv.indexOf('--source-root');
const sourceRoot = rootArg < 0 ? path.resolve(__dirname, '..') : path.resolve(process.argv[rootArg + 1]);
const sources = new Map();
function text(file) { return fs.readFileSync(path.join(sourceRoot, file), 'utf8'); }
function source(file) {
  if (!sources.has(file)) sources.set(file,
    ts.createSourceFile(file, text(file), ts.ScriptTarget.Latest, true));
  return sources.get(file);
}
function collect(node, predicate) {
  const hits = [];
  function visit(n) { if (predicate(n)) hits.push(n); ts.forEachChild(n, visit); }
  visit(node);
  return hits;
}
function one(hits, label) { assert.equal(hits.length, 1, `${label}: missing/ambiguous AST anchor`); return hits[0]; }
function namedFunction(file, name) {
  return one(collect(source(file), n => ts.isFunctionDeclaration(n) && n.name?.text === name), `${file}:${name}`);
}
function compile(src, bindings, requireSafe = name => { throw Error(`FORBIDDEN module: ${name}`); }) {
  const output = ts.transpileModule(src, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  const context = vm.createContext({ ...bindings, module, exports: module.exports, require: requireSafe, console });
  new vm.Script(output, { filename: 'isolated-production-branch.ts' }).runInContext(context, { timeout: 5000 });
  return module.exports;
}
const logger = { info() {}, warn() {}, error() {}, default: { info() {}, warn() {}, error() {} } };
const zone = 'Asia/Jerusalem';
const plain = value => JSON.parse(JSON.stringify(value));

// Effective work-day stub: the date decides office / home / away.
const dayKind = { '2026-10-04': 'office', '2026-10-05': 'home', '2026-10-06': 'elsewhere' };
const effectiveDayFor = iso => {
  const date = DateTime.fromISO(iso, { zone, setZone: true }).setZone(zone).toISODate();
  const location = dayKind[date] ?? 'office';
  return {
    isWorkday: true, windows: [{ startMin: 9 * 60, endMin: 18 * 60 }], location,
    timezone: zone, isAway: location === 'elsewhere', hasOverride: false, source: 'yaml',
  };
};
const workHoursStub = {
  getEffectiveWorkDayForInstant: effectiveDayFor,
  getEffectiveWorkDay: effectiveDayFor,
  ownerWorkSegmentsBetween: (from, until) => [{ start: from, end: until, effectiveDay: effectiveDayFor(from.toISO()), fitsWorkHours: true }],
};

// Real helpers.
const densityModule = compile(text('src/utils/calendarDensity.ts'), {},
  name => { if (name === 'luxon') return luxon; throw Error(`FORBIDDEN module: ${name}`); });
const floatingBlocks = compile(text('src/utils/floatingBlocks.ts'), {}, name => {
  if (name === 'luxon') return luxon;
  if (name === './logger') return { default: logger, ...logger };
  if (name === './calendarDensity') return densityModule;
  throw Error(`FORBIDDEN module: ${name}`);
});
const resolveLocationModule = compile(text('src/utils/resolveLocation.ts'), {}, name => {
  if (name === './workHours') return workHoursStub;
  throw Error(`FORBIDDEN module: ${name}`);
});
const rules = compile(text('src/utils/scheduleRules.ts'), {}, name => {
  if (name === '../db/calendarIssues') return { getSuppressedEventIds: () => new Set() };
  if (name === 'luxon') return luxon;
  if (name === './categoryRules') return { checkCategorySlot: () => ({ allowed: true }), getProfileCategoryByName: () => undefined };
  if (name === './displaySubject') return { displaySubject: ev => ev.subject, PRIVATE_MASK: '(private)' };
  if (name === './floatingBlocks') return floatingBlocks;
  if (name === './workHours') return workHoursStub;
  throw Error(`FORBIDDEN module: ${name}`);
});

const profile = (overrides = {}) => ({
  user: { name: 'Idan Cohen', email: 'idan@reflectiz.com', timezone: zone, slack_user_id: 'U1' },
  meetings: {
    physical_meetings_require_office_day: true,
    office_location: { short_label: 'Reflectiz Office', full_label: 'Reflectiz, 6 Hanagar St' },
    floating_blocks: [],
  },
  schedule: { office_days: { days: ['Sunday'] }, home_days: { days: ['Monday'] } },
  categories: [{ name: 'Meeting' }, { name: 'Private', sets_sensitivity_private: true }, { name: 'Logistic', no_default_location: true }],
  ...overrides,
});

// ── L2 · rule 1b in THE validator ─────────────────────────────────────────
function slotOn(date, extra = {}) {
  return rules.checkSlot({
    profile: profile(), category: 'Meeting', events: [],
    slotStartIso: `${date}T10:00:00+03:00`, slotEndIso: `${date}T10:25:00+03:00`,
    viewer: 'owner', ...extra,
  });
}

test('L2 · in-person on a home day is a soft violation named for the owner', () => {
  const verdict = slotOn('2026-10-05', { inPersonRequested: true });
  assert.equal(verdict.passes, false);
  assert.equal(verdict.violation_kind, 'in_person_on_home_day');
  assert.match(verdict.violation_label, /in-person meetings are only on your office days — Monday 5 Oct is a home day/);
});

test('L2 · the colleague reads the same rule about the owner, not "you"', () => {
  const verdict = slotOn('2026-10-05', { inPersonRequested: true, viewer: 'other' });
  assert.equal(verdict.violation_kind, 'in_person_on_home_day');
  assert.match(verdict.violation_label, /^Idan only takes in-person meetings on office days/);
});

test('L2 · an away day is not an office day either', () => {
  assert.equal(slotOn('2026-10-06', { inPersonRequested: true }).violation_kind, 'in_person_on_home_day');
});

test('L2 · owner override (allowRelaxed) books through it (legitimate control)', () => {
  assert.equal(slotOn('2026-10-05', { inPersonRequested: true, allowRelaxed: true }).passes, true);
});

test('L2 · office day, or no in-person request, or flag off → no rule (legitimate controls)', () => {
  assert.equal(slotOn('2026-10-04', { inPersonRequested: true }).passes, true);
  assert.equal(slotOn('2026-10-05', {}).passes, true);
  const off = profile(); off.meetings.physical_meetings_require_office_day = false;
  assert.equal(slotOn('2026-10-05', { inPersonRequested: true, profile: off }).passes, true);
});

test('L2 · the kind is owner-overridable and maps to the search label the day skip used', () => {
  assert.equal(rules.OWNER_OVERRIDABLE_KINDS.has('in_person_on_home_day'), true);
  assert.equal(rules.mapVerdictToRejectLabel('in_person_on_home_day', 'home'), 'wrong_day_type');
  assert.equal(rules.OWNER_OVERRIDABLE_SEARCH_LABELS.has('wrong_day_type'), true);
});

test('L2 · the search walker no longer clamps days itself and feeds the rule (structural)', () => {
  const walker = text('src/connectors/graph/findAvailableSlots.ts');
  assert.equal(/reason: 'wrong_day_type'/.test(walker), false, 'the whole-day in_person skip is still in the walker');
  assert.equal(/officeDayNames\s*\/\/ hard constraint/.test(walker), false, 'the office-only workDays clamp is still there');
  assert.match(walker, /inPersonRequested: meetingMode === 'in_person'/);
  const plan = one(collect(source('src/skills/meetings/planMeeting.ts'), n => ts.isPropertyAssignment(n)
    && n.name.getText() === 'inPersonRequested'), 'planMeeting inPersonRequested');
  assert.equal(plan.initializer.getText(), "input.isOnlineHint === false");
});

// ── L3 · create_meeting's Graph location is plan.location only ────────────
const createFile = 'src/skills/meetings/ops/handlers/createMeeting.ts';
function graphLocationFor(args, resolvedLocationParts) {
  const prop = one(collect(source(createFile), n => ts.isPropertyAssignment(n) && n.name.getText() === 'location'
    && n.initializer.getText().includes('resolvedLocationParts.join')), 'create location property');
  return compile(`const location = ${prop.initializer.getText()};\nmodule.exports = { location };`,
    { args, resolvedLocationParts },
    name => { if (name.endsWith('utils/textScrubber')) return { scrubInternalLeakage: s => s }; throw Error(`FORBIDDEN module: ${name}`); }).location;
}

test('L3 · an is_online meeting the tree still gave a venue keeps it on the event', () => {
  assert.equal(graphLocationFor({ is_online: true }, ['Idan Office']), 'Idan Office');
});

test('L3 · no venue from the tree → no location, whatever is_online says (legitimate control)', () => {
  assert.equal(graphLocationFor({ is_online: true }, []), undefined);
  assert.equal(graphLocationFor({ is_online: false }, []), undefined);
});

test('L3 · external + is_online:true reaches an empty venue through the tree itself', () => {
  const verdict = resolveLocationModule.resolveLocation({
    profile: profile(), startIso: '2026-10-04T10:00:00+03:00', intent: 'new_booking', category: 'Meeting',
    participantCount: 2, hasExternalAttendee: true, ownerIsOnlineHint: true, initiatorRole: 'owner',
  });
  assert.deepEqual(plain({ kind: verdict.kind, isOnline: verdict.isOnline, location: verdict.location }),
    { kind: 'resolved', isOnline: true, location: '' });
});

// ── L4 · update_meeting builds the same resolveLocation input as create ────
const planFile = 'src/skills/meetings/planMeeting.ts';
function loadPlanModule(people) {
  return compile(text(planFile), {}, name => {
    if (name === 'luxon') return luxon;
    if (name === '../../utils/resolveLocation') return resolveLocationModule;
    if (name === '../../utils/workHours') return workHoursStub;
    if (name === '../../utils/locationTz') return { inferTimezoneFromStateStatic: x => x };
    if (name === '../../utils/logger') return { default: logger, ...logger };
    if (name === '../../db/people') return {
      getTravelRecordById: () => null,
      personIdForSlackId: () => null,
      searchPeopleMemory: email => people.filter(p => p.email === email),
      getEffectiveTimezoneById: id => ({ timezone: people.find(p => p.person_id === id)?.timezone }),
    };
    if ([
      '../../connectors/graph/calendar', '../../utils/attendeeAvailability', '../../utils/scheduleRules',
      '../../utils/displaySubject', '../../utils/weTimeResolver', './nearbyAlternatives', './detectCategory',
      './findMeetingOwner', '../../db/venues', './bookingRequest',
    ].includes(name)) return {};
    throw Error(`FORBIDDEN module: ${name}`);
  });
}
const owner = { email: 'idan@reflectiz.com', isOwner: true };

test('L4 · two externals of unknown zone → has-external, zone unknown, nobody remote', () => {
  const plan = loadPlanModule([]);
  assert.equal(typeof plan.locationSignalsFor, 'function', 'locationSignalsFor missing (pre-fix source)');
  const signals = plan.locationSignalsFor(profile(), [owner, { email: 'a@acme.com' }, { email: 'b@acme.com' }], '2026-10-04T10:00:00+03:00');
  assert.deepEqual(plain(signals), plain({ anyParticipantRemote: false, hasExternalAttendee: true, externalAttendeeInDifferentTz: undefined, externalAttendeeNames: ['a@acme.com', 'b@acme.com'], tzAssumptionNotes: [] }));
  assert.equal('externalAttendeeInDifferentTz' in signals && signals.externalAttendeeInDifferentTz === undefined, true, 'unknown zone must stay undefined (→ ask), not false');
});

test('L4 · an external known to sit in another zone flips the different-zone signal', () => {
  const plan = loadPlanModule([{ person_id: 'p9', email: 'a@acme.com', timezone: 'America/New_York' }]);
  const signals = plan.locationSignalsFor(profile(), [owner, { email: 'a@acme.com' }], '2026-10-04T10:00:00+03:00');
  assert.equal(signals.externalAttendeeInDifferentTz, true);
});

test('L4 · internal-only → no external signals (legitimate control)', () => {
  const plan = loadPlanModule([]);
  const signals = plan.locationSignalsFor(profile(), [owner, { email: 'yael@reflectiz.com' }], '2026-10-04T10:00:00+03:00');
  assert.deepEqual(plain(signals), plain({ anyParticipantRemote: false, hasExternalAttendee: false, externalAttendeeInDifferentTz: undefined, externalAttendeeNames: [], tzAssumptionNotes: [] }));
});

test('L4 · those signals on an office day make the tree ASK the owner, and resolve for a colleague', () => {
  const base = {
    profile: profile(), startIso: '2026-10-04T10:00:00+03:00', intent: 'new_booking', category: 'Meeting',
    participantCount: 3, hasExternalAttendee: true, externalAttendeeInDifferentTz: undefined, anyParticipantRemote: false,
  };
  assert.equal(resolveLocationModule.resolveLocation({ ...base, initiatorRole: 'owner' }).kind, 'ask_owner_online_or_physical');
  assert.equal(resolveLocationModule.resolveLocation({ ...base, initiatorRole: 'colleague' }).kind, 'resolved');
});

test('L4 · update_meeting passes the builder\'s signals and returns the create-shaped refusal (structural)', () => {
  const move = source('src/skills/meetings/ops/handlers/moveMeeting.ts');
  const call = one(collect(move, n => ts.isCallExpression(n) && n.expression.getText() === 'resolveLocation'), 'update resolveLocation call');
  const arg = call.arguments[0].getText();
  for (const key of ['hasExternalAttendee: signals.hasExternalAttendee', 'externalAttendeeInDifferentTz: signals.externalAttendeeInDifferentTz',
    'anyParticipantRemote: signals.anyParticipantRemote', 'initiatorRole:']) {
    assert.ok(arg.includes(key), `update_meeting resolveLocation input lacks ${key}`);
  }
  const src = text('src/skills/meetings/ops/handlers/moveMeeting.ts');
  assert.match(src, /locationSignalsFor\(context\.profile, attendeesAfterEdit, existing\.startIso\)/);
  assert.match(src, /loc\?\.kind === 'ask_owner_online_or_physical'[\s\S]{0,700}HANDLER_ERROR_CODE\.LOCATION_MODE_UNSPECIFIED/);
  assert.equal(/location → trip place/.test(src), false, 'the update-only trip-place override is still there');
});

// ── L6 · a move keeps a Private / Logistic event's owner-stated venue ─────
function moveVerdict(category, extra = {}) {
  return resolveLocationModule.resolveLocation({
    profile: profile(), intent: 'move', category, participantCount: 1, hasExternalAttendee: false,
    priorStartIso: '2026-10-04T10:00:00+03:00', startIso: '2026-10-05T10:00:00+03:00',   // office → home
    existingLocation: 'Home, Ramat Gan', existingIsOnline: false, ...extra,
  });
}

test('L6 · Private event moved across day types keeps its venue', () => {
  const verdict = moveVerdict('Private');
  assert.equal(verdict.kind, 'preserve_existing');
  assert.equal(verdict.location, 'Home, Ramat Gan');
  assert.equal(verdict.isOnline, false);
});

test('L6 · Logistic event moved across day types keeps its venue too', () => {
  assert.equal(moveVerdict('Logistic').kind, 'preserve_existing');
});

test('L6 · an owner hint on the move still wins (legitimate control)', () => {
  const verdict = moveVerdict('Private', { ownerLocationHint: 'Cafe Nero' });
  assert.deepEqual(plain({ kind: verdict.kind, location: verdict.location }), { kind: 'resolved', location: 'Cafe Nero' });
});

test('L6 · a fresh Private booking is still not auto-stamped (legitimate control)', () => {
  const verdict = resolveLocationModule.resolveLocation({
    profile: profile(), intent: 'new_booking', category: 'Private', participantCount: 1, hasExternalAttendee: false,
    startIso: '2026-10-05T10:00:00+03:00',
  });
  assert.equal(verdict.kind, 'skip_stamp');
});

test('L6 · an ordinary meeting moved across day types is still re-placed (legitimate control)', () => {
  assert.equal(moveVerdict('Meeting').kind, 'resolved');
});

// ── L7 · sameDayType reads the effective day ──────────────────────────────
function sameDayTypeWith(kindA, kindB) {
  const fn = namedFunction(planFile, 'sameDayType').getText();
  const stub = iso => ({ location: iso.startsWith('2026-10-04') ? kindA : kindB });
  return compile(`${fn}\nmodule.exports = { sameDayType };`, {
    DateTime, getEffectiveWorkDayForInstant: stub,
  }).sameDayType(profile(), '2026-10-04T10:00:00+03:00', '2026-10-05T10:00:00+03:00');
}

test('L7 · an override that makes a yaml-home Monday an office day is the same day type', () => {
  assert.equal(sameDayTypeWith('office', 'office'), true);
});

test('L7 · office → home still flips (legitimate control)', () => {
  assert.equal(sameDayTypeWith('office', 'home'), false);
});

// ── L9 · hygiene ──────────────────────────────────────────────────────────
test('L9 · dead schema keys and dead request args are gone; Huddle is one constant', () => {
  const schema = text('src/config/userProfile.ts');
  assert.equal(/^\s*default_location:/m.test(schema), false, 'default_location schema key still declared');
  assert.equal(/^\s*default_is_online:/m.test(schema), false, 'default_is_online schema key still declared');
  assert.equal(/\.strict\(\)/.test(schema), false, 'schema is strict — removing keys would reject a yaml still carrying them');
  const request = text('src/skills/meetings/bookingRequest.ts').replace(/\/\/[^\n]*/g, '');
  assert.equal(/existing_location|existing_is_online|prior_start|prior_end/.test(request), false);
  assert.match(text('src/db/venues.ts'), /HUDDLE_LABEL\.toLowerCase\(\)/);
  assert.match(text('src/utils/resolveLocation.ts'), /export const HUDDLE_LABEL = 'Huddle'/);
});

// ── A · forced physical keeps the venue AND the Teams link ────────────────
const resolve = input => resolveLocationModule.resolveLocation({
  profile: profile(), intent: 'new_booking', category: 'Meeting', anyParticipantRemote: false, ...input,
});
const shape = v => ({ kind: v.kind, isOnline: v.isOnline, location: v.location, addRoomEmail: v.addRoomEmail });
const OFFICE = '2026-10-04T10:00:00+03:00', HOME = '2026-10-05T10:00:00+03:00', AWAY = '2026-10-06T10:00:00+03:00';

test('A · office day + external in a different zone + owner said in-person → office address WITH the link', () => {
  const v = resolve({ startIso: OFFICE, participantCount: 2, hasExternalAttendee: true, externalAttendeeInDifferentTz: true, ownerIsOnlineHint: false, initiatorRole: 'owner' });
  assert.deepEqual(shape(v), { kind: 'resolved', isOnline: true, location: 'Reflectiz, 6 Hanagar St', addRoomEmail: undefined });
});

test('A · office day + external in the same zone + owner said in-person → office address WITH the link', () => {
  const v = resolve({ startIso: OFFICE, participantCount: 2, hasExternalAttendee: true, externalAttendeeInDifferentTz: false, ownerIsOnlineHint: false, initiatorRole: 'owner' });
  assert.deepEqual(shape(v), { kind: 'resolved', isOnline: true, location: 'Reflectiz, 6 Hanagar St', addRoomEmail: undefined });
});

test('A · home day + external + owner said in-person → short label WITH the link', () => {
  const v = resolve({ startIso: HOME, participantCount: 2, hasExternalAttendee: true, ownerIsOnlineHint: false, initiatorRole: 'owner' });
  assert.deepEqual(shape(v), { kind: 'resolved', isOnline: true, location: 'Reflectiz Office', addRoomEmail: undefined });
});

test('A · the other forced-physical exits (office ≤3, home internal, non-work day) keep the link too', () => {
  for (const startIso of [OFFICE, HOME, AWAY]) {
    const v = resolve({ startIso, participantCount: 3, hasExternalAttendee: false, ownerIsOnlineHint: false, initiatorRole: 'owner' });
    assert.deepEqual(shape(v), { kind: 'resolved', isOnline: true, location: 'Reflectiz Office', addRoomEmail: undefined }, startIso);
  }
});

test('A · a remote participant + owner said in-person still lands physical, with the link', () => {
  const v = resolve({ startIso: OFFICE, participantCount: 2, hasExternalAttendee: false, anyParticipantRemote: true, ownerIsOnlineHint: false, initiatorRole: 'owner' });
  assert.deepEqual(shape(v), { kind: 'resolved', isOnline: true, location: 'Reflectiz Office', addRoomEmail: undefined });
});

test('A · unchanged: phone dial-in, Huddle, an owner-named venue, the ≥4 room branch (legitimate controls)', () => {
  assert.deepEqual(shape(resolve({ startIso: OFFICE, participantCount: 2, hasExternalAttendee: false, ownerLocationHint: '+972-54-123-4567', ownerIsOnlineHint: false })),
    { kind: 'resolved', isOnline: false, location: '+972-54-123-4567', addRoomEmail: undefined });
  assert.deepEqual(shape(resolve({ startIso: HOME, participantCount: 2, hasExternalAttendee: false })),
    { kind: 'resolved', isOnline: false, location: 'Huddle', addRoomEmail: undefined });
  assert.deepEqual(shape(resolve({ startIso: OFFICE, participantCount: 2, hasExternalAttendee: true, ownerLocationHint: 'Cafe Nero', ownerIsOnlineHint: false })),
    { kind: 'resolved', isOnline: false, location: 'Cafe Nero', addRoomEmail: undefined });
  assert.deepEqual(shape(resolve({ startIso: OFFICE, participantCount: 4, hasExternalAttendee: false, ownerIsOnlineHint: false })),
    { kind: 'resolved', isOnline: true, location: 'Meeting Room', addRoomEmail: true });
});

test('A · Graph keeps a real venue label next to isOnlineMeeting — only literal Teams strings are dropped', () => {
  const decl = one(collect(source('src/connectors/graph/calendarMutations.ts'), n => ts.isVariableDeclaration(n)
    && n.name.getText() === 'isTeamsSentinel'), 'isTeamsSentinel');
  const isTeamsSentinel = compile(`const isTeamsSentinel = ${decl.initializer.getText()};\nmodule.exports = { isTeamsSentinel };`, {}).isTeamsSentinel;
  assert.equal(isTeamsSentinel('Reflectiz, 6 Hanagar St'), false);
  assert.equal(isTeamsSentinel('Reflectiz Office'), false);
  assert.equal(isTeamsSentinel('Microsoft Teams'), true);
  const src = text('src/connectors/graph/calendarMutations.ts');
  assert.match(src, /isOnlineMeeting: params\.isOnline \?\? false/);
  assert.match(src, /\.\.\.\(effectiveLocation && \{ location:\s+\{ displayName: effectiveLocation \} \}\)/);
});

// ── B · owner/external 1:1 is online; a real hybrid roster asks once ──────
const askBase = { startIso: OFFICE, participantCount: 3, hasExternalAttendee: true, initiatorRole: 'owner' };

test('B · Louis incident: owner + one external on an office day books online without asking where the owner sits', () => {
  for (const externalAttendeeInDifferentTz of [true, false, undefined]) {
    const v = resolve({
      startIso: OFFICE,
      participantCount: 2,
      hasExternalAttendee: true,
      initiatorRole: 'owner',
      externalAttendeeInDifferentTz,
      externalAttendeeNames: ['Louis'],
    });
    assert.deepEqual(shape(v), { kind: 'resolved', isOnline: true, location: '', addRoomEmail: undefined });
    assert.match(v.reasoning, /one-to-one/);
  }
});

test('B · owner-explicit physical one-to-one still uses the office address and keeps Teams (legitimate control)', () => {
  const v = resolve({
    startIso: OFFICE,
    participantCount: 2,
    hasExternalAttendee: true,
    initiatorRole: 'owner',
    ownerIsOnlineHint: false,
    externalAttendeeNames: ['Louis'],
  });
  assert.deepEqual(shape(v), { kind: 'resolved', isOnline: true, location: 'Reflectiz, 6 Hanagar St', addRoomEmail: undefined });
});

test('B · office day + external in a different zone, owner path → ask (was: silent online)', () => {
  const v = resolve({ ...askBase, externalAttendeeInDifferentTz: true, externalAttendeeNames: ['Dana Levi'] });
  assert.equal(v.kind, 'ask_owner_online_or_physical');
  assert.equal(v.suggestedAskText, 'Apart from Dana Levi, do you want the rest to meet onsite at Reflectiz, 6 Hanagar St (with Dana Levi on Teams), or all online?');
});

test('B · the same-zone and unknown-zone asks use the SAME wording', () => {
  const same = resolve({ ...askBase, externalAttendeeInDifferentTz: false, externalAttendeeNames: ['Dana Levi'] });
  const unknown = resolve({ ...askBase, externalAttendeeInDifferentTz: undefined, externalAttendeeNames: ['Dana Levi'] });
  const different = resolve({ ...askBase, externalAttendeeInDifferentTz: true, externalAttendeeNames: ['Dana Levi'] });
  assert.equal(same.suggestedAskText, different.suggestedAskText);
  assert.equal(unknown.suggestedAskText, different.suggestedAskText);
  assert.equal(/online or physical/.test(same.suggestedAskText), false, 'the old "online or physical?" wording is still there');
});

test('B · two externals are named; three or more are counted', () => {
  assert.match(resolve({ ...askBase, externalAttendeeNames: ['Dana', 'Yossi'] }).suggestedAskText,
    /^Apart from Dana and Yossi, .* \(with them on Teams\), or all online\?$/);
  assert.match(resolve({ ...askBase, externalAttendeeNames: ['Dana', 'Yossi', 'Eli'] }).suggestedAskText,
    /^Apart from the 3 external guests, .* \(with them on Teams\), or all online\?$/);
  assert.match(resolve({ ...askBase, externalAttendeeNames: [] }).suggestedAskText, /^Apart from the external guest, /);
});

test('B · colleague path: different zone still books online silently (legitimate control, v3.2.6)', () => {
  const v = resolve({ ...askBase, initiatorRole: 'colleague', externalAttendeeInDifferentTz: true });
  assert.deepEqual(shape(v), { kind: 'resolved', isOnline: true, location: '', addRoomEmail: undefined });
});

test('B · the answers land where the ask says: onsite → address + link; all online → Teams, no venue', () => {
  assert.deepEqual(shape(resolve({ ...askBase, externalAttendeeInDifferentTz: true, ownerIsOnlineHint: false })),
    { kind: 'resolved', isOnline: true, location: 'Reflectiz, 6 Hanagar St', addRoomEmail: undefined });
  assert.deepEqual(shape(resolve({ ...askBase, externalAttendeeInDifferentTz: true, ownerIsOnlineHint: true })),
    { kind: 'resolved', isOnline: true, location: '', addRoomEmail: undefined });
});

test('B · locationSignalsFor names the externals: people-memory name, then stated name, then the address', () => {
  const plan = loadPlanModule([{ person_id: 'p9', email: 'a@acme.com', name: 'Dana Levi', timezone: 'America/New_York' }]);
  const signals = plan.locationSignalsFor(profile(), [owner, { email: 'a@acme.com' }, { email: 'b@acme.com', name: 'Yossi' }, { email: 'c@acme.com' }], OFFICE);
  assert.deepEqual(plain(signals.externalAttendeeNames), ['Dana Levi', 'Yossi', 'c@acme.com']);
  const call = one(collect(source(planFile), n => ts.isCallExpression(n) && n.expression.getText() === 'resolveLocation'), 'planMeeting resolveLocation call');
  assert.ok(call.arguments[0].getText().includes('externalAttendeeNames: locationSignals.externalAttendeeNames'));
  const update = one(collect(source('src/skills/meetings/ops/handlers/moveMeeting.ts'), n => ts.isCallExpression(n) && n.expression.getText() === 'resolveLocation'), 'update resolveLocation call');
  assert.ok(update.arguments[0].getText().includes('externalAttendeeNames: signals.externalAttendeeNames'));
});

test('B · the three ask refusals ride the existing deferred hint and tell the model is_online=false/true (structural)', () => {
  for (const [file, tool] of [[createFile, 'create_meeting'], ['src/skills/meetings/ops/handlers/moveMeeting.ts', 'update_meeting'], ['src/skills/meetings/ops/handlers/moveMeeting.ts', 'move_meeting']]) {
    const src = text(file);
    const re = new RegExp(`LOCATION_MODE_UNSPECIFIED[\\s\\S]{0,900}?_deferred_action_hint: \\{ tool: '${tool}'[\\s\\S]{0,120}?_note: '([^']*)'`);
    const m = src.match(re);
    assert.ok(m, `${file}: ${tool} ask refusal lost its deferred hint`);
    assert.match(m[1], /is_online=false \(onsite/, `${file}:${tool} note`);
    assert.equal(/same\/unknown timezone/.test(m[1]), false, `${file}:${tool} note still scopes the ask to same/unknown zone`);
  }
});

// ── C · the room mailbox is never a person ────────────────────────────────
const roomProfile = () => profile({ meetings: { ...profile().meetings, room_email: 'Meeting@Reflectiz.com' } });

test('C · participantHeadcount: owner once, everyone else, never the room (case-insensitive)', () => {
  const plan = loadPlanModule([]);
  assert.equal(typeof plan.participantHeadcount, 'function', 'participantHeadcount missing (pre-fix source)');
  const room = { email: 'meeting@reflectiz.com' };
  assert.equal(plan.participantHeadcount(roomProfile(), [owner, { email: 'a@reflectiz.com' }, { email: 'b@reflectiz.com' }, room]), 3);
  assert.equal(plan.participantHeadcount(roomProfile(), [{ email: 'a@reflectiz.com' }, { email: 'b@reflectiz.com' }, room]), 3, 'owner absent from the roster is still counted once');
  assert.equal(plan.participantHeadcount(roomProfile(), [owner, { email: 'a@reflectiz.com' }, { email: 'b@reflectiz.com' }, { email: 'c@reflectiz.com' }, room]), 4);
  assert.equal(plan.participantHeadcount(profile(), [owner, { email: 'a@reflectiz.com' }, { email: 'b@reflectiz.com' }, room]), 4, 'no room_email configured → the address is a person');
});

test('C · three people with the room pre-added no longer reach the Meeting Room branch', () => {
  const plan = loadPlanModule([]);
  const count = plan.participantHeadcount(roomProfile(), [owner, { email: 'a@reflectiz.com' }, { email: 'b@reflectiz.com' }, { email: 'MEETING@reflectiz.com' }]);
  assert.deepEqual(shape(resolve({ profile: roomProfile(), startIso: OFFICE, participantCount: count, hasExternalAttendee: false })),
    { kind: 'resolved', isOnline: true, location: 'Reflectiz Office', addRoomEmail: undefined });
});

test('C · planMeeting and update_meeting count through the ONE helper (structural)', () => {
  const planSrc = text(planFile);
  assert.equal(/participantCount: participants\.length/.test(planSrc), false, 'planMeeting still counts participants.length');
  assert.match(planSrc, /const headcount = participantHeadcount\(profile, participants\)/);
  const moveSrc = text('src/skills/meetings/ops/handlers/moveMeeting.ts');
  assert.match(moveSrc, /const oldCount = participantHeadcount\(context\.profile, existing\.attendees\)/);
  assert.match(moveSrc, /const newCount = participantHeadcount\(context\.profile, attendeesAfterEdit\)/);
  assert.equal(/existing\.attendees\.length \+ 1/.test(moveSrc), false, 'update_meeting still hand-counts the roster');
});
