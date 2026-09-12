// Actual find_slack_user (src/connections/slack/index.ts) and processMessage
// (src/connectors/slack/app/processMessage.ts) against the actual people store
// (src/db/people.ts) on in-memory SQLite. Slack client, logger and every other
// neighbour are fixtures; no model, network or production DB is touched.
// SLACK_DIRECTORY_BEFORE=1 replays the two lane files from the baseline commit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const ts = require('typescript');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const baseline = 'edd243330307d5dd025e8dc4f7770da24aab16c3';
const before = process.env.SLACK_DIRECTORY_BEFORE === '1';
const presenceBefore = process.env.SLACK_OWNER_PRESENCE_BEFORE === '1';
const laneFiles = new Set(['src/connections/slack/index.ts', 'src/connectors/slack/app/processMessage.ts']);
const actual = new Set([...laneFiles, 'src/db/people.ts']);
const compiled = new Map();
const OWNER = 'UOWNER001', COLLEAGUE = 'UCOLL0001', OLD = '2026-01-01 00:00:00';
const OWNER_PROFILE = {
  user: { name: 'Idan Owner', slack_user_id: OWNER, email: 'idan@example.com', timezone: 'Asia/Jerusalem' },
  assistant: { name: 'Maelle', slack: { bot_token: 'xoxb-fixture' } }, skills: {}, advanced: {},
};
const MEMBERS = [
  { id: 'UPAUL0001', real_name: 'Paul Fixture', name: 'paul', tz: 'Europe/London', profile: { email: 'paul@example.com', display_name: 'Paul', image_72: 'https://img/paul' } },
  { id: 'UPAUL0002', real_name: 'Paula Fixture', name: 'paula', profile: { email: 'paula@example.com' } },
  { id: 'UPAUL0003', real_name: 'Pauline Fixture', name: 'pauline', tz: 'America/New_York', profile: { email: 'pauline@example.com' } },
  { id: 'UPAULBOT1', real_name: 'Paulbot', name: 'paulbot', is_bot: true, profile: {} },
  { id: 'UPAULGONE', real_name: 'Paul Gone', name: 'paulgone', deleted: true, profile: {} },
  { id: 'UOTHER001', real_name: 'Other Person', name: 'other', profile: { email: 'other@example.com' } },
];
const memoryPaul = { person_id: 'p_UPAUL0001', slack_id: 'UPAUL0001', name: 'Paul Fixture', email: 'paul@example.com', kind: 'internal', source: 'slack', timezone: 'Europe/London', timezone_set_by: 'auto', state: 'London', last_seen: '2026-09-01 00:00:00' };
const IDENTITY = ['name', 'slack_id'];
const keys = o => Object.keys(o).filter(k => o[k] !== undefined).sort();
// Objects built inside the vm sandbox carry that realm's prototypes; strict deep
// equality compares prototypes, so cross-realm shapes are compared as plain data.
const plain = x => JSON.parse(JSON.stringify(x));

