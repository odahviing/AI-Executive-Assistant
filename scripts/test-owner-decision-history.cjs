/* Verification only: full actual ownerDailyThread.ts in an isolated VM.
 * node --test scripts/test-owner-decision-history.cjs
 * Pre-fix replay: MAELLE_OWNER_HISTORY_SOURCE_FILE=<temporary git-show fixture>.
 * Only Connection, history, daily-thread DB, clock, and logger are mocked.
 * The assertions cover supplied decision text, not Connection-formatted wire bytes.
 */
const assert = require('node:assert/strict');
const { test, afterEach, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const { DateTime } = require('luxon');

const productionFile = path.resolve(__dirname, '../src/utils/ownerDailyThread.ts');
const sourceFile = process.env.MAELLE_OWNER_HISTORY_SOURCE_FILE || productionFile;
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const frozenDigest = digest(productionFile);
const javascript = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
  fileName: sourceFile,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const profile = { user: { slack_user_id: 'UOWNER', timezone: 'Asia/Jerusalem' } };
const suppliedTuesdayAsk = 'Can we move the meeting to Tuesday 22 Sep at 20:30?';
const mondayAsk = 'Would Monday 21 Sep at 20:30 work?';
const clone = value => JSON.parse(JSON.stringify(value));
const instances = [];

function fixture(options = {}) {
  let dailyRow = options.dailyRow === undefined ? { dm_channel: 'DOWNER', root_ts: 'daily.root' } : options.dailyRow;
  const calls = { posts: [], direct: [], appends: [], reads: [], writes: [], logs: [], order: [], unexpected: [] };
  const history = new Map(Object.entries(options.history || {}).map(([key, entries]) => [key, clone(entries)]));
  function response(queue, index, fallback) {
    const result = queue?.[index] ?? fallback;
    if (result instanceof Error) throw result;
    return result;
  }
  const conn = {
    postToChannel: async (channel, text, opts) => {
      calls.posts.push({ channel, text, opts: clone(opts) });
      calls.order.push('post');
      return response(options.posts, calls.posts.length - 1, { ok: true, ts: `decision.${calls.posts.length}` });
    },
    sendDirect: async (userId, text) => {
      calls.direct.push({ userId, text });
      calls.order.push('direct');
      return response(options.direct, calls.direct.length - 1, { ok: true, ref: 'DFALLBACK', ts: `direct.${calls.direct.length}` });
    },
  };
  const db = {
    prepare(sql) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized === 'SELECT dm_channel, root_ts FROM owner_daily_threads WHERE owner_user_id = ? AND day_key = ?') {
        return { get(ownerId, day) {
          assert.equal(ownerId, 'UOWNER');
          assert.equal(day, '2026-09-10');
          calls.reads.push({ ownerId, day });
          if (options.readThrows) throw new Error('mock daily-thread read failed');
          return dailyRow;
        } };
      }
      if (normalized === 'INSERT OR IGNORE INTO owner_daily_threads (owner_user_id, day_key, dm_channel, root_ts) VALUES (?, ?, ?, ?)') {
        return { run(ownerId, day, channel, root) {
          assert.equal(ownerId, 'UOWNER');
          assert.equal(day, '2026-09-10');
          calls.writes.push({ ownerId, day, channel, root });
          if (options.writeThrows) throw new Error('mock daily-thread write failed');
          dailyRow ??= { dm_channel: channel, root_ts: root };
        } };
      }
      calls.unexpected.push(`SQL: ${normalized}`);
      throw new Error('Unapproved SQL in isolated test');
    },
  };
  const dependencies = {
    luxon: { DateTime },
    './effectiveToday': { getEffectiveToday: () => DateTime.fromISO('2026-09-10T12:00:00+03:00', { setZone: true }) },
    '../db/client': { getDb: () => db },
    '../db/conversations': { appendToConversation(threadTs, channel, message) {
      calls.appends.push({ threadTs, channel, message: clone(message) });
      calls.order.push('append');
      if (options.historyThrows) throw new Error('mock history append failed');
      const entries = history.get(threadTs) || [];
      entries.push(clone(message));
      history.set(threadTs, entries);
    } },
    './logger': { __esModule: true, default: Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (...args) => calls.logs.push({ level, args })])) },
  };
  const module = { exports: {} };
  const isolatedRequire = name => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    calls.unexpected.push(`module: ${name}`);
    throw new Error(`Blocked module: ${name}`);
  };
  // No native require, process, filesystem, timers, or network inside production code.
  const load = vm.runInNewContext(`(function(require,module,exports){${javascript}\n})`, {}, { filename: sourceFile });
  load(isolatedRequire, module, module.exports);
  const instance = {
    calls, history,
    post: (text = suppliedTuesdayAsk, extra = {}) => module.exports.postOwnerDecision({ profile, conn, text, label: 'owner-history-regression', ...extra }),
  };
  instances.push(instance);
  return instance;
}
afterEach(() => {
  for (const instance of instances.splice(0)) assert.deepEqual(instance.calls.unexpected, [], 'all dependencies and SQL must be explicitly mocked, including caught failures');
});
after(() => assert.equal(digest(productionFile), frozenDigest, 'production file must remain frozen'));

