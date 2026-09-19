// Run: node --test scripts/test-gatekeeper-approval-owner-delivery.cjs
// Baseline replay: node scripts/test-gatekeeper-approval-owner-delivery.cjs --source-revision 63221e4
//
// Executes the real producer (turnHelpers.summarizeToolCall) and the real
// claim-check wrapper from runOutputGates with a closed dependency allowlist.
// No application, database, network, or delivery connection is started.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const ts = require('typescript');

const repo = path.resolve(__dirname, '..');
const revisionAt = process.argv.indexOf('--source-revision');
const sourceRevision = revisionAt >= 0 ? process.argv[revisionAt + 1] : null;

function source(rel) {
  if (sourceRevision) return cp.execFileSync('git', ['show', `${sourceRevision}:${rel}`], { cwd: repo, encoding: 'utf8' });
  return fs.readFileSync(path.join(repo, rel), 'utf8');
}

function compile(rel, text) {
  return ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: path.join(repo, rel),
  }).outputText;
}

function loadTurnHelpers() {
  const rel = 'src/core/orchestrator/turnHelpers.ts';
  const code = compile(rel, source(rel));
  const module = { exports: {} };
  const deps = {
    '@anthropic-ai/sdk': {},
    luxon: require('luxon'),
    '../../llm/client': { getAnthropicClient: () => ({ messages: { create: async () => { throw new Error('forbidden LLM call'); } } }) },
    '../../utils/usageLog': { logLlmUsage() {} },
    '../../utils/logger': { __esModule: true, default: { info() {}, warn() {}, error() {} } },
    '../../utils/attendeeAvailability': { ATTENDEE_REASON_PREFIXES: [] },
  };
  const isolatedRequire = name => {
    assert.ok(Object.hasOwn(deps, name), `unexpected turnHelpers dependency: ${name}`);
    return deps[name];
  };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {}, { filename: rel })(isolatedRequire, module, module.exports);
  return module.exports;
}

const profile = {
  user: { name: 'Idan Cohen', slack_user_id: 'U_OWNER', timezone: 'Asia/Jerusalem' },
  assistant: { name: 'Maelle' },
};

function loadGate({ verdict, rewrite = 'I did not send that yet.' } = {}) {
  const rel = 'src/utils/guards/runOutputGates.ts';
  const instrumented = `${source(rel)}\nexport { runClaimCheckAndMaybeRewrite as __testRunClaimCheckAndMaybeRewrite };\n`;
  const code = compile(rel, instrumented);
  const calls = { check: 0, rewrite: 0, backstop: 0, warnings: [] };
  const claimChecker = {
    checkReplyClaims: async () => { calls.check++; return verdict; },
    rewriteOwningTheMiss: async () => { calls.rewrite++; return rewrite; },
  };
  const deps = {
    '../../llm/client': { getAnthropicClient: () => ({ messages: { create: async () => { throw new Error('forbidden LLM call'); } } }) },
    '../../core/requests/types': { FREEFORM_OWNER_FLAG_SUBKIND: 'freeform_owner_flag' },
    '../../llm/models': { SONNET: {}, MODEL_SONNET: 'fixture' },
    '../../core/orchestrator/turnHelpers': { toolLinesMatching: () => [] },
    '../../connections/slack/formatting': { formatForSlack: value => value },
    '../logger': { __esModule: true, default: { info() {}, warn: (...args) => calls.warnings.push(args), error() {} } },
    '../usageLog': { logLlmUsage() {} },
    '../claimChecker': claimChecker,
    '../../db/requests': {
      buildIdempotencyKey: () => 'gatekeeper-test-key',
      getRequestByIdempotencyKey: () => null,
    },
    '../../db': { getPersonMemory: () => ({ name: 'Yael Test' }) },
    '../ownerDailyThread': {
      deliverAndRecordOwnerFlag: async () => { calls.backstop++; return { ok: true }; },
    },
  };
  const isolatedRequire = name => {
    assert.ok(Object.hasOwn(deps, name), `unexpected runOutputGates dependency: ${name}`);
    return deps[name];
  };
  const module = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {}, { filename: rel })(isolatedRequire, module, module.exports);
  return { run: module.exports.__testRunClaimCheckAndMaybeRewrite, calls };
}

function ctx(summary, overrides = {}) {
  return {
    profile,
    result: { toolSummaries: summary ? [summary] : [] },
    history: [],
    userMessage: 'The 15:00 slot conflicts; please ask Idan.',
    senderId: 'U_YAEL',
    channelId: 'D_YAEL',
    threadTs: '1789590035.616',
    role: 'colleague',
    isMpim: false,
    isChannel: false,
    ...overrides,
  };
}

const deliveredVerdict = {
  claimed_action: true,
  action_type: 'message',
  target_name: 'Idan',
  action_summary: 'said the approval was sent to Idan',
};
const turn = loadTurnHelpers();
const approvalSummary = result => turn.summarizeToolCall(
  'create_approval',
  { kind: 'policy_exception' },
  result,
  profile.user.timezone,
);

test('confirmed create_approval delivery carries a narrow owner-notification marker', () => {
  const line = approvalSummary({ ok: true, created: true, approval_id: 'req_1789590035616_wp9cv', owner_notified: true });
  assert.match(line, /mutated=task/);
  assert.match(line, /notified=approval_owner/);
  assert.doesNotMatch(line, /Idan|Yael|req_1789590035616_wp9cv/);
});

