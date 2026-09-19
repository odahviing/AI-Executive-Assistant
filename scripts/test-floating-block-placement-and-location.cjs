/*
 * Isolated branch integration for the 2026-09-14 scheduling batch:
 *   A. no relocation whose target start equals the block's CURRENT start.
 *   B. resolveLocation never stamps the home-day default "Huddle" when the
 *      owner forced a physical meeting (is_online=false).
 *   C. the per-turn resolved-attendee union never injects a colleague into a
 *      booking that named no attendees (the owner's solo drive block).
 *   D. owner ruling "I'm allowed to move a floating block outside of my frame.
 *      Count it as lunch." — a placed block counts as placed: no reclaim
 *      offers, no "no room for lunch" rejection, no duplicate booking.
 *   E. every mover (post-write rebalance, dense consolidation, pre-booking dry
 *      run, check_join, move_meeting) sizes a block to its EVENT's span, and
 *      create/move put the real post-write move on the tool result.
 *   F. calendar-health missing-block detection: whole-day presence, the
 *      override-day gate, and `can_skip` = fine to leave un-booked when no room.
 *   G. analyzeCalendar's detector uses the same day-scoped presence + can_skip.
 *   H. the owner-path block move writes its move_meeting activity row; the
 *      dead `confirm_outside_window` read on moves is gone.
 *
 * Production modules and AST-selected production branches are compiled from
 * source; no copied scheduling logic, no app bootstrap, no network/DB/LLM.
 * Run with --source-root <pre-fix checkout> to see the guarded cases fail.
 *
 * node scripts/test-floating-block-placement-and-location.cjs [--source-root SNAPSHOT]
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
const ms = iso => DateTime.fromISO(iso, { zone }).toMillis();

// Real floating-block helpers (used by the rule-6 branch under test).
const densityModule = compile(text('src/utils/calendarDensity.ts'), {},
  name => { if (name === 'luxon') return luxon; throw Error(`FORBIDDEN module: ${name}`); });
const floatingBlocks = compile(text('src/utils/floatingBlocks.ts'), {}, name => {
  if (name === 'luxon') return luxon;
  if (name === './logger') return { default: logger, ...logger };
  if (name === './calendarDensity') return densityModule;
  throw Error(`FORBIDDEN module: ${name}`);
});

const lunch = {
  name: 'lunch', duration_minutes: 25,
  preferred_start: '11:30', preferred_end: '13:30',
};
const event = (id, subject, start, end) => ({
  id, subject, isCancelled: false, isAllDay: false, showAs: 'busy', categories: [],
  start: { dateTime: start, timeZone: zone }, end: { dateTime: end, timeZone: zone },
});

// ── A. destination search: a slot equal to the current start is not a move ──
const relocationFile = 'src/utils/rebalanceFloatingBlocks.ts';
const hasGuardHelper = collect(source(relocationFile),
  n => ts.isFunctionDeclaration(n) && n.name?.text === 'findRelocationDestination').length === 1;
const BLOCK_START = ms('2026-10-04T13:00:00');
function destinationFor(alignedFromFinder) {
  const fb = { findBlockDestination: () => ({ aligned: alignedFromFinder, usedWorkingElsewhereFallback: true }) };
  const mod = compile(`${namedFunction(relocationFile, 'findRelocationDestination').getText()}
module.exports = { findRelocationDestination };`, { fb });
  return mod.findRelocationDestination(lunch, '2026-10-04', zone, { id: 'blk' }, BLOCK_START, []);
}

test('A · a destination equal to the block\'s current start is rejected', () => {
  assert.equal(hasGuardHelper, true, 'findRelocationDestination missing (pre-fix source)');
  assert.deepEqual(plain(destinationFor(BLOCK_START)),
    { aligned: null, usedWorkingElsewhereFallback: false, currentPlacementAcceptable: true });
});

test('A · a different in-window start still relocates (legitimate control)', () => {
  assert.equal(hasGuardHelper, true, 'findRelocationDestination missing (pre-fix source)');
  assert.deepEqual(plain(destinationFor(ms('2026-10-04T12:00:00'))),
    { aligned: ms('2026-10-04T12:00:00'), usedWorkingElsewhereFallback: true, currentPlacementAcceptable: false });
});

test('A · no slot at all stays a real "no room" (legitimate control)', () => {
  assert.deepEqual(plain(destinationFor(null)),
    { aligned: null, usedWorkingElsewhereFallback: false, currentPlacementAcceptable: false });
});

test('A · the overlap branch stays silent when the block is already best-placed', () => {
  const sweep = namedFunction(relocationFile, 'rebalanceFloatingBlocksAfterMutation');
  const branch = one(collect(sweep, n => ts.isIfStatement(n)
    && n.expression.getText() === 'relocation.currentPlacementAcceptable'), 'best-placed branch');
  const body = branch.thenStatement.getText();
  assert.equal(/Floating block overlap|result\.overlapping\+\+/.test(body), false,
    'the "current placement is fine" case still falls into the no-room overlap shadow');
});

test('A · computeBlockRelocation routes through the guard, not the raw finder', () => {
  const fn = namedFunction(relocationFile, 'computeBlockRelocation');
  assert.equal(collect(fn, n => ts.isCallExpression(n) && n.expression.getText() === 'fb.findBlockDestination').length, 0,
    'computeBlockRelocation still calls fb.findBlockDestination directly');
  assert.equal(collect(fn, n => ts.isCallExpression(n) && n.expression.getText() === 'findRelocationDestination').length, 1,
    'computeBlockRelocation does not call the guarded helper');
});

// ── B. home day + internal-only + owner forced physical ────────────────────
function resolveOn(dayLocation, input) {
  const mod = compile(text('src/utils/resolveLocation.ts'), {}, name => {
    if (name === './workHours') return { getEffectiveWorkDayForInstant: () => ({ location: dayLocation }) };
    throw Error(`FORBIDDEN module: ${name}`);
  });
  return mod.resolveLocation({
    profile: {
      user: { name: 'Idan Cohen', timezone: zone },
      meetings: { office_location: { short_label: 'Reflectiz Office', full_label: 'Reflectiz, 6 Hanagar St' } },
      categories: [{ name: 'Meeting' }],
    },
    startIso: '2026-10-04T10:00:00+03:00',
    intent: 'new_booking',
    category: 'Meeting',
    participantCount: 2,
    hasExternalAttendee: false,
    initiatorRole: 'owner',
    ...input,
  });
}

test('B · forced physical, home day, internal-only → a real venue, never Huddle', () => {
  const verdict = resolveOn('home', { ownerIsOnlineHint: false });
  assert.equal(verdict.kind, 'resolved');
  assert.notEqual(verdict.location, 'Huddle');
  assert.equal(verdict.location, 'Reflectiz Office');
  // Owner ruling 2026-09-15 (test-location-rules-and-venue.cjs, A): forced
  // physical keeps the Teams link — venue AND isOnline=true.
  assert.equal(verdict.isOnline, true);
});

test('B · no hint, home day, internal-only → still Huddle (legitimate control)', () => {
  const verdict = resolveOn('home', {});
  assert.deepEqual(
    { kind: verdict.kind, location: verdict.location, isOnline: verdict.isOnline },
    { kind: 'resolved', location: 'Huddle', isOnline: false },
  );
});

test('B · office day, internal-only, forced physical keeps the short label (legitimate control)', () => {
  const verdict = resolveOn('office', { ownerIsOnlineHint: false });
  assert.equal(verdict.location, 'Reflectiz Office');
  assert.equal(verdict.isOnline, true);   // owner ruling 2026-09-15 — link kept on forced physical
});

// ── C. the resolved-attendee union ────────────────────────────────────────
const createFile = 'src/skills/meetings/ops/handlers/createMeeting.ts';
function runAttendeeUnion(attendees, resolved) {
  const unionIf = one(collect(source(createFile), n => ts.isIfStatement(n)
    && n.getText().includes('recovered resolved internal attendees into booking')
    && n.expression.getText().includes('Array.isArray(context.resolvedMeetingAttendees)')), 'attendee-union if');
  const block = unionIf.parent;
  assert.equal(ts.isBlock(block) || ts.isSourceFile(block), true, 'attendee-union: unexpected parent');
  const index = block.statements.indexOf(unionIf);
  const before = block.statements[index - 1];
  const prelude = before && ts.isVariableStatement(before) && before.getText().includes('callerNamedAnAttendee')
    ? `${before.getText()}\n` : '';
  const mod = compile(`${prelude}${unionIf.getText()}
module.exports = { attendees };`, {
    attendees,
    context: { resolvedMeetingAttendees: resolved, senderRole: 'owner' },
    args: { subject: 'Drive home' },
    logger,
  });
  return mod.attendees;
}

test('C · a booking with no attendees never absorbs the turn\'s resolved people', () => {
  assert.deepEqual(plain(runAttendeeUnion([], ['michal.s@reflectiz.com'])), []);
});

test('C · a booking that names someone still gets the resolved email (legitimate control)', () => {
  const out = runAttendeeUnion([{ name: 'Einav Noy' }], ['einav.n@reflectiz.com']);
  assert.deepEqual(plain(out), [{ name: 'Einav Noy' }, { email: 'einav.n@reflectiz.com' }]);
});

test('C · an already-present email is not duplicated (legitimate control)', () => {
  const out = runAttendeeUnion([{ email: 'Einav.N@reflectiz.com' }], ['einav.n@reflectiz.com']);
  assert.deepEqual(plain(out), [{ email: 'Einav.N@reflectiz.com' }]);
});

// ── C2. the classifier sees the owner's forced-physical signal ────────────
// Prompt capture: proves the input reaches the model (owner ruling 2026-09-14),
// never that the model obeys it. The classification outcome stays model-dependent.
let capturedPrompt = '';
async function capture({ messages }) {
  capturedPrompt = messages[0].content;
  return { content: [{ text: 'Physical | stub' }] };
}
const detectCategoryModule = compile(text('src/skills/meetings/detectCategory.ts'), {}, name => {
  if (name === '@anthropic-ai/sdk') return {};
  if (name === '../../llm/client') return { getAnthropicClient: () => ({ messages: { create: capture } }) };
  if (name === '../../llm/models') return { SONNET: { model: 'stub' } };
  if (name === '../../config') return { config: { ANTHROPIC_API_KEY: 'stub-key-not-used' } };
  if (name === '../../utils/logger') return { default: logger, ...logger };
  throw Error(`FORBIDDEN module: ${name}`);
});
async function classifierPromptFor(extra) {
  capturedPrompt = '';
  await detectCategoryModule.detectCategory({
    profile: {
      user: { name: 'Idan Cohen', email: 'idan@reflectiz.com', timezone: zone },
      meetings: { private_emails: [] },
      categories: [
        { name: 'Meeting', description: 'generic work meeting' },
        { name: 'Physical', description: 'in person at his own office' },
      ],
    },
    subject: 'Meeting with Einav',
    attendees: [{ email: 'einav.n@reflectiz.com' }],
    requestedCategory: 'Physical',
    ...extra,
  });
  return capturedPrompt;
}

test('C2 · a venue-less in-person request reaches the classifier as a stated fact', async () => {
  assert.match(await classifierPromptFor({ ownerRequestedInPerson: true }), /Meeting mode: IN-PERSON/);
});

test('C2 · nothing is added without an in-person request (legitimate control)', async () => {
  assert.equal(/Meeting mode:/.test(await classifierPromptFor({})), false);
  assert.equal(/Meeting mode:/.test(await classifierPromptFor({ ownerRequestedInPerson: false })), false);
});

test('C2 · the hint is owner-path only and never set by is_online:true', () => {
  const gates = collect(source('src/skills/meetings/planMeeting.ts'), n => ts.isPropertyAssignment(n)
    && n.name.getText() === 'ownerRequestedInPerson');
  assert.equal(gates.length, 2, 'planMeeting: both detectCategory calls must carry the hint');
  for (const gate of gates) {
    assert.equal(gate.initializer.getText(),
      "input.isOnlineHint === false && input.initiator !== 'colleague'",
      'the hint is not gated to an owner-stated is_online:false');
  }
  const moveGate = one(collect(source('src/skills/meetings/ops/handlers/moveMeeting.ts'),
    n => ts.isPropertyAssignment(n) && n.name.getText() === 'ownerRequestedInPerson'), 'moveMeeting hint');
  assert.equal(moveGate.initializer.getText(),
    "args.is_online === false && context.senderRole === 'owner'");
});

// ── D1. the reclaim path is gone ──────────────────────────────────────────
test('D1 · the post-mutation sweep produces no reclaim candidates at all', () => {
  const sweep = namedFunction(relocationFile, 'rebalanceFloatingBlocksAfterMutation');
  assert.equal(collect(sweep, n => ts.isIdentifier(n) && n.text === 'reclaimable').length, 0,
    'the sweep still builds reclaim candidates');
  assert.equal(collect(sweep, n => ts.isIdentifier(n) && n.text === 'freedRangeIso').length, 0,
    'the freed-range gate (reclaim-only) is still wired');
  assert.equal(/ReclaimableBlock/.test(text(relocationFile).replace(/\/\/[^\n]*/g, '')), false,
    'ReclaimableBlock is still exported');
});

