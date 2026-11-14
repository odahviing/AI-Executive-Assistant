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
const timezoneModule = { exports: {} };
const timezoneJs = ts.transpileModule(fs.readFileSync(path.join(srcRoot, 'src/utils/timezoneConvert.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
vm.runInNewContext(`(function(require,module,exports){${timezoneJs}\n})`, {})(id => {
  assert.equal(id, 'luxon', `Unexpected timezone helper dependency ${id}`);
  return require('luxon');
}, timezoneModule, timezoneModule.exports);
const deps = {
  '../connectors/graph/calendar': {},
  './meetings/ops': { SchedulingSkill: class {} },
  './meetings/calendarOffline': {},
  '../utils/logger': { __esModule: true, default: { info: noop, warn: noop } },
  luxon: require('luxon'),
  '../utils/timezoneConvert': timezoneModule.exports,
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
console.log('capture lengths', JSON.stringify({ owner: owner.length, colleague: colleague.length, email: email.length, tools: JSON.stringify(tools).length }));
check('DURATION-R01 offers and recaps share the duration rendering rule', () => {
  for (const prompt of [owner, colleague, email]) {
    assert.ok(prompt.includes('offers and recaps') && prompt.includes('explain the preset only when asked'));
  }
});
check('DURATION-P01 exact and unstated duration inputs remain supported', () => {
  const schema = tool('find_available_slots').input_schema;
  assert.deepEqual(Array.from(schema.properties.duration_minutes.enum), [25,55]);
  assert.ok(!schema.required.includes('duration_minutes'));
  assert.match(schema.properties.duration_minutes.description, /exact allowed lengths stay exact/);
});
check('PAIR-R01 recaps distinguish tentative pairs from jointly checked plans', () => {
  for (const prompt of [owner, colleague, email]) {
    assert.ok(prompt.includes('separate searches') && prompt.includes('tentative combination') && prompt.includes('checked together'));
  }
});
check('PAIR-P01 direct booking of a picked individual offer remains supported', () => {
  for (const prompt of [owner, colleague, email]) assert.ok(prompt.includes('call create_meeting with that exact slot'));
});
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
check('OPTIONS-R01 configured count and returned diversity survive every prompt surface', () => {
  for (const prompt of [owner, colleague, email]) {
    assert.doesNotMatch(prompt, /returns up to 3 spread slots/);
    assert.match(prompt, /requested count or configured offered_slot_count/);
    assert.match(prompt, /Preserve the returned day\/time diversity and preference ranking/);
    assert.match(prompt, /brevity means compact lines, not fewer options or days/);
    assert.match(prompt, /If fewer viable choices remain, state the actual count/);
  }
});
check('OPTIONS-R02 legitimate narrowing is disclosed without broad availability claims', () => {
  for (const prompt of [owner, colleague, email]) {
    assert.match(prompt, /stated constraint or requested count requires presenting fewer returned choices, name that reason and the remaining count/);
    assert.match(prompt, /retaining their conflict, approval and unknown-availability annotations/);
    assert.match(prompt, /not the only availability overall/);
  }
});
check('CONDITION-R01 optional move argument distinguishes conditional, assumed-free and unconditional moves', () => {
  const schema = tool('move_meeting').input_schema;
  const flag = schema.properties.require_attendee_availability;
  assert.equal(flag?.type, 'boolean');
  assert.ok(!schema.required?.includes('require_attendee_availability'));
  assert.match(flag.description, /believes they are free/);
  assert.match(flag.description, /Busy or unconfirmed availability/);
  assert.match(flag.description, /unconditional move/);
});
check('EXCEPTION-R01 a new booking starts ordinary and a disclosed exception binds the specific action', () => {
  assert.match(owner, /Start a new booking with ordinary checks/);
  assert.match(owner, /authorized action, roster and slot/);
  assert.match(owner, /Picking an offer with a disclosed attendee conflict accepts it/);
  assert.doesNotMatch(owner, /DIRECTLY with relaxed:true/);
});
check('PACKING-R01 actual dense preference renders only on the owner path', () => {
  const dense = { ...profile, meetings: { ...profile.meetings, packing_preference: 'dense' } };
  const spread = { ...profile, meetings: { ...profile.meetings, packing_preference: 'spread' } };
  const render = (p, ownerRole) => skill.getSystemPromptSection(p, undefined, ownerRole, 'slack');
  assert.match(render(dense, true), /Dense calendar packing is on/);
  for (const prompt of [render(dense, false), render(spread, true), owner]) assert.doesNotMatch(prompt, /Dense calendar packing is on/);
});
check('CONFIRM-R01 ambiguous yes needs a specific choice and one identifiable proposal can proceed', () => {
  assert.match(owner, /A short yes accepts one identifiable proposal/);
  assert.match(owner, /two pending actions, ask which one before acting/);
});
check('CONFIRM-R02 print secondary and vacated clocks only in context', () => {
  assert.match(owner, /second clock when requested or when it explains a scheduling constraint/);
  assert.match(owner, /material conflicts, unknowns, side effects or details the requester asked for/);
  assert.match(owner, /labeled travel-day display/);
  assert.match(email, /Append the other party's zone once as a parenthetical only if relevant/);
  assert.match(tool('move_meeting').description, /when the freed slot matters to the request/);
});
check('CONFIRM-P01 partial outcomes, unchecked attendees and supplied duration changes stay explicit', () => {
  assert.match(owner, /Account for every event and confirmed time/);
  assert.match(owner, /Claim an attendee is free only when that slot's evidence confirms it/);
  assert.match(tool('move_meeting').input_schema.properties.new_end.description, /Set it ONLY when the duration is actually changing/);
});
check('COVERAGE-R01 joint search, move proposal and create preserve unknown calendar coverage', () => {
  for (const prompt of [owner, colleague]) {
    assert.ok(prompt.includes('An unreadable calendar stays unconfirmed'));
    assert.ok(prompt.includes('unchecked attendees for that candidate'));
    assert.ok(!prompt.includes('returns slots where everyone is free'));
  }
  assert.ok(tool('create_meeting').description.includes('per-attendee status'));
});
check('HOURS-R01 search distinguishes reported hours from assumptions and busy time', () => {
  assert.ok(tool('find_available_slots').description.includes('distinguish stated hours from an assumed window'));
});
check('INTEGRATION-P01 predecessor survives exact searches and booking, room venue and private role remain supported', () => {
  assert.ok(tool('find_available_slots').input_schema.properties.must_be_after_event_id);
  assert.ok(tool('create_meeting').input_schema.properties.must_be_after_event_id);
  assert.ok(tool('create_meeting').input_schema.properties.start_at_event_end_id);
  assert.ok(tool('update_meeting').input_schema.properties.location);
  assert.match(colleague, /SCHEDULE IS PRIVATE/);
});
console.log('METRICS '+JSON.stringify({ownerPromptChars:owner.length,colleaguePromptChars:colleague.length,emailPromptChars:email.length,toolJsonChars:JSON.stringify(tools).length,deleteDescriptionChars:tool('delete_meeting').description.length,tokenCounts:'unavailable; no character/token estimate used'}));
console.log(`${passed} passed; ${failed} failed`); process.exitCode=failed?1:0;
