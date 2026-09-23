// Actual duplicate/sibling matchers and create guard branches, isolated I/O.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { DateTime } = require('luxon');
const root = path.resolve(__dirname, '..');
const arg = process.argv.indexOf('--source-root');
const before = arg < 0 ? root : path.resolve(process.argv[arg + 1]);
function read(rel) { const file = path.join(before, rel); return fs.readFileSync(fs.existsSync(file) ? file : path.join(root, rel), 'utf8'); }
function nodes(file, pred) { const out = []; const src = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true); (function walk(n) { if (pred(n)) out.push(n); ts.forEachChild(n, walk); })(src); return out; }
function one(xs) { assert.equal(xs.length, 1); return xs[0]; }
function compile(source, bindings) { const m = { exports: {} }; const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText; vm.runInNewContext(js, { ...bindings, module: m, exports: m.exports, console }); return m.exports; }
const readsFile = 'src/connectors/graph/calendarReads.ts';
const createFile = 'src/skills/meetings/ops/handlers/createMeeting.ts';
const fn = name => one(nodes(readsFile, n => ts.isFunctionDeclaration(n) && n.name?.text === name)).getText().replace('export ', '');
const event = (start = '2026-09-24T12:00:00') => ({ id: 'existing', subject: 'Review', start: { dateTime: start, timeZone: 'UTC' }, attendees: [{ emailAddress: { address: 'peer@example.test' } }] });
function matchers({ warm = [], live = [event()], error } = {}) {
  let calls = 0;
  const fns = compile(fn('findDuplicateEvent') + '\n' + fn('findReschedulableSibling') + '\nmodule.exports = { findDuplicateEvent, findReschedulableSibling };', {
    DateTime, getCalendarEvents: async (_email, _from, _to, _zone, freshness) => { calls++; if (error) throw error; return freshness === 'force' ? live : warm; },
  });
  return { ...fns, calls: () => calls };
}
const duplicate = h => h.findDuplicateEvent('owner@example.test', 'Review', '2026-09-24T12:00:00Z', 'UTC');
const sibling = h => h.findReschedulableSibling({ userEmail: 'owner@example.test', ownerEmail: 'owner@example.test', subject: 'Review', startIso: '2026-09-25T12:00:00Z', timezone: 'UTC', attendeeEmails: ['peer@example.test'] });
function guard(kind, result, error, forceNew = false) {
  const marker = kind === 'duplicate' ? 'create_meeting idempotency pre-check failed' : 'reschedulable-sibling check threw';
  const branch = one(nodes(createFile, n => ts.isTryStatement(n) && n.catchClause?.getText().includes(marker)));
  const code = kind === 'sibling' ? branch.parent.parent.getText() : branch.getText();
  return compile('module.exports = async function() {' + code + '\nreturn { reachedWrite: true }; };', {
    args: { subject: 'Review', start: '2026-09-24T12:00:00Z', end: '2026-09-24T12:25:00Z', force_new: forceNew },
    userEmail: 'owner@example.test', ownerEmail: 'owner@example.test', timezone: 'UTC', attendees: [{ email: 'peer@example.test' }],
    context: { profile: {} }, viewerEmail: undefined, DateTime, tripDisplay: undefined,
    logger: { warn() {}, info() {} }, presentationLocalFieldFor: () => ({}), renderWeDualClock: () => 'Thursday 12:00',
    displaySubject: x => x.subject, subjectViewerFor: () => 'owner',
    findDuplicateEvent: async () => { if (error) throw error; return result; },
    findReschedulableSibling: async () => { if (error) throw error; return result; },
  })();
}
let passed = 0, failed = 0;
async function check(name, f) { try { await f(); passed++; console.log('ok ' + name); } catch (e) { failed++; console.log('not ok ' + name + ': ' + e.message); } }
(async () => {
  await check('regression cached-absence-cannot-hide-duplicate', async () => assert.equal((await duplicate(matchers()))?.id, 'existing'));
  await check('regression cached-absence-cannot-hide-sibling', async () => assert.equal((await sibling(matchers()))?.id, 'existing'));
  await check('regression duplicate-read-failure-stops-create', async () => assert.rejects(guard('duplicate', null, Error('unavailable')), /unavailable/));
  await check('regression sibling-read-failure-stops-create', async () => assert.rejects(guard('sibling', null, Error('unavailable')), /unavailable/));
  await check('preserved no-match-allows-create', async () => assert.equal((await guard('duplicate')).reachedWrite, true));
  await check('preserved no-sibling-allows-create', async () => assert.equal((await guard('sibling')).reachedWrite, true));
  await check('preserved existing-duplicate-idempotent', async () => assert.equal((await guard('duplicate', event())).idempotent, true));
  await check('preserved existing-sibling-steers-move', async () => assert.equal((await guard('sibling', event())).error, 'possible_reschedule'));
  await check('preserved force-new-skips-sibling-only', async () => assert.equal((await guard('sibling', event(), Error('not-called'), true)).reachedWrite, true));
  await check('preserved exact-start-is-not-sibling', async () => assert.equal(await sibling(matchers({ warm: [event('2026-09-25T12:00:00')], live: [event('2026-09-25T12:00:00')] })), undefined));
  await check('preserved cancellation-does-not-block-create', async () => assert.equal(await duplicate(matchers({ warm: [{ ...event(), isCancelled: true }], live: [{ ...event(), isCancelled: true }] })), undefined));
  console.log(`${passed} passed; ${failed} failed`); process.exitCode = failed ? 1 : 0;
})();