test('D1 · neither handler returns reclaimable_block to the model', () => {
  for (const file of [
    'src/skills/meetings/ops/handlers/moveMeeting.ts',
    'src/skills/meetings/ops/handlers/calendarReads.ts',
  ]) {
    assert.equal(/reclaimable/.test(text(file).replace(/\/\/[^\n]*/g, '')), false,
      `${file} still carries the reclaim payload`);
  }
});

// ── D2. a placed block counts as placed ───────────────────────────────────
// The real rule-6 loop out of checkSlot, executed against fixtures.
const rule6Loop = one(collect(source('src/utils/scheduleRules.ts'),
  n => ts.isForOfStatement(n) && n.expression.getText() === 'floatingBlockDefs'), 'rule 6 loop');
const rule6 = compile(`function rule6(input, profile, dayName, slotStart, slotEnd, excludeSet, whose, floatingBlockDefs, tz, slotFacts) {
  ${rule6Loop.getText()}
  return { passes: true };
}
module.exports = { rule6 };`, {
  DateTime,
  blockAppliesOnDay: floatingBlocks.blockAppliesOnDay,
  busyForBlockWindow: floatingBlocks.busyForBlockWindow,
  blockSizedToEvent: floatingBlocks.blockSizedToEvent,
  hasOtherHumanAttendee: floatingBlocks.hasOtherHumanAttendee,
  suppressedFloatingIds: new Set(),
  isFloatingBlockEvent: floatingBlocks.isFloatingBlockEvent,
}).rule6;

