const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const ts = require('typescript');
const luxon = require('luxon');
const { harness } = require('./test-timezone-owner-decisions.cjs');

const sourceFile = 'src/connectors/graph/calendarReads.ts';
const repo = path.resolve(__dirname, '..');
const revisionIndex = process.argv.indexOf('--revision');
const readSource = file => revisionIndex < 0 ? fs.readFileSync(path.join(repo, file), 'utf8')
  : cp.execFileSync('git', ['show', process.argv[revisionIndex + 1] + ':' + file], { cwd: repo, encoding: 'utf8' });
const source = readSource(sourceFile);
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText;
const owner = 'owner@example.test', person = 'person@example.test';
const late = '2026-12-11T09:00:00Z', lateEnd = '2026-12-11T09:25:00Z';
const start = '2026-10-01T09:00:00Z';
const busyItem = { start: { dateTime: late }, end: { dateTime: lateEnd }, status: 'busy' };
const overlap = (item, from, to) => Date.parse(item.start.dateTime) < Date.parse(to) && Date.parse(item.end.dateTime) > Date.parse(from);

function provider({ schedule, page } = {}) {
  const posts = [], queries = [], warm = new Map(), eventCache = new Map();
  const client = { api(url) {
    let query;
    return {
      header() { return this; }, select() { return this; },
      query(value) { query = value; return this; },
      async get() { queries.push({ url, query }); return page(url, query); },
      async post(body) {
        posts.push(body);
        return { value: body.schedules.map(email => schedule ? schedule(email, body) : {
          scheduleId: email,
          scheduleItems: email === person && overlap(busyItem, body.startTime.dateTime, body.endTime.dateTime) ? [busyItem] : [],
        }) };
      },
    };
  } };
  const cache = {
    getCachedFreeBusy: k => warm.get(k), setCachedFreeBusy: (k, v) => warm.set(k, v),
    getCachedEvents: k => eventCache.get(k), setCachedEvents: (k, v) => eventCache.set(k, v),
  };
  const deps = { luxon, './graphClient': { getClient: () => client },
    './calendarCache': cache, '../../utils/turnCache': { memoize: (_key, read) => read() },
    '../../utils/logger': { info() {}, warn() {}, error() {} } };
  const mod = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + compiled + '\n})')(name => {
    if (!Object.hasOwn(deps, name)) throw Error('Unexpected dependency ' + name);
    return deps[name];
  }, mod, mod.exports);
  return { reads: mod.exports, posts, queries, warm, eventCache };
}

test('the last attendee clash in a long window reaches both search and the exact booking read', async () => {
  const p = provider(), h = harness({ ownerZone: 'UTC', travel: null });
  for (const day of Object.keys(h.profile.schedule.work_hours)) h.profile.schedule.work_hours[day] = ['09:00-09:25'];
  h.load('src/connectors/graph/calendarReads.ts').getFreeBusyForDecision = p.reads.getFreeBusyForDecision;
  const slots = await h.find(start, lateEnd, { durationMinutes: 25, attendeeAvailability: [], attendeeBusyEmails: [person] });
  assert.ok(slots.length > 0, 'other days remain available');
  const exact = await p.reads.getFreeBusyForDecision(owner, [person], late, lateEnd, 'UTC');
  assert.equal(exact[person].length, 1);
  assert.ok(!slots.some(slot => Date.parse(slot.start) === Date.parse(late)), 'search offered a time the write read marks busy');
});

test('a long read covers both endpoints across DST, deduplicates boundary-spanning items, and caches the full range', async () => {
  const allDay = { ...busyItem, start: { dateTime: start }, end: { dateTime: lateEnd } };
  const p = provider({ schedule: (email, body) => ({ scheduleId: email, scheduleItems: [allDay, busyItem].filter(item => overlap(item, body.startTime.dateTime, body.endTime.dateTime)) }) });
  const read = () => p.reads.getFreeBusy(owner, [person], start, lateEnd, 'America/New_York');
  assert.equal((await read())[person].length, 2);
  assert.equal(p.posts.length, 2);
  assert.equal(Date.parse(p.posts[0].endTime.dateTime), Date.parse(p.posts[1].startTime.dateTime));
  assert.ok(p.posts.every(body => Date.parse(body.endTime.dateTime) - Date.parse(body.startTime.dateTime) < 62 * 86400000));
  assert.equal(Date.parse(p.posts.at(-1).endTime.dateTime), Date.parse(lateEnd));
  await read();
  assert.equal(p.posts.length, 2);
});

test('missing schedule items are unconfirmed while an explicitly empty mailbox remains checked', async () => {
  const p = provider({ schedule: email => email === person ? { scheduleId: email } : { scheduleId: email, scheduleItems: [] } });
  const diag = {};
  const result = await p.reads.getFreeBusyForDecision(owner, [owner, person], late, lateEnd, 'UTC', diag);
  assert.deepEqual(diag.notChecked, [person]);
  assert.deepEqual(result[owner], []);
  assert.equal(p.warm.size, 0);
});

test('a malformed item cannot erase a known clash or establish the rest of the window as free', async () => {
  const p = provider({ schedule: email => ({ scheduleId: email, scheduleItems: [busyItem, { ...busyItem, start: { dateTime: 'invalid' } }] }) });
  const diag = {}, result = await p.reads.getFreeBusy(owner, [person], late, lateEnd, 'UTC', 'live', diag);
  assert.deepEqual(diag.notChecked, [person]);
  assert.equal(result[person].length, 1);
});