function assertAppend(f, { threadTs, channel, ts, text = suppliedTuesdayAsk }) {
  assert.deepEqual(f.calls.appends, [{ threadTs, channel, message: { role: 'assistant', content: text, ...(ts ? { ts } : {}) } }]);
}

test('reused daily thread appends the supplied Tuesday ask after earlier Monday context', async () => {
  const f = fixture({ history: { 'daily.root': [{ role: 'assistant', content: mondayAsk, ts: 'old.monday' }] } });
  const result = await f.post();
  assert.deepEqual(clone(result), { ok: true, channel: 'DOWNER', threadTs: 'daily.root', ts: 'decision.1' });
  assertAppend(f, { threadTs: 'daily.root', channel: 'DOWNER', ts: 'decision.1' });
  assert.deepEqual(f.history.get('daily.root').map(message => message.content), [mondayAsk, suppliedTuesdayAsk]);
  assert.deepEqual(f.calls.order, ['post', 'append']);
  assert.equal(f.calls.direct.length, 0);
  assert.equal(f.calls.writes.length, 0);
});
test('explicit inThread stores under that thread and bypasses the daily-thread DB', async () => {
  const f = fixture();
  const result = await f.post(suppliedTuesdayAsk, { inThread: { channel: 'DOUTREACH', threadTs: 'outreach.root' } });
  assert.equal(result.ok, true);
  assertAppend(f, { threadTs: 'outreach.root', channel: 'DOUTREACH', ts: 'decision.1' });
  assert.equal(f.calls.reads.length, 0);
  assert.equal(f.calls.writes.length, 0);
  assert.equal(f.calls.direct.length, 0);
});
test('incomplete inThread falls back to the actual daily destination', async () => {
  const f = fixture();
  await f.post(suppliedTuesdayAsk, { inThread: { channel: 'DSTALE', threadTs: '' } });
  assertAppend(f, { threadTs: 'daily.root', channel: 'DOWNER', ts: 'decision.1' });
});
test('first decision creates the daily root but appends only the decision text', async () => {
  const f = fixture({ dailyRow: null, direct: [{ ok: true, ref: 'DNEW', ts: 'new.root' }] });
  const result = await f.post();
  assert.equal(result.threadTs, 'new.root');
  assert.equal(f.calls.direct.length, 1);
  assert.equal(f.calls.direct[0].text, '🗓️ Discussions — Thursday 10 Sep');
  assert.deepEqual(f.calls.writes, [{ ownerId: 'UOWNER', day: '2026-09-10', channel: 'DNEW', root: 'new.root' }]);
  assertAppend(f, { threadTs: 'new.root', channel: 'DNEW', ts: 'decision.1' });
  assert.deepEqual(f.calls.order, ['direct', 'post', 'append']);
});
test('two supplied decisions retain append order and their distinct message timestamps', async () => {
  const f = fixture();
  await f.post(mondayAsk);
  await f.post(suppliedTuesdayAsk);
  assert.deepEqual(f.history.get('daily.root'), [
    { role: 'assistant', content: mondayAsk, ts: 'decision.1' },
    { role: 'assistant', content: suppliedTuesdayAsk, ts: 'decision.2' },
  ]);
  assert.deepEqual(f.calls.order, ['post', 'append', 'post', 'append']);
  assert.equal(f.calls.direct.length, 0);
});
test('thread refusal followed by successful direct fallback stores under the sent message root', async () => {
  const f = fixture({ posts: [{ ok: false, reason: 'thread unavailable' }], direct: [{ ok: true, ref: 'DDELIVERED', ts: 'fallback.ask' }] });
  const result = await f.post();
  assert.deepEqual(clone(result), { ok: true, channel: 'DDELIVERED', ts: 'fallback.ask' });
  assertAppend(f, { threadTs: 'fallback.ask', channel: 'DDELIVERED', ts: 'fallback.ask' });
  assert.equal(f.history.has('daily.root'), false);
  assert.deepEqual(f.calls.order, ['post', 'direct', 'append']);
});
test('daily header refusal falls back directly and appends under the actual ask timestamp', async () => {
  const f = fixture({ dailyRow: null, direct: [{ ok: false, reason: 'header refused' }, { ok: true, ref: 'DACTUAL', ts: 'actual.ask' }] });
  const result = await f.post();
  assert.equal(result.ok, true);
  assert.equal(f.calls.posts.length, 0);
  assertAppend(f, { threadTs: 'actual.ask', channel: 'DACTUAL', ts: 'actual.ask' });
  assert.equal(f.calls.direct[1].text, suppliedTuesdayAsk);
});
test('daily header exception still records a successfully delivered fallback ask', async () => {
  const f = fixture({ dailyRow: null, direct: [new Error('header transport failed'), { ok: true, ref: 'DACTUAL', ts: 'actual.ask' }] });
  assert.equal((await f.post()).ok, true);
  assertAppend(f, { threadTs: 'actual.ask', channel: 'DACTUAL', ts: 'actual.ask' });
});
test('daily root persistence failure uses the posted root for decision history', async () => {
  const f = fixture({ dailyRow: null, writeThrows: true, direct: [{ ok: true, ref: 'DPOSTED', ts: 'posted.root' }] });
  assert.equal((await f.post()).ok, true);
  assertAppend(f, { threadTs: 'posted.root', channel: 'DPOSTED', ts: 'decision.1' });
});
test('thread and direct send refusal append nothing', async () => {
  const f = fixture({ posts: [{ ok: false, reason: 'thread refused' }], direct: [{ ok: false, reason: 'DM refused' }] });
  const result = await f.post();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'DM refused');
  assert.equal(f.calls.appends.length, 0);
  assert.equal(f.calls.posts.length, 1);
  assert.equal(f.calls.direct.length, 1);
});
test('unavailable daily header and failed fallback append nothing', async () => {
  const f = fixture({ dailyRow: null, direct: [{ ok: false }, { ok: false, reason: 'DM refused' }] });
  assert.equal((await f.post()).ok, false);
  assert.equal(f.calls.appends.length, 0);
  assert.equal(f.calls.posts.length, 0);
});
test('thread transport exception is a delivery failure with no phantom history', async () => {
  const f = fixture({ posts: [new Error('thread transport failed')] });
  assert.equal((await f.post()).ok, false);
  assert.equal(f.calls.appends.length, 0);
});
test('fallback transport exception is a delivery failure with no phantom history', async () => {
  const f = fixture({ posts: [{ ok: false }], direct: [new Error('DM transport failed')] });
  assert.equal((await f.post()).ok, false);
  assert.equal(f.calls.appends.length, 0);
});
test('history exception after threaded success preserves success and does not resend', async () => {
  const f = fixture({ historyThrows: true });
  const result = await f.post();
  assert.equal(result.ok, true);
  assertAppend(f, { threadTs: 'daily.root', channel: 'DOWNER', ts: 'decision.1' });
  assert.equal(f.calls.posts.length, 1);
  assert.equal(f.calls.direct.length, 0);
  assert.equal(f.calls.logs.filter(log => log.level === 'warn').length, 1);
});
test('history exception after fallback success preserves success and does not resend', async () => {
  const f = fixture({ historyThrows: true, posts: [{ ok: false }], direct: [{ ok: true, ref: 'DACTUAL', ts: 'actual.ask' }] });
  const result = await f.post();
  assert.equal(result.ok, true);
  assertAppend(f, { threadTs: 'actual.ask', channel: 'DACTUAL', ts: 'actual.ask' });
  assert.equal(f.calls.posts.length, 1);
  assert.equal(f.calls.direct.length, 1);
});
test('known thread root records a successful post even when message timestamp is absent', async () => {
  const f = fixture({ posts: [{ ok: true }] });
  assert.equal((await f.post()).ok, true);
  assertAppend(f, { threadTs: 'daily.root', channel: 'DOWNER' });
});
test('direct success without a timestamp cannot invent a history thread key', async () => {
  const f = fixture({ posts: [{ ok: false }], direct: [{ ok: true, ref: 'DACTUAL' }] });
  assert.equal((await f.post()).ok, true);
  assert.equal(f.calls.appends.length, 0);
  assert.equal(f.calls.direct.length, 1);
});
test('direct history uses an empty missing channel rather than the failed old destination', async () => {
  const f = fixture({ posts: [{ ok: false }], direct: [{ ok: true, ts: 'actual.ask' }] });
  assert.equal((await f.post()).ok, true);
  assertAppend(f, { threadTs: 'actual.ask', channel: '', ts: 'actual.ask' });
});
test('multiline supplied decision text is preserved for later context', async () => {
  const text = 'Tuesday 22 Sep, 20:30\nאפשר לאשר?\nCounter-proposal: café at 20:30.';
  const f = fixture();
  await f.post(text);
  assertAppend(f, { threadTs: 'daily.root', channel: 'DOWNER', ts: 'decision.1', text });
  assert.equal(f.calls.posts[0].text, text);
});
