// Run: node scripts/test-gatekeeper-held-send-summary.cjs
// Baseline replay: node scripts/test-gatekeeper-held-send-summary.cjs --source-dir <dir holding src/...>
//
// chris-headsup-scheduled-claim-summary-20260920 — a held message_colleague
// result (`_status:'scheduled_not_sent'`) must reach the claim-checkers as
// SCHEDULED with its send time, never look like a delivered send. Executes the
// real producer (turnHelpers.summarizeToolCall), the real checker prompt
// builder (claimChecker.checkReplyClaims, LLM client captured, not called) and
// the real claim-check wrapper in runOutputGates with a closed dependency
// allowlist. No application, database, network, or delivery connection starts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const repo = path.resolve(__dirname, '..');
const dirAt = process.argv.indexOf('--source-dir');
const sourceDir = dirAt >= 0 ? path.resolve(process.argv[dirAt + 1]) : null;

function source(rel) {
  if (sourceDir && fs.existsSync(path.join(sourceDir, rel))) return fs.readFileSync(path.join(sourceDir, rel), 'utf8');
  return fs.readFileSync(path.join(repo, rel), 'utf8');
}

function load(rel, deps, extra = '') {
  const code = ts.transpileModule(`${source(rel)}\n${extra}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: path.join(repo, rel),
  }).outputText;
  const module = { exports: {} };
  const req = name => {
    assert.ok(Object.hasOwn(deps, name), `unexpected ${rel} dependency: ${name}`);
    return deps[name];
  };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {}, { filename: rel })(req, module, module.exports);
  return module.exports;
}

const noLlm = { getAnthropicClient: () => ({ messages: { create: async () => { throw new Error('forbidden LLM call'); } } }) };
const quietLog = { __esModule: true, default: { info() {}, warn() {}, error() {} } };
const OWNER_TZ = 'Asia/Jerusalem';

const turn = load('src/core/orchestrator/turnHelpers.ts', {
  '@anthropic-ai/sdk': {},
  luxon: require('luxon'),
  '../../llm/client': noLlm,
  '../../utils/usageLog': { logLlmUsage() {} },
  '../../utils/logger': quietLog,
  '../../utils/attendeeAvailability': { ATTENDEE_REASON_PREFIXES: [] },
});

function loadChecker() {
  const captured = [];
  const client = { messages: { create: async req => { captured.push(req.messages[0].content); return { content: [{ type: 'text', text: '{"claimed_action":false,"action_type":null,"claim_specifics_mismatch":false,"target_name":null,"action_summary":null}' }] }; } } };
  const mod = load('src/utils/claimChecker.ts', {
    '@anthropic-ai/sdk': {},
    '../llm/client': { getAnthropicClient: () => client },
    '../llm/models': { SONNET: {}, MODEL_SONNET: 'fixture-sonnet', MODEL_HAIKU: 'fixture-haiku' },
    './logger': quietLog,
    './extractJson': { extractFirstJsonObject: s => s },
    './usageLog': { logLlmUsage() {} },
    './detectMessageLanguage': { detectMessageLanguage: () => 'en' },
  });
  return { mod, captured };
}

const profile = { user: { name: 'Idan Cohen', slack_user_id: 'U_OWNER', timezone: OWNER_TZ }, assistant: { name: 'Maelle' } };

function loadGate(verdict) {
  const calls = { rewrite: 0, backstop: 0 };
  const mod = load('src/utils/guards/runOutputGates.ts', {
    '../../llm/client': noLlm,
    '../../core/requests/types': { FREEFORM_OWNER_FLAG_SUBKIND: 'freeform_owner_flag' },
    '../../llm/models': { SONNET: {}, MODEL_SONNET: 'fixture' },
    '../../core/orchestrator/turnHelpers': { toolLinesMatching: () => [] },
    '../../connections/slack/formatting': { formatForSlack: v => v },
    '../logger': quietLog,
    '../usageLog': { logLlmUsage() {} },
    '../claimChecker': {
      checkReplyClaims: async () => verdict,
      rewriteOwningTheMiss: async () => { calls.rewrite++; return 'REWRITTEN'; },
    },
    '../../db/requests': { buildIdempotencyKey: () => 'k', getRequestByIdempotencyKey: () => null },
    '../../db': { getPersonMemory: () => ({ name: 'Chris' }) },
    '../ownerDailyThread': { deliverAndRecordOwnerFlag: async () => { calls.backstop++; return { ok: true }; } },
  }, 'export { runClaimCheckAndMaybeRewrite as __run };');
  return { run: mod.__run, calls };
}

const ownerCtx = summary => ({
  profile, result: { toolSummaries: [summary] }, history: [],
  userMessage: 'Give Chris a heads-up that the review moved.',
  senderId: 'U_OWNER', channelId: 'D_OWNER', threadTs: '1789000000.1', role: 'owner', isMpim: false, isChannel: false,
});

const input = { colleague_name: 'Chris', message: 'Heads-up: the review moved.' };
const held = { scheduled: true, jobId: 'job_1', scheduled_at: '2026-09-21T06:00:00.000Z', _status: 'scheduled_not_sent', held_for_recipient_work_hours: true, _note: 'NOT sent yet' };
const requestedLater = { scheduled: true, jobId: 'job_2', scheduled_at: '2026-09-21T06:00:00.000Z', _status: 'scheduled_not_sent', _note: 'NOT sent yet' };
const sentNow = { ok: true, jobId: 'job_3', colleague_name: 'Chris', await_reply: false, attachments_failed: 0 };
const failed = { ok: false, error: 'dm_open_failed', detail: 'x' };
const unconfirmed = { ok: false, error: 'error', detail: 'slack 500', delivery_unconfirmed: true, scheduled_copy_cancelled: true, _must_reply_with: 'may have reached them' };
const definiteFail = { ok: false, error: 'connection_not_registered', scheduled_copy_kept: true, _must_reply_with: 'Nothing reached Chris' };
const summarize = r => turn.summarizeToolCall('message_colleague', input, r, OWNER_TZ);

const sentVerdict = { claimed_action: true, action_type: 'message', target_name: 'Chris', claim_specifics_mismatch: true, action_summary: 'said sent, tool held it' };
const misflagVerdict = { claimed_action: true, action_type: 'message', target_name: 'Chris', claim_specifics_mismatch: false, action_summary: 'flagged a send' };
const hoursVerdict = { claimed_action: true, action_type: 'invented_third_party_fact', target_name: 'Chris', claim_specifics_mismatch: false, action_summary: 'outside Chris hours' };
const cleanVerdict = { claimed_action: false, action_type: null, target_name: null, claim_specifics_mismatch: false, action_summary: null };

const cases = [
  ['regression', 'held result renders SCHEDULED, NOT sent, with owner-local send time', () => {
    const line = summarize(held);
    assert.match(line, /^\[message_colleague SCHEDULED, NOT sent yet: Chris — goes out Mon 21 Sep 09:00 \(outside Chris's working hours\)\]/);
    assert.match(line, /mutated=message/);
    assert.match(line, /attendee_check=send_hold/);
  }],
  ['regression', 'checker prompt carries the held line and the held-send rule', async () => {
    const { mod, captured } = loadChecker();
    await mod.checkReplyClaims({ reply: 'Sent Chris the heads-up about the review move.', toolSummaries: [summarize(held)], ownerFirstName: 'Idan' });
    assert.equal(captured.length, 1);
    assert.match(captured[0], /\[message_colleague SCHEDULED, NOT sent yet: Chris — goes out Mon 21 Sep 09:00/);
    assert.match(captured[0], /ONE exception — a HELD send/);
    assert.match(captured[0], /claim_specifics_mismatch=true, target_name=<name>/);
  }],
  ['regression', 'held + "outside Chris\'s hours, scheduled for Monday" is shielded from a third-party-fact misflag', async () => {
    const g = loadGate(hoursVerdict);
    const draft = "It's outside Chris's working hours, so I've scheduled it for Monday at 09:00.";
    assert.equal(await g.run(ownerCtx(summarize(held)), draft), draft);
    assert.equal(g.calls.rewrite, 0);
  }],
  ['preserved', 'held + "sent" draft flagged by the checker is rewritten (owner path)', async () => {
    const g = loadGate(sentVerdict);
    assert.equal(await g.run(ownerCtx(summarize(held)), 'Sent Chris the heads-up about the review.'), 'REWRITTEN');
    assert.equal(g.calls.rewrite, 1);
    assert.equal(g.calls.backstop, 0);
  }],
  ['preserved', 'held + "scheduled for Monday" draft passes the checker verdict', async () => {
    const g = loadGate(cleanVerdict);
    const draft = "I've scheduled the heads-up to Chris for Monday at 09:00.";
    assert.equal(await g.run(ownerCtx(summarize(held)), draft), draft);
    assert.equal(g.calls.rewrite, 0);
  }],
  ['preserved', 'held + "scheduled" draft misflagged without a mismatch is kept by the shield', async () => {
    const g = loadGate(misflagVerdict);
    const draft = "I've scheduled the heads-up to Chris for Monday at 09:00.";
    assert.equal(await g.run(ownerCtx(summarize(held)), draft), draft);
    assert.equal(g.calls.rewrite, 0);
  }],
  ['regression', 'requested send_at (not an hours hold) is SCHEDULED without an attendee_check marker', () => {
    const line = summarize(requestedLater);

    assert.match(line, /^\[message_colleague SCHEDULED, NOT sent yet: Chris — goes out Mon 21 Sep 09:00\] mutated=message$/);
  }],
  ['regression', 'held result with an unreadable scheduled_at still says SCHEDULED, NOT sent (no invented time)', () => {
    assert.match(summarize({ ...held, scheduled_at: 'not-a-date' }), /^\[message_colleague SCHEDULED, NOT sent yet: Chris \(outside Chris's working hours\)\]/);
  }],
  ['regression', 'unconfirmed send_now renders UNCONFIRMED, never FAILED, with no mutated marker', () => {
    assert.equal(summarize(unconfirmed), '[message_colleague UNCONFIRMED: Chris — may have been delivered; scheduled copy cancelled]');
    assert.equal(summarize({ ...unconfirmed, error: 'send_threw' }), '[message_colleague UNCONFIRMED: Chris — may have been delivered; scheduled copy cancelled]');
  }],
  ['regression', 'checker and rewriter prompts carry the UNCONFIRMED line and its semantics', async () => {
    const { mod, captured } = loadChecker();
    const line = summarize(unconfirmed);
    await mod.checkReplyClaims({ reply: 'Sent Chris the heads-up about the review move.', toolSummaries: [line], ownerFirstName: 'Idan' });
    assert.match(captured[0], /\[message_colleague UNCONFIRMED: Chris — may have been delivered/);
    assert.match(captured[0], /An UNCONFIRMED send: .*outcome is UNKNOWN/);
    await mod.rewriteOwningTheMiss({ draft: 'Sent Chris the heads-up.', actionType: 'message', targetName: 'Chris', ownerFirstName: 'Idan', toolSummaries: [line] });
    assert.match(JSON.stringify(captured[1]), /UNCONFIRMED SEND — .*NEVER say it did not go out or that nothing reached them/);
  }],
  ['preserved', 'unconfirmed + "sent" draft flagged by the checker is rewritten (no shield)', async () => {
    const g = loadGate(misflagVerdict);
    assert.equal(await g.run(ownerCtx(summarize(unconfirmed)), 'Sent Chris the heads-up about the review.'), 'REWRITTEN');
    assert.equal(g.calls.rewrite, 1);
  }],
  ['preserved', 'unconfirmed + "may have reached him, please check" passes a clean verdict', async () => {
    const g = loadGate(cleanVerdict);
    const draft = "I tried to send it to Chris but couldn't confirm it went through; it may have reached him, please check.";
    assert.equal(await g.run(ownerCtx(summarize(unconfirmed)), draft), draft);
    assert.equal(g.calls.rewrite, 0);
  }],
  ['preserved', 'definite failure with the held copy kept stays FAILED', () => {
    assert.equal(summarize(definiteFail), '[message_colleague FAILED: connection_not_registered]');
  }],
  ['preserved', 'immediate send keeps its line and marker', () => {
    assert.equal(summarize(sentNow), '[message_colleague: Chris] mutated=message');
  }],
  ['preserved', 'immediate send + "sent" draft is kept by the shield', async () => {
    const g = loadGate(misflagVerdict);
    const draft = 'Sent Chris the heads-up about the review.';
    assert.equal(await g.run(ownerCtx(summarize(sentNow)), draft), draft);
    assert.equal(g.calls.rewrite, 0);
  }],
  ['preserved', 'failed send stays FAILED with no marker', () => {
    assert.equal(summarize(failed), '[message_colleague FAILED: dm_open_failed]');
  }],
  ['preserved', 'failed send + "sent" draft is still rewritten', async () => {
    const g = loadGate(misflagVerdict);
    assert.equal(await g.run(ownerCtx(summarize(failed)), 'Sent Chris the heads-up about the review.'), 'REWRITTEN');
  }],
];

(async () => {
  let passed = 0; let failedCount = 0;
  for (const [kind, name, fn] of cases) {
    try { await fn(); passed++; console.log(`ok   [${kind}] ${name}`); }
    catch (err) { failedCount++; console.log(`FAIL [${kind}] ${name}\n     ${String(err.message).split('\n')[0]}`); }
  }
  console.log(`${passed} passed; ${failedCount} failed`);
  process.exit(failedCount ? 1 : 0);
})();
