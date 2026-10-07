// Real preference persistence and prompt assembly, isolated filesystem/profile.
// PREFERENCE_BEFORE_REV loads preserved git source without modifying the checkout.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const ts = require('typescript');
const luxon = require('luxon');
const root = path.resolve(__dirname, '..');
const before = process.env.PREFERENCE_BEFORE_REV;
const noop = () => {};

function source(rel) {
  return before && ['src/db/preferences.ts','src/core/assistant.ts','src/skills/summary.ts'].includes(rel) ? execFileSync('git', ['show', `${before}:${rel}`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, rel), 'utf8');
}
function fixture() {
  // Preserve the actual atomic-rename path without Windows sandbox temp EPERM.
  const dir = fs.mkdtempSync(path.join(root, '.maelle-preference-safety-'));
  const cleanup=()=>{const target=path.resolve(dir);assert.equal(path.dirname(target),root);assert.ok(path.basename(target).startsWith('.maelle-preference-safety-'));fs.rmSync(target,{recursive:true,force:true});};
  const modules = new Map();
  const faults = { read: false, rename: false };
  const profile = {
    user: { name: 'Alex Smith', role: 'Founder', email: 'alex@example.test', slack_user_id: 'UOWNER', timezone: 'UTC', language: 'en' },
    assistant: { name: 'Maelle', persona: 'PERSONA_FIXTURE professional and concise.' },
    schedule: { office_days: { days: ['Monday'] }, home_days: { days: ['Tuesday'] }, day_boundary_hour: '00:00' },
    skills: { social: false }, channels: {},
  };
  let profiles=new Map([['owner',profile]]); const sqlite=new (require('better-sqlite3'))(':memory:'); sqlite.exec('CREATE TABLE user_preferences(id TEXT,user_id TEXT,category TEXT,key TEXT,value TEXT,source TEXT,created_at TEXT,updated_at TEXT,UNIQUE(user_id,key))');
  let active = ['meetings', 'summary', 'knowledge', 'search', 'venue'];
  const file = (area, name = 'alex') => path.join(dir, 'config', 'users', `${name}_prefs`, `${area}.md`);
  function seed(area, text, name = 'alex') { fs.mkdirSync(path.dirname(file(area, name)), { recursive: true }); fs.writeFileSync(file(area, name), text); }
  const wrappedFs = {
    ...fs,
    readFileSync: (...args) => { if (faults.read && String(args[0]).startsWith(dir)) throw Object.assign(new Error('fixture unavailable'), { code: 'EACCES' }); return fs.readFileSync(...args); },
    promises: { ...fs.promises, rename: async (...args) => { if (faults.rename) throw new Error('fixture rename failed'); return fs.promises.rename(...args); } },
  };
  function load(rel) {
    if (modules.has(rel)) return modules.get(rel).exports;
    const mod = { exports: {} }; modules.set(rel, mod);
    const js = ts.transpileModule(source(rel), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const mocks = {
      'src/utils/logger': { __esModule: true, default: { info: noop, warn: noop, debug: noop, error: noop } },
      'src/skills/registry': { getActiveSkills: () => active.map(id => ({ id, name: id, getTools: () => [{ name: `tool_${id}` }], getSystemPromptSection: () => `DEFAULT_${id}` })), getSkillTools: () => active.map(id => ({ name: `tool_${id}` })) },
      'src/db': { formatPreferencesCatalog: () => 'PRIVATE_CATALOG_FIXTURE', formatPeopleMemoryForPrompt: () => '', formatThreadPeopleBlock: () => '', getPersonMemory: () => null },
      'src/db/requests': { getAwaitingOwnerRequests: () => [], getOpenRequestsForThread: () => [], getUnrelayedTerminalRequestForThread: () => null },
      'src/core/requests/types': { parseDetails: () => null },
      'src/core/assistantSelf': { formatAssistantSelfForPrompt: () => '' },
      'src/memory/peopleMemory': { formatPeopleCatalogSync: () => '', readPersonMemorySync: () => '' },
      'src/utils/effectiveToday': { getEffectiveToday: p => luxon.DateTime.now().setZone(p.user.timezone).startOf('day') },
      'src/connections/registry': { listConnections: () => [] },
    };
    function req(spec) {
      if (spec === 'fs') return wrappedFs;
      if (['path', 'crypto', 'luxon'].includes(spec)) return require(spec);
      const resolved = spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)) : spec;
      if(resolved==='src/config/userProfile')return {loadAllProfiles:()=>profiles};
      if(resolved==='src/db/client')return {getDb:()=>sqlite};
      if(resolved==='src/db')return {...load('src/db/preferences.ts'),getSummarySessionByThread:()=>({id:1}),parseDraft:()=>({subject:'Planning',attendees:[],paragraphs:[],action_items:[]})};
      if(['src/db/preferences','src/core/assistant','src/skills/summary'].includes(resolved))return load(resolved+'.ts');
      if(['src/utils/resolveSlackId','src/memory/resolveAttendeeEmails','src/utils/workingHoursDefault','src/connectors/graph/calendar','src/skills/knowledge','src/llm/models','src/utils/extractJson'].includes(resolved))return {};
      if(resolved==='src/llm/client')return {getAnthropicClient:()=>({messages:{create:async()=>{throw Error('No model call allowed');}}})};
      if (resolved === 'src/utils/skillPreferences') return load(resolved + '.ts');
      if (Object.hasOwn(mocks, resolved)) return mocks[resolved];
      throw new Error(`Unexpected dependency ${resolved}`);
    }
    vm.runInNewContext(`(function(require,module,exports){${js}\n})`, { process: { cwd: () => dir }, Buffer, Date, console, Set, Map }, { filename: rel })(req, mod, mod.exports);
    return mod.exports;
  }
  const prefs = load('src/utils/skillPreferences.ts');
  // Adapter lets old writers receive the same revision and expose actual unsafe writes.
  const revision = area => crypto.createHash('sha256').update(fs.existsSync(file(area)) ? fs.readFileSync(file(area)) : '').digest('hex');
  const write = (area, mode, text, expectedRevision) => prefs.writeSkillPreferences(profile, area, mode, text, { expectedRevision });
  const prompt = (role = 'owner', scopes, surface = 'dm', authority = role) => load('src/core/orchestrator/systemPrompt.ts').buildSystemPromptParts(profile, role, role === 'owner' ? 'Alex' : 'Colleague', surface === 'mpim' && authority === 'owner', undefined, surface === 'mpim', surface === 'room', undefined, authority === 'owner' ? 'UOWNER' : 'UCOLLEAGUE', [], scopes, 'slack', authority);
  return { load, sqlite, setProfiles:p=>{profiles=p}, dir, prefs, profile, faults, file, seed, revision, write, prompt, reloadPreferences: () => { modules.delete('src/utils/skillPreferences.ts'); return load('src/utils/skillPreferences.ts'); }, setActive: ids => { active = ids; }, cleanup };
}
function scenario(name,run){test(name,async()=>{const f=fixture();try{await run(f);}finally{f.sqlite.close();f.cleanup();}});}
const ctx=(f,role='owner',surface='dm')=>({profile:f.profile,userId:role==='owner'?'UOWNER':'UCOLLEAGUE',senderRole:role,authority:role,surface,threadTs:'1',channelId:'D1'});
const call=(f,args,role,surface)=>new(f.load('src/core/assistant.ts').AssistantSkill)().executeToolCall('manage_preference',args,ctx(f,role,surface));
const keyed=(key='tone',extra={})=>({key,category:'communication',source:'user_taught',condition:null,value:'Speak concisely',...extra});
scenario('owner tool writes canonical only, reads next turn, forgets and safely retries',async f=>{
  assert.equal((await call(f,{action:'set',key:'tone',category:'communication',value:'Speak concisely'})).saved,true);
  let r=f.prefs.readKeyedPreferences(f.profile);assert.equal(r.entries.length,1);assert.equal(r.entries[0].value,'Speak concisely');assert.equal(f.sqlite.prepare('SELECT count(*) n FROM user_preferences').get().n,0);
  assert.equal((await call(f,{action:'recall',key:'tone'})).preferences[0].value,'Speak concisely');
  assert.equal((await call(f,{action:'forget',key:'tone'})).deleted,true);assert.equal((await call(f,{action:'forget',key:'tone'})).deleted,false);
});
scenario('legitimate colleague refusal preserves no-write boundary',async f=>{assert.equal((await call(f,{action:'set',key:'tone',category:'communication',value:'private'},'colleague')).error,'not_permitted');assert.equal(f.prefs.readKeyedPreferences(f.profile).entries.length,0);});
scenario('legitimate owner room read and write refusal',async f=>{for(const action of ['set','recall','forget'])assert.equal((await call(f,{action,key:'tone',category:'communication',value:'private'},'owner','room')).error,'not_permitted');});
scenario('unavailable canonical storage cannot confirm save or empty recall',async f=>{f.faults.read=true;await assert.rejects(call(f,{action:'set',key:'tone',category:'communication',value:'private'}));await assert.rejects(call(f,{action:'recall'}));});
scenario('failed atomic write cannot report saved',async f=>{f.faults.rename=true;await assert.rejects(call(f,{action:'set',key:'tone',category:'communication',value:'private'}));assert.equal(f.sqlite.prepare('SELECT count(*) n FROM user_preferences').get().n,0);});
scenario('owner first-name alias refuses cross-owner preference path',async f=>{f.setProfiles(new Map([['one',f.profile],['two',{...f.profile,user:{...f.profile.user,slack_user_id:'UOTHER'}}]]));await assert.rejects(call(f,{action:'recall'}),/path_conflict/);});
scenario('canonical exact key retains destination and summary condition/provenance once',async f=>{
  const db=f.load('src/db/preferences.ts');await db.savePreference({userId:'UOWNER',key:'interview_rule',category:'summary_type_interview',value:'INTERVIEW_ONLY_FIXTURE',source:'inferred'});
  const entry=f.prefs.readKeyedPreferences(f.profile).entries[0];assert.equal(entry.skill,'summary');assert.equal(entry.condition.summaryType,'interview');assert.equal(entry.source,'inferred');
  const rendered=f.prefs.formatSkillPreferencesBlock(f.profile,'summary');assert.equal(rendered.split('INTERVIEW_ONLY_FIXTURE').length-1,1);assert.match(rendered,/interview/);assert.equal(f.prefs.readKeyedPreferences(f.profile,{summaryType:'weekly'}).entries.length,0);
  await db.savePreference({userId:'UOWNER',key:'interview_rule',category:'summary',value:'GLOBAL_FIXTURE'});assert.equal(f.prefs.readKeyedPreferences(f.profile).entries[0].condition,null);
});
scenario('summary style tool waits for durable canonical write',async f=>{const summary=new(f.load('src/skills/summary.ts').SummarySkill)();const r=await summary.executeToolCall('learn_summary_style',{key:'tone',value:'SUMMARY_FIXTURE'},ctx(f));assert.equal(r.saved,true);assert.equal(f.prefs.readKeyedPreferences(f.profile).entries[0].value,'SUMMARY_FIXTURE');f.faults.rename=true;await assert.rejects(summary.executeToolCall('learn_summary_style',{key:'tone',value:'CHANGED'},ctx(f)));});
scenario('ordinary prose survives keyed tool change',async f=>{f.seed('general','Keep existing unmarked text.\n');await call(f,{action:'set',key:'tone',category:'communication',value:'Speak concisely'});assert.ok(fs.readFileSync(f.file('general'),'utf8').startsWith('Keep existing unmarked text.\n'));});
