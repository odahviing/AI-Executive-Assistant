// Structural capture of the real meetings tool definitions and prompt. No model,
// Graph, delivery, or production DB calls; model obedience is not established.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), ts = require('typescript');
const root = path.resolve(__dirname, '..');
const at = process.argv.indexOf('--source-root');
const srcRoot = at < 0 ? root : path.resolve(process.argv[at + 1]);
const source = fs.readFileSync(path.join(srcRoot, 'src/skills/meetings.ts'), 'utf8');
const noop = () => {};
let skill;
const deps = {
  '../connectors/graph/calendar': {},
  './meetings/ops': { SchedulingSkill: class {} },
  './meetings/calendarOffline': {},
  '../utils/logger': { __esModule: true, default: { info: noop, warn: noop } },
  luxon: require('luxon'),
  '../utils/calendarListingFormat': { calendarListingFormatRule: () => '' },
  '../utils/scheduleRules': {}, '../utils/displaySubject': {},
  './registry': { getSkillTools: (p, role, scopes, channel) => skill.getTools(p).filter(t => channel !== 'email' || ['create_meeting','find_available_slots'].includes(t.name)) },
  '../utils/workHours': { getOwnerWorkHoursForDay: () => [{ startMin: 540, endMin: 1020 }], formatMinuteOfDay: n => `${Math.floor(n / 60)}:00` },
  '../utils/floatingBlocks': { getFloatingBlocks: () => [] },
};
const mod = { exports: {} };
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
vm.runInNewContext(`(function(require,module,exports){${js}\n})`, {})(id => { assert.ok(id in deps, `Unexpected dependency ${id}`); return deps[id]; }, mod, mod.exports);
skill = new mod.exports.MeetingsSkill();
const profile = { user: { name: 'Owner Example', timezone: 'UTC' }, assistant: { name: 'Assistant' }, categories: [], schedule: { office_days: { days: ['Monday'] }, home_days: { days: ['Tuesday'] } }, meetings: { allowed_durations: [25,55], buffer_minutes: 5 } };
const tools = skill.getTools(profile);
const tool = name => tools.find(t => t.name === name);
const owner = skill.getSystemPromptSection(profile, undefined, true, 'slack');
const colleague = skill.getSystemPromptSection(profile, undefined, false, 'slack');
const email = skill.getSystemPromptSection(profile, undefined, true, 'email');
let passed = 0, failed = 0;
function check(id, fn) { try { fn(); passed++; console.log(`ok ${id}`); } catch (e) { failed++; console.log(`not ok ${id}: ${e.message}`); } }
check('CANCEL-R01 explicit owner cancellation is authorization', () => {
  assert.match(tool('delete_meeting').description, /unambiguous owner instruction.*confirmation/i);
  assert.doesNotMatch(owner, /always confirm with the owner first for destructive ops/);
});
check('CANCEL-R02 description distinguishes decline and occurrence', () => {
  assert.match(tool('delete_meeting').description, /one occurrence/i);
  assert.doesNotMatch(tool('delete_meeting').description, /permanently delete/);
});
check('ROUTE-R01 explicit move time does not require a new search', () => {
  const paragraph = owner.split('RESCHEDULES →')[1].split('\n\n')[0];
  assert.match(paragraph, /when a new time is needed/i);
  assert.doesNotMatch(paragraph, /always route through the slot finder/);
});
check('OUTCOME-R01 success rule accepts real move update delete payloads', () => {
  const paragraph = owner.split('MEETINGS HONESTY')[1].split('\n\n')[1];
  assert.doesNotMatch(paragraph, /with an event id/i);
  assert.match(paragraph, /returned success THIS turn/);
  assert.match(paragraph, /action_summary|cancelled_label/);
});
check('CANCEL-P01 ambiguous targets still require selection', () => { assert.match(owner, /If multiple matches → list them numbered, ask which one/); assert.match(owner, /If zero matches → say so plainly/); });
check('CANCEL-P02 truthful successful occurrence-only notification', () => { assert.match(owner, /one line per SUCCESSFUL call's `cancelled_label`/); assert.match(owner, /`notified_via` is the only truth/); assert.match(owner, /event_not_found/); });
check('ROUTE-P01 unknown-time and colleague-rule approval remain', () => { assert.match(tool('move_meeting').description, /names NO new time[^\n]+find_available_slots/); assert.match(tool('move_meeting').description, /create_approval\(kind=policy_exception\)/); });
check('ROUTE-P02 hypothetical checks still search', () => assert.match(owner, /HYPOTHETICAL VALIDATION[^]+find_available_slots[^]+NARROW window/));
check('OUTCOME-P01 failures and aggregate success remain qualified', () => { assert.match(owner, /On failure, name what happened/); assert.match(owner, /every individual mutation must have returned success/); assert.match(owner, /Don't summarize unresolved as resolved/); });
check('SURFACE-P01 email excludes destructive operation guidance', () => { assert.doesNotMatch(email, /DELETE-MEETING PROTOCOL/); assert.doesNotMatch(email, /move_meeting \/ update_meeting \/ delete_meeting —/); });
check('SURFACE-P02 colleague and room role retain scoped rendering', () => { assert.match(colleague, /SCHEDULE IS PRIVATE/); assert.match(colleague, /MEETINGS HONESTY/); });
console.log('METRICS '+JSON.stringify({ownerPromptChars:owner.length,colleaguePromptChars:colleague.length,emailPromptChars:email.length,toolJsonChars:JSON.stringify(tools).length,deleteDescriptionChars:tool('delete_meeting').description.length,tokenCounts:'unavailable; no character/token estimate used'}));
console.log(`${passed} passed; ${failed} failed`); process.exitCode=failed?1:0;
