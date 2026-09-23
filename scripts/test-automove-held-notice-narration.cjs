/*
 * automove-held-notice-narration-20260920 — the active-mode auto-move tells the
 * owner the truth about each attendee notice: sent ("let X know"), held for the
 * recipient's work hours (notifyColleagueOfMove -> 'scheduled': "I'll let X know
 * when their workday starts" — the return carries no time, so none is stated),
 * or failed ("couldn't confirm").
 *
 * Reuses the isolated calendar-health harness (scripts/test-calendar-health-audit.cjs):
 * the production autoMove.ts runs; only its I/O boundaries are fixtures.
 *
 * node scripts/test-automove-held-notice-narration.cjs [--source-root SNAPSHOT]
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const arg = process.argv.indexOf('--source-root');
const snapshot = arg < 0 ? null : path.resolve(process.argv[arg + 1]);
let src = fs.readFileSync(path.join(__dirname, 'test-calendar-health-audit.cjs'), 'utf8');
src = src.slice(0, src.indexOf('async function test('));
const swap = (a, b) => { if (src.split(a).length !== 2) throw Error('harness anchor moved: ' + a.slice(0, 60)); src = src.replace(a, b); };
swap("return !opts.noticeFalse; } };", "return opts.noticeResult !== undefined ? opts.noticeResult : !opts.noticeFalse; } };");
swap("return { correctedColleagueSlackIds: [] };", "return opts.cascadeResult ?? { correctedColleagueSlackIds: [] };");
swap("const file = ['meetingProtection', 'attendeeScope'].includes(name)",
  "const file = (name === 'autoMove' && SNAPSHOT && require('node:fs').existsSync(require('node:path').join(SNAPSHOT, 'src/skills/calendarHealth/autoMove.ts'))) ? require('node:path').join(SNAPSHOT, 'src/skills/calendarHealth/autoMove.ts') : ['meetingProtection', 'attendeeScope'].includes(name)");
src += '\nmodule.exports = { harness };';
const mod = { exports: {} };
vm.runInThisContext('(function(require,module,exports,__dirname,SNAPSHOT){' + src + '\n})', { filename: 'calendar-health-harness' })(require, mod, mod.exports, __dirname, snapshot);
const { harness } = mod.exports;

let passed = 0, failed = 0;
async function check(kind, name, fn) {
  try { await fn(); passed++; console.log(`ok ${kind} ${name}`); }
  catch (e) { failed++; console.log(`not ok ${kind} ${name} — ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw Error(m); };

(async () => {
  await check('regression', 'direct-unknown-never-claims-sent', async () => {
    const r = await harness({ noticeResult: 'unconfirmed' }).move();
    ok(r.issue.fixed === true && /couldn.t confirm the notification/.test(r.issue.fix_detail), r.issue.fix_detail);
    ok(!/and let Peer know/.test(r.issue.fix_detail), 'unknown notice claimed sent');
  });
  await check('regression', 'cascade-unknown-reported-without-second-send', async () => {
    const h = harness({ cascadeResult: { correctedColleagueSlackIds: ['peer'], unconfirmedColleagueSlackIds: ['peer'] } });
    const r = await h.move();
    ok(r.issue.fixed === true && /couldn.t confirm/.test(r.issue.fix_detail), r.issue.fix_detail);
    ok(!h.calls.some(c => c[0] === 'notice'), 'duplicate notification attempted');
  });
  await check('regression', 'held-notice-gets-scheduled-wording', async () => {
    const r = await harness({ noticeResult: 'scheduled' }).move();
    ok(r.issue.fixed === true, 'move not confirmed');
    ok(!/let Peer know —/.test(r.issue.fix_detail), `held notice narrated as sent: ${r.issue.fix_detail}`);
    ok(/I'll let Peer know when their workday starts\./.test(r.issue.fix_detail), `no scheduled wording: ${r.issue.fix_detail}`);
    const held = r.issue.fix_detail.slice(r.issue.fix_detail.indexOf("I'll let Peer know"));
    ok(!/\d{1,2}:\d{2}/.test(held), `invented a send time: ${held}`);
  });
  await check('preserved', 'sent-notice-keeps-todays-wording', async () => {
    const r = await harness({ noticeResult: true }).move();
    ok(/and let Peer know — I'll loop you in if they push back\./.test(r.issue.fix_detail), r.issue.fix_detail);
    ok(!/workday starts/.test(r.issue.fix_detail), 'sent notice got the scheduled wording');
  });
  await check('preserved', 'failed-notice-keeps-todays-wording', async () => {
    const r = await harness({ noticeResult: false }).move();
    ok(/couldn.t confirm the notification to Peer/.test(r.issue.fix_detail), r.issue.fix_detail);
    ok(!/let Peer know/.test(r.issue.fix_detail), 'failed notice claimed');
  });
  await check('preserved', 'thrown-notice-keeps-todays-wording', async () => {
    const r = await harness({ noticeError: true }).move();
    ok(r.issue.fixed === true && /couldn.t confirm the notification/.test(r.issue.fix_detail), r.issue.fix_detail);
  });
  console.log(`${passed} passed; ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
