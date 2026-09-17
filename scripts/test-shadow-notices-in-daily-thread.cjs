/* Verification only: the actual src/utils/shadowNotify.ts in an isolated VM.
 * Owner ruling 2026-09-15: a passive owner notice with no conversation context
 * (rebalance move, unkeyed auto-fix, colleague-surface flood/image-guard notice)
 * is a reply in the owner's daily thread, not a fresh top-level DM.
 *
 * node --test scripts/test-shadow-notices-in-daily-thread.cjs [--source-root <pre-fix checkout>]
 * Only Connection, the daily-thread helper, conversation history and logger are mocked.
 */
const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const rootArg = process.argv.indexOf('--source-root');
const sourceRoot = rootArg < 0 ? path.resolve(__dirname, '..') : path.resolve(process.argv[rootArg + 1]);
const sourceFile = path.join(sourceRoot, 'src/utils/shadowNotify.ts');
const javascript = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
  fileName: sourceFile,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

const OWNER = 'UOWNER';
const OWNER_DM = 'DOWNER';
const DAILY = { channel: OWNER_DM, rootTs: 'daily.root' };
const profile = (on = true) => ({ user: { slack_user_id: OWNER }, behavior: { v1_shadow_mode: on } });
const rebalance = {
  channel: '',
  icon: '🔧',
  action: 'Floating block rebalanced',
  detail: 'Moved lunch to 12:30–12:55 on Tue 22 Sep.',
};
const REBALANCE_TEXT = '🔧 _*Floating block rebalanced:* Moved lunch to 12:30–12:55 on Tue 22 Sep._';
const clone = value => JSON.parse(JSON.stringify(value));
const instances = [];

function fixture(options = {}) {
  const calls = { posts: [], direct: [], appends: [], dailyAsks: 0, logs: [], unexpected: [] };
  const reply = (queue, index, fallback) => {
    const result = queue?.[index] ?? fallback;
    if (result instanceof Error) throw result;
    return result;
  };
  const conn = {
    postToChannel: async (channel, text, opts) => {
      calls.posts.push({ channel, text, opts: clone(opts ?? {}) });
      return reply(options.posts, calls.posts.length - 1, { ok: true, ts: `post.${calls.posts.length}` });
    },
    sendDirect: async (userId, text, opts) => {
      calls.direct.push({ userId, text, opts: clone(opts ?? {}) });
      return reply(options.direct, calls.direct.length - 1, { ok: true, ref: OWNER_DM, ts: `direct.${calls.direct.length}` });
    },
  };
  const dependencies = {
    '../connections/registry': { getConnection: (id, transport) => (id === OWNER && transport === 'slack' ? conn : null) },
    './ownerDailyThread': { getOrCreateOwnerDailyThread: async () => { calls.dailyAsks++; return options.daily === undefined ? DAILY : options.daily; } },
    '../db/conversations': { appendToConversation: (threadTs, channel, message) => {
      calls.appends.push({ threadTs, channel, message: clone(message) });
      if (options.historyThrows) throw new Error('mock history failed');
    } },
    './logger': { __esModule: true, default: Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, (...args) => calls.logs.push({ level, args })])) },
  };
  const module = { exports: {} };
  const isolatedRequire = name => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    calls.unexpected.push(`module: ${name}`);
    throw new Error(`Blocked module: ${name}`);
  };
  const load = vm.runInNewContext(`(function(require,module,exports){${javascript}\n})`, {}, { filename: sourceFile });
  load(isolatedRequire, module, module.exports);
  const instance = { calls, notify: (params, p = profile()) => module.exports.shadowNotify(p, params) };
  instances.push(instance);
  return instance;
}
afterEach(() => {
  for (const instance of instances.splice(0)) assert.deepEqual(instance.calls.unexpected, [], 'every dependency must be explicitly mocked');
});

test('R1 · rebalance notice is a reply in the daily thread, text unchanged, never a top-level DM', async () => {
  const f = fixture();
  await f.notify(rebalance);
  assert.deepEqual(f.calls.direct, [], 'no top-level sendDirect');
  assert.deepEqual(f.calls.posts, [{ channel: OWNER_DM, text: REBALANCE_TEXT, opts: { threadTs: DAILY.rootTs } }]);
});

