// Actual AssistantSkill and complete morning-brief module with isolated boundaries.
// --revision=3f2f17e selects the preserved pre-audit modules, never production.
const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('typescript'), { DateTime } = require('luxon');
const root = path.resolve(__dirname, '..');
const revision = process.argv.find(a => a.startsWith('--revision='))?.split('=')[1];
const compiled = new Map(), pending = [];
const profile = { user: { slack_user_id: 'UOWNER', name: 'Owner Example', email: 'owner@example.test', timezone: 'UTC', language: 'en' }, assistant: { name: 'Maelle' }, skills: { news: false, calendar: false } };
function loader(mocks, actual) {
  const unexpected = [], modules = new Map(); pending.push(unexpected);
  function load(relative) {
    if (Object.hasOwn(mocks, relative)) return mocks[relative];
    if (modules.has(relative)) return modules.get(relative).exports;
    if (!actual.includes(relative)) { unexpected.push(relative); throw new Error(`Blocked module ${relative}`); }
    if (!compiled.has(relative)) {
      const source = revision ? execFileSync('git', ['show', `${revision}:${relative}`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, relative), 'utf8');
      compiled.set(relative, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
    }
    const mod = { exports: {} }; modules.set(relative, mod);
    const req = spec => {
      if (spec === 'luxon') return { DateTime };
      if (!spec.startsWith('.')) { unexpected.push(spec); throw new Error(`Blocked external ${spec}`); }
      return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), spec)) + '.ts');
    };
    vm.runInNewContext(`(function(require,module,exports){${compiled.get(relative)}\n})`, { Date, Set, Map, Intl, setTimeout: () => ({ unref() {} }) }, { filename: relative })(req, mod, mod.exports);
    return mod.exports;
  }
  return load;
}
afterEach(() => { for (const unexpected of pending.splice(0)) assert.deepEqual(unexpected, [], 'no unexpected dependency hidden by production catches'); });
const logger = { __esModule: true, default: { info() {}, warn() {}, error() {}, debug() {} } };
function person(options = {}) {
  const effects = { email: [], core: [], profile: [] };
  const target = { personId: 'person-1', slackId: options.external ? null : 'UPERSON', name: 'Person Example' };
  const core = (...args) => { effects.core.push(args); return options.refuseTimezone ? 'refused_lower_authority' : 'applied'; };
  const db = {
    upsertPersonMemory() {}, updatePersonProfile: (...args) => effects.profile.push(args), updatePersonProfileById: (...args) => effects.profile.push(args),
    setPersonEmail: (...args) => { effects.email.push(args); return { personId: options.conflict ? null : options.survivor || target.personId, outcome: options.conflict ? 'identity_conflict' : options.emailOutcome || 'applied' }; },
    setCoreFieldWithProvenance: core, setCoreFieldWithProvenanceById: core,
    getPersonMemory: () => ({ name: target.name, email: 'person@example.test' }),
  };
  const load = loader({
    'src/db.ts': db, 'src/connections/registry.ts': {}, 'src/memory/peopleMemory.ts': {},
    'src/utils/skillPreferences.ts': {}, 'src/utils/resolveSlackId.ts': { SLACK_ID_RE: /^U[A-Z0-9]+$/ },
    'src/memory/resolveAttendeeEmails.ts': { nameGenuinelyMatches: () => false },
    'src/utils/workingHoursDefault.ts': { refreshAutoWorkingHours() {}, refreshAutoWorkingHoursById() {} },
    'src/utils/logger.ts': logger, 'src/utils/resolvePersonTarget.ts': { resolvePersonTarget: () => target },
    'src/utils/timezoneValidator.ts': { isStrictIana: () => true },
  }, ['src/core/assistant.ts']);
  const skill = new (load('src/core/assistant.ts').AssistantSkill)();
  return { effects, run: (args = {}, context = {}) => skill.executeToolCall('update_person_profile', {
    colleague_slack_id: 'UPERSON', colleague_name: 'Person Example', email: 'new@example.test', ...args,
  }, { profile, senderRole: 'owner', authority: 'owner', surface: 'owner_dm', userId: 'UOWNER', ...context }) };
}
for (const external of [false, true]) for (const mixed of [false, true]) test(`LA-profile-${external ? 'external' : 'internal'}-${mixed ? 'partial' : 'email'}: conflict is structured without erasing other writes`, async () => {
  const h = person({ external, conflict: true });
  const result = await h.run(mixed ? { timezone: 'Europe/London', language_preference: 'he' } : {});
  assert.equal(result.updated, true); assert.ok(result.not_saved?.includes('email'));
  assert.match(result._note, /email NOT saved/);
  if (mixed) { assert.equal(h.effects.core.length, 1); assert.equal(h.effects.profile[0][1].language_preference, 'he'); }
});
test('LA-profile-merged-refusals: identity conflict preserves authority refusal too', async () => {
  const result = await person({ conflict: true, refuseTimezone: true }).run({ timezone: 'Europe/London' });
  assert.deepEqual(Array.from(result.not_saved).sort(), ['email', 'timezone']);
});
for (const surface of ['colleague_dm', 'room']) test(`LA-profile-${surface}: self conflict remains structured at person authority`, async () => {
  const h = person({ conflict: true }); const result = await h.run({}, { userId: 'UPERSON', senderRole: 'colleague', authority: 'colleague', surface });
  assert.ok(result.not_saved?.includes('email')); assert.equal(h.effects.email[0][2].by, 'person');
});
for (const external of [false, true]) for (const emailOutcome of ['applied', 'already_set', 'refused_lower_authority']) test(`LA-profile-${external ? 'external' : 'internal'}-${emailOutcome}: existing structured result preserved`, async () => {
  const h = person({ external, emailOutcome }); const result = await h.run();
  assert.equal(result.updated, true);
  assert.equal(result.not_saved?.includes('email') || false, emailOutcome === 'refused_lower_authority');
  assert.equal(result.already_set?.includes('email') || false, emailOutcome === 'already_set');
});
test('LA-profile-survivor: merged external identity retains survivor for other writes', async () => {
  const h = person({ external: true, survivor: 'survivor-1' }); await h.run({ timezone: 'Europe/London' });
  assert.equal(h.effects.core[0][0], 'survivor-1'); assert.equal(h.effects.profile[0][0], 'survivor-1');
});
test('LA-profile-other-person: colleague refusal still makes no writes', async () => {
  const h = person(); const result = await h.run({}, { senderRole: 'colleague', userId: 'UOTHER' });
  assert.equal(result.updated, false); assert.equal(h.effects.email.length + h.effects.core.length + h.effects.profile.length, 0);
});
function brief(options = {}) {
  const effects = { posts: [], history: [], events: [], seen: 0, newsSeen: 0, surfaced: 0, closures: 0, logs: [] };
  let row = { id: 'req_brief_1', owner_user_id: 'UOWNER', kind: 'approval', subkind: 'unknown_person', state: 'awaiting_owner', surfaced_count: 2, subject: 'Contact review', requester_slack_id: null, details_json: '{}' };
  const db = { prepare: () => ({ get: () => options.alreadySent ? { id: 1 } : undefined, all: () => [] }) };
  const conn = { postToChannel: async (...args) => { effects.posts.push(args); if (options.sendThrows) throw new Error('isolated send exception'); return options.sendFails ? { ok: false, reason: 'isolated refusal' } : { ok: true, ts: 'brief.1' }; } };
  const load = loader({
    'src/db.ts': { getDb: () => db, getPreferences: () => [], markEventsSeen: () => effects.seen++, logEvent: e => { if(options.eventThrows) throw new Error('bookkeeping unavailable'); effects.events.push(e); }, appendToConversation: (...args) => { if(options.historyThrows) throw new Error('history unavailable'); effects.history.push(args); } },
    'src/db/requests.ts': { getRequestsForBrief: () => [row], todayStartUtcIso: () => '2026-09-11T00:00:00Z', markRequestSurfaced: () => effects.surfaced++, getRequest: () => row },
    'src/core/requests/closeRequest.ts': { closeRequest: () => { effects.closures++; row = { ...row, state: 'cancelled' }; return { ok: true }; } },
    'src/core/requests/requesterRelay.ts': {}, 'src/db/people.ts': { getPersonByEmail: () => undefined },
    'src/core/requests/resolver.ts': { withRequestLock: (_id, work) => work() },
    'src/connections/registry.ts': { getConnection: () => options.noConnection ? null : conn },
    'src/connectors/graph/calendar.ts': { getCalendarEvents: async () => [] },
    'src/utils/skillPreferences.ts': { formatSkillPreferencesBlock: () => '' },
    'src/skills/news.ts': { formatSeenLogBlock: () => '', NEWS_PER_GOAL_TIMEOUT_MS: 1, gatherNews: async () => ({ sources: [{ url: 'https://example.test/news', title: 'Fixture news' }] }), writeSeenLog: async () => effects.newsSeen++ },
    'src/skills/meetings/ops.ts': {}, 'src/utils/verifyScheduledOutcome.ts': {},
    'src/utils/logger.ts': { __esModule: true, default: Object.fromEntries(['info','warn','error'].map(l => [l, (...args) => effects.logs.push([l,...args])])) },
    'src/utils/calendarListingFormat.ts': { calendarListingFormatRule: () => '' },
    'src/utils/cleanupVanishedMeetingArtifacts.ts': { cleanupVanishedMeetingArtifacts: async () => {} },
    'src/db/slotHolds.ts': { getActiveSlotHolds: () => [], getRecentlyFulfilledHolds: () => [] },
    'src/utils/humanGate.ts': { runHumanGate: async () => ({ ok: true }) },
    'src/llm/client.ts': { getAnthropicClient: () => ({ messages: { create: async () => { if(options.composeThrows) throw new Error('composer unavailable'); return { content: [{ type:'text', text:'Review your pending ask.' }] }; } } }) },
    'src/llm/models.ts': { SONNET: {} },
  }, ['src/tasks/briefs.ts', 'src/core/requests/types.ts']);
  const briefProfile = { ...profile, skills: { ...profile.skills, news: !!options.news } };
  return { effects, row: () => row, run: (force = true, thread) => load('src/tasks/briefs.ts').sendMorningBriefing({}, briefProfile, 'DOWNER', force, thread) };
}
for (const [label, options] of [['no-connection',{noConnection:true}],['send-refusal',{sendFails:true}],['send-throws',{sendThrows:true}]]) test(`LA-brief-${label}: failure does not mark delivered or close unseen requests`, async () => {
  const h = brief(options); await assert.rejects(h.run());
  assert.equal(h.effects.events.length + h.effects.seen + h.effects.surfaced + h.effects.closures + h.effects.history.length, 0);
  assert.equal(h.row().state, 'awaiting_owner');
});
for (const [label,options] of [['history',{historyThrows:true}],['bookkeeping',{eventThrows:true}]]) test(`LA-brief-${label}: failure after confirmed delivery does not report unsent`, async () => {
  const h = brief(options); await h.run(); assert.equal(h.effects.posts.length,1);
  assert.ok(h.effects.logs.some(([level,message])=>level==='warn'&&message.includes('delivered but')));
});
for (const [label, force, thread] of [['requested',true,'brief.thread'],['scheduled',false,undefined]]) test(`LA-brief-${label}: confirmed send preserves history and lifecycle`, async () => {
  const h = brief(); await h.run(force,thread);
  assert.equal(h.effects.posts.length,1); assert.equal(h.effects.events.length,1); assert.equal(h.effects.seen,1);
  assert.equal(h.effects.surfaced,1); assert.equal(h.effects.closures,1); assert.equal(h.effects.history.length,1);
  assert.equal(h.effects.posts[0][2].threadTs,thread); assert.equal(h.effects.history[0][0],thread || 'brief.1');
});
for (const sendFails of [false,true]) test(`LA-brief-news-${sendFails ? 'failed' : 'delivered'}: seen log follows actual delivery`,async()=>{
  const h=brief({news:true,sendFails});
  if(sendFails) await assert.rejects(h.run()); else await h.run();
  assert.equal(h.effects.newsSeen,sendFails?0:1);
});
test('LA-brief-dedup: existing scheduled delivery remains a no-op',async()=>{
  const h=brief({alreadySent:true}); await h.run(false); assert.equal(h.effects.posts.length+h.effects.events.length+h.effects.closures,0);
});
