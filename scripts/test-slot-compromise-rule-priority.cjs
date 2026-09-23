// Owner ruling 2026-09-23: a meeting one hour away that preserves lunch wins
// over a candidate that breaches lunch. Reuses actual validator/walker/handler
// harness; only calendar and DB I/O are isolated. No application bootstrap.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const fixtureFile = path.join(__dirname, 'test-inperson-home-day-colleague.cjs');
const prefix = fs.readFileSync(fixtureFile, 'utf8').split('(async () => {')[0];
const mod = { exports: {} };
vm.runInNewContext(prefix + '\nmodule.exports = { rules, profile, events, Settings, find, mustBeResult };',
  { require, process, __dirname, module: mod, console, setTimeout, clearTimeout }, { filename: fixtureFile });
const { rules, profile, events, Settings, find, mustBeResult } = mod.exports;
const plain = x => JSON.parse(JSON.stringify(x));
let passed = 0, failed = 0;
async function check(kind, name, fn) { try { await fn(); passed++; console.log(`ok ${kind} ${name}`); } catch (e) { failed++; console.log(`not ok ${kind} ${name}: ${e.message}`); } }
const cmp = (a, b) => rules.compareByRulePriority(a, b);
(async () => {
  Settings.now = () => Date.parse('2026-09-22T05:00:00Z'); // 08:00 Jerusalem
  events.splice(0, 2); // 09:00 free; lunch window has only its existing 12:30 gap.
  const slots = await find({ searchFrom: '2026-09-22T09:00:00+03:00', searchTo: '2026-09-22T13:30:00+03:00', relaxed: true, keepWorkHours: true, minBufferHours: 4, viewer: 'other' });
  const slot = hhmm => slots.find(s => s.start.includes('T' + hhmm));
  const pair = [slot('09:00'), slot('12:30')];
  assert.ok(pair.every(Boolean), 'actual walker must produce both fixture candidates');
  const result = await mustBeResult(pair);
  console.log('# actual candidates ' + JSON.stringify(result.owner_approval_candidates));
  await check('regression', 'owner-one-hour-preserves-lunch-choice', () => {
    assert.deepEqual(plain(pair.map(s => s.broken_rules)), [['within_lead_time'], ['floating_block_overlap']]);
    assert.equal(result.owner_approval_candidates[0].start, pair[0].start);
  });
  await check('regression', 'priority-list-records-lunch-above-short-notice', () => {
    const order = [...rules.OWNER_OVERRIDABLE_KINDS];
    assert.ok(order.indexOf('floating_block_overlap') < order.indexOf('within_lead_time'));
  });
  await check('regression', 'multiple-breaches-normalized-from-validator-order', () => {
    assert.ok(cmp(['within_lead_time', 'floating_block_overlap'], ['in_person_on_home_day']) < 0);
  });
  await check('preserved', 'fully-compliant-first', async () => {
    const clean = { ...pair[1], start: '2026-09-22T14:00:00+03:00', end: '2026-09-22T14:25:00+03:00', broken_rules: [] };
    const ranked = await mustBeResult([...pair, clean]);
    assert.equal(ranked.owner_approval_candidates[0].start, clean.start);
  });
  await check('preserved', 'extra-breach-loses-after-shared-rule', () => assert.ok(cmp(['floating_block_overlap'], ['within_lead_time', 'floating_block_overlap']) < 0));
  await check('preserved', 'equivalent-rule-sets-tie', () => assert.equal(cmp(['floating_block_overlap', 'focus_time_floor'], ['floating_block_overlap', 'focus_time_floor']), 0));
  await check('regression', 'annotation-order-does-not-change-priority', () => assert.equal(cmp(['within_lead_time', 'floating_block_overlap'], ['floating_block_overlap', 'within_lead_time']), 0));
  await check('preserved', 'same-time-lesser-breach-wins', async () => {
    const a = { ...pair[0], broken_rules: ['floating_block_overlap'] }, b = { ...a, broken_rules: ['focus_time_floor'] };
    const ranked = await mustBeResult([a, b]);
    assert.deepEqual(plain(ranked.owner_approval_candidates[0].broken_rules), ['focus_time_floor']);
  });
  await check('preserved', 'equal-priority-time-order', async () => {
    const ranked = await mustBeResult(pair.map(s => ({ ...s, broken_rules: ['within_lead_time'] })));
    assert.deepEqual(plain(ranked.owner_approval_candidates.map(s => s.start)), pair.map(s => s.start));
  });
  await check('preserved', 'unrelated-priority-pairs-unchanged', () => {
    const old = ['in_person_on_home_day', 'category_day_type', 'category_per_day', 'category_per_week', 'outside_working_hours', 'floating_block_overlap', 'travel_buffer_collision', 'focus_time_floor'];
    for (let i = 0; i < old.length; i++) for (let j = i + 1; j < old.length; j++) assert.ok(cmp([old[i]], [old[j]]) > 0, old[i] + ' vs ' + old[j]);
    assert.ok(cmp(['within_lead_time'], ['travel_buffer_collision']) > 0);
    assert.ok(cmp(['within_lead_time'], ['focus_time_floor']) > 0);
  });
  await check('preserved', 'collector-still-reports-validator-order', () => {
    const input = { profile, slotStartIso: pair[1].start, slotEndIso: pair[1].end, category: null, events, inPersonRequested: true, leadTimeHours: 72 };
    assert.deepEqual(plain(rules.brokenOwnerRules(input)), ['within_lead_time', 'in_person_on_home_day', 'floating_block_overlap']);
    assert.equal(rules.checkSlot(input).violation_kind, 'within_lead_time');
  });
  await check('preserved', 'strict-lead-floor-and-owner-relaxation-unchanged', () => {
    const input = { profile, slotStartIso: pair[0].start, slotEndIso: pair[0].end, category: null, events, leadTimeHours: 4 };
    assert.equal(rules.checkSlot(input).violation_kind, 'within_lead_time');
    assert.equal(rules.checkSlot({ ...input, allowRelaxed: true }).passes, true);
  });
  await check('preserved', 'colleague-still-needs-owner-approval', () => {
    assert.deepEqual(plain(result.slots), []);
    assert.match(result._must_be_owner_approval_note, /do NOT book directly/);
    assert.match(result._must_be_owner_approval_note, /policy_exception/);
  });
  await check('preserved', 'comparison-does-not-mutate-annotations', () => {
    const a = ['within_lead_time', 'floating_block_overlap'], b = ['focus_time_floor'];
    cmp(a, b); assert.deepEqual(a, ['within_lead_time', 'floating_block_overlap']); assert.deepEqual(b, ['focus_time_floor']);
  });
  console.log(`\n${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
})();
