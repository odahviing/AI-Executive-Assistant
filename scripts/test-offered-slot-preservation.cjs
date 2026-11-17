/*
 * Isolated branch integration for offered-slot preservation. No app bootstrap.
 * Runs the actual TS stash module and AST-selected production branches/functions;
 * no copied scheduling algorithm and no test-only runtime exports. Selection is
 * strict (missing/ambiguous anchors fail). The Graph walker is a fixture boundary;
 * network, DB, filesystem writes and unlisted module loads are unavailable.
 *
 * node scripts/test-offered-slot-preservation.cjs [--source-root SNAPSHOT]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { DateTime } = require('luxon');
const { test } = require('node:test');

const rootArg = process.argv.indexOf('--source-root');
const sourceRoot = rootArg < 0 ? path.resolve(__dirname, '..') : path.resolve(process.argv[rootArg + 1]);
const handlerDir = 'src/skills/meetings/ops/handlers/';
const sources = new Map();
function source(file) {
  if (!sources.has(file)) sources.set(file, ts.createSourceFile(file,
    fs.readFileSync(path.join(sourceRoot, file), 'utf8'), ts.ScriptTarget.Latest, true));
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
function calls(node, name) {
  return collect(node, n => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name).length > 0;
}
function variableNames(node) {
  return ts.isVariableStatement(node) ? node.declarationList.declarations.map(d => d.name.getText()) : [];
}
function containsName(node, name) {
  return collect(node, n => ts.isIdentifier(n) && n.text === name).length > 0;
}
function compile(text, bindings, requireSafe = name => { throw Error(`FORBIDDEN module: ${name}`); }) {
  const output = ts.transpileModule(text, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  const context = vm.createContext({ ...bindings, module, exports: module.exports, require: requireSafe });
  new vm.Script(output, { filename: 'isolated-production-branch.ts' }).runInContext(context, { timeout: 3000 });
  return module.exports;
}
const logger = { info() {}, warn() {}, error() {} };
const zone = 'Asia/Jerusalem';
const instant = '2026-09-16T17:25:00+03:00';
const end = '2026-09-16T18:05:00+03:00';
const millis = value => DateTime.fromISO(value, { zone }).toMillis();
const density = compile(namedFunction('src/utils/calendarDensity.ts', 'alignNearestQuarter').getText(), { DateTime });
const tz = compile(source('src/utils/timezoneConvert.ts').text, {}, name => {
  assert.equal(name, 'luxon'); return { DateTime };
});
const workHours = compile(source('src/utils/workHours.ts').text, {}, name => {
  if (name === 'luxon') return { DateTime };
  if (name === './calendarDensity') return compile(source('src/utils/calendarDensity.ts').text, {}, () => ({ DateTime }));
  if (name === '../db/scheduleOverrides') return { getScheduleOverride: () => null };
  throw Error(`FORBIDDEN work-hours dependency: ${name}`);
});
const stated = compile(source('src/utils/weTimeResolver.ts').text, {}, name => {
  if (name === 'luxon') return { DateTime };
  if (name === './timezoneConvert') return tz;
  if (name === './workHours') return workHours;
  throw Error(`FORBIDDEN stated-clock dependency: ${name}`);
});
const requestedClock = one(collect(source(handlerDir + 'findAvailableSlots.ts'), n =>
  ts.isVariableStatement(n) && variableNames(n).includes('resolveRequestedClock')), 'actual requested-clock helper');

// Exercise the production named-slot guard with the no-predecessor fixture.
function orderGuardFor(branch) {
  return ['violatesOrder', 'anchoredSlotFailure', 'searchBoundFailure'].filter(name => calls(branch, name)).map(name =>
    one(collect(source(handlerDir + 'findAvailableSlots.ts'), n =>
      ts.isVariableStatement(n) && variableNames(n).includes(name)), name));
}

function harness(memoryFiles = new Map()) {
  let now = Date.parse('2026-09-14T10:30:00Z');
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const fakeFs = {
    readFileSync(file) { if (!memoryFiles.has(file)) throw Error('fixture file absent'); return memoryFiles.get(file); },
    writeFileSync(file, value) { memoryFiles.set(file, value); },
    mkdirSync() {},
  };
  const stash = compile(source('src/utils/offeredSlotsStash.ts').text,
    { Date: Clock, process: { cwd: () => '/isolated-offer-test' } }, name => {
      if (name === 'luxon') return { DateTime };
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:path') return path;
      if (name === './logger') return logger;
      throw Error(`FORBIDDEN stash dependency: ${name}`);
    });
  const requireSafe = name => {
    assert.match(name, /(?:\.\.\/)+utils\/offeredSlotsStash$/);
    return stash;
  };
  function execute(nodes, env, tail = '') {
    const body = nodes.map(n => n.getText()).join('\n');
    return compile(`export async function run() { ${body}\n${tail}\n }`,
      { DateTime, logger, predecessorEnd: undefined, ...density, ...tz, ...stated, ...env }, requireSafe).run();
  }
  function context(actor = 'owner', channelId = 'D-offer', threadTs = 't1') {
    return { channelId, threadTs, channel: 'slack', senderRole: actor, userId: actor,
      profile: { user: { timezone: zone, name: 'Owner Example', email: 'owner@example.test', slack_user_id: 'owner' },
        schedule: { work_hours: {}, office_days: { days: ['Monday', 'Tuesday', 'Wednesday'] }, home_days: { days: [] } } } };
  }
  const record = (ctx, slots = [{ start: instant }], extra = {}) => stash.recordOfferedSlots({
    channelId: ctx.channelId, threadTs: ctx.threadTs, timezone: zone, slots, ...extra,
  });
  function alternatives(ctx) {
    const fn = namedFunction('src/skills/meetings/ops/helpers.ts', 'recordProposedAlternatives');
    compile(fn.getText(), { logger }, requireSafe).recordProposedAlternatives({
      channelId: ctx.channelId, threadTs: ctx.threadTs, timezone: zone,
      alternatives: [{ start: instant, end }],
      widenedAlternatives: [{ start: '2026-09-17T17:25:00+03:00', end: '2026-09-17T18:05:00+03:00' }],
    });
  }
  async function grid(kind, ctx, start = instant, explicit = false) {
    const file = handlerDir + (kind === 'create' ? 'createMeeting.ts' : 'moveMeeting.ts');
    const fn = namedFunction(file, kind === 'create' ? 'handleCreateMeeting' : 'handleMoveMeeting');
    const args = { subject: 'Example meeting', start, end: DateTime.fromMillis(millis(start) + 40 * 60000, { zone }).toISO(), start_is_explicit: explicit };
    if (kind === 'create') {
      const block = one(collect(fn, n => ts.isBlock(n) && n.statements.some(s => variableNames(s).includes('startStr'))), 'create grid');
      await execute([block], { context: ctx, args });
      return { start: args.start, end: args.end };
    }
    args.new_start = args.start; args.new_end = args.end;
    const statements = fn.body.statements;
    const begin = statements.findIndex(s => variableNames(s).includes('effectiveStart'));
    const finish = statements.findIndex(s => ts.isIfStatement(s) && containsName(s.expression, 'offeredStart'));
    assert.ok(begin >= 0 && finish > begin, 'move grid statement range');
    return execute(Array.from(statements).slice(begin, finish + 1), { context: ctx, args, timezone: zone },
      'return { start: effectiveStart, end: effectiveEnd };');
  }
  async function consume(kind, ctx) {
    const file = handlerDir + (kind === 'create' ? 'createMeeting.ts' : 'moveMeeting.ts');
    const node = one(collect(source(file), n => ts.isIfStatement(n)
      && calls(n, 'clearOfferedSlots') && n.expression.getText() === 'context.channelId'), `${kind} consumption`);
    await execute([node], { context: ctx });
  }
  async function spread(ctx, annotatedSlots = [{ start: instant, end }], preferredSlotStatus) {
    const file = handlerDir + 'findAvailableSlots.ts';
    const declaration = one(collect(source(file), n => ts.isVariableStatement(n)
      && variableNames(n).includes('annotatedSlots')), 'spread slot list');
    const recorder = one(collect(source(file), n => ts.isIfStatement(n) && n.pos > declaration.pos
      && calls(n, 'recordOfferedSlots')), 'spread recorder');
    const before = recorder.parent.statements;
    const index = before.indexOf(recorder);
    const nodes = variableNames(before[index - 1]).includes('offeredSlots') ? [before[index - 1], recorder] : [recorder];
    await execute(nodes, { context: ctx, timezone: zone, annotatedSlots, preferredSlotStatus,
      presentTzForOutput: () => '', offerFingerprint: '40|2026-09-16|2026-09-17|person@example.test' });
  }
  async function candidate(ctx, options = {}) {
    const node = one(collect(source(handlerDir + 'findAvailableSlots.ts'), n => ts.isIfStatement(n)
      && containsName(n.expression, 'candidate_slots')), 'candidate branch');
    const args = { candidate_slots: [{ start: instant }], duration_minutes: 40, ...options.args };
    const callsMade = [];
    const env = {
      args, context: ctx, timezone: zone, userEmail: 'owner@example.test', searchWindowTz: '', autoPresentTz: '', presentTzForOutput: () => '',
      candidateAttendeeBusyEmails: ['person@example.test'], attendeeAvailability: [], mode: 'online',
      ownerClockProfile: undefined, optionLocale: undefined, partialSearch:false, scope:{},
      ...compile(namedFunction('src/utils/attendeeAvailability.ts', 'presentationClockFields').getText(), {}),
      relaxedGranted: false, excludeEventIdsForSearch: ['source-event'], leadHours: 1,
      viewer: ctx.senderRole, viewerEmail: 'viewer@example.test', movingEventIdMismatchWarning: undefined,
      CalendarOfflineError: class CalendarOfflineError extends Error {},
      firstRejectReason: counts => counts ? Object.keys(counts)[0] : undefined,
      // the real pure span lookup the block imports (findAvailableSlots.ts, 2026-09-15)
      ...compile(namedFunction('src/connectors/graph/findAvailableSlots.ts', 'oofUntilDisplayFor').getText(), {}),
      humanizeViolationLabel: reason => `fixture label: ${reason}`,
      attendeeHoursGroundingNotes() { throw Error('unexpected attendee-hours branch'); },
      attendeeCheckWarnings: () => ({}),
      findAvailableSlots: async params => {
        callsMade.push(params);
        if (options.error) throw new Error('fixture search failure');
        if (options.available === false) { params.diagnosticsOut.rejectedCounts = { owner_busy: 1 }; return []; }
        return [{ start: options.returnedStart ?? params.searchFrom, end: params.searchTo }];
      }, ...options.env,
    };
    const result = await execute([requestedClock, ...orderGuardFor(node), node], env);
    return { result, callsMade };
  }
  async function preferred(ctx, options = {}) {
    const file = handlerDir + 'findAvailableSlots.ts';
    const first = one(collect(source(file), n => ts.isVariableStatement(n)
      && variableNames(n).includes('rawPreferredSlot')), 'preferred start');
    const last = one(collect(source(file), n => ts.isIfStatement(n)
      && ts.isIdentifier(n.expression) && n.expression.text === 'preferredSlot'), 'preferred branch');
    const siblings = first.parent.statements;
    assert.equal(last.parent, first.parent, 'preferred anchors share a block');
    return execute([requestedClock, ...orderGuardFor(last), ...Array.from(siblings).slice(siblings.indexOf(first), siblings.indexOf(last) + 1)], {
      args: { preferred_slot: options.start ?? instant, duration_minutes: 40 }, context: ctx,
      timezone: zone, searchWindowTz: '', candidateSet: options.candidateSet ?? [], explicitCount: undefined, chosenStarts: new Set(),
      userEmail: 'owner@example.test', attendeeBusyEmails: ['person@example.test'], attendeeAvailability: [],
      mode: 'online', relaxedGranted: false, excludeEventIdsForSearch: ['source-event'], leadHours: 1,
      viewer: ctx.senderRole, viewerEmail: 'viewer@example.test', presentTzForOutput: () => '',
      findAvailableSlots: async params => options.returnedSlots ?? [{ start: params.searchFrom, end: params.searchTo }],
      firstRejectReason: () => 'owner_busy', humanizeViolationLabel: reason => `fixture label: ${reason}`,
    }, 'return { status: preferredSlotStatus, chosen: [...chosenStarts], preferredSlot };');
  }
  function holdHandler(t) {
    const db = new (require('better-sqlite3'))(':memory:');
    t.after(() => db.close());
    const schema = source('src/db/client.ts').text.match(/CREATE TABLE IF NOT EXISTS slot_holds[\s\S]*?idx_slot_holds_expiry ON slot_holds\(status, expires_at\);/);
    assert.ok(schema);
    db.exec(schema[0]);
    const sh = compile(source('src/db/slotHolds.ts').text, { Date: Clock }, name => {
      assert.equal(name, './client'); return { getDb: () => db };
    });
    const getPersonMemory = () => ({ name: 'Example colleague' });
    const { handleHoldSlot } = compile(namedFunction(handlerDir + 'calendarReads.ts', 'handleHoldSlot').getText(),
      { DateTime, Date: Clock, getPersonMemory }, name => {
        if (name.endsWith('/db/slotHolds')) return sh;
        if (name.endsWith('/db')) return { getPersonMemory };
        if (name.endsWith('/utils/workHours')) return workHours;
        return requireSafe(name);
      });
    return {
      hold: (ctx, startIso = instant, endIso = end, extra = {}) => handleHoldSlot(
        { action: 'hold', subject: 'Interview', start_iso: startIso, end_iso: endIso, ...extra }, { context: ctx }),
      active: () => sh.getActiveSlotHolds('owner'),
      sh,
    };
  }
  return { stash, context, record, alternatives, candidate, preferred, spread, grid, consume, execute, holdHandler,
    advance(ms) { now += ms; } };
}

test('every interval in a single twenty-option offer remains selectable', () => {
  const h = harness(), ctx = h.context('colleague');
  const slots = Array.from({length:20}, (_, i) => {
    const start = millis(instant) + i * 3600000;
    return {start:new Date(start).toISOString(),end:new Date(start + 25 * 60000).toISOString()};
  });
  h.stash.recordOfferedSlots({channelId:ctx.channelId,threadTs:ctx.threadTs,timezone:zone,slots});
  for(const slot of slots) assert.equal(h.stash.wasOfferedSlot(ctx.channelId,ctx.threadTs,slot.start),true);
});

test('exact stash matching accepts equivalent offsets but rejects nearby seconds/minutes', () => {
  const h = harness(), ctx = h.context(); h.record(ctx);
  assert.equal(h.stash.wasOfferedSlot(ctx.channelId, ctx.threadTs, '2026-09-16T14:25:00.000Z'), true);
  for (const delta of [-60000, -1000, -1, 1, 1000, 60000]) {
    assert.equal(h.stash.wasOfferedSlot(ctx.channelId, ctx.threadTs, new Date(millis(instant) + delta).toISOString()), false, `unoffered delta ${delta}`);
  }
  assert.equal(h.stash.wasOfferedSlot(ctx.channelId, ctx.threadTs, 'invalid'), false);
});

for (const actor of ['owner', 'colleague']) for (const producer of ['spread', 'candidate', 'preferred']) for (const kind of ['create', 'move']) {
  test(`${actor} ${producer} offer -> ${kind} keeps 17:25 and 40min, then consumes`, async () => {
    const h = harness(), ctx = h.context(actor);
    if (producer === 'candidate') {
      const { result, callsMade } = await h.candidate(ctx);
      assert.equal(result.results[0].available, true);
      assert.equal(callsMade[0].durationMinutes, 40);
      assert.equal(millis(callsMade[0].searchTo) - millis(callsMade[0].searchFrom), 40 * 60000);
      assert.equal(callsMade[0].relaxed, false);
      assert.equal(callsMade[0].autoExpand, false);
      assert.deepEqual(callsMade[0].attendeeBusyEmails, ['person@example.test']);
      assert.deepEqual(callsMade[0].excludeEventIds, ['source-event']);
    } else await h.spread(ctx, producer === 'preferred' ? [] : undefined,
      producer === 'preferred' ? { start: instant, end, available: true } : undefined);
    const booked = await h.grid(kind, ctx);
    assert.equal(millis(booked.start), millis(instant));
    assert.equal(millis(booked.end) - millis(booked.start), 40 * 60000);
    assert.equal(h.stash.wasOfferedSlot(ctx.channelId, ctx.threadTs, instant), true);
    await h.consume(kind, ctx);
    assert.equal(h.stash.getOfferedSlots(ctx.channelId, ctx.threadTs), null);
  });
}

for (const kind of ['create', 'move']) {
  test(`${kind}: unoffered 17:26 snaps, explicit 17:26 preserved, equivalent offset preserved`, async () => {
    const h = harness(), ctx = h.context(); h.record(ctx);
    const nearby = '2026-09-16T17:26:00+03:00';
    assert.equal(millis((await h.grid(kind, ctx, nearby)).start), millis('2026-09-16T17:30:00+03:00'));
    assert.equal(millis((await h.grid(kind, ctx, nearby, true)).start), millis(nearby));
    assert.equal(millis((await h.grid(kind, ctx, '2026-09-16T14:25:00Z')).start), millis(instant));
  });
}

test('candidate false/error/invalid/nearby result never records an offer', async () => {
  for (const options of [{ available: false }, { error: true }, { args: { candidate_slots: [{ start: 'invalid' }] } },
    { returnedStart: '2026-09-16T17:26:00+03:00' }]) {
    const h = harness(), ctx = h.context(); const { result } = await h.candidate(ctx, options);
    assert.equal(result.results[0].available, false);
    assert.equal(h.stash.getOfferedSlots(ctx.channelId, ctx.threadTs), null);
  }
});

for (const producer of ['candidate', 'preferred', 'spread', 'alternatives']) {
  test(producer + ' authorizes only the exact offered interval, including equivalent offsets', async t => {
    const h = harness(), ctx = h.context('colleague'), store = h.holdHandler(t);
    if (producer === 'candidate') await h.candidate(ctx);
    if (producer === 'preferred') await h.spread(ctx, [], (await h.preferred(ctx)).status);
    if (producer === 'spread') await h.spread(ctx);
    if (producer === 'alternatives') h.alternatives(ctx);
    const ok = await store.hold(ctx, '2026-09-16T14:25:00Z', '2026-09-16T15:05:00Z', { holder_slack_id: 'impostor' });
    assert.equal(ok.success, true);
    for (const delta of [-1, 1, 86_400_000]) {
      const wrongEnd = new Date(millis(end) + delta).toISOString();
      assert.equal((await store.hold(ctx, instant, wrongEnd)).error, 'slot_not_offered');
    }
    const rows = store.active();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, ok.hold_id);
    assert.equal(rows[0].holder_slack_id, ctx.userId);
    assert.equal(rows[0].end_iso, '2026-09-16T15:05:00.000Z');
    assert.equal(ok.expires_at, '2026-09-16T10:30:00.000Z');
  });
}

test('a reoffer supersedes the duration across offsets and a later point keeps only the booking start', async t => {
  const h = harness(), ctx = h.context('colleague'), store = h.holdHandler(t);
  await h.spread(ctx);
  const newEnd = '2026-09-16T14:50:00Z';
  h.record(ctx, [{ start: '2026-09-16T14:25:00Z', end: newEnd }]);
  assert.equal(h.stash.getOfferedSlots(ctx.channelId).length, 1);
  assert.equal((await store.hold(ctx)).error, 'slot_not_offered');
  assert.equal((await store.hold(ctx, instant, newEnd)).success, true);
  for (const invalid of [undefined, 'invalid', instant, '2026-09-16T14:00:00Z']) {
    h.record(ctx, [{ start: instant, end: invalid }]);
    assert.equal(h.stash.wasOfferedSlot(ctx.channelId, ctx.threadTs, instant), true);
    assert.equal((await store.hold(ctx, instant, newEnd)).error, 'slot_not_offered');
  }
});

test('email persists its start-only shape and booked picks survive restart; Slack holds require a live conversation', async t => {
  const files = new Map(), first = harness(files);
  const email = first.context('colleague', 'email:thread'), slack = first.context('colleague');
  first.record(email, [{ start: instant, end }]);
  first.record(slack, [{ start: instant, end }]);
  const entries = Object.values(JSON.parse([...files.values()][0]));
  assert.equal(entries.length, 1);
  assert.deepEqual(Object.keys(entries[0].slots[0]).sort(), ['display', 'startIso']);
  const restarted = harness(files), store = restarted.holdHandler(t);
  assert.equal(restarted.stash.wasOfferedSlot(email.channelId, email.threadTs, instant), true);
  for (const ctx of [email, slack]) assert.equal((await store.hold(ctx)).error, 'slot_not_offered');
  first.advance(2 * 3600_000 + 1);
  assert.equal((await first.holdHandler(t).hold(slack)).error, 'slot_not_offered');
});

test('owner can hold an unoffered interval; room threads remain separate', async t => {
  const h = harness(), store = h.holdHandler(t), room = h.context('colleague', 'Croom', 'thread');
  assert.equal((await store.hold(h.context())).success, true);
  await h.spread(room);
  assert.equal((await store.hold({ ...room, threadTs: 'other' })).error, 'slot_not_offered');
  assert.equal((await store.hold(room)).success, true);
});

test('later explicit owner/requester placeholder uses the current roster and authenticated colleague', async () => {
  const h = harness(), ctx = h.context('colleague'), userEmail = ctx.profile.user.email;
  const requesterEmail = 'requester@example.test';
  ctx.conversationHistory = [{ role: 'user', content: 'A candidate might pass HR later. Details will follow.' }];
  ctx.resolvedMeetingAttendeeGroups = [{ emails: [requesterEmail], unresolvedNames: [] }];
  const args = { subject: 'Tentative', attendees: [{ email: userEmail }], requester_slack_id: 'future-candidate' };
  const fn = namedFunction(handlerDir + 'createMeeting.ts', 'handleCreateMeeting');
  const statements = Array.from(fn.body.statements);
  const start = statements.findIndex(s => variableNames(s).includes('callerNamedAnAttendee'));
  const finish = statements.findIndex(s => variableNames(s).includes('assistantEmail'));
  const add = one(collect(fn, n => ts.isIfStatement(n)
    && n.expression.getText() === 'args.requester_is_attending !== false && requesterId && requesterEmailRaw'), 'attending requester');
  assert.ok(start >= 0 && finish > start);
  const roster = namedFunction('src/skills/meetings/ops/helpers.ts', 'meetingScopedAttendees');
  await h.execute([...statements.slice(start, finish), add], {
    context: ctx, args, attendees: args.attendees, userEmail,
    ...compile(roster.getText(), {}),
    getPersonMemory: id => id === ctx.userId ? { name: 'Requester', email: requesterEmail } : null,
  });
  assert.equal(args.requester_slack_id, ctx.userId);
  assert.deepEqual(args.attendees.map(a => a.email).sort(), [userEmail, requesterEmail].sort());
});

test('exact retries and caps leave one active hold per start; a nearer start bounds expiry', async t => {
  const h = harness(), ctx = h.context('colleague'), store = h.holdHandler(t);
  const slots = [0, 1, 2, 3].map(hour => ({
    start: DateTime.fromISO('2026-09-15T14:00:00Z').plus({ hours: hour }).toISO(),
    end: DateTime.fromISO('2026-09-15T14:25:00Z').plus({ hours: hour }).toISO(),
  }));
  h.record(ctx, slots);
  const hold = (i, subject) => store.hold(ctx, slots[i].start, slots[i].end, { subject });
  const first = await hold(0, 'A');
  assert.equal(first.success, true);
  assert.equal(Date.parse(first.expires_at), Date.parse(slots[0].start));
  assert.equal((await hold(0, 'A')).success, true);
  assert.equal(store.active().length, 1);
  assert.equal((await hold(1, 'A')).success, true);
  assert.equal((await hold(2, 'A')).error, 'meeting_hold_cap_reached');
  assert.equal((await hold(2, 'B')).success, true);
  assert.equal((await hold(3, 'B')).error, 'hold_cap_reached');
  assert.equal(store.active().length, 3);
  assert.equal(store.sh.getDueSlotHolds(first.expires_at).length, 1);
});

test('candidate foreign zone conversion, normalized duration, equivalent UTC result and fingerprint preservation', async () => {
  const h = harness(), ctx = h.context('colleague');
  h.record(ctx, [{ start: '2026-09-17T17:25:00+03:00' }], { searchFingerprint: 'prior-shape' });
  const { result, callsMade } = await h.candidate(ctx, {
    args: { candidate_slots: [{ start: '2026-09-16T10:25:00', end: '2026-09-16T10:26:00' }] },
    env: { searchWindowTz: 'America/New_York' }, returnedStart: '2026-09-16T14:25:00Z',
  });
  assert.equal(result.results[0].available, true);
  assert.equal(millis(callsMade[0].searchTo) - millis(callsMade[0].searchFrom), 40 * 60000);
  assert.equal(h.stash.wasOfferedSlot(ctx.channelId, ctx.threadTs, instant), true);
  assert.equal(h.stash.getOfferedSearchFingerprint(ctx.channelId, ctx.threadTs), 'prior-shape');
});

test('unavailable preferred status is not an offer', async () => {
  const h = harness(), ctx = h.context();
  await h.spread(ctx, [], { start: instant, end, available: false, broken_rule: 'owner_busy' });
  assert.equal(h.stash.getOfferedSlots(ctx.channelId, ctx.threadTs), null);
});

test('preferred exact validation canonicalizes bare owner clock and offers its exact instant', async () => {
  const h = harness(), ctx = h.context();
  const { status, preferredSlot } = await h.preferred(ctx, {
    start: '2026-09-16T17:25:00', returnedSlots: [{ start: '2026-09-16T14:25:00Z', end }],
  });
  assert.equal(millis(preferredSlot), millis(instant));
  assert.match(preferredSlot, /(?:Z|[+-]\d{2}:\d{2})$/);
  assert.equal(status.available, true);
  await h.spread(ctx, [], status);
  assert.equal(h.stash.wasOfferedSlot(ctx.channelId, ctx.threadTs, instant), true);
});

test('preferred nearby candidate or nearby recheck cannot impersonate the requested time', async () => {
  const h = harness(), ctx = h.context();
  const nearby = { start: '2026-09-16T17:26:00+03:00', end };
  const { status, chosen } = await h.preferred(ctx, { candidateSet: [nearby], returnedSlots: [nearby] });
  assert.equal(chosen.length, 0);
  assert.equal(status.available, false);
  await h.spread(ctx, [], status);
  assert.equal(h.stash.getOfferedSlots(ctx.channelId, ctx.threadTs), null);
});

test('candidate bare owner clock is returned and recorded as a canonical instant', async () => {
  const h = harness(), ctx = h.context();
  const { result } = await h.candidate(ctx, { args: { candidate_slots: [{ start: '2026-09-16T17:25:00' }] } });
  assert.equal(result.results[0].available, true);
  assert.match(result.results[0].start, /(?:Z|[+-]\d{2}:\d{2})$/);
  assert.equal(h.stash.wasOfferedSlot(ctx.channelId, ctx.threadTs, instant), true);
});

test('email retains its existing longer TTL and only persists through the in-memory filesystem fixture', async () => {
  const h = harness(), ctx = h.context('owner', 'email:fixture-thread');
  const { result } = await h.candidate(ctx);
  assert.equal(result.results[0].available, true);
  h.advance(2 * 3600000 + 1);
  assert.equal(h.stash.wasOfferedSlot(ctx.channelId, ctx.threadTs, instant), true);
  assert.equal(h.stash.wasOfferedSlot(ctx.channelId, 'other-thread', instant), false);
  await h.consume('move', ctx);
  assert.equal(h.stash.getOfferedSlots(ctx.channelId, ctx.threadTs), null);
});

test('mixed candidate batch records only available results and preserves rejection reason', async () => {
  const h = harness(), ctx = h.context('colleague');
  const blocked = '2026-09-16T18:25:00+03:00';
  const { result } = await h.candidate(ctx, {
    args: { candidate_slots: [{ start: instant }, { start: blocked }] },
    env: { findAvailableSlots: async params => {
      if (millis(params.searchFrom) === millis(instant)) return [{ start: params.searchFrom, end: params.searchTo }];
      params.diagnosticsOut.rejectedCounts = { owner_busy: 1 }; return [];
    } },
  });
  assert.equal(result.results[0].available, true);
  assert.equal(result.results[1].available, false);
  assert.equal(result.results[1].broken_rule, 'owner_busy');
  assert.equal(h.stash.wasOfferedSlot(ctx.channelId, ctx.threadTs, instant), true);
  assert.equal(h.stash.wasOfferedSlot(ctx.channelId, ctx.threadTs, blocked), false);
});

test('existing proposed-alternatives producer records both lists without replacing fingerprint', () => {
  const h = harness(), ctx = h.context('colleague');
  h.record(ctx, [{ start: instant }], { searchFingerprint: 'existing-spread' });
  h.alternatives(ctx);
  assert.equal(h.stash.wasOfferedSlot(ctx.channelId, ctx.threadTs, instant), true);
  assert.equal(h.stash.wasOfferedSlot(ctx.channelId, ctx.threadTs, '2026-09-17T17:25:00+03:00'), true);
  assert.equal(h.stash.getOfferedSearchFingerprint(ctx.channelId, ctx.threadTs), 'existing-spread');
});

test('DM lifecycle, group/channel isolation, TTL and missing context retain normal grid', async () => {
  const h = harness(), dm = h.context(); h.record(dm);
  assert.equal(h.stash.wasOfferedSlot(dm.channelId, 'next-top-level-message', instant), true);
  const room = h.context('colleague', 'C-room', 't1'); h.record(room);
  assert.equal(h.stash.wasOfferedSlot('C-room', 't2', instant), false);
  assert.equal(h.stash.wasOfferedSlot('C-other', 't1', instant), false);
  for (const kind of ['create', 'move']) {
    assert.equal(millis((await h.grid(kind, h.context('colleague', 'C-room', 't2'))).start), millis('2026-09-16T17:30:00+03:00'));
    assert.equal(millis((await h.grid(kind, h.context('owner', ''))).start), millis('2026-09-16T17:30:00+03:00'));
  }
  h.advance(2 * 3600000 + 1);
  assert.equal(h.stash.wasOfferedSlot(dm.channelId, dm.threadTs, instant), false);
  for (const kind of ['create', 'move']) assert.equal(millis((await h.grid(kind, dm)).start), millis('2026-09-16T17:30:00+03:00'));
});

test('Graph readers normalize UTC / explicit offset / named zone and reject bad zones', async () => {
  const file = 'src/connectors/graph/calendarReads.ts';
  const names = ['eventPartAsInstant', 'getEventType', 'getEventForAttendeeUpdate'];
  const code = names.map(name => namedFunction(file, name).getText()).join('\n');
  const vacatedHelper = compile(namedFunction('src/skills/meetings/ops/helpers.ts', 'computeVacatedSlot').getText(), { DateTime });
  for (const part of [
    { dateTime: '2026-09-16T11:00:00.0000000', timeZone: 'UTC' },
    { dateTime: '2026-09-16T14:00:00+03:00', timeZone: 'UTC' },
    { dateTime: '2026-09-16T14:00:00', timeZone: zone },
  ]) {
    const event = { id: 'fixture', type: 'singleInstance', start: part, end: { dateTime: '2026-09-16T11:40:00', timeZone: 'UTC' }, attendees: [] };
    const chain = { api(url) { assert.match(url, /^\/users\/owner@example\.test\/events\/fixture$/); return chain; }, select() { return chain; }, async get() { return event; } };
    const reader = compile(code, { DateTime, logger, getClient: () => chain });
    const detail = await reader.getEventType('owner@example.test', 'fixture');
    const attendee = await reader.getEventForAttendeeUpdate('owner@example.test', 'fixture');
    assert.equal(DateTime.fromISO(detail.startDateTime, { zone }).toFormat('HH:mm'), '14:00');
    assert.equal(millis(detail.endDateTime) - millis(detail.startDateTime), 40 * 60000);
    assert.equal(millis(attendee.startIso), millis(detail.startDateTime));
    const vacated = vacatedHelper.computeVacatedSlot.length === 3
      ? vacatedHelper.computeVacatedSlot(detail.startDateTime, detail.endDateTime, zone)
      : vacatedHelper.computeVacatedSlot(detail.startDateTime, instant, end, zone);
    assert.equal(millis(vacated.start), millis('2026-09-16T14:00:00+03:00'));
    assert.match(vacated.label, /14:00.*14:40/);
    event.start = { dateTime: '2026-09-16T11:00:00', timeZone: 'Invalid/Zone' };
    assert.equal((await reader.getEventType('owner@example.test', 'fixture')).startDateTime, undefined);
  }
});
