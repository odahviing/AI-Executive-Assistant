const { test: nodeTest } = require('node:test');
// Evidence runs may select one atomic correction without counting unrelated cases.
const test = (name, fn) => { if (!process.env.SUMMARY_CASE_FILTER || new RegExp(process.env.SUMMARY_CASE_FILTER).test(name)) nodeTest(name, fn); };
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), Database = require('better-sqlite3');
const root = path.resolve(__dirname, '..');
const sourceRoot = process.env.SUMMARY_SOURCE_ROOT || root;
const compiled = new Map();
function actualDirectory(members) {
  const cache=new Map(), mocks={
    'src/utils/logger.ts':{__esModule:true,default:{info(){},warn(){},error(){}}},
    'src/connections/slack/eligibility.ts':{}, 'src/connections/slack/formatting.ts':{formatForSlack:s=>s},
    'src/db.ts':{searchPeopleMemory:()=>[]},
  };
  function load(rel) {
    if(mocks[rel])return mocks[rel];if(cache.has(rel))return cache.get(rel).exports;
    const code=ts.transpileModule(fs.readFileSync(path.join(process.env.SUMMARY_DIRECTORY_ROOT || root,rel),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
    const mod={exports:{}};cache.set(rel,mod);
    const req=s=>s.startsWith('.')?load(path.posix.normalize(path.posix.join(path.posix.dirname(rel),s))+'.ts'):require(s);
    vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{console},{filename:rel})(req,mod,mod.exports);return mod.exports;
  }
  return load('src/connections/slack/index.ts').createSlackConnection({client:{users:{list:async()=>({members})}}},'fixture',{user:{slack_user_id:'UOWNER'}});
}
function harness(opts = {}) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE summary_sessions (id INTEGER PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, owner_user_id TEXT, thread_ts TEXT UNIQUE, channel_id TEXT, stage TEXT, current_draft TEXT, meeting_date TEXT, meeting_time TEXT, meeting_subject TEXT, main_topic TEXT, attendees TEXT, is_external INTEGER, transcript_chars INTEGER, shared_at TEXT, shared_to TEXT);`);
  const sends = [], tasks = [], prompts = [], preferences = opts.preferences || [], modules = new Map();
  const profile = {user:{slack_user_id:'UOWNER', name:'Owner Test', email:'owner@example.com', timezone:'UTC'}, assistant:{name:'Maelle'},skills:{}};
  const conn = {
    findUserByName: async query => actualDirectory(opts.members || (opts.users || []).map(u=>({id:u.id,real_name:u.name,name:u.name,profile:{email:u.email}}))).findUserByName(query),
    findChannelByName: async () => opts.channels || [],
    sendDirect: async (id,text) => send('user',id,text),
    postToChannel: async (id,text) => send('channel',id,text),
    sendGroupConversation: async (ids,text) => send('mpim',ids.join(','),text),
  };
  function send(type,id,text) { sends.push({type,id,text}); return opts.sendResult || {ok:true}; }
  const mocks = {
    'src/db/client.ts': {getDb:()=>db},
    'src/llm/client.ts':{getAnthropicClient:()=>({messages:{create:async p=>{prompts.push(p);const next=opts.responses?.shift();if(next instanceof Error)throw next;return {content:[{type:'text',text:JSON.stringify(next || {is_style_rule:false,generalizes:false})}]};}}})},
    'src/llm/models.ts':{},
    'src/connections/registry.ts':{getConnection:()=>opts.noConnection?undefined:conn},
    'src/tasks.ts':{createTask:t=>{tasks.push(t);return 'task_'+tasks.length;}},
    'src/connectors/graph/calendar.ts':{getCalendarEvents:async()=>[]},
    'src/skills/knowledge.ts':{},
    'src/utils/logger.ts':{__esModule:true,default:{info(){},warn(){},error(){}}},
    'src/utils/skillPreferences.ts':{formatSkillPreferencesBlock:()=>''},
    'src/utils/attendeeAvailability.ts':{loadAttendeeAvailabilityForPerson:()=>undefined,attendeeTzForDay:()=> 'UTC'},
    'src/utils/responseDeadline.ts':{colleagueWorkTimeBaseFromNow:()=>require('luxon').DateTime.fromISO('2026-10-01T14:00Z')},
  };
  function load(rel) {
    if(rel === 'src/db.ts')return {...load('src/db/summarySessions.ts'),savePreference:p=>preferences.push(p),getPreferences:()=>preferences,getPersonMemory:()=>null};
    if(Object.hasOwn(mocks,rel))return mocks[rel];
    if(modules.has(rel))return modules.get(rel).exports;
    assert.ok(['src/skills/summary.ts','src/db/summarySessions.ts','src/memory/resolveAttendeeEmails.ts','src/utils/extractJson.ts'].includes(rel),'unexpected import '+rel);
    if(!compiled.has(rel)) {
      const selected=path.join(sourceRoot,rel), source=fs.readFileSync(fs.existsSync(selected)?selected:path.join(root,rel),'utf8');
      compiled.set(rel,ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);
    }
    const mod={exports:{}};modules.set(rel,mod);
    const req=s=>s==='@anthropic-ai/sdk'?{}:s.startsWith('.')?load(path.posix.normalize(path.posix.join(path.posix.dirname(rel),s))+'.ts'):require(s);
    vm.runInNewContext('(function(require,module,exports){'+compiled.get(rel)+'\n})',{console,Buffer,setTimeout},{filename:rel})(req,mod,mod.exports);return mod.exports;
  }
  const store=load('src/db/summarySessions.ts');
  const draft={subject:'Planning',main_topic:'Launch',is_external:false,attendees:[],paragraphs:['Approved launch plan.'],action_items:[],speakers_unresolved:['דובר 2'],...opts.draft};
  if(!opts.empty)store.createSummarySession({ownerUserId:'UOWNER',threadTs:'1.2',channelId:'DOWNER',draft,transcriptChars:100});
  const skill=new (load('src/skills/summary.ts').SummarySkill)();
  const context={profile,app:{},userId:'UOWNER',senderRole:'owner',authority:'owner',surface:'owner_dm',threadTs:'1.2',channelId:'DOWNER'};
  const call=(name,args,ctx={})=>skill.executeToolCall(name,args,{...context,...ctx});
  return {db,store,sends,tasks,prompts,preferences,call,session:()=>store.getSummarySessionByThread('1.2'),share:(recipients=[{type:'user',id_or_name:'UOWNER'}])=>call('share_summary',{recipients}),ingest:(text)=>load('src/skills/summary.ts').ingestTranscriptUpload({text,caption:'',ownerUserId:'UOWNER',threadTs:'1.2',channelId:'DOWNER',profile})};
}
const user=(id,name,email=id+'@example.com')=>({id,name,email});
const action={assignee_text:'Dan',description:'Send launch plan',deadline_iso:'2026-10-01'};
function plainAction(h) { assert.equal(h.sends.length,1);assert.ok(h.sends[0].text.includes('Send launch plan'));assert.ok(!h.sends[0].text.includes('<@U')); }
test('recipient ambiguity never sends private draft to first match',async()=>{const h=harness({users:[user('UONE','Dan One'),user('UTWO','Dan Two')]});const r=await h.share([{type:'user',id_or_name:'Dan'}]);assert.equal(h.sends.length,0);assert.equal(r.ok,false);assert.ok(h.session().current_draft);});
test('Hebrew recipient ambiguity remains unresolved',async()=>{const h=harness({users:[user('UONE','דנה כהן'),user('UTWO','דנה לוי')]});await h.share([{type:'user',id_or_name:'דנה'}]);assert.equal(h.sends.length,0);});
test('substring-only directory result is rejected',async()=>{const h=harness({users:[user('UONE','Daniel One')]});await h.share([{type:'user',id_or_name:'Dan'}]);assert.equal(h.sends.length,0);});
test('unique named Hebrew recipient remains deliverable',async()=>{const h=harness({users:[user('UONE','דנה כהן')]});const r=await h.share([{type:'user',id_or_name:'דנה'}]);assert.equal(r.sent_to[0].id,'UONE');assert.equal(h.session().stage,'shared');assert.equal(h.session().current_draft,null);});
test('unique explicit user channel and mpim recipients remain deliverable',async()=>{const h=harness();const r=await h.share([{type:'user',id_or_name:'UONE'},{type:'channel',id_or_name:'CTEAM'},{type:'mpim',id_or_name:'UONE,UTWO'}]);assert.equal(r.sent_to.length,3);assert.equal(h.sends.length,3);});
test('ambiguous attendee action retains plain content without guessed mention',async()=>{const h=harness({users:[user('UONE','Dan One')],draft:{attendees:[{name:'Dan One',internal:true,slackId:'UONE'},{name:'Dan Two',internal:true,slackId:'UTWO'}],action_items:[action]}});await h.share();plainAction(h);});
test('ambiguous directory action retains plain content without guessed mention',async()=>{const h=harness({users:[user('UONE','Dan One'),user('UTWO','Dan Two')],draft:{action_items:[action]}});await h.share();plainAction(h);});
test('blank assignee cannot bind directory first result',async()=>{const h=harness({users:[user('UONE','Dan One')],draft:{action_items:[{...action,assignee_text:''}]}});await h.share();plainAction(h);});
test('external attendee name cannot bind same-named internal action',async()=>{const h=harness({users:[user('UONE','Dan One')],draft:{attendees:[{name:'Dan One',email:'dan@external.com',internal:false,slackId:'UONE'}],action_items:[action]}});await h.share();plainAction(h);});
test('unique internal assignee remains in content without followup and terminal replay sends nothing',async()=>{const h=harness({users:[user('UONE','Dan One')],draft:{action_items:[action]}});const r=await h.share();assert.ok(h.sends[0].text.includes('<@UONE>'));assert.ok(h.sends[0].text.includes('Send launch plan'));const repeat=await h.share();assert.equal(repeat.ok,false);assert.equal(h.sends.length,1);assert.equal(h.tasks.length,0);});
test('missing transport preserves draft and creates no followup',async()=>{const h=harness({noConnection:true,draft:{action_items:[{...action,assignee_slack_id:'UONE',assignee_internal:true}]}});const r=await h.share();assert.equal(r.ok,false);assert.equal(h.tasks.length,0);assert.equal(h.session().stage,'iterating');assert.ok(h.session().current_draft);});
test('not-attempted delivery preserves draft for safe retry',async()=>{const h=harness({sendResult:{ok:false,reason:'not_attempted'}});const r=await h.share();assert.equal(r.ok,false);assert.equal(h.session().stage,'iterating');assert.ok(h.session().current_draft);});
test('speaker labels survive ingestion and edited summary roundtrip',async()=>{const draft={subject:'Planning',main_topic:'Launch',attendees:[],paragraphs:['Plan'],action_items:[],speakers_unresolved:['דובר 2']};const h=harness({empty:true,responses:[draft,{kind:'summary'},{...draft,paragraphs:['Edited plan'],speakers_unresolved:[]}]});await h.ingest('דובר 2: אשלח מחר');assert.equal(h.session().transcript_chars,16);assert.equal(JSON.parse(h.session().current_draft).speakers_unresolved[0],'דובר 2');await h.ingest('Edited plan');assert.equal(JSON.parse(h.session().current_draft).paragraphs[0],'Edited plan');assert.equal(h.prompts.length,3);});
test('model edit failure preserves original draft and no style write',async()=>{const h=harness({responses:[new Error('unavailable')]});const before=h.session().current_draft;const r=await h.call('update_summary_draft',{instruction:'Fix title'});assert.equal(r.ok,false);assert.equal(h.session().current_draft,before);assert.equal(h.preferences.length,0);});
test('explicit summary style reaches stored preference',async()=>{const h=harness();const r=await h.call('learn_summary_style',{key:'spacing',value:'Separate paragraphs'});assert.equal(r.saved,true);assert.equal(h.preferences[0].value,'Separate paragraphs');});
test('edited action cannot retain previous assignee identity',async()=>{const h=harness({users:[user('UTWO','Dana Two')],draft:{action_items:[{...action,assignee_text:'Dana',assignee_slack_id:'UONE',assignee_internal:true,assignee_name:'Dan One'}]}});await h.share();assert.ok(h.sends[0].text.includes('<@UTWO>'));assert.ok(h.sends[0].text.includes('Send launch plan'));});
test('unknown edited assignee retains content without stale mention',async()=>{const h=harness({draft:{action_items:[{...action,assignee_text:'Unknown',assignee_slack_id:'UONE',assignee_internal:true,assignee_name:'Dan One'}]}});await h.share();plainAction(h);});
test('duplicate directory rows for same user remain one identity',async()=>{const h=harness({users:[user('UONE','Dan One'),user('UONE','Dan One')],draft:{action_items:[action]}});const r=await h.share([{type:'user',id_or_name:'Dan'}]);assert.equal(r.sent_to.length,1);assert.ok(h.sends[0].text.includes('<@UONE>'));assert.ok(h.sends[0].text.includes('Send launch plan'));});
test('ambiguous channel lookup cannot publish to first room',async()=>{const h=harness({channels:[{id:'CONE',name:'team-one'},{id:'CTWO',name:'team-two'}]});await h.share([{type:'channel',id_or_name:'team'}]);assert.equal(h.sends.length,0);});
test('unique named channel still receives summary',async()=>{const h=harness({channels:[{id:'CONE',name:'team'}]});const r=await h.share([{type:'channel',id_or_name:'team'}]);assert.equal(r.sent_to[0].id,'CONE');});
const member=(id,real_name,name,display_name)=>({id,real_name,name,profile:{email:id+'@example.com',display_name}});
test('actual Slack display alias survives adapter projection to recipient',async()=>{const h=harness({members:[member('UONE','Daniel Cohen','danielc','Dani')]});const r=await h.share([{type:'user',id_or_name:'Dani'}]);assert.equal(r.sent_to[0].id,'UONE');});
test('actual Slack username survives adapter projection to recipient',async()=>{const h=harness({members:[member('UONE','Daniel Cohen','dc_ops','Daniel')]});const r=await h.share([{type:'user',id_or_name:'dc_ops'}]);assert.equal(r.sent_to[0].id,'UONE');});
test('actual real-name plus display alias remains ambiguous',async()=>{const h=harness({members:[member('UONE','Dani Cohen','dcohen','Dani Cohen'),member('UTWO','Daniel Levy','dlevy','Dani')]});await h.share([{type:'user',id_or_name:'Dani'}]);assert.equal(h.sends.length,0);});
test('actual Slack Hebrew display alias remains valid action assignee',async()=>{const h=harness({members:[member('UONE','Daniel Cohen','danielc','דני')],draft:{action_items:[{...action,assignee_text:'דני'}]}});await h.share();assert.ok(h.sends[0].text.includes('<@UONE>'));assert.ok(h.sends[0].text.includes('Send launch plan'));});
test('actual mixed alias ambiguity retains content without guessed mention',async()=>{const h=harness({members:[member('UONE','Dani Cohen','dcohen','Dani Cohen'),member('UTWO','Daniel Levy','dlevy','Dani')],draft:{action_items:[{...action,assignee_text:'Dani'}]}});await h.share();plainAction(h);});
for (const [field,value] of Object.entries({paragraphs:[{text:'invalid'}],attendees:[{name:34,internal:true}],action_items:[{assignee_text:'Dan',description:{text:'invalid'}}],speakers_unresolved:[null],is_external:'false',subject:{text:'title'}})) {
  test('malformed '+field+' edit leaves prior draft intact',async()=>{const h=harness({responses:[{[field]:value}]});const before=h.session().current_draft;const r=await h.call('update_summary_draft',{instruction:'Update'});assert.equal(r.ok,false);assert.equal(h.session().current_draft,before);assert.equal(h.preferences.length,0);});
}
test('malformed new transcript response creates no durable session',async()=>{const h=harness({empty:true,responses:[{paragraphs:[{text:'invalid'}]}]});await assert.rejects(()=>h.ingest('Transcript'));assert.equal(h.session(),undefined);});
test('malformed corrected upload preserves previous draft',async()=>{const h=harness({responses:[{kind:'summary'},{action_items:[null]}]});const before=h.session().current_draft;await assert.rejects(()=>h.ingest('Corrected'));assert.equal(h.session().current_draft,before);});
test('valid partial edit preserves omitted arrays and updates text',async()=>{const h=harness({responses:[{subject:'Edited title'}]});const r=await h.call('update_summary_draft',{instruction:'Rename'});assert.equal(r.ok,true);assert.equal(JSON.parse(h.session().current_draft).subject,'Edited title');assert.equal(JSON.parse(h.session().current_draft).paragraphs[0],'Approved launch plan.');});
const stylePrefs=[{category:'summary',key:'global',value:'GLOBAL_RULE'},{category:'summary_type_interview',key:'interview',value:'INTERVIEW_RULE'},{category:'summary_type_weekly',key:'weekly',value:'WEEKLY_RULE'}];
for(const subject of ['ראיון עם דנה','Еженедельная встреча','Unknown meeting'])test('structural style groups remain available for '+subject,async()=>{const h=harness({draft:{subject},preferences:stylePrefs,responses:[{subject}]});await h.call('update_summary_draft',{instruction:'עדכן את הכותרת'});const p=h.prompts[0].messages[0].content;assert.match(p,/GLOBAL_RULE/);assert.match(p,/INTERVIEW_RULE/);assert.match(p,/WEEKLY_RULE/);assert.match(p,/unknown.*global/is);assert.match(p,/any language/i);});
test('structural style learner receives multilingual subject without inferred English hint',async()=>{const h=harness({draft:{subject:'ראיון עם דנה'},preferences:stylePrefs,responses:[{subject:'ראיון עם דנה'}]});await h.call('update_summary_draft',{instruction:'קצר יותר בראיונות'});const p=h.prompts[1].messages[0].content;assert.ok(p.includes('ראיון עם דנה'));assert.ok(!p.includes('INFERRED TYPE:'));assert.match(p,/type_name/);});
test('retired automatic followups retain deadlines as summary content only',async()=>{const h=harness({users:[user('UONE','Dan One')],draft:{action_items:[{...action,deadline_label:'Thursday'}]}});const r=await h.share();assert.equal(r.ok,true);assert.equal(h.tasks.length,0);assert.ok(h.sends[0].text.includes('Send launch plan'));assert.ok(h.sends[0].text.includes('Thursday'));assert.equal(r.tasks_created,undefined);});
test('model edit cannot promote stale attendee Slack ID into wrong mention',async()=>{const h=harness({users:[user('UTWO','Dana Two')],draft:{attendees:[{name:'Dan One',email:'uone@example.com',slackId:'UONE',internal:true}],action_items:[action]},responses:[{attendees:[{name:'Dana Two',email:'utwo@example.com',slackId:'UONE',internal:true}],action_items:[{...action,assignee_text:'Dana Two'}]}]});assert.equal((await h.call('update_summary_draft',{instruction:'Dana Two owns this'})).ok,true);await h.share();assert.ok(h.sends[0].text.includes('<@UTWO>'));assert.ok(!h.sends[0].text.includes('<@UONE>'));assert.equal(h.tasks.length,0);});
// Adapted from Bouncer final-product/independent-summary.cjs; exercise retained
// content and lifecycle behavior after the automatic followup feature was removed.
test('unknown edited attendee retains content without stale mention',async()=>{const h=harness({draft:{attendees:[{name:'Dan One',internal:true,slackId:'UONE'}],action_items:[{...action,assignee_text:'Dan One'}]}});await h.share();plainAction(h);});
for(const reason of ['unknown','failed'])test('attempted '+reason+' share archives and terminal replay does not resend',async()=>{const h=harness({sendResult:{ok:false,reason},draft:{action_items:[action]}});const r=await h.share();assert.equal(r.send_failures.length,1);assert.equal(h.session().current_draft,null);assert.equal(h.session().stage,'shared');assert.equal((await h.share()).ok,false);assert.equal(h.sends.length,1);assert.ok(h.sends[0].text.includes('Send launch plan'));});
test('not-attempted delivery retries once after transport restoration',async()=>{const result={ok:false,reason:'not_attempted'};const h=harness({sendResult:result,draft:{action_items:[action]}});assert.equal((await h.share()).ok,false);assert.ok(h.session().current_draft);result.ok=true;delete result.reason;assert.equal((await h.share()).ok,true);assert.equal(h.session().current_draft,null);assert.equal((await h.share()).ok,false);assert.equal(h.sends.length,2);assert.ok(h.sends[1].text.includes('Send launch plan'));});

