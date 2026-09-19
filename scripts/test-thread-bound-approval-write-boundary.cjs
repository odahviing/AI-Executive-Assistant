// Executes the actual Registrar helper with isolated classifier/request fixtures.
// Optional source root replays the preserved before snapshot; no live I/O.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const sourceRoot = process.env.APPROVAL_BOUNDARY_SOURCE_ROOT || root;
const file = path.join(sourceRoot, 'src/utils/threadBoundApprovalAutoResolve.ts');
const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

function harness(options = {}) {
  const events = [], resolutions = [];
  const response = { content: [{ type: 'tool_use', input: { target: 1, verdict: options.verdict || 'approve' } }] };
  const row = {
    id: 'req_fixture', kind: 'approval', subkind: 'book', subject: 'Fixture meeting',
    requester_slack_id: options.colleague ? 'UCOLLEAGUE' : 'UOWNER',
    terminal_dm_msg_ts: '100.001', owner_dm_thread_ts: '100.000',
    details: { on_approve: { tool: 'fixture' } },
  };
  const mocks = {
    '../llm/client': { getAnthropicClient: () => ({ messages: { create: async () => {
      events.push('classify');
      if (options.pause) await options.pause.promise;
      if (options.classifierThrows) throw Error('classifier unavailable');
      events.push('classified');
      return response;
    } } }) },
    '../llm/models': { MODEL_HAIKU: 'fixture' },
    '../db/requests': { getAwaitingOwnerRequests: () => options.noCandidate ? [] : [row] },
    '../core/requests/types': { parseDetails: request => request.details },
    '../core/approvals/approvalCallbacks': { extractCallbacks: details => details },
    '../core/requests/resolver': { resolveRequest: async (id, decision, ctx) => {
      events.push('resolve');
      resolutions.push({ id, decision, ctx });
      options.onResolve?.();
      if (options.resolvePause) await options.resolvePause.promise;
      if (options.resolverThrows) throw Error('resolver unavailable');
      return options.notOk ? { ok: false, reason: 'fixture_unavailable' } : { ok: true, effect: 'fixture_complete' };
    } },
    './logger': Object.fromEntries(['info', 'warn', 'error', 'debug'].map(key => [key, () => {}])),
  };
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => {
    assert.ok(Object.hasOwn(mocks, name), `unexpected import ${name}`);
    return mocks[name];
  } }, { filename: file });
  const params = { message: 'yes', threadTs: '100.001', ownerUserId: 'UOWNER', profile: { user: { name: 'Owner Fixture' } } };
  return { events, resolutions, run: overrides => exports.tryAutoResolveThreadBoundApproval({ ...params, ...overrides }) };
}

test('S7 delayed classifier cannot resolve after abort; cancellation propagates', async () => {
  const pause = deferred(), controller = new AbortController(), abort = Error('interrupted');
  const h = harness({ pause });
  const turn = h.run({ onBeforeWrite: () => {
    if (controller.signal.aborted) throw abort;
    h.events.push('mark');
  } });
  assert.deepEqual(h.events, ['classify']);
  controller.abort();
  pause.resolve();
  let thrown;
  try { await turn; } catch (error) { thrown = error; }
  assert.equal(h.resolutions.length, 0, 'aborted classification must not execute approval');
  assert.equal(thrown, abort, 'cancellation must not become pass_to_sonnet');
});

for (const verdict of ['approve', 'reject']) test(`S7 ${verdict} marks write before resolver begins`, async () => {
  const h = harness({ verdict });
  const result = await h.run({ onBeforeWrite: () => h.events.push('mark') });
  assert.deepEqual(h.events, ['classify', 'classified', 'mark', 'resolve']);
  assert.deepEqual(plain(result), { resolved: true, verdict, request_id: 'req_fixture' });
  assert.equal(h.resolutions[0].ctx.resolvedByColleague, false);
});

test('S7 write remains marked while resolver is pending', async () => {
  const resolvePause = deferred(), resolverStarted = deferred();
  let marked = false;
  const h = harness({ resolvePause, onResolve: () => resolverStarted.resolve() });
  const turn = h.run({ onBeforeWrite: () => { marked = true; } });
  await resolverStarted.promise;
  const markedAtStart = marked;
  resolvePause.resolve();
  assert.equal((await turn).resolved, true);
  assert.equal(markedAtStart, true);
});

for (const verdict of ['approve', 'reject']) test(`control ${verdict} without callback preserves decision`, async () => {
  const h = harness({ verdict });
  const result = await h.run();
  assert.equal(result.resolved, true);
  assert.equal(h.resolutions.length, 1);
  assert.deepEqual(plain(h.resolutions[0].decision), verdict === 'approve'
    ? { verdict: 'approve', data: {} } : { verdict: 'reject', reason: 'owner short-form reject' });
});

for (const [option, reason] of [['classifierThrows', 'pass_to_sonnet'], ['notOk', 'resolver_not_ok:fixture_unavailable'], ['resolverThrows', 'resolver_threw']]) {
  test(`control ${option} preserves fallback and bound request`, async () => {
    const h = harness({ [option]: true });
    const result = await h.run();
    assert.equal(result.resolved, false);
    assert.equal(result.reason, reason);
    assert.equal(result.boundHint.requestId, 'req_fixture');
    assert.equal(h.resolutions.length, option === 'classifierThrows' ? 0 : 1);
  });
}

for (const option of ['notOk', 'resolverThrows']) test(`S7 ${option} retains write-start marker on fallback`, async () => {
  const h = harness({ [option]: true });
  const result = await h.run({ onBeforeWrite: () => h.events.push('mark') });
  assert.equal(result.resolved, false);
  assert.deepEqual(h.events, ['classify', 'classified', 'mark', 'resolve']);
});

for (const options of [{ verdict: 'pass_to_sonnet' }, { classifierThrows: true }, { noCandidate: true }, { colleague: true }]) {
  test(`control no write for ${Object.keys(options)[0]} leaves boundary untouched`, async () => {
    const h = harness(options);
    const result = await h.run({ onBeforeWrite: () => { throw Error('boundary must not run'); } });
    assert.equal(result.resolved, false);
    assert.equal(h.resolutions.length, 0);
  });
}
