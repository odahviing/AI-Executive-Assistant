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
const event = (start = '2026-09-24T12:00:00') => ({ id: 'existing', subject: 'Review', isAllDay:false,
  start: { dateTime: start, timeZone: 'UTC' }, end: { dateTime: start.slice(0,11)+'12:25:00', timeZone:'UTC' },
  organizer: {emailAddress:{address:'owner@example.test'}}, attendees: [{ type:'required', emailAddress: { address: 'peer@example.test' } }] });
function matchers({ warm = [], live = [event()], error } = {}) {
  let calls = 0;
  const fns = compile(fn('findDuplicateEvent') + '\n' + fn('findReschedulableSibling') + '\nmodule.exports = { findDuplicateEvent, findReschedulableSibling };', {
    DateTime, getCalendarEvents: async (_email, _from, _to, _zone, freshness) => { calls++; if (error) throw error; return freshness === 'force' ? live : warm; },
  });
  return { ...fns, calls: () => calls };
}
const intended = { endIso:'2026-09-24T12:25:00Z', attendees:[{email:'PEER@example.test'}], allDay:false,
  roomEmail:'room@example.test', requireRoom:false };
const duplicate = (h, identity = intended) => h.findDuplicateEvent('owner@example.test', 'Review', '2026-09-24T12:00:00Z', 'UTC',
  ...(fn('findDuplicateEvent').includes('intended:') ? [identity] : []));
const sibling = h => h.findReschedulableSibling({ userEmail: 'owner@example.test', ownerEmail: 'owner@example.test', subject: 'Review', startIso: '2026-09-25T12:00:00Z', timezone: 'UTC', attendeeEmails: ['peer@example.test'] });
function guard(kind, result, error, forceNew = false) {
  const marker = kind === 'early' ? 'colleague-path early idempotency probe failed' : kind === 'duplicate' ? 'create_meeting idempotency pre-check failed' : 'reschedulable-sibling check threw';
  const branch = one(nodes(createFile, n => ts.isTryStatement(n) && n.catchClause?.getText().includes(marker)));
  const code = kind === 'sibling' ? branch.parent.parent.getText() : branch.getText();
  const helpers = nodes(createFile, n => ts.isVariableDeclaration(n) && n.name?.getText() === 'probeExistingBooking');
  const probe = helpers.length ? 'const '+helpers[0].getText()+';\n' : '';
  return compile('module.exports = async function() {' + probe + code + '\nreturn { reachedWrite: true }; };', {
    args: { subject: 'Review', start: '2026-09-24T12:00:00Z', end: '2026-09-24T12:25:00Z', force_new: forceNew },
    userEmail: 'owner@example.test', ownerEmail: 'owner@example.test', timezone: 'UTC', attendees: [{ email: 'peer@example.test' }],
    context: { profile: {user:{name:'Owner'},meetings:{}} }, assistantEmail:undefined, viewerEmail: undefined, DateTime, tripDisplay: undefined,
    formatIsoTime: () => 'Thursday 12:00',
    logger: { warn() {}, info() {} }, presentationLocalFieldFor: () => ({}), renderWeDualClock: () => 'Thursday 12:00',
    displaySubject: x => x.subject, subjectViewerFor: () => 'owner',
    findDuplicateEvent: async (...params) => { if (error) throw error; return typeof result === 'function' ? result(...params) : result; },
    findReschedulableSibling: async () => { if (error) throw error; return result; },
  })();
}
let passed = 0, failed = 0;
async function check(name, f) { try { await f(); passed++; console.log('ok ' + name); } catch (e) { failed++; console.log('not ok ' + name + ': ' + e.message); } }
(async () => {
  const read = (...live) => duplicate(matchers({live}));
  for (const [label, change] of [
    ['different roster', {attendees:[]}], ['missing roster', {attendees:undefined}],
    ['different organizer', {organizer:{emailAddress:{address:'someone@example.test'}}}],
    ['different duration', {end:{dateTime:'2026-09-24T12:30:00',timeZone:'UTC'}}],
    ['nearby start', {start:{dateTime:'2026-09-24T12:01:00',timeZone:'UTC'}}],
    ['changed attendee role', {attendees:[{type:'optional',emailAddress:{address:'peer@example.test'}}]}],
  ]) await check('same title with '+label+' requests clarification', async () =>
    assert.equal(await read({...event(), ...change}), 'ambiguous'));
  await check('two matching events cannot identify one retry', async () => assert.equal(await read(event(), {...event(),id:'second'}), 'ambiguous'));
  await check('one proven invitation among nearby events is a true retry', async () => assert.equal((await read({...event(),attendees:[]}, event())).id, 'existing'));
  await check('room auto-addition and address case preserve a genuine retry', async () =>
    assert.equal((await read({...event(), attendees:[...event().attendees,{type:'optional',emailAddress:{address:'ROOM@example.test'}}]})).id,'existing'));
  await check('an explicitly requested room must be present', async () =>
    assert.equal(await duplicate(matchers(), {...intended,requireRoom:true}), 'ambiguous'));
  for (const path of ['early','duplicate']) {
    await check(path+' ambiguous collision withholds both success and creation',async () => {
      const result = await guard(path, 'ambiguous'); assert.equal(result.error,'existing_booking_identity_unconfirmed');
      assert.equal(result.reachedWrite,undefined); assert.equal(result.meetingId,undefined);
    });
    await check(path+' actual matcher returns the intended invitation and withholds a different roster',async () => {
      const good = await guard(path, matchers().findDuplicateEvent);
      assert.equal(good.idempotent,true); assert.equal(good.meetingId,'existing');
      const mismatched = matchers({live:[{...event(), attendees:[]}]});
      const result = await guard(path, mismatched.findDuplicateEvent);
      assert.equal(result.error,'existing_booking_identity_unconfirmed');
      assert.equal(result.meetingId,undefined); assert.equal(result.reachedWrite,undefined);
    });
  }
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