function checkRule6(blockEvent, slot) {
  const profile = {
    user: {email:'owner@test.invalid',timezone:zone,slack_user_id:'owner'},
    meetings: { floating_blocks: [lunch] },
    schedule: { office_days: { days: ['Sunday'] }, home_days: { days: ['Monday'] } },
  };
  const events = [
    // The whole 11:30–13:30 window is taken by real meetings, so the only way
    // the slot passes is the block already being placed.
    event('m1', 'Standup', '2026-10-04T11:30:00', '2026-10-04T13:00:00'),
    event('m2', 'Sync', '2026-10-04T13:00:00', '2026-10-04T13:30:00'),
    ...(blockEvent ? [blockEvent] : []),
  ];
  return rule6(
    { events, isFloatingBlock: false },
    profile,
    'Sunday',
    DateTime.fromISO(slot.start, { zone }),
    DateTime.fromISO(slot.end, { zone }),
    new Set(),
    'your',
    [lunch],
    zone,
    { slot_start: '2026-10-04T12:00:00' },
  );
}

test('D2 · a lunch the owner placed outside its window still counts as lunch', () => {
  const placed = event('blk', 'Drive home & lunch', '2026-10-04T13:00:00', '2026-10-04T13:55:00');
  assert.deepEqual(plain(checkRule6(placed, { start: '2026-10-04T12:00:00', end: '2026-10-04T12:40:00' })),
    { passes: true });
});

