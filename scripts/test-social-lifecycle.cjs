// Executes the real social skill, store, picker and engagement modules with an
// isolated in-memory SQLite database. No application startup or external calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Sqlite = require('better-sqlite3');
const root = path.resolve(__dirname, '..');
const profile = { user: { name: 'Owner', slack_user_id: 'U_OWNER', email: 'owner@example.com', timezone: 'UTC' }, assistant: { name: 'Maelle' } };
function harness({ captureFailure = false, profileFailure = false } = {}) {
  const db = new Sqlite(':memory:');
  const schema = fs.readFileSync(path.join(root, 'src/db/client.ts'), 'utf8');
  for (const table of ['social_categories', 'social_subjects', 'social_topics', 'social_person_category_scores', 'engagement_rank_log']) {
    const ddl = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n    \\);`));
    assert.ok(ddl, table); db.exec(ddl[0]);
  }
  db.exec(`CREATE TABLE people_memory (person_id TEXT PRIMARY KEY, slack_id TEXT UNIQUE, name TEXT, notes TEXT DEFAULT '[]', interaction_log TEXT DEFAULT '[]', profile_json TEXT DEFAULT '{}', engagement_rank INTEGER DEFAULT 2, last_social_at TEXT, last_initiated_at TEXT, last_social_capture_unknown_at TEXT, last_seen TEXT, updated_at TEXT)`);
  for (const id of ['U_OWNER', 'U_PERSON']) db.prepare('INSERT INTO people_memory(person_id,slack_id,name) VALUES (?,?,?)').run(id,id,id);
  const modules = new Map();
  const logs = [];
  let random = 0;
  const logger = { info: (...x) => logs.push(x), warn: (...x) => logs.push(x), error: (...x) => logs.push(x) };
  const capture = { marked: false, modelCalls: 0, failureMode: captureFailure?'all':profileFailure?'profile':'none', humanTs:String(Date.now()/1000) };
  const allowed = new Set(['src/memory/resolveAttendeeEmails.ts','src/skills/social.ts', 'src/db/people.ts', 'src/db/socialSubjects.ts', 'src/db/engagementRank.ts', 'src/core/social/stateMachine.ts', 'src/core/social/logEngagement.ts', 'src/memory/capturePass.ts', 'src/utils/extractJson.ts']);
  function load(rel) {
    if (modules.has(rel)) return modules.get(rel).exports;
    assert.ok(allowed.has(rel), `Unexpected module ${rel}`);
    const mod = { exports: {} }; modules.set(rel, mod);
    const sourceRoot = process.env.SOCIAL_LIFECYCLE_BEFORE_DIR || root;
    const file = path.join(sourceRoot, rel);
    const source = fs.readFileSync(fs.existsSync(file) ? file : path.join(root,rel), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const requireLocal = spec => {
      if (spec === 'luxon') return require('luxon');
      if (spec === 'crypto') return require('crypto');
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (resolved === 'src/db/client') return { getDb: () => db };
      if (resolved === 'src/utils/logger') return logger;
      if (resolved === 'src/db') return {...load('src/db/people.ts'),
        findThreadsReadyForCapture: () => capture.marked ? [] : [{thread_ts:'1.0',channel_id:'D_PERSON',captured_at:null}],
        markThreadCaptured: () => {capture.marked=true;},
        getConversationHistory: () => capture.noHuman ? [{role:'assistant',content:'How was the game?'}] : [{role:'assistant',content:'How was the game?'},{role:'user',content:'I loved that game and finished it today.',ts:capture.humanTs}],
      };
      if (resolved === 'src/connections/registry') return {getConnection:()=>({resolveChannelCounterpart:async()=> 'U_PERSON'})};
      if (resolved === 'src/memory/peopleMemory') return {readPersonMemory:async()=>'',writePersonSection:()=>assert.fail('unexpected memory write')};
      if (resolved === 'src/core/assistantSelf') return {selfSlackId:()=>assert.fail('unexpected self path')};
      if (resolved === 'src/config') return {config:{ANTHROPIC_API_KEY:'isolated-placeholder'}};
      if (resolved === 'src/llm/models') return {MODEL_HAIKU:'isolated-model'};
      if (resolved === 'src/llm/client') return {getAnthropicClient:()=>({messages:{create:async args=>{
        capture.modelCalls++;
        if(capture.failureMode==='all' || (capture.failureMode==='profile' && args.max_tokens===800)) throw Error('isolated capture API failure');
        return {content:[{type:'text',text:args.max_tokens!==800 && capture.responseText!==undefined ? capture.responseText : JSON.stringify(args.max_tokens===800?{}:{decisions:capture.decisions??[{action:'match',category:'gaming',subject_id:capture.subjectId,sentiment:'positive',topic_beats:[]}]})}]};
      }}})};
      if (resolved === 'src/utils/timezoneValidator') return {isStrictIana:()=>assert.fail('unexpected timezone path')};
      if (resolved === 'src/utils/resolvePersonTarget') return { resolvePersonTarget: ({rawSlackId}) => ({ personId: rawSlackId, slackId: rawSlackId, name: rawSlackId }) };
      return load(`${resolved}.ts`);
    };
    const math = Object.create(Math); math.random = () => typeof random === 'function' ? random() : random;
    vm.runInNewContext(js, { exports: mod.exports, module: mod, require: requireLocal, Date, Math: math }, { filename: file });
    return mod.exports;
  }
  const people = load('src/db/people.ts');
  const subjects = load('src/db/socialSubjects.ts'); subjects.ensureCategoriesSeeded();
  const state = load('src/core/social/stateMachine.ts');
  const skill = new (load('src/skills/social.ts').SocialSkill)();
  const engagement = load('src/core/social/logEngagement.ts');
  return { db, people, subjects, state, skill, engagement, capture, runCapture:()=>load('src/memory/capturePass.ts').runCapturePass(profile), random: n => {random=n;},
    note: (sender, target, note = 'PRIVATE owner assessment', initiated_by = 'maelle') => skill.executeToolCall('note_about_person', { colleague_slack_id: target, colleague_name: target, note, topic: 'gaming', subject: 'a game', initiated_by }, { profile, userId: sender, senderRole: sender === 'U_OWNER' ? 'owner' : 'colleague', authority: sender === 'U_OWNER' ? 'owner' : 'colleague', surface: sender === 'U_OWNER' ? 'owner_dm' : 'colleague_dm' }),
    pick: personSlackId => state.directiveForProactiveSlot({ personSlackId, ownerUserId: 'U_OWNER', ownerTimezone:'UTC' }),
  };
}
test('owner note about absent colleague stays private and does not consume their coda', async () => {
  const h = harness();
  assert.equal(h.pick('U_PERSON').mode, 'raise_new');
  await h.note('U_OWNER','U_PERSON');
  assert.match(h.people.getPersonMemory('U_PERSON').notes, /PRIVATE owner assessment/);
  assert.equal(h.people.getPersonMemory('U_PERSON').last_initiated_at, null);
  assert.equal(h.pick('U_PERSON').mode, 'raise_new');
  assert.ok(!h.people.buildSocialContextBlock('U_PERSON').includes('PRIVATE owner assessment'));
  assert.equal(JSON.parse(h.people.getPersonMemory('U_PERSON').interaction_log).length, 0);
});
test('legacy unprovenanced social timeline is withheld while colleague subjects remain', () => {
  const h = harness();
  h.people.appendPersonInteraction('U_PERSON', {type:'social_chat',summary:'PRIVATE owner assessment'});
  const category = h.subjects.getCategoryByLabel('gaming');
  const own = h.subjects.createSubject({ownerUserId:'U_OWNER',personSlackId:'U_PERSON',categoryId:category.id,label:'Their own game',createdBy:'colleague'});
  const block = h.people.buildSocialContextBlock('U_PERSON');
  assert.ok(!block.includes('PRIVATE owner assessment'));
  assert.ok(block.includes(own.label));
  assert.match(h.people.getPersonMemory('U_PERSON').interaction_log,/PRIVATE owner assessment/,'owner history stays stored');
});
test('direct colleague social note and owner self note preserve activity and cadence', async () => {
  for (const id of ['U_PERSON','U_OWNER']) {
    const h = harness(); await h.note(id,id,'Real direct conversation');
    assert.equal(JSON.parse(h.people.getPersonMemory(id).interaction_log).length,1);
    assert.ok(h.people.getPersonMemory(id).last_social_at);
    assert.equal(h.pick(id).mode,'none');
  }
});
test('person-initiated note preserves eligibility; accepted coda accounting closes it', async () => {
  const h = harness(); await h.note('U_PERSON','U_PERSON','Shared voluntarily','person');
  assert.equal(h.pick('U_PERSON').mode,'raise_new');
  h.engagement.recordCodaDelivered({personSlackId:'U_PERSON',ownerUserId:'U_OWNER',raisedCategoryLabel:'gaming'});
  assert.equal(h.pick('U_PERSON').mode,'none');
  assert.equal(h.pick('U_OWNER').mode,'raise_new');
});
test('subject lifecycle respects unanswered twice, explicit rejection and organic revival', () => {
  const h = harness(); const category = h.subjects.getCategoryByLabel('gaming');
  const sub = h.subjects.createSubject({ownerUserId:'U_OWNER',personSlackId:'U_PERSON',categoryId:category.id,label:'A real game',createdBy:'colleague'});
  for (let count=1;count<=2;count++) {
    h.subjects.markSubjectRaised(sub.id);
    h.engagement.applyRaiseFeedbackForMatches({ownerUserId:'U_OWNER',personSlackId:'U_PERSON',matchedSubjects:[]});
    assert.equal(h.subjects.getSubjectById(sub.id).status,count===2?'dead':'live');
  }
  h.subjects.reviveSubject(sub.id,'colleague');
  assert.equal(h.subjects.getSubjectById(sub.id).status,'live');
  h.subjects.markSubjectDead(sub.id);
  assert.equal(h.subjects.getSubjectById(sub.id).last_assistant_initiated_at,null);
  assert.equal(h.subjects.getSubjectById(sub.id).status,'dead');
});
test('unanswered category raises expire only after two delivered attempts', () => {
  const h = harness(); const category=h.subjects.getCategoryByLabel('gaming');
  h.subjects.adjustCategoryScore({ownerUserId:'U_OWNER',personSlackId:'U_PERSON',categoryId:category.id,delta:1});
  for(let count=1;count<=2;count++) {
    h.engagement.recordCodaDelivered({personSlackId:'U_PERSON',ownerUserId:'U_OWNER',raisedCategoryLabel:'gaming'});
    h.db.exec("UPDATE people_memory SET last_initiated_at=datetime('now','-2 days'); UPDATE social_person_category_scores SET last_raise_attempt_at=datetime('now','-2 days')");
    h.pick('U_PERSON');
    assert.equal(h.subjects.getCategoryScoresForPerson('U_PERSON')[0].score,count===2?0:1);
  }
});
test('failed cadence reservation returns false without marking a subject or category raised', () => {
  const h=harness(); const category=h.subjects.getCategoryByLabel('gaming');
  const sub=h.subjects.createSubject({ownerUserId:'U_OWNER',personSlackId:'U_MISSING',categoryId:category.id,label:'Missing person game',createdBy:'colleague'});
  const reserved=h.engagement.recordCodaDelivered({personSlackId:'U_MISSING',subjectId:sub.id,ownerUserId:'U_OWNER',raisedCategoryLabel:'gaming'});
  assert.equal(reserved,false);
  assert.equal(h.subjects.getSubjectById(sub.id).last_assistant_initiated_at,null);
  assert.equal(h.subjects.getCategoryScoresForPerson('U_MISSING')[0].last_raise_attempt_at,null);
});
test('successful cadence reservation returns true and preserves subject marker', () => {
  const h=harness(); const category=h.subjects.getCategoryByLabel('gaming');
  const sub=h.subjects.createSubject({ownerUserId:'U_OWNER',personSlackId:'U_PERSON',categoryId:category.id,label:'Real game',createdBy:'colleague'});
  const reserved=h.engagement.recordCodaDelivered({personSlackId:'U_PERSON',subjectId:sub.id});
  // The old API returned void; behavioral control is its persisted state.
  if (h.state.isSocialInitiationDue) assert.equal(reserved,true);
  assert.ok(h.subjects.getSubjectById(sub.id).last_assistant_initiated_at);
  assert.equal(h.pick('U_PERSON').mode,'none');
});
test('colleague picker excludes owner-authored subjects while owner keeps their own', () => {
  for(const person of ['U_PERSON','U_OWNER']) {
    const h=harness(); const category=h.subjects.getCategoryByLabel('gaming');
    h.subjects.createSubject({ownerUserId:'U_OWNER',personSlackId:person,categoryId:category.id,label:'PRIVATE owner assessment',createdBy:'owner'});
    // Filled slot followed by continue choice.
    let calls=0;
    h.random(0);
    // Pin stage 2 via a second category fill: use a random getter sequence.
    h.random(()=> calls++===0?0:0.9);
    const chosen=h.pick(person);
    assert.equal(chosen.mode,person==='U_OWNER'?'continue':'raise_new');
    if(person==='U_PERSON') assert.equal(chosen.subjectLabel,null);
  }
});
test('exact repeated subject creation reuses the existing row including retired subjects', () => {
  const h=harness(); const category=h.subjects.getCategoryByLabel('gaming');
  const args={ownerUserId:'U_OWNER',personSlackId:'U_PERSON',categoryId:category.id,label:'A real game',createdBy:'colleague'};
  h.random(0.1); const original=h.subjects.createSubject(args);
  h.random(0.2); const same=h.subjects.createSubject(args);
  assert.equal(same.id,original.id);
  h.subjects.markSubjectDead(original.id);
  h.random(0.3); const revived=h.subjects.createSubject(args);
  assert.equal(revived.id,original.id);
  assert.equal(revived.status,'live');
  h.random(0.4); const other=h.subjects.createSubject({...args,label:'Another real game'});
  assert.notEqual(other.id,original.id);
  assert.equal(h.subjects.getAllSubjectsForPerson('U_PERSON').length,2);
});
test('failed capture records unknown and cannot count a real reply as silence', async () => {
  const h=harness({captureFailure:true}); const category=h.subjects.getCategoryByLabel('gaming');
  const sub=h.subjects.createSubject({ownerUserId:'U_OWNER',personSlackId:'U_PERSON',categoryId:category.id,label:'A real game',createdBy:'colleague'});
  h.engagement.recordCodaDelivered({personSlackId:'U_PERSON',subjectId:sub.id});
  h.db.exec("UPDATE people_memory SET last_initiated_at=datetime('now','-2 days'); UPDATE social_subjects SET last_assistant_initiated_at=datetime('now','-2 days'), unanswered_raises=1");
  await h.runCapture();
  assert.equal(h.capture.marked,true);
  const attempted=h.capture.modelCalls;
  await h.runCapture();
  assert.equal(h.capture.modelCalls,attempted,'failed attempt is not retried');
  h.pick('U_PERSON');
  assert.equal(h.subjects.getSubjectById(sub.id).status,'live');
  assert.equal(h.subjects.getSubjectById(sub.id).unanswered_raises,1);
});
for(const profileFailure of [true,false]) test(`profile extraction ${profileFailure?'failure preserves unknown without extra calls':'success reconciles the social answer'}`, async () => {
  const h=harness({profileFailure}); const category=h.subjects.getCategoryByLabel('gaming');
  const sub=h.subjects.createSubject({ownerUserId:'U_OWNER',personSlackId:'U_PERSON',categoryId:category.id,label:'A real game',createdBy:'colleague'});
  h.capture.subjectId=sub.id;
  h.engagement.recordCodaDelivered({personSlackId:'U_PERSON',subjectId:sub.id});
  await h.runCapture();
  assert.equal(h.capture.modelCalls,profileFailure?1:2);
  if(profileFailure) {
    assert.ok(h.people.getPersonMemory('U_PERSON').last_social_capture_unknown_at);
    assert.ok(h.subjects.getSubjectById(sub.id).last_assistant_initiated_at);
  } else {
    assert.equal(h.subjects.getSubjectById(sub.id).last_assistant_initiated_at,null);
    assert.equal(h.subjects.getCategoryScoresForPerson('U_PERSON')[0].score,2);
  }
});
test('unknown watermark survives unrelated success, protects old subject/category and permits newer silence', async () => {
  const h=harness({captureFailure:true}); const gaming=h.subjects.getCategoryByLabel('gaming'); const music=h.subjects.getCategoryByLabel('music');
  const args={ownerUserId:'U_OWNER',personSlackId:'U_PERSON',categoryId:gaming.id,createdBy:'colleague'};
  h.random(0.1); const old=h.subjects.createSubject({...args,label:'Old game'});
  h.random(0.2); const newer=h.subjects.createSubject({...args,label:'New game'});
  h.db.exec("UPDATE social_subjects SET last_assistant_initiated_at=datetime('now','-4 days'),unanswered_raises=1");
  h.db.prepare("UPDATE social_subjects SET last_assistant_initiated_at=datetime('now','-2 days') WHERE id=?").run(newer.id);
  h.subjects.adjustCategoryScore({ownerUserId:'U_OWNER',personSlackId:'U_PERSON',categoryId:music.id,delta:1});
  h.subjects.markCategoryRaised({ownerUserId:'U_OWNER',personSlackId:'U_PERSON',categoryId:music.id});
  h.db.exec("UPDATE social_person_category_scores SET last_raise_attempt_at=datetime('now','-4 days'),unanswered_raises=1 WHERE category_id='cat_global_music'");
  h.capture.humanTs=String(Date.now()/1000-3*86400); await h.runCapture();
  const stamp=h.people.getPersonMemory('U_PERSON').last_social_capture_unknown_at;
  h.capture.marked=false; h.capture.humanTs=String(Date.now()/1000-5*86400); await h.runCapture();
  assert.equal(h.people.getPersonMemory('U_PERSON').last_social_capture_unknown_at,stamp,'older failure cannot move watermark back');
  h.capture.marked=false; h.capture.failureMode='none'; h.capture.decisions=[]; await h.runCapture();
  assert.equal(h.people.getPersonMemory('U_PERSON').last_social_capture_unknown_at,stamp,'unrelated success cannot erase unknown');
  h.pick('U_PERSON');
  assert.equal(h.subjects.getSubjectById(old.id).status,'live');
  assert.equal(h.subjects.getSubjectById(newer.id).status,'dead');
  assert.equal(h.subjects.getCategoryScoresForPerson('U_PERSON').find(c=>c.category_id===music.id).score,1);
  h.engagement.applyRaiseFeedbackForMatches({ownerUserId:'U_OWNER',personSlackId:'U_PERSON',matchedSubjects:[]});
  assert.equal(h.subjects.getSubjectById(old.id).status,'live','later pivot cannot resolve unknown as silence');
  h.engagement.applyRaiseFeedbackForMatches({ownerUserId:'U_OWNER',personSlackId:'U_PERSON',matchedSubjects:[{id:old.id,sentiment:'positive'}]});
  assert.equal(h.subjects.getSubjectById(old.id).last_assistant_initiated_at,null,'real answer resolves marker');
});
test('failed capture of only pre-raise human messages leaves genuine silence accounting intact', async () => {
  const h=harness({captureFailure:true}); const gaming=h.subjects.getCategoryByLabel('gaming');
  const sub=h.subjects.createSubject({ownerUserId:'U_OWNER',personSlackId:'U_PERSON',categoryId:gaming.id,label:'A game',createdBy:'colleague'});
  h.db.exec("UPDATE social_subjects SET last_assistant_initiated_at=datetime('now','-2 days'),unanswered_raises=1");
  h.capture.humanTs=String(Date.now()/1000-3*86400); await h.runCapture();
  h.pick('U_PERSON');
  assert.equal(h.subjects.getSubjectById(sub.id).status,'dead');
});
for(const responseText of ['not JSON', JSON.stringify({decisions:[{}]}), JSON.stringify({decisions:[{action:'match',category:'gaming',subject_id:'hallucinated-id'}]})]) test(`unusable reconciliation output stays unknown: ${responseText}`, async () => {
  const h=harness(); const gaming=h.subjects.getCategoryByLabel('gaming');
  const sub=h.subjects.createSubject({ownerUserId:'U_OWNER',personSlackId:'U_PERSON',categoryId:gaming.id,label:'A game',createdBy:'colleague'});
  h.db.exec("UPDATE social_subjects SET last_assistant_initiated_at=datetime('now','-2 days'),unanswered_raises=1");
  h.capture.responseText=responseText;
  await h.runCapture();
  assert.equal(h.capture.modelCalls,2);
  h.pick('U_PERSON');
  assert.equal(h.subjects.getSubjectById(sub.id).status,'live');
  assert.ok(h.people.getPersonMemory('U_PERSON').last_social_capture_unknown_at);
});
test('legacy unstamped human failure is conservative; assistant-only failure cannot invent a response', async () => {
  for(const noHuman of [false,true]) {
    const h=harness({captureFailure:true}); h.capture.noHuman=noHuman; h.capture.humanTs=undefined;
    await h.runCapture();
    assert.equal(Boolean(h.people.getPersonMemory('U_PERSON').last_social_capture_unknown_at),!noHuman);
  }
});
test('person merge plan preserves the latest unknown watermark', () => {
  const h=harness();
  h.db.exec("ALTER TABLE people_memory ADD COLUMN kind TEXT DEFAULT 'internal'; ALTER TABLE people_memory ADD COLUMN email TEXT; ALTER TABLE people_memory ADD COLUMN created_at TEXT; UPDATE people_memory SET email='same@example.com' WHERE slack_id='U_PERSON'");
  h.db.prepare("INSERT INTO people_memory(person_id,slack_id,name,email,kind,last_social_capture_unknown_at) VALUES ('P_EXTERNAL',NULL,'U_PERSON','same@example.com','external',?)").run('2026-09-10T00:00:00.000Z');
  h.db.exec("UPDATE people_memory SET last_social_capture_unknown_at='2026-09-09T00:00:00.000Z' WHERE slack_id='U_PERSON'");
  const plan=h.people.planPersonMerge('U_PERSON','P_EXTERNAL');
  assert.equal(plan.ok,true);
  assert.equal(plan.merged.last_social_capture_unknown_at,'2026-09-10T00:00:00.000Z');
});
