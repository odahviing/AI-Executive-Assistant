// Actual classifier and calendar-health consumer, isolated Graph/DB/provider fixtures.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { harness, event } = require('./test-calendar-health-audit.cjs');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'artifacts/workshop-verification/models-208-20261011/matchmaker');
const baseline = process.argv.includes('--baseline');
const outIndex = process.argv.indexOf('--out');
const outputPath = outIndex < 0 ? null : process.argv[outIndex + 1];
if (outIndex >= 0 && (!outputPath || outputPath.startsWith('--'))) throw Error('--out requires a new output file path');
const classifySource = fs.readFileSync(path.join(root, baseline ? 'artifacts/workshop-verification/models-208-20261011/matchmaker/classify-before.ts' : 'src/skills/calendarHealth/classify.ts'), 'utf8');
const results = [];
const selection = (input = { category: 'Meeting', confidence: 'high' }, name = 'pick_category') => ({ type: 'tool_use', id: 'tool_synthetic', name, input });
function setup(opts = {}) {
  const requests = [];
  const client = { messages: { create: async req => {
    requests.push(req);
    if (opts.unavailable) throw Error('Synthetic unavailable');
    if (opts.target && req.tool_choice.type !== 'auto') throw Error('Synthetic target: forced tools unsupported');
    return { stop_reason: opts.stop ?? 'tool_use', content: opts.content ?? [selection()] };
  } } };
  const h = harness({ client, classifySource, events: [{ ...event('synthetic'), subject: 'Team planning', categories: [] }], writeError: opts.writeError });
  return { ...h, requests, classify: () => h.load('classify').classifyEventCategory(event('synthetic'), h.profile) };
}
async function test(id, fn) { try { await fn(); results.push({ id, status: 'pass' }); } catch (e) { results.push({ id, status: 'fail', error: e.message }); } }
(async () => {
  await test('target-auto-choice-classifies', async () => { const h = setup({ target: true }); assert.equal(await h.classify(), 'Meeting'); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].max_tokens, 200); });
  await test('legitimate-high-tool-use', async () => { assert.equal(await setup().classify(), 'Meeting'); });
  await test('legitimate-end-turn-text-tool', async () => { assert.equal(await setup({ stop: 'end_turn', content: [{ type: 'text', text: 'Selected.' }, selection()] }).classify(), 'Meeting'); });
  for (const stop of ['max_tokens', 'refusal', 'pause_turn', 'stop_sequence', null]) {
    await test(`reject-stop-${stop}`, async () => { const h = setup({ stop: stop ?? 'unknown' }); assert.equal(await h.classify(), null); });
  }
  for (const [id, content] of [
    ['wrong-tool', [selection(undefined, 'other')]], ['duplicate', [selection(), selection()]],
    ['missing', []], ['text-only', [{ type: 'text', text: 'Meeting' }]],
    ['null-input', [selection(null)]], ['array-input', [selection([])]],
    ['wrong-category-type', [selection({ category: 3, confidence: 'high' })]],
    ['missing-confidence', [selection({ category: 'Meeting' })]],
    ['unknown-category', [selection({ category: 'Unknown', confidence: 'high' })]],
    ['medium', [selection({ category: 'Meeting', confidence: 'medium' })]],
    ['low', [selection({ category: 'Meeting', confidence: 'low' })]],
  ]) await test(`reject-${id}`, async () => { assert.equal(await setup({ content }).classify(), null); });
  await test('unavailable-retains-null', async () => { const h = setup({ unavailable: true }); assert.equal(await h.classify(), null); assert.equal(h.requests.length, 1); });
  await test('empty-catalog-no-call', async () => { const h = setup(); h.profile.categories = []; assert.equal(await h.classify(), null); assert.equal(h.requests.length, 0); });
  await test('consumer-target-tags-and-reports-confirmed', async () => { const h = setup({ target: true }); const r = await h.scan({ mode: 'active' }); assert.equal(h.calls.filter(c => c[0] === 'write').length, 1); assert.equal(r.fixes_applied, 1); assert.equal(r.issues[0].fixed, true); assert.match(r.issues[0].fix_detail, /Meeting/); });
  await test('consumer-legitimate-tags-once', async () => { const h = setup(); const r = await h.scan({ mode: 'active' }); assert.equal(h.calls.filter(c => c[0] === 'write').length, 1); assert.equal(r.fixes_applied, 1); });
  await test('consumer-truncated-no-write-no-success', async () => { const h = setup({ stop: 'max_tokens' }); const r = await h.scan({ mode: 'active' }); assert.equal(h.calls.filter(c => c[0] === 'write').length, 0); assert.equal(r.fixes_applied, 0); assert.notEqual(r.issues[0].fixed, true); });
  await test('consumer-unavailable-no-write-no-success', async () => { const h = setup({ unavailable: true }); const r = await h.scan({ mode: 'active' }); assert.equal(h.calls.filter(c => c[0] === 'write').length, 0); assert.equal(r.fixes_applied, 0); });
  await test('consumer-write-failure-not-fixed', async () => { const h = setup({ writeError: true }); const r = await h.scan({ mode: 'active' }); assert.equal(h.calls.filter(c => c[0] === 'write').length, 1); assert.equal(r.fixes_applied, 0); assert.notEqual(r.issues[0].fixed, true); });
  await test('consumer-restart-tagged-event-no-repeat', async () => { const h = harness({ classifySource, client: { messages: { create: async () => { throw Error('Must not classify tagged event'); } } }, events: [event('tagged')] }); const r = await h.scan({ mode: 'active' }); assert.equal(h.calls.filter(c => c[0] === 'write').length, 0); assert.equal(r.fixes_applied, 0); });
  const report = { revision: baseline ? 'b7dc0e54 classifier, current consumer fixtures' : 'working tree', results, passed: results.filter(r => r.status === 'pass').length, failed: results.filter(r => r.status === 'fail').length };
  if (outputPath) fs.writeFileSync(path.resolve(outputPath), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2)); process.exitCode = report.failed ? 1 : 0;
})();
