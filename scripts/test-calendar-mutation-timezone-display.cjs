// Exercises the real Graph calendar mutation module with an isolated Graph client.
// No app bootstrap, live calendar, database, model call, or production write.
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');
const { DateTime } = require('luxon');

const root = path.resolve(__dirname, '..');
const revisionArg = process.argv.indexOf('--source-revision');
const revision = revisionArg < 0 ? null : process.argv[revisionArg + 1];
const sourcePath = 'src/connectors/graph/calendarMutations.ts';

function readSource() {
  if (!revision) return fs.readFileSync(path.join(root, sourcePath), 'utf8');
  return cp.execFileSync('git', ['show', `${revision}:${sourcePath}`], { cwd: root, encoding: 'utf8' });
}

function compile(source, deps) {
  const module = { exports: {} };
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  new vm.Script(js, { filename: sourcePath }).runInNewContext({
    module,
    exports: module.exports,
    require(id) {
      if (id in deps) return deps[id];
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  return module.exports;
}

function harness(metadata = { isAllDay: false, type: 'singleInstance' }, writeError = null) {
  const writes = [];
  const reads = [];
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const profile = { user: { slack_user_id: 'owner', email: 'owner@example.test' } };
  const api = url => ({
    select(fields) { reads.push({ url, fields }); return this; },
    async get() { if (metadata instanceof Error) throw metadata; return metadata; },
    async patch(body) { if (writeError) throw writeError; writes.push({ method: 'patch', url, body }); },
    async post(body) { if (writeError) throw writeError; writes.push({ method: 'post', url, body }); return { id: 'fixture-event' }; },
  });
  const mutations = compile(readSource(), {
    luxon: { DateTime },
    '../../utils/logger': logger,
    '../../db': { auditLog() {} },
    '../../config/userProfile': { getProfileByEmail: () => profile },
    './graphClient': { getClient: () => ({ api }) },
    './calendarReads': { verifyEventDeleted: async () => true },
    './calendarCache': { invalidateCalendarCache() {} },
  });
  return { mutations, writes, reads };
}

function millis(pair) {
  return DateTime.fromISO(pair.dateTime, { zone: pair.timeZone }).toMillis();
}

function assertPair(pair, dateTime, timeZone) {
  assert.equal(pair.dateTime, dateTime);
  assert.equal(pair.timeZone, timeZone);
}

const owner = 'Asia/Jerusalem';
const baseCreate = {
  userEmail: 'owner@example.test',
  timezone: owner,
  subject: 'Fixture',
  attendees: [],
};

test('ordinary create stores owner timezone metadata without changing the instant', async () => {
  const h = harness();
  await h.mutations.createMeeting({
    ...baseCreate,
    start: '2026-09-17T13:15:00+03:00',
    end: '2026-09-17T13:25:00+03:00',
  });
  const event = h.writes[0].body;
  assertPair(event.start, '2026-09-17T13:15:00', owner);
  assertPair(event.end, '2026-09-17T13:25:00', owner);
  assert.equal(millis(event.start), DateTime.fromISO('2026-09-17T13:15:00+03:00').toMillis());
});

test('move update stores owner timezone metadata without changing the instant', async () => {
  const h = harness();
  await h.mutations.updateMeeting({
    userEmail: baseCreate.userEmail,
    meetingId: 'event-1',
    timezone: owner,
    start: '2026-09-17T10:15:00Z',
    end: '2026-09-17T10:25:00Z',
    isAllDay: false,
    eventType: 'singleInstance',
  });
  const patch = h.writes[0].body;
  assertPair(patch.start, '2026-09-17T13:15:00', owner);
  assert.equal(millis(patch.start), DateTime.fromISO('2026-09-17T10:15:00Z').toMillis());
});

test('occurrence update retains recurrence guard and uses owner timezone when unambiguous', async () => {
  const h = harness();
  await h.mutations.updateMeeting({
    userEmail: baseCreate.userEmail,
    meetingId: 'occurrence-1',
    timezone: owner,
    start: '2026-09-17T13:15:00+03:00',
    end: '2026-09-17T13:25:00+03:00',
    isAllDay: false,
    eventType: 'occurrence',
  });
  assert.equal(h.writes[0].body.start.timeZone, owner);
});

test('effective travel-zone write uses that owner zone and preserves the supplied instant', async () => {
  const h = harness();
  const zone = 'America/New_York';
  const start = '2026-07-08T09:00:00-04:00';
  await h.mutations.createMeeting({
    ...baseCreate,
    timezone: zone,
    start,
    end: '2026-07-08T09:30:00-04:00',
  });
  assert.equal(h.writes[0].body.start.timeZone, zone);
  assert.equal(millis(h.writes[0].body.start), DateTime.fromISO(start).toMillis());
});

test('attendee timezone cannot replace the owner timezone on the organizer event', async () => {
  const h = harness();
  await h.mutations.createMeeting({
    ...baseCreate,
    start: '2026-09-17T13:15:00+03:00',
    end: '2026-09-17T13:25:00+03:00',
    attendees: [{ name: 'New York attendee', email: 'attendee@example.test' }],
  });
  assert.equal(h.writes[0].body.start.timeZone, owner);
});

test('explicit spring-gap instant converts to a real owner clock without drift', async () => {
  const h = harness();
  const zone = 'America/New_York';
  const explicit = '2027-03-14T02:30:00-05:00';
  await h.mutations.createMeeting({
    ...baseCreate,
    timezone: zone,
    start: explicit,
    end: '2027-03-14T03:00:00-05:00',
  });
  assertPair(h.writes[0].body.start, '2027-03-14T03:30:00', zone);
  assert.equal(millis(h.writes[0].body.start), DateTime.fromISO(explicit).toMillis());
});

test('both repeated-hour occurrences retain distinct exact instants', async () => {
  const seen = [];
  for (const offset of ['+03:00', '+02:00']) {
    const h = harness();
    const start = `2026-10-25T01:15:00${offset}`;
    await h.mutations.updateMeeting({
      userEmail: baseCreate.userEmail,
      meetingId: `fold-${offset}`,
      timezone: owner,
      start,
      end: `2026-10-25T01:45:00${offset}`,
      isAllDay: false,
      eventType: 'exception',
    });
    const pair = h.writes[0].body.start;
    assert.equal(pair.timeZone, 'UTC');
    assert.equal(millis(pair), DateTime.fromISO(start).toMillis());
    seen.push(pair.dateTime);
  }
  assert.notEqual(seen[0], seen[1]);
});

test('all-day create keeps owner-local midnight boundaries and metadata', async () => {
  const h = harness();
  await h.mutations.createMeeting({
    ...baseCreate,
    subject: 'Away',
    start: '2026-10-25T11:00:00+03:00',
    end: '2026-10-25T12:00:00+03:00',
    isAllDay: true,
  });
  assertPair(h.writes[0].body.start, '2026-10-25T00:00:00', owner);
  assertPair(h.writes[0].body.end, '2026-10-26T00:00:00', owner);
});

test('invalid datetime or owner zone still fails before Graph write', async () => {
  for (const invalid of [
    { start: 'not-a-datetime', timezone: owner },
    { start: '2026-09-17T13:15:00+03:00', timezone: 'Mars/Olympus_Mons' },
  ]) {
    const h = harness();
    await assert.rejects(() => h.mutations.createMeeting({
      ...baseCreate,
      ...invalid,
      end: '2026-09-17T13:25:00+03:00',
    }), /invalid calendar datetime/);
    assert.equal(h.writes.length, 0);
  }
});

test('series-master time update remains blocked', async () => {
  const h = harness({ isAllDay: false, type: 'seriesMaster' });
  await assert.rejects(() => h.mutations.updateMeeting({
    userEmail: baseCreate.userEmail,
    meetingId: 'series-master',
    timezone: owner,
    start: '2026-09-17T13:15:00+03:00',
    end: '2026-09-17T13:25:00+03:00',
  }), /series master/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.reads.length, 1);
});

test('metadata-only update does not add a time or perform metadata read', async () => {
  const h = harness(new Error('must not read'));
  await h.mutations.updateMeeting({
    userEmail: baseCreate.userEmail,
    meetingId: 'event-1',
    timezone: owner,
    subject: 'Renamed',
  });
  assert.equal(JSON.stringify(Object.keys(h.writes[0].body)), JSON.stringify(['subject']));
  assert.equal(h.reads.length, 0);
});

test('Graph write unavailability remains explicit to the caller', async () => {
  const unavailable = new Error('Graph unavailable');
  const h = harness({ isAllDay: false, type: 'singleInstance' }, unavailable);
  await assert.rejects(() => h.mutations.createMeeting({
    ...baseCreate,
    start: '2026-09-17T13:15:00+03:00',
    end: '2026-09-17T13:25:00+03:00',
  }), error => error === unavailable);
  assert.equal(h.writes.length, 0);
});