for (const [label, result] of [
  ['delivery failed', { ok: true, created: true, approval_id: 'req_failed', owner_notified: false }],
  ['delivery unknown', { ok: true, created: true, approval_id: 'req_unknown' }],
  ['approval failed', { error: 'no_verified_deviation', owner_notified: true }],
]) {
  test(`${label} does not carry the owner-notification marker`, () => {
    assert.doesNotMatch(approvalSummary(result), /notified=approval_owner/);
  });
}

test('confirmed owner delivery defeats the false-positive rewrite and duplicate backstop', async () => {
  const summary = approvalSummary({ ok: true, created: true, approval_id: 'req_live', owner_notified: true });
  const h = loadGate({ verdict: deliveredVerdict });
  const draft = '15:00 conflicts, so I sent it to Idan for approval.';
  assert.equal(await h.run(ctx(summary), draft), draft);
  assert.equal(h.calls.rewrite, 0);
  assert.equal(h.calls.backstop, 0);
});

for (const target_name of ['Idan Cohen', 'Cohen']) {
  test(`confirmed owner delivery accepts the exact configured owner name ${JSON.stringify(target_name)}`, async () => {
    const summary = approvalSummary({ ok: true, created: true, approval_id: 'req_live', owner_notified: true });
    const h = loadGate({ verdict: { ...deliveredVerdict, target_name } });
    assert.equal(await h.run(ctx(summary), `I sent that to ${target_name}.`), `I sent that to ${target_name}.`);
    assert.equal(h.calls.rewrite, 0);
    assert.equal(h.calls.backstop, 0);
  });
}

for (const target_name of ['Dan', undefined]) {
  test(`confirmed owner delivery rejects non-exact owner target ${JSON.stringify(target_name)}`, async () => {
    const summary = approvalSummary({ ok: true, created: true, approval_id: 'req_live', owner_notified: true });
    const h = loadGate({ verdict: { ...deliveredVerdict, target_name } });
    assert.equal(await h.run(ctx(summary), 'I sent that.'), 'I did not send that yet.');
    assert.equal(h.calls.rewrite, 1);
    assert.equal(h.calls.backstop, 0);
  });
}

test('a prior approval delivery cannot ground a distinct current relay claim', async () => {
  const summary = approvalSummary({ ok: true, created: true, approval_id: 'req_prior', owner_notified: true });
  const h = loadGate({ verdict: deliveredVerdict });
  const c = ctx(null, { history: [{ role: 'assistant', content: `${summary}\nSent to Idan.` }] });
  assert.equal(await h.run(c, 'I sent this new ask to Idan.'), 'I did not send that yet.');
  assert.equal(h.calls.rewrite, 1);
  assert.equal(h.calls.backstop, 1);
});

for (const [label, result] of [
  ['undelivered', { ok: true, created: true, approval_id: 'req_pending', owner_notified: false }],
  ['unknown', { ok: true, created: true, approval_id: 'req_unknown' }],
  ['failed', { error: 'no_verified_deviation' }],
]) {
  test(`${label} approval claim is still rewritten and backstopped in a colleague DM`, async () => {
    const h = loadGate({ verdict: deliveredVerdict });
    assert.equal(await h.run(ctx(approvalSummary(result)), 'I sent that to Idan.'), 'I did not send that yet.');
    assert.equal(h.calls.rewrite, 1);
    assert.equal(h.calls.backstop, 1);
  });
}

test('confirmed owner delivery cannot ground a claim about another colleague', async () => {
  const summary = approvalSummary({ ok: true, created: true, approval_id: 'req_live', owner_notified: true });
  const h = loadGate({ verdict: { ...deliveredVerdict, target_name: 'Michal' } });
  assert.equal(await h.run(ctx(summary), 'I sent that to Michal.'), 'I did not send that yet.');
  assert.equal(h.calls.rewrite, 1);
  assert.equal(h.calls.backstop, 0);
});

test('a checker-confirmed specifics mismatch still wins over confirmed delivery', async () => {
  const summary = approvalSummary({ ok: true, created: true, approval_id: 'req_live', owner_notified: true });
  const h = loadGate({ verdict: { ...deliveredVerdict, claim_specifics_mismatch: true } });
  assert.equal(await h.run(ctx(summary), 'I sent the changed ask to Idan.'), 'I did not send that yet.');
  assert.equal(h.calls.rewrite, 1);
  assert.equal(h.calls.backstop, 1);
});

for (const [label, overrides] of [
  ['owner actor', { senderId: 'U_OWNER', role: 'owner' }],
  ['group DM', { isMpim: true }],
  ['channel', { isChannel: true }],
  ['email', { transport: 'email', senderId: 'owner@example.com' }],
]) {
  test(`an undelivered owner claim on the ${label} surface is rewritten without a colleague-DM backstop`, async () => {
    const h = loadGate({ verdict: deliveredVerdict });
    const summary = approvalSummary({ ok: true, created: true, approval_id: 'req_pending', owner_notified: false });
    assert.equal(await h.run(ctx(summary, overrides), 'I sent that to Idan.'), 'I did not send that yet.');
    assert.equal(h.calls.rewrite, 1);
    assert.equal(h.calls.backstop, 0);
  });
}

test('ordinary confirmed colleague messaging keeps its existing recipient-bound shield', async () => {
  const summary = turn.summarizeToolCall('message_colleague', { colleague_name: 'Michal' }, { ok: true }, profile.user.timezone);
  const h = loadGate({ verdict: { ...deliveredVerdict, target_name: 'Michal' } });
  assert.equal(await h.run(ctx(summary), 'I sent that to Michal.'), 'I sent that to Michal.');
  assert.equal(h.calls.rewrite, 0);
  assert.equal(h.calls.backstop, 0);
});