function compile(rel) {
  if (!compiled.has(rel)) {
    const source = presenceBefore && rel === 'src/connectors/slack/app/processMessage.ts'
      ? fs.readFileSync(path.join(root, 'artifacts/workshop-verification/person-memory-completion-20260912/slackmaster-attempt-2/before-processMessage.txt'), 'utf8')
      : before && laneFiles.has(rel)
      ? cp.execFileSync('git', ['show', `${baseline}:${rel}`], { cwd: root, encoding: 'utf8' })
      : fs.readFileSync(path.join(root, rel), 'utf8');
    compiled.set(rel, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
  }
  return compiled.get(rel);
}

function harness(options = {}) {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE people_memory(
    person_id TEXT PRIMARY KEY, slack_id TEXT UNIQUE, name TEXT, email TEXT, kind TEXT, source TEXT,
    timezone TEXT, timezone_set_by TEXT, timezone_temp TEXT, state TEXT, state_set_by TEXT,
    name_set_by TEXT, name_he TEXT, name_he_set_by TEXT, email_set_by TEXT,
    gender TEXT NOT NULL DEFAULT 'unknown', gender_set_by TEXT, gender_confirmed INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '[]', profile_json TEXT NOT NULL DEFAULT '{}', interaction_log TEXT NOT NULL DEFAULT '[]',
    social_topics TEXT NOT NULL DEFAULT '[]', working_hours_auto TEXT, currently_traveling TEXT,
    is_vip INTEGER NOT NULL DEFAULT 0, engagement_rank INTEGER NOT NULL DEFAULT 2, proactive_pending INTEGER NOT NULL DEFAULT 0,
    last_inbound_lang TEXT, last_inbound_lang_at TEXT, last_social_at TEXT, last_initiated_at TEXT, last_social_capture_unknown_at TEXT,
    last_seen TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const insert = row => sqlite.prepare(`INSERT INTO people_memory(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(k => '@' + k).join(',')})`).run(row);
  // The owner row as ownerSelf.ts seeds it — owner-authored config at 'owner' rank — last seen long ago.
  insert({ person_id: `p_${OWNER}`, slack_id: OWNER, name: 'Idan Owner', name_set_by: 'owner', email: 'idan@example.com', kind: 'internal', source: 'slack', timezone: 'Asia/Jerusalem', timezone_set_by: 'owner', last_seen: OLD });
  for (const row of options.rows ?? []) insert(row);

  const state = { dbDownOnce: !!options.dbDownOnce };
  const logs = [], genderCalls = [], slackCalls = [], enqueued = [], unexpected = [], modules = new Map();
  const noop = () => {};
  const logger = { __esModule: true, default: Object.fromEntries(['info', 'warn', 'error', 'debug'].map(k => [k, (...a) => logs.push([k, ...a])])) };
  const users = {
    list: async params => {
      slackCalls.push(['users.list', params]);
      if (options.slackDown || (options.partialSlackFailure && params.cursor)) throw Error('users_list_unavailable');
      return { members: MEMBERS, response_metadata: options.partialSlackFailure ? { next_cursor: 'fixture-next-page' } : {} };
    },
    info: async ({ user }) => {
      slackCalls.push(['users.info', user]);
      return { user: MEMBERS.find(x => x.id === user) ?? { id: user, real_name: 'Paul Colleague', tz: 'Europe/London', profile: { email: 'colleague@example.com' } } };
    },
  };
  const app = { client: { users, reactions: { add: async () => ({}) }, conversations: { replies: async () => ({ messages: [] }) } } };
  const mocks = {
    'src/db/client.ts': { getDb: () => { if (state.dbDownOnce) { state.dbDownOnce = false; throw Error('people store unavailable'); } return sqlite; } },
    'src/utils/logger.ts': logger,
    'src/db/socialSubjects.ts': { getActiveSubjectsForPerson: () => [], getRecentTopicBeats: () => [] },
    'src/db/engagementRank.ts': { isCurrentRankOwnerAuthored: () => false },
    'src/utils/locationTz.ts': { inferTimezoneFromStateStatic: () => null },
    'src/utils/workingHoursDefault.ts': { refreshAutoWorkingHoursById: noop, getEffectiveWorkingHours: () => null, formatWorkingHoursWindow: () => '' },
    'src/utils/timezoneValidator.ts': { isStrictIana: () => true },
    'src/memory/peopleMemory.ts': { mergePersonMdFiles: noop },
    // Name binding belongs to the identity harness. These Slack search and
    // keyed presence paths must never invoke it; fail loudly if that changes.
    'src/memory/resolveAttendeeEmails.ts': { nameGenuinelyMatches: () => { throw Error('Unexpected name binding in Slack directory fixture'); } },
    'src/connections/slack/messaging.ts': {},
    'src/connections/slack/formatting.ts': { formatForSlack: t => t },
    'src/utils/genderDetect.ts': { detectAndSaveGender: p => { genderCalls.push(p); return Promise.resolve(); } },
    'src/core/orchestrator/index.ts': { runOrchestrator: async () => ({ reply: '' }) },
    'src/core/briefIntent.ts': { isBriefRequest: async () => false },
    'src/tasks/briefs.ts': { sendMorningBriefing: async () => {} },
    'src/connectors/slack/coordinator.ts': { handleOutreachReply: async () => ({ handled: false }), closeOutreachReplyIfResolvedThisTurn: async () => {} },
    'src/vision/index.ts': { describeImage: async () => null, downloadSlackImage: async () => ({ error: 'fixture' }), buildImageBlock: () => ({}) },
    'src/connectors/slack/app/helpers.ts': { failureReply: () => 'failure' },
    'src/connectors/slack/socketWatermark.ts': { stampSocketAlive: noop },
    'src/connectors/slack/inboundQueue.ts': { enqueueMessage: p => enqueued.push(p), isMergeAbort: () => false },
  };
  const resolve = target => [target + '.ts', target + '/index.ts'].find(c => Object.hasOwn(mocks, c) || actual.has(c) || c === 'src/db/index.ts') ?? target + '.ts';
  function load(rel) {
    if (rel === 'src/db/index.ts') return { ...load('src/db/people.ts'), getConversationHistory: () => [], appendToConversation: noop, auditLog: noop, logEvent: noop, getSummarySessionByThread: () => null };
    if (Object.hasOwn(mocks, rel)) return mocks[rel];
    if (modules.has(rel)) return modules.get(rel).exports;
    if (!actual.has(rel)) { unexpected.push(rel); throw Error(`Forbidden dependency ${rel}`); }
    const mod = { exports: {} };
    modules.set(rel, mod);
    const req = s => s.startsWith('.') ? load(resolve(path.posix.normalize(path.posix.join(path.posix.dirname(rel), s)))) : require(s);
    vm.runInNewContext('(function(require,module,exports){' + compile(rel) + '\n})', { console, process, Set, Map, Buffer, Date, setTimeout, setImmediate, Promise, Error }, { filename: rel })(req, mod, mod.exports);
    return mod.exports;
  }
  const conn = () => load('src/connections/slack/index.ts').createSlackConnection(app, 'xoxb-fixture', OWNER_PROFILE);
  const find = (name, scope) => scope === undefined
    ? conn().executeToolCall('find_slack_user', { name })
    : conn().executeToolCall('find_slack_user', { name }, scope);
  const ctx = { app, profile: OWNER_PROFILE, botUserId: 'UMAELLE01', getSenderRole: id => id === OWNER ? 'owner' : 'colleague', resolveSlackMentions: async t => t };
  const turn = (overrides = {}) => load('src/connectors/slack/app/processMessage.ts').processMessage(ctx, {
    senderId: OWNER, text: 'hello', channelId: 'DOWNER', ts: '1.1', threadTs: '1.1', say: async () => ({}), client: app.client, isChannel: false, isMpim: false, ...overrides,
  });
  const person = id => sqlite.prepare('SELECT * FROM people_memory WHERE slack_id = ?').get(id);
  const people = () => sqlite.prepare('SELECT slack_id FROM people_memory ORDER BY slack_id').all().map(r => r.slack_id);
  const search = q => load('src/db/people.ts').searchPeopleMemoryEitherDirection(q);
  return { load, find, turn, person, people, search, sqlite, logs, genderCalls, slackCalls, enqueued, unexpected };
}

// ── S1 · surface-scoped payload ──────────────────────────────────────────────
test('regression: room surface returns identity only from the Slack directory', async () => {
  const h = harness();
  const r = await h.find('paul', { surface: 'room' });
  assert.equal(r.count, 3);
  for (const m of r.matches) assert.deepEqual(keys(m), IDENTITY);
  assert.deepEqual(h.unexpected, []);
});
test('regression: room surface returns identity only from the people_memory pull-through', async () => {
  const h = harness({ rows: [memoryPaul] });
  const r = await h.find('paul', { surface: 'room' });
  assert.equal(r.count, 1);
  assert.deepEqual(keys(r.matches[0]), IDENTITY);
  assert.equal(r.matches[0].slack_id, 'UPAUL0001');
  assert.equal(h.slackCalls.length, 0);
});
test('regression: a call carrying no surface fails closed to identity only', async () => {
  const h = harness({ rows: [memoryPaul] });
  const r = await h.find('paul');
  assert.deepEqual(keys(r.matches[0]), IDENTITY);
});
test('preserved: owner DM surface keeps timezone, city and email', async () => {
  const h = harness({ rows: [memoryPaul] });
  const r = await h.find('paul', { surface: 'owner_dm' });
  assert.equal(r.source, 'people_memory');
  assert.deepEqual(plain(r.matches[0]), { slack_id: 'UPAUL0001', name: 'Paul Fixture', tz_iana: 'Europe/London', tz_note: 'Guessed, not confirmed — confirm before presenting their local time as fact.', state: 'London', email: 'paul@example.com' });
});
test('preserved: colleague DM surface keeps today\'s third-party shape', async () => {
  const h = harness({ rows: [memoryPaul] });
  const r = await h.find('paul', { surface: 'colleague_dm' });
  assert.equal(r.matches[0].tz_iana, 'Europe/London');
  assert.equal(r.matches[0].state, 'London');
  assert.equal(r.matches[0].email, 'paul@example.com');
});
test('preserved: Slack directory hit in a DM carries tz note and email, no city', async () => {
  const h = harness();
  const r = await h.find('paul', { surface: 'owner_dm' });
  const paul = r.matches.find(m => m.slack_id === 'UPAUL0001');
  assert.equal(paul.tz_iana, 'Europe/London');
  assert.match(paul.tz_note, /City not on file/);
  assert.equal(paul.email, 'paul@example.com');
  assert.equal(paul.state, undefined);
  const paula = r.matches.find(m => m.slack_id === 'UPAUL0002');
  assert.equal(paula.tz_iana, undefined);
  assert.match(paula.tz_note, /No timezone on file/);
  assert.equal(r.source, undefined);
});
test('preserved: deleted and bot members never match', async () => {
  const h = harness();
  const r = await h.find('paul', { surface: 'owner_dm' });
  assert.deepEqual(plain(r.matches.map(m => m.slack_id).sort()), ['UPAUL0001', 'UPAUL0002', 'UPAUL0003']);
});
test('preserved: a memory row without a slack id never surfaces; the directory is consulted', async () => {
  const h = harness({ rows: [{ person_id: 'p_ext', slack_id: null, name: 'Paul External', email: 'paul@other.com', kind: 'external', source: 'calendar' }] });
  const r = await h.find('paul', { surface: 'owner_dm' });
  assert.equal(r.source, undefined);
  assert.equal(r.count, 3);
});
for (const scope of [{ surface: 'room' }, { surface: 'owner_dm' }]) test(`preserved: external email query returns the external signal (${scope.surface})`, async () => {
  const h = harness();
  const r = await h.find('someone@other.com', scope);
  assert.equal(r.external, true);
  assert.equal(r.count, 0);
  assert.equal(r.email, 'someone@other.com');
});
test('preserved: people store unavailable falls through to the Slack directory', async () => {
  const h = harness({ dbDownOnce: true });
  const r = await h.find('paul', { surface: 'room' });
  assert.equal(r.count, 3);
  assert.ok(h.logs.some(l => l[0] === 'warn' && /people_memory lookup threw/.test(l[1])));
});
test('preserved: Slack directory failure returns an error payload, not a partial match', async () => {
  const h = harness({ slackDown: true });
  const r = await h.find('paul', { surface: 'owner_dm' });
  assert.ok(r.error);
  assert.equal(r.matches, undefined);
});
test('preserved: a failed later Slack page returns no partial results or persisted contacts', async () => {
  const h = harness({ partialSlackFailure: true });
  const r = await h.find('paul', { surface: 'colleague_dm' });
  assert.ok(r.error);
  assert.equal(r.matches, undefined);
  assert.equal(h.slackCalls.length, 2);
  assert.deepEqual(h.people(), [OWNER]);
});

// ── S2 · search persists nothing ─────────────────────────────────────────────
test('regression: directory search persists no unengaged match and detects no gender', async () => {
  const h = harness();
  const r = await h.find('paul', { surface: 'owner_dm' });
  assert.equal(r.count, 3);
  assert.deepEqual(h.people(), [OWNER]);
  assert.equal(h.genderCalls.length, 0);
});
test('regression: searched people do not displace an engaged contact in last_seen order', async () => {
  const h = harness({ rows: [{ person_id: 'p_UENGAGED1', slack_id: 'UENGAGED1', name: 'Dana Engaged', kind: 'internal', source: 'slack', last_seen: '2026-09-05 00:00:00' }] });
  await h.find('paul', { surface: 'owner_dm' });
  assert.equal(h.sqlite.prepare("SELECT slack_id FROM people_memory WHERE kind != 'self' ORDER BY last_seen DESC LIMIT 1").get().slack_id, 'UENGAGED1');
});
test('regression: repeated directory searches remain reads across every surface', async () => {
  const h = harness();
  for (const surface of ['owner_dm', 'colleague_dm', 'room']) {
    const r = await h.find('paul', { surface });
    assert.equal(r.count, 3);
  }
  assert.deepEqual(h.people(), [OWNER]);
  assert.equal(h.person(OWNER).last_seen, OLD);
  assert.equal(h.genderCalls.length, 0);
});
test('preserved: colleague turn stamps the colleague row and never the owner', async () => {
  const h = harness();
  await h.turn({ senderId: COLLEAGUE, channelId: 'DCOLL' });
  assert.equal(h.enqueued.length, 1);
  const col = h.person(COLLEAGUE);
  assert.ok(col && col.last_seen > OLD);
  assert.equal(col.name, 'Paul Colleague');
  assert.equal(col.timezone, 'Europe/London');
  assert.equal(h.person(OWNER).last_seen, OLD);
  assert.deepEqual(h.unexpected, []);
});

// ── S3 · owner presence stamp ────────────────────────────────────────────────
test('regression: owner DM turn stamps the owner last_seen', async () => {
  const h = harness();
  await h.turn();
  assert.equal(h.enqueued.length, 1);
  assert.ok(h.person(OWNER).last_seen > OLD, h.person(OWNER).last_seen);
  assert.deepEqual(h.unexpected, []);
});
test('regression: owner room turn stamps the owner last_seen', async () => {
  const h = harness();
  await h.turn({ channelId: 'CROOM', isChannel: true, isExplicitMention: true });
  assert.equal(h.enqueued.length, 1);
  assert.ok(h.person(OWNER).last_seen > OLD);
});
test('regression: owner MPIM turn stamps presence while retaining room scope', async () => {
  const h = harness();
  await h.turn({ channelId: 'GROOM', isMpim: true, isExplicitMention: true });
  assert.equal(h.enqueued.length, 1);
  assert.ok(h.person(OWNER).last_seen > OLD);
  const roleLog = h.logs.find(l => l[1] === 'processMessage — role determined')[2];
  assert.equal(roleLog.authority, 'owner');
  assert.equal(roleLog.surface, 'room');
  assert.equal(roleLog.effectiveRole, 'colleague');
  assert.equal(h.slackCalls.filter(c => c[0] === 'users.info').length, 0);
});
test('regression: unavailable owner presence write does not block delivery and a later turn retries', async () => {
  const h = harness({ dbDownOnce: true });
  await h.turn();
  assert.equal(h.enqueued.length, 1);
  assert.equal(h.person(OWNER).last_seen, OLD);
  assert.ok(h.logs.some(l => l[0] === 'warn' && l[1] === 'owner last_seen stamp failed — continuing'));
  await h.turn({ ts: '2.1', threadTs: '2.1' });
  assert.equal(h.enqueued.length, 2);
  assert.ok(h.person(OWNER).last_seen > OLD);
  assert.deepEqual(h.people(), [OWNER]);
});
test('regression: bare first-name lookup ranks the owner above a colleague seen more recently', async () => {
  const h = harness({ rows: [{ person_id: 'p_UIDANLEVI', slack_id: 'UIDANLEVI', name: 'Idan Levi', kind: 'internal', source: 'slack', last_seen: '2026-09-11 00:00:00' }] });
  await h.turn();
  assert.equal(h.search('idan')[0].slack_id, OWNER);
});
test('preserved: owner turn makes no Slack profile read and keeps owner-authored identity', async () => {
  const h = harness();
  await h.turn();
  assert.equal(h.slackCalls.filter(c => c[0] === 'users.info').length, 0);
  const o = h.person(OWNER);
  assert.equal(o.name, 'Idan Owner'); assert.equal(o.name_set_by, 'owner');
  assert.equal(o.timezone, 'Asia/Jerusalem'); assert.equal(o.timezone_set_by, 'owner');
  assert.equal(o.email, 'idan@example.com');
});
test('preserved: owner turn still reaches the inbound queue with the owner text', async () => {
  const h = harness();
  await h.turn({ text: 'book me 25 mins' });
  assert.equal(h.enqueued[0].text, 'book me 25 mins');
  assert.equal(h.enqueued[0].senderId, OWNER);
});

for (const [surface, turn] of [
  ['DM', {}],
  ['channel', { channelId: 'CROOM', isChannel: true, isExplicitMention: true }],
  ['MPIM', { channelId: 'GROOM', isMpim: true, isExplicitMention: true }],
]) {
  test(`repair regression: owner ${surface} presence preserves an accepted name correction`, async () => {
    const h = harness();
    const store = h.load('src/db/people.ts');
    assert.equal(store.setCoreFieldWithProvenance(OWNER, 'name', 'Yoni Owner', 'owner'), 'applied');
    await h.turn(turn);
    assert.equal(h.person(OWNER).name, 'Yoni Owner');
    assert.equal(h.person(OWNER).name_set_by, 'owner');
    assert.ok(h.person(OWNER).last_seen > OLD);
    assert.equal(h.enqueued.length, 1);
    assert.equal(h.slackCalls.filter(c => c[0] === 'users.info').length, 0);
  });
  test(`repair control: owner ${surface} presence creates a missing owner row`, async () => {
    const h = harness();
    h.sqlite.prepare('DELETE FROM people_memory WHERE slack_id = ?').run(OWNER);
    await h.turn(turn);
    assert.deepEqual(h.people(), [OWNER]);
    assert.equal(h.person(OWNER).name, 'Idan Owner');
    assert.equal(h.person(OWNER).name_set_by, 'owner');
    assert.ok(h.person(OWNER).last_seen > OLD);
    assert.equal(h.enqueued.length, 1);
  });
}