test('D2 · with no lunch anywhere on the day the window is still protected (legitimate control)', () => {
  const verdict = checkRule6(null, { start: '2026-10-04T12:00:00', end: '2026-10-04T12:40:00' });
  assert.equal(verdict.passes, false);
  assert.equal(verdict.violation_kind, 'floating_block_overlap');
});

test('D2 · a lunch placed INSIDE its window is still treated as movable (legitimate control)', () => {
  const placed = event('blk', 'Lunch', '2026-10-04T12:00:00', '2026-10-04T12:25:00');
  const verdict = checkRule6(placed, { start: '2026-10-04T12:00:00', end: '2026-10-04T12:40:00' });
  assert.equal(verdict.passes, false, 'an in-window block must still go through the capacity math');
});

// D2 (overturn) · "count it as lunch" satisfies the BLOCK, it does not make the
// clock time free: an out-of-window block is a commitment for rules 7/8, the
// occupancy tier and check_join_availability.
const occupancyRoleOf = compile(`${namedFunction('src/utils/scheduleRules.ts', 'occupancyRoleOf').getText()}
module.exports = { occupancyRoleOf };`, {
  DateTime, isFloatingBlockEvent: floatingBlocks.isFloatingBlockEvent,
  isMovableFloatingBlockEvent: floatingBlocks.isMovableFloatingBlockEvent,
}).occupancyRoleOf;

test('D2 · a lunch placed outside its window holds the owner\'s time (commitment)', () => {
  const placed = event('blk', 'Drive home & lunch', '2026-10-04T13:00:00', '2026-10-04T13:55:00');
  assert.equal(occupancyRoleOf(placed, [lunch], zone), 'commitment');
});

test('D2 · a lunch inside its window is still elastic (legitimate control)', () => {
  const placed = event('blk', 'Lunch', '2026-10-04T12:00:00', '2026-10-04T12:25:00');
  assert.equal(occupancyRoleOf(placed, [lunch], zone), 'ignore');
});