test('a short verified free window uses one provider request', async () => {
  const p = provider(), diag = {};
  assert.deepEqual((await p.reads.getFreeBusy(owner, [owner], late, lateEnd, 'UTC', 'live', diag))[owner], []);
  assert.deepEqual(diag.notChecked, []);
  assert.equal(p.posts.length, 1);
});

test('owner decision reads include events after the thousandth item', async () => {
  let pageIndex = 0;
  const p = provider({ page: () => {
    const index = pageIndex++;
    return index === 10 ? { value: [{ id: 'last-commitment' }] }
      : { value: Array.from({ length: 100 }, (_, n) => ({ id: String(index * 100 + n) })), '@odata.nextLink': 'next-' + pageIndex };
  } });
  const events = await p.reads.getOwnerEventsForDecision(owner, start, lateEnd, 'UTC');
  assert.equal(events.at(-1).id, 'last-commitment');
});

test('a malformed owner calendar page cannot populate a verified empty calendar', async () => {
  const p = provider({ page: () => ({}) });
  await assert.rejects(p.reads.getOwnerEventsForDecision(owner, start, lateEnd, 'UTC'));
  assert.equal(p.eventCache.size, 0);
});

test('an empty owner calendar page is complete', async () => {
  const p = provider({ page: () => ({ value: [] }) });
  assert.deepEqual(await p.reads.getOwnerEventsForDecision(owner, late, lateEnd, 'UTC'), []);
  assert.equal(p.eventCache.size, 1);
});

test('a continuation cycle fails without caching the partial calendar', async () => {
  let calls = 0;
  const p = provider({ page: () => ++calls > 2 ? { value: [] } : { value: [], '@odata.nextLink': 'repeated' } });
  await assert.rejects(p.reads.getOwnerEventsForDecision(owner, start, lateEnd, 'UTC'));
  assert.equal(p.eventCache.size, 0);
  assert.equal(calls, 2);
});

test('an offset-bearing move reads the actual mailbox day before excluding its source occurrence', async () => {
  const from = '2026-12-11T01:00:00Z', to = '2026-12-11T01:25:00Z';
  const source = { id: 'source', iCalUId: 'source-uid', isCancelled: false, type: 'singleInstance',
    start: { dateTime: from, timeZone: 'UTC' }, end: { dateTime: to, timeZone: 'UTC' },
    attendees: [{ emailAddress: { address: person } }] };
  const concurrent = { ...source, id: 'other', iCalUId: 'other-uid', showAs: 'busy' };
  const p = provider({ page: (url, query) => url.includes('/events/') ? source
    : { value: overlap(concurrent, query.startDateTime, query.endDateTime) ? [concurrent] : [] } });
  const diag = {};
  const busy = await p.reads.getFreeBusyForDecision(owner, [person], from, to, 'America/New_York', diag, ['source']);
  assert.equal(busy[person].length, 1, 'unrelated clash on the evening of December 10 must survive exclusion');
  assert.deepEqual(diag.notChecked, []);
});

test('the free/busy tool keeps a checked mailbox when another mailbox is incomplete', async () => {
  const p = provider({ schedule: email => email === person ? { scheduleId: email } : { scheduleId: email, scheduleItems: [busyItem] } });
  const file = 'src/skills/meetings/ops/handlers/calendarReads.ts';
  const tree = ts.createSourceFile(file, readSource(file), ts.ScriptTarget.Latest, true);
  const fn = tree.statements.find(n => n.name?.text === 'handleGetFreeBusy');
  const code = ts.transpileModule(fn.getText(), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, getFreeBusy: p.reads.getFreeBusy, logger: { warn() {} }, require: () => ({ summarizeWorkingElsewhere: () => null }) });
  const result = await exports.handleGetFreeBusy({ emails: [owner, person], start_date: late, end_date: lateEnd },
    { userEmail: owner, timezone: 'UTC', context: { profile: {}, senderRole: 'owner' } });
  assert.equal(result[owner]?.length, 1);
  assert.equal(result[person], undefined);
  assert.deepEqual(Array.from(result.not_checked), [person]);
});

for (const problem of ['repeated cursor', 'invalid status', 'nonpositive duration', 'missing page', 'absent from event view']) {
  test('move preserves a disjoint known busy item: ' + problem, async () => {
    const source = { id: 'source', iCalUId: 'source-uid', isCancelled: false, type: 'singleInstance',
      start: { dateTime: start }, end: { dateTime: '2026-10-01T09:25:00Z' },
      attendees: [{ emailAddress: { address: person } }] };
    const event = { ...source, id: 'other', iCalUId: 'other', start: busyItem.start, end: busyItem.end, showAs: 'busy' };
    let pages = 0;
    const p = provider({ page: url => {
      if (url.includes('/events/')) return source;
      pages++;
      if (problem === 'repeated cursor' && pages <= 2) return { value: [], '@odata.nextLink': 'repeated' };
      if (problem === 'invalid status') return { value: [{ ...event, showAs: 'invalid' }] };
      if (problem === 'nonpositive duration') return { value: [{ ...event, end: event.start }] };
      if (problem === 'missing page') return {};
      return { value: [] };
    } });
    const diag = {}, data = await p.reads.getFreeBusyForDecision(owner, [person], late, lateEnd, 'UTC', diag, ['source']);
    assert.deepEqual(data[person].map(slot => slot.status), ['busy']);
    assert.deepEqual(diag.notChecked, problem === 'absent from event view' ? [] : [person]);
    if (problem === 'repeated cursor') assert.equal(pages, 2);
  });
}
