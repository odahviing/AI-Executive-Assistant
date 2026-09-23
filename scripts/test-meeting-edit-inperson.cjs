// Runs the production move search arguments, planner check and update gate with
// the real slot validator/walker. Only calendar/identity I/O is mocked.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
let base = fs.readFileSync(path.join(__dirname, 'test-inperson-home-day-colleague.cjs'), 'utf8');
base = base.slice(0, base.indexOf('// ── AST helpers'));
base += '\nmodule.exports = { read, rules, find, profile, events, logger };';
const m = { exports: {} };
vm.runInThisContext('(function(require,module,exports,__dirname,process){' + base + '\n})')(require, m, m.exports, __dirname, process);
const { read, rules, find, profile, events, logger } = m.exports;
const moveFile = 'src/skills/meetings/ops/handlers/moveMeeting.ts';
function nodes(file, predicate) {
  const out = [];
  function visit(n) { if (predicate(n)) out.push(n); ts.forEachChild(n, visit); }
  visit(ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true));
  return out;
}
function one(xs) { assert.equal(xs.length, 1, 'unique production AST anchor'); return xs[0]; }
function compile(body, bindings = {}, deps = {}) {
  const mod = { exports: {} };
  const js = ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { ...bindings, module: mod, exports: mod.exports, console,
    require: id => { if (id in deps) return deps[id]; throw Error('Unexpected dependency ' + id); } });
  return mod.exports;
}
const planArg = one(nodes('src/skills/meetings/planMeeting.ts', n => ts.isCallExpression(n) && n.expression.getText() === 'checkSlot')).arguments[0].getText();
function planner({ day = '2026-09-22', isOnline = false, initiator = 'colleague', relaxed = false } = {}) {
  const input = { slotStartIso: day + 'T13:45:00+03:00', slotEndIso: day + 'T14:10:00+03:00', isOnlineHint: isOnline, initiator, allowRelaxed: relaxed, existingEventId: 'moving' };
  return compile('module.exports = checkSlot(' + planArg + ');', {
    input, profile, category: 'Meeting', events, initiator, venueTravelMinutes: undefined,
    checkSlot: rules.checkSlot, bookingLeadTimeHours: rules.bookingLeadTimeHours,
  });
}
const moveArg = one(nodes(moveFile, n => ts.isBinaryExpression(n) && n.left.getText() === 'validSlots' && n.right.getText().startsWith('await findAvailableSlots('))).right.expression.arguments[0].getText();
async function moveSearch(day, isOnline) {
  const diagnostics = {};
  const slots = await compile('module.exports = findAvailableSlots(' + moveArg + ');', {
    args: { meeting_id: 'moving', is_online: isOnline }, userEmail: profile.user.email, timezone: profile.user.timezone,
    durationMin: 25, attendeeCheckParams: () => ({}), moveCheckAttendees: [], context: { profile },
    fromIso: day + 'T13:45:00+03:00', toIso: day + 'T14:10:00+03:00', diagnostics, findAvailableSlots: find,
  });
  return { slots, diagnostics };
}
const updateFn = one(nodes(moveFile, n => ts.isFunctionDeclaration(n) && n.name?.text === 'colleagueUpdateRuleGate')).getText();
async function update({ day = '2026-09-22', isOnline = false, unchanged = false, failRead = false } = {}) {
  const args = { meeting_id: 'moving', meeting_subject: 'Fixture', is_online: isOnline };
  const gate = compile(updateFn + '\nmodule.exports = colleagueUpdateRuleGate;', {
    getPersonMemory: () => ({ name: 'Peer' }), checkSlot: rules.checkSlot, logger,
    HANDLER_ERROR_CODE: { NOT_RULE_COMPLIANT: 'not_rule_compliant' },
    subjectViewerFor: () => 'other', viewerEmailFor: () => undefined,
    CalendarOfflineError: class extends Error {},
  }, { '../../planMeeting': { loadEventsForCheck: async () => { if (failRead) throw Error('calendar unavailable'); return events; } } });
  return gate(args, { context: { profile, userId: 'UPEER' }, userEmail: profile.user.email }, {
    existing: { categories: ['Meeting'], location: '', isOnline: true, startIso: day + 'T13:45:00+03:00', endIso: day + 'T14:10:00+03:00' },
    ...(unchanged ? {} : { patchLocation: isOnline ? '' : 'Idan Office', patchIsOnline: isOnline }),
  });
}
let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; console.log('ok ' + name); } catch (e) { failed++; console.log('not ok ' + name + ': ' + e.message); } }
(async () => {
  await check('regression planner-colleague-inperson-home', () => assert.equal(planner().violation_kind, 'in_person_on_home_day'));
  await check('regression move-search-colleague-inperson-home', async () => { const r = await moveSearch('2026-09-22', false); assert.equal(r.slots.length, 0); assert.ok(r.diagnostics.rejectedCounts.wrong_day_type); });
  await check('regression update-colleague-inperson-home', async () => { const r = await update(); assert.equal(r.refusal?.broken_rule, 'in_person_on_home_day'); assert.equal(r.refusal?._deferred_action_hint.tool, 'update_meeting'); });
  await check('preserved planner-remote-home', () => assert.equal(planner({ isOnline: true }).passes, true));
  await check('preserved planner-inperson-office', () => assert.equal(planner({ day: '2026-09-23' }).passes, true));
  await check('preserved planner-owner-approved-home', () => assert.equal(planner({ initiator: 'owner', relaxed: true }).passes, true));
  await check('preserved planner-owner-unapproved-home', () => assert.equal(planner({ initiator: 'owner' }).violation_kind, 'in_person_on_home_day'));
  await check('preserved move-search-remote-home', async () => assert.ok((await moveSearch('2026-09-22', true)).slots.length));
  await check('preserved move-search-inperson-office', async () => assert.ok((await moveSearch('2026-09-23', false)).slots.length));
  await check('preserved update-remote-home', async () => assert.equal((await update({ isOnline: true })).refusal, undefined));
  await check('preserved update-inperson-office', async () => assert.equal((await update({ day: '2026-09-23' })).refusal, undefined));
  await check('preserved update-rename-no-new-rule-input', async () => assert.equal((await update({ unchanged: true })).refusal, undefined));
  await check('preserved update-unavailable-refuses', async () => assert.equal((await update({ failRead: true })).refusal?.reason, 'rule_check_failed'));
  console.log(`${passed} passed; ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
