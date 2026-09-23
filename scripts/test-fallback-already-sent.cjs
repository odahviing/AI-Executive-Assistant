// Actual orchestrator + actual Gatekeeper summary; no model/network/database access.
// FALLBACK_VERB_BEFORE_DIR selects preserved index.before.ts for before replay.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict');
const filename = path.join(__dirname, 'test-fallback-held-send-verb.cjs');
const source = fs.readFileSync(filename, 'utf8');
const mod = { exports: {} };
vm.runInNewContext('(function(require,module,exports,__dirname){' + source.slice(0, source.indexOf('const cases =')) +
  '\nmodule.exports={run,msg,sent,held,unconfirmed,failed};})',
{ console, process, Date, Map, Set, structuredClone, setImmediate })(require, mod, mod.exports, __dirname);
const { run, msg, sent, held, unconfirmed, failed } = mod.exports;
const prior = { ok: true, sent: false, already_sent: true, request_id: 'req_original_1', sent_at: '2026-09-21T06:00:00Z' };
const old = msg('Chris', prior);
const reply = verbs => `Done — ${verbs}. Let me know if anything's off.`;
const already = 'the original message was already sent';
const unknown = "tried to send the message but couldn't confirm it went through";
const cases = [
  ['already-sent', [old], reply(already)],
  ['already-sent-duplicate', [old, old], reply(already), 1],
  ['mixed-prior-fresh', [old, msg('Dana', sent)], reply('sent the message and ' + already)],
  ['mixed-prior-held', [old, msg('Dana', held)], reply('scheduled the message and ' + already)],
  ['mixed-prior-unknown', [old, msg('Dana', unconfirmed)], reply(unknown + ' and ' + already)],
  ['mixed-prior-failed', [old, msg('Dana', failed)], reply(already)],
  ['preserved-fresh', [msg('Dana', sent)], reply('sent the message')],
  ['preserved-held', [msg('Dana', held)], reply('scheduled the message')],
  ['preserved-unknown', [msg('Dana', unconfirmed)], reply(unknown)],
  ['preserved-failed', [msg('Dana', failed)], /^That didn't go through on my end/],
  ['preserved-two-fresh-outcomes-prior', [old, msg('Dana', sent), msg('Lee', held)], reply('sent the message and scheduled the message')],
];
(async () => {
  let passed = 0, failedCount = 0;
  for (const [id, steps, expected, executions] of cases) {
    try {
      const result = await run(steps, { details: true, expectedExecutions: executions ?? steps.length });
      if (typeof expected === 'string') assert.equal(result.reply, expected); else assert.match(result.reply, expected);
      if (steps.includes(old)) {
        const line = result.toolSummaries.find(s => s.includes('ALREADY_SENT'));
        assert.ok(line); assert.match(line, /request_id=req_original_1/); assert.doesNotMatch(line, /mutated=/);
        assert.equal(result.toolSummaries.filter(s => s.includes('mutated=message')).length,
          steps.filter(s => s !== old && s.result !== failed && s.result !== unconfirmed).length);
      }
      console.log(`PASS ${id} ${JSON.stringify(result)}`); passed++;
    } catch (error) { console.log(`FAIL ${id}: ${error.stack}`); failedCount++; }
  }
  console.log(`${passed} passed; ${failedCount} failed`); process.exitCode = failedCount ? 1 : 0;
})();