test('D2 · a block exactly filling its window edges is still elastic (legitimate control)', () => {
  const placed = event('blk', 'Lunch', '2026-10-04T11:30:00', '2026-10-04T11:55:00');
  assert.equal(occupancyRoleOf(placed, [lunch], zone), 'ignore');
});

test('D2 · ordinary and WE events keep their roles (legitimate control)', () => {
  const meeting = event('m1', 'Standup', '2026-10-04T10:00:00', '2026-10-04T10:40:00');
  assert.equal(occupancyRoleOf(meeting, [lunch], zone), 'commitment');
  assert.equal(occupancyRoleOf({ ...meeting, showAs: 'workingElsewhere' }, [lunch], zone), 'optional');
  assert.equal(occupancyRoleOf({ ...meeting, showAs: 'free' }, [lunch], zone), 'ignore');
});

test('D2 · every occupancyRoleOf call site passes the owner timezone', () => {
  for (const file of ['src/utils/scheduleRules.ts', 'src/skills/meetings.ts']) {
    for (const call of collect(source(file), n => ts.isCallExpression(n)
      && n.expression.getText() === 'occupancyRoleOf')) {
      assert.ok(call.arguments.length >= 3, `${file}: occupancyRoleOf called without a timezone`);
    }
  }
});

// book_floating_block idempotency: any block event on the DAY, not just in window.
const blockOpsFile = 'src/skills/calendarHealth/handlers/floatingBlockOps.ts';
const existingStmt = one(collect(source(blockOpsFile), n => ts.isVariableStatement(n)
  && n.getText().startsWith('const existingEvent = events.find(')), 'book_floating_block idempotency');
const parseGraphDtFn = namedFunction('src/skills/calendarHealth/classify.ts', 'parseGraphDt').getText();
function findExistingBlock(events) {
  const mod = compile(`${parseGraphDtFn}
${existingStmt.getText()}
module.exports = { existingEvent };`, {
    events, block: lunch, timezone: zone, date: '2026-10-04', DateTime,
    windowStart: DateTime.fromISO('2026-10-04T11:30:00', { zone }),
    windowEnd: DateTime.fromISO('2026-10-04T13:30:00', { zone }),
    fb: floatingBlocks,
  });
  return mod.existingEvent;
}

test('D2 · book_floating_block sees a lunch placed outside the window (no duplicate)', () => {
  const placed = event('blk', 'Drive home & lunch', '2026-10-04T13:45:00', '2026-10-04T14:40:00');
  assert.equal(findExistingBlock([placed])?.id, 'blk');
});

test('D2 · book_floating_block still sees an in-window lunch (legitimate control)', () => {
  const placed = event('blk', 'Lunch', '2026-10-04T12:00:00', '2026-10-04T12:25:00');
  assert.equal(findExistingBlock([placed])?.id, 'blk');
});

