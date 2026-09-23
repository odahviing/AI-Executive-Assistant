// Actual outreach producer -> actual orchestrator duplicate guard -> real summary/fallback.
// Isolated transport/requests fixtures; no network, live database or LLM.
// FALLBACK_VERB_BEFORE_DIR selects the preserved index.before.ts for before replay.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
function fixture(file, cut, exports) {
  const filename = path.join(__dirname, file);
  const source = fs.readFileSync(filename, 'utf8');
  const mod = { exports: {} };
  const req = name => name === 'node:test' ? { test() {}, afterEach() {} } : require(name);
  vm.runInNewContext('(function(require,module,exports,__dirname){' +
    (cut ? source.slice(0, source.indexOf(cut)) : source) + '\nmodule.exports={' + exports + '};\n})',
  { console, process, Buffer, Date, Map, Set, Promise, Error, JSON, structuredClone, setImmediate, setTimeout })
    (req, mod, mod.exports, __dirname);
  return mod.exports;
}
const producer = fixture('test-outreach-recipient-timezone.cjs', null, 'harness,CHRIS,SUN_EVENING');
const fallback = fixture('test-fallback-held-send-verb.cjs', 'const cases =', 'run,msg,sent');
const gates = fixture('test-gatekeeper-held-send-summary.cjs', 'const cases =', 'loadChecker,loadGate,ownerCtx,cleanVerdict,misflagVerdict,sentVerdict');
const cases = [];
for (const channel of [false, true]) for (const mode of ['scheduled', 'sent', 'unknown', 'throw', 'unavailable', 'definite']) {
  for (const duplicate of [false, true]) {
    const id = `${channel ? 'room-target' : 'dm'}-${mode}-${duplicate ? 'duplicate' : 'single'}`;
    cases.push([id, async () => {
      const h = producer.harness({ person: producer.CHRIS, noConnection: mode === 'unavailable',
        sendResults: mode === 'throw' ? [new Error('socket reset')] : mode === 'unknown' ? [{ ok: false, reason: 'error' }]
          : mode === 'definite' ? [{ ok: false, reason: 'cannot_dm' }] : [] });
      h.setNow(producer.SUN_EVENING);
      let actualResult;
      const step = { ...fallback.msg('Chris'), execute: async () => actualResult = await h.tool({
        send_now: mode !== 'scheduled', await_reply: false, ...(channel ? { channel_id: 'CROOM' } : {}),
      }) };
      const output = await fallback.run(duplicate ? [step, step] : [step], { expectedExecutions: 1, details: true });
      assert.equal(h.sends.length, ['scheduled', 'unavailable'].includes(mode) ? 0 : 1, 'duplicate cannot execute transport again');
      const expected = mode === 'scheduled' ? 'scheduled the message' : mode === 'sent' ? 'sent the message'
        : ['unknown', 'throw'].includes(mode) ? "tried to send the message but couldn't confirm it went through" : null;
      if (expected) assert.equal(output.reply, `Done — ${expected}. Let me know if anything's off.`);
      else assert.match(output.reply, /^That didn't go through on my end/);
      assert.equal(output.toolSummaries.length, 1, 'skipped invocation is not another action');
      assert.equal(h.row()?.next_check_handler != null, mode === 'scheduled', 'original timer state is preserved');
      const checker = gates.loadChecker();
      await checker.mod.checkReplyClaims({ reply: output.reply, toolSummaries: output.toolSummaries, ownerFirstName: 'Owner' });
      assert.ok(checker.captured[0].includes(output.toolSummaries[0]));
      const context = { ...gates.ownerCtx(output.toolSummaries[0]), result: output };
      assert.equal(await gates.loadGate(gates.cleanVerdict).run(context, output.reply), output.reply);
      assert.equal(await gates.loadGate(mode === 'scheduled' ? gates.sentVerdict : gates.misflagVerdict)
        .run(context, 'Sent Chris the heads-up about the review.'), mode === 'sent' ? 'Sent Chris the heads-up about the review.' : 'REWRITTEN');
      console.log(JSON.stringify({ id, actualResult, output, row: h.row(), attempts: h.sends.length }));
    }]);
  }
}
cases.push(['mixed-sent-scheduled-duplicate', async () => {
  const h = producer.harness({ person: producer.CHRIS }); h.setNow(producer.SUN_EVENING);
  const step = { ...fallback.msg('Chris'), execute: () => h.tool({ await_reply: false }) };
  const output = await fallback.run([fallback.msg('Dana', fallback.sent), step, step], { expectedExecutions: 2, details: true });
  assert.equal(output.reply, "Done — sent the message and scheduled the message. Let me know if anything's off.");
  assert.equal(output.toolSummaries.length, 2);
}]);
for (const [verdict, notified, skipped] of [['approve', true, true], ['amend', true, true], ['reject', true, false], ['approve', false, false]]) {
  cases.push([`resolver-${verdict}-notified-${notified}`, async () => {
    const resolver = { name: 'resolve_approval', args: { verdict }, result: { ok: true, request_id: 'req_test', requester_notified: notified } };
    const output = await fallback.run([resolver, fallback.msg('Chris', fallback.sent)], {
      expectedExecutions: skipped ? 1 : 2, details: true, request: { requester_slack_id: 'U_Chris' },
    });
    assert.equal(output.reply, skipped ? "Done — recorded your decision. Let me know if anything's off."
      : "Done — recorded your decision and sent the message. Let me know if anything's off.");
    assert.equal(output.toolSummaries.length, skipped ? 1 : 2);
  }]);
}
cases.push(['turn-boundary-resets-duplicate-guard', async () => {
  const step = fallback.msg('Chris', fallback.sent);
  for (let turn = 0; turn < 2; turn++) {
    assert.match(await fallback.run([step]), /sent the message/);
  }
}]);
cases.push(['duplicate-tool-result-defers-to-original-outcome', async () => {
  const inputs = [], step = fallback.msg('Chris', { ok: false, error: 'connection_not_registered' });
  await fallback.run([step, step], { expectedExecutions: 1, observeModelInput: input => inputs.push(input) });
  const results = inputs.flatMap(input => input.messages.flatMap(message => Array.isArray(message.content) ? message.content : []));
  const duplicate = results.filter(block => block.type === 'tool_result').map(block => JSON.parse(block.content))
    .find(result => result.reason === 'already_messaged_this_turn');
  assert.ok(duplicate);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate._note, /original result/);
  assert.doesNotMatch(duplicate._note, /first message is queued/);
}]);
(async () => {
  let passed = 0, failed = 0;
  for (const [id, test] of cases) {
    try { await test(); passed++; console.log(`PASS ${id}`); }
    catch (error) { failed++; console.log(`FAIL ${id}: ${error.stack}`); }
  }
  console.log(`${passed} passed; ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