test('R2 · two notices the same day share the one daily thread and each lands in its history', async () => {
  const f = fixture();
  await f.notify(rebalance);
  await f.notify({ ...rebalance, action: 'Floating block overlap', detail: 'Your lunch on Tue 22 Sep overlaps "Sync".' });
  assert.equal(f.calls.direct.length, 0);
  assert.deepEqual(f.calls.posts.map(p => p.opts.threadTs), [DAILY.rootTs, DAILY.rootTs]);
  assert.deepEqual(f.calls.appends, [
    { threadTs: DAILY.rootTs, channel: OWNER_DM, message: { role: 'assistant', content: REBALANCE_TEXT, ts: 'post.1' } },
    { threadTs: DAILY.rootTs, channel: OWNER_DM, message: { role: 'assistant', content: '🔧 _*Floating block overlap:* Your lunch on Tue 22 Sep overlaps "Sync"._', ts: 'post.2' } },
  ]);
});

test('R3 · a notice born on a colleague surface lands in the daily thread — never in that channel', async () => {
  const f = fixture();
  await f.notify({ channel: 'C_COLLEAGUE_ROOM', threadTs: 'room.1', action: '⚠ Colleague tool-call flood', detail: 'Dana tripped the budget.' });
  assert.deepEqual(f.calls.direct, []);
  assert.equal(f.calls.posts.length, 1);
  assert.equal(f.calls.posts[0].channel, OWNER_DM);
  assert.equal(f.calls.posts[0].opts.threadTs, DAILY.rootTs);
});

test('R4 · attachments ride the daily-thread post', async () => {
  const f = fixture();
  const attachments = [{ sourceUrl: 'https://files.slack.com/x.png' }];
  await f.notify({ ...rebalance, attachments });
  assert.deepEqual(f.calls.posts[0].opts, { threadTs: DAILY.rootTs, attachments });
  assert.equal(f.calls.direct.length, 0);
});

test('P1 · shadow mode off sends nothing and never asks for the daily thread', async () => {
  const f = fixture();
  await f.notify(rebalance, profile(false));
  assert.equal(f.calls.posts.length + f.calls.direct.length + f.calls.dailyAsks, 0);
});

test('P2 · conversation-keyed shadows keep their own anchored thread', async () => {
  const f = fixture();
  const keyed = { channel: 'DCOLLEAGUE', threadTs: 'c.1', action: 'Reply', detail: 'I → Dana: "sure"', conversationKey: 'c.1', conversationHeader: 'Conversation with Dana' };
  await f.notify(keyed);
  await f.notify({ ...keyed, detail: 'I → Dana: "done"' });
  assert.equal(f.calls.dailyAsks, 0);
  assert.equal(f.calls.direct.length, 1);
  assert.match(f.calls.direct[0].text, /^🔍 \*Conversation with Dana\*\n/);
  assert.deepEqual(f.calls.posts.map(p => [p.channel, p.opts.threadTs]), [[OWNER_DM, 'direct.1']]);
});

test('P3 · a shadow inside the owner\'s own live DM thread stays in that thread', async () => {
  const f = fixture();
  await f.notify(rebalance); // populates the owner-DM channel cache
  await f.notify({ channel: OWNER_DM, threadTs: 'live.7', action: 'Auto-accepted counter', detail: 'moved it.' });
  const last = f.calls.posts.at(-1);
  assert.deepEqual([last.channel, last.opts.threadTs, last.text], [OWNER_DM, 'live.7', '🔍 _*Auto-accepted counter:* moved it._']);
});

test('P4 · daily thread unavailable → plain DM to the owner still delivers the notice', async () => {
  const f = fixture({ daily: null });
  await f.notify(rebalance);
  assert.equal(f.calls.posts.length, 0);
  assert.deepEqual(f.calls.direct.map(d => [d.userId, d.text]), [[OWNER, REBALANCE_TEXT]]);
});

test('P5 · daily-thread post refused → plain DM fallback, exactly one delivery', async () => {
  const f = fixture({ posts: [{ ok: false, reason: 'thread unavailable' }] });
  await f.notify(rebalance);
  assert.deepEqual(f.calls.direct.map(d => [d.userId, d.text]), [[OWNER, REBALANCE_TEXT]], 'exactly one delivery — no repeat');
});

test('P6 · transport exception is swallowed — shadow never breaks the caller', async () => {
  const f = fixture({ posts: [new Error('socket down')], direct: [new Error('socket down')] });
  await f.notify(rebalance);
  assert.equal(f.calls.logs.filter(l => l.level === 'warn').length, 1);
});

test('P7 · history failure after a delivered notice is logged, never resent', async () => {
  const f = fixture({ historyThrows: true });
  await f.notify(rebalance);
  assert.equal(f.calls.posts.length + f.calls.direct.length, 1);
});