test('D2 · an unrelated event is not mistaken for the block (legitimate control)', () => {
  assert.equal(findExistingBlock([event('m1', 'Standup', '2026-10-04T12:00:00', '2026-10-04T12:25:00')]), undefined);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2026-09-14 floating-block batch (F1 · F3 · F4 · F5 · F7 · F8 · F10)
// ═══════════════════════════════════════════════════════════════════════════

// ── E. every mover sizes a block to ITS EVENT's span, and reports the move ──
// Real rebalance module: Graph writes, the shadow DM and the activity row are
// captured stubs; the destination search and the sizing are production code.
const graphCalls = [];
const activityRows = [];
function loadRebalance() {
  return compile(text(relocationFile), { DateTime }, name => {
    if (name === 'luxon') return luxon;
    if (name === '../db/calendarIssues') return {getSuppressedEventIds:()=>new Set()};
    if (name === './floatingBlocks') return floatingBlocks;
    if (name === './calendarDensity') return densityModule;
    if (name === './workHours') return { getEffectiveWorkDay: () => ({ hasOverride: false }) };
    if (name === './logger') return { default: logger, ...logger };
    if (name === '../core/requests/logActivity') return { logActivity: row => activityRows.push(row) };
    if (name === './shadowNotify') return { shadowNotify: async () => {} };
    if (name === '../connectors/graph/calendar') return {
      getCalendarEvents: async () => { throw Error('FORBIDDEN Graph read — preloadedDayEvents expected'); },
      updateMeeting: async args => { graphCalls.push(args); },
    };
    throw Error(`FORBIDDEN module: ${name}`);
  });
}
const rebalance = loadRebalance();
const rebalanceProfile = {
  user: { email: 'idan@reflectiz.com', timezone: zone, slack_user_id: 'U1' },
  meetings: { floating_blocks: [lunch] },
  schedule: { office_days: { days: ['Sunday'] }, home_days: { days: ['Monday'] } },
};
// The owner stretched lunch to 40 min (config says 25); a 12:00 meeting lands on it.
const stretchedLunch = event('blk', 'Lunch', '2026-10-04T12:00:00', '2026-10-04T12:40:00');
const newMeeting = event('m1', 'Sync', '2026-10-04T12:00:00', '2026-10-04T12:25:00');
const spanMin = args => DateTime.fromISO(args.end).diff(DateTime.fromISO(args.start), 'minutes').minutes;

test('E · blockSizedToEvent sizes to the event, falls back to config when unparsable', () => {
  assert.equal(typeof floatingBlocks.blockSizedToEvent, 'function', 'blockSizedToEvent missing (pre-fix source)');
  assert.equal(floatingBlocks.blockSizedToEvent(lunch, stretchedLunch, zone).duration_minutes, 40);
  assert.equal(floatingBlocks.blockSizedToEvent(lunch, event('b', 'Lunch', '2026-10-04T12:00:00', '2026-10-04T12:25:00'), zone), lunch);
  assert.equal(floatingBlocks.blockSizedToEvent(lunch, { start: { dateTime: 'garbage' }, end: { dateTime: 'x' } }, zone), lunch);
});

test('E · post-write rebalance relocates a stretched lunch at 40 min and reports the move', async () => {
  graphCalls.length = 0; activityRows.length = 0;
  const result = await rebalance.rebalanceFloatingBlocksAfterMutation({
    profile: rebalanceProfile, affectedSlotIso: '2026-10-04T12:00:00+03:00', ownerSlackId: 'U1',
    preloadedDayEvents: [stretchedLunch, newMeeting],
  });
  assert.equal(graphCalls.length, 1, 'exactly one Graph PATCH');
  assert.equal(spanMin(graphCalls[0]), 40, 'the block keeps the owner\'s 40-min span');
  const newStart = DateTime.fromISO(graphCalls[0].start, { zone });
  assert.notEqual(newStart.toFormat('HH:mm'), '12:00');
  assert.ok(newStart >= DateTime.fromISO('2026-10-04T11:30:00', { zone }) && newStart.plus({ minutes: 40 }) <= DateTime.fromISO('2026-10-04T13:30:00', { zone }), 'lands inside the window');
  assert.deepEqual(plain(result.moves), [`moved lunch 12:00→${newStart.toFormat('HH:mm')}`], 'the real move rides the result (F7)');
  assert.equal(result.moved, 1);
  assert.equal(activityRows.length, 1, 'one move_meeting activity row (M18)');
  assert.equal(activityRows[0].subkind, 'move_meeting');
});

test('E · a config-length lunch still relocates at config length (legitimate control)', async () => {
  graphCalls.length = 0;
  const plain = event('blk', 'Lunch', '2026-10-04T12:00:00', '2026-10-04T12:25:00');
  const result = await rebalance.rebalanceFloatingBlocksAfterMutation({
    profile: rebalanceProfile, affectedSlotIso: '2026-10-04T12:00:00+03:00', ownerSlackId: 'U1',
    preloadedDayEvents: [plain, newMeeting],
  });
  assert.equal(graphCalls.length, 1);
  assert.equal(spanMin(graphCalls[0]), 25);
  assert.equal(result.moves.length, 1);
});

test('E · nothing overlapping → no move, empty moves (legitimate control)', async () => {
  graphCalls.length = 0;
  const result = await rebalance.rebalanceFloatingBlocksAfterMutation({
    profile: rebalanceProfile, affectedSlotIso: '2026-10-04T15:00:00+03:00', ownerSlackId: 'U1',
    preloadedDayEvents: [stretchedLunch, event('m2', 'Late', '2026-10-04T15:00:00', '2026-10-04T15:25:00')],
  });
  assert.equal(graphCalls.length, 0);
  assert.deepEqual(plain(result.moves), []);
});

test('E · the pre-booking dry run promises the same 40-min landing the mover makes', async () => {
  const impact = await rebalance.dryRunFloatingBlockRelocation({
    profile: rebalanceProfile, candidateStartIso: '2026-10-04T12:00:00+03:00', candidateEndIso: '2026-10-04T12:25:00+03:00',
    preloadedDayEvents: [stretchedLunch],
  });
  assert.equal(impact.length, 1);
  assert.equal(impact[0].relocatable, true);
  const [from, to] = impact[0].newSlotLabel.split('–');
  const labelMin = DateTime.fromFormat(to, 'HH:mm').diff(DateTime.fromFormat(from, 'HH:mm'), 'minutes').minutes;
  assert.equal(labelMin, 40, `dry-run label ${impact[0].newSlotLabel} must span the event's 40 min`);
});

test('E · check_join and move_meeting size off the same helper (structural)', () => {
  const join = text('src/skills/meetings.ts');
  assert.match(join, /fb\.blockSizedToEvent\(block, (?:existingBlockEvent|blockEvent), timezone\)/, 'check_join in-turn move still sizes at config');
  assert.equal(/newStart\.plus\(\{ minutes: block\.duration_minutes \}\)/.test(join), false);
  const move = text('src/skills/meetings/ops/handlers/moveMeeting.ts');
  assert.match(move, /fb\.blockSizedToEvent\(matchedBlock, movingEvent!, timezone\)/, 'move_meeting keeps its own duration copy');
});

test('E · create_meeting / move_meeting put the real moves on the tool result (F7, structural)', () => {
  for (const file of ['src/skills/meetings/ops/handlers/createMeeting.ts', 'src/skills/meetings/ops/handlers/moveMeeting.ts']) {
    const src = text(file);
    assert.match(src, /const floatingResult = await rebalanceFloatingBlocksAfterMutation\(/, `${file}: rebalance result discarded`);
    assert.match(src, /\{ blocks_moved: blocksMoved \}/, `${file}: blocks_moved missing from the success return`);
  }
});

// ── F. calendar-health missing-block detection (F3 · F4 · F10) ─────────────
// The real detector statements out of checkHealth.ts, executed against fixtures.
const healthFile = 'src/skills/calendarHealth/handlers/checkHealth.ts';
function healthDetector() {
  const tree = source(healthFile);
  const stmt = (name, prefix) => one(collect(tree, n => ts.isVariableStatement(n)
    && n.declarationList.declarations.some(d => d.name.getText() === name
      && (!prefix || d.initializer?.getText().startsWith(prefix)))), `checkHealth:${name}`);
  const loop = one(collect(tree, n => ts.isForOfStatement(n) && n.expression.getText() === 'floatingBlocks'
    && n.getText().includes("type: 'missing_floating_block'")), 'missing-block loop');
  return `${parseGraphDtFn}\n${stmt('dayAllEvents').getText()}\n${stmt('dayEvents', 'dayAllEvents.filter').getText()}\n${stmt('dayHasOverride').getText()}\n${loop.getText()}\nmodule.exports = { issues };`;
}
// idan.yaml's lunch is `can_skip: true`; the D2 fixture above predates the field.
function runHealthDetection({ events, nowIso, hasOverride = false, block = { ...lunch, can_skip: true } }) {
  const profile = { ...rebalanceProfile, meetings: { floating_blocks: [block] } };
  return compile(healthDetector(), {
    DateTime, events, timezone: zone, dayStr: '2026-10-04', dayName: 'Sunday',
    nowMs: DateTime.fromISO(nowIso, { zone }).toMillis(),
    floatingBlocks: [block], fb: floatingBlocks, profile, waivedBlockGapIds: new Set(), issues: [],
    getEffectiveWorkDay: () => ({ hasOverride }),
  }).issues;
}

test('F4 · an early lunch that already ended is today\'s lunch, not a missing one', () => {
  const issues = runHealthDetection({
    events: [event('blk', 'Lunch', '2026-10-04T11:30:00', '2026-10-04T11:55:00')],
    nowIso: '2026-10-04T14:00:00',
  });
  assert.deepEqual(issues, []);
});

test('F3 · no missing-block issue on a schedule-override day (the fix loop\'s own gate)', () => {
  const issues = runHealthDetection({ events: [], nowIso: '2026-10-04T08:00:00', hasOverride: true });
  assert.deepEqual(issues, []);
});

test('F10 · skippable block, no room in the window → nothing to nag about', () => {
  const issues = runHealthDetection({
    events: [event('m1', 'Workshop', '2026-10-04T11:00:00', '2026-10-04T14:00:00')],
    nowIso: '2026-10-04T08:00:00',
  });
  assert.deepEqual(issues, []);
});

test('F10 · must-fit block, no room → still an issue (legitimate control)', () => {
  const issues = runHealthDetection({
    events: [event('m1', 'Workshop', '2026-10-04T11:00:00', '2026-10-04T14:00:00')],
    nowIso: '2026-10-04T08:00:00', block: { ...lunch, can_skip: false },
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, 'missing_floating_block');
});

test('F · missing lunch with room is still detected (legitimate control)', () => {
  const issues = runHealthDetection({ events: [], nowIso: '2026-10-04T08:00:00' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].block_name, 'lunch');
});

test('F · the overlap detectors still see only future-facing events (structural)', () => {
  const tree = source(healthFile);
  const dayEvents = one(collect(tree, n => ts.isVariableStatement(n)
    && n.declarationList.declarations.some(d => d.name.getText() === 'dayEvents' && d.initializer?.getText().startsWith('dayAllEvents.filter'))), 'dayEvents');
  assert.match(dayEvents.getText(), /nowMs/);
});

// ── G. analyzeCalendar's detector agrees with calendar-health (F10 / M1) ────
const analysisFile = 'src/skills/meetings/ops/analysis.ts';
function runAnalysisDetection({ timedMeetings, gaps, block = { ...lunch, can_skip: true } }) {
  const tree = source(analysisFile);
  const fmt = one(collect(tree, n => ts.isVariableStatement(n)
    && n.declarationList.declarations.some(d => d.name.getText() === 'fmt')), 'analysis:fmt');
  const loop = one(collect(tree, n => ts.isForOfStatement(n) && n.expression.getText() === 'floatingBlocks'
    && n.getText().includes("type: 'missing_floating_block'")), 'analysis missing-block loop');
  const profile = { ...rebalanceProfile, meetings: { floating_blocks: [block] } };
  return compile(`${fmt.getText()}\n${loop.getText()}\nmodule.exports = { issues };`, {
    floatingBlocks: [block], fb: floatingBlocks, dayName: 'Sunday', profile, timedMeetings, gaps, issues: [],
  }).issues;
}
const processed = (subject, start, end, blockName) => ({
  subject, _localStartTime: start, _localEndTime: end, ...(blockName ? { is_floating_block: { name: blockName } } : {}),
});

test('G · a lunch the owner placed outside its window counts as placed', () => {
  const issues = runAnalysisDetection({
    timedMeetings: [processed('Lunch', '14:00', '14:25', 'lunch')], gaps: [],
    block: { ...lunch, can_skip: false },
  });
  assert.deepEqual(issues, []);
});

test('G · a skippable lunch with room is reported, as calendar-health reports it', () => {
  const issues = runAnalysisDetection({ timedMeetings: [], gaps: [{ start: 9 * 60, end: 18 * 60 }] });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, 'missing_floating_block');
  assert.match(issues[0].suggestedFix, /block 25 min at 11:30/);
});

test('G · a skippable lunch with no room stays quiet (legitimate control)', () => {
  assert.deepEqual(runAnalysisDetection({ timedMeetings: [processed('Workshop', '11:00', '14:00')], gaps: [] }), []);
});

test('G · a must-fit lunch with no room is reported (legitimate control)', () => {
  const issues = runAnalysisDetection({ timedMeetings: [processed('Workshop', '11:00', '14:00')], gaps: [], block: { ...lunch, can_skip: false } });
  assert.equal(issues.length, 1);
});

test('G · an in-window lunch stuck under a meeting is still reported (legitimate control)', () => {
  const issues = runAnalysisDetection({
    timedMeetings: [processed('Lunch', '12:00', '12:25', 'lunch'), processed('Workshop', '11:00', '14:00')], gaps: [],
    block: { ...lunch, can_skip: false },
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0].detail, /overlaps Workshop/);
});

// ── H. owner-path block move writes its activity row; the dead flag is gone ─
test('F5 · the owner-path floating-block move logs a move_meeting row before returning', () => {
  const chain = one(collect(source('src/skills/meetings/ops/handlers/moveMeeting.ts'), n => ts.isArrowFunction(n)
    && n.getText().includes('action_summary: `Moved ${matchedBlock.name}')), 'owner block-move chain');
  const call = one(collect(chain, n => ts.isCallExpression(n) && n.expression.getText() === 'logActivity'), 'logActivity in chain');
  assert.match(call.getText(), /subkind: 'move_meeting'/);
  assert.match(call.getText(), /original_start: preMoveStartIso/);
});

test('F8 · move_meeting / bookingRequest carry no confirm_outside_window read or reference', () => {
  for (const file of ['src/skills/meetings/bookingRequest.ts', 'src/skills/meetings/ops/handlers/moveMeeting.ts']) {
    const stripped = text(file).replace(/\/\/[^\n]*/g, '');
    assert.equal(/confirm_outside_window/.test(stripped), false, `${file} still references confirm_outside_window`);
  }
});
