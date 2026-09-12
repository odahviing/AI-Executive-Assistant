// Actual person-memory modules over isolated SQLite/files; no live DB or model.
// PERSON_MEMORY_BEFORE=edd2433 runs the same cases against the preserved revision.
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const cp = require('node:child_process'), ts = require('typescript'), Database = require('better-sqlite3');
const root = path.resolve(__dirname, '..'), before = process.env.PERSON_MEMORY_BEFORE, compiled = new Map();
const cols = 'person_id,slack_id,name,name_set_by,email,email_set_by,kind,source,org,is_vip,timezone,timezone_set_by,timezone_temp,state,state_set_by,name_he,name_he_set_by,gender,gender_set_by,gender_confirmed,last_inbound_lang,last_inbound_lang_at,profile_json,working_hours_auto,currently_traveling,notes,interaction_log,engagement_rank,proactive_pending,last_social_at,last_initiated_at,last_social_capture_unknown_at,last_seen,created_at,updated_at'.split(',');
function harness(people = []) {
  const sqlite = new Database(':memory:'), disk = fs.mkdtempSync(path.join(os.tmpdir(), 'person-memory-'));
  fs.mkdirSync(path.join(disk,'config/users'),{recursive:true});
  sqlite.exec(`CREATE TABLE people_memory(${cols.map(c => c === 'person_id' ? c + ' TEXT PRIMARY KEY' : c === 'slack_id' ? c + ' TEXT UNIQUE' : c + (['gender_confirmed','engagement_rank','proactive_pending','is_vip'].includes(c)?' INTEGER':' TEXT')).join(',')})`);
  for (const person of people) {
    const p = Object.assign(Object.fromEntries(cols.map(c => [c, null])), {person_id:'p_' + (person.slack_id || person.name.replace(/\W/g,'')),kind:person.slack_id?'internal':'external',gender:'unknown',gender_confirmed:0,profile_json:'{}',notes:'[]',interaction_log:'[]',last_seen:'2020-01-01',created_at:'2020-01-01'}, person);
    sqlite.prepare(`INSERT INTO people_memory(${cols}) VALUES(${cols.map(c=>'@'+c)})`).run(p);
  }
  const profile={user:{name:'Owner Example',slack_user_id:'UOWNER99',email:'owner@example.com',timezone:'Asia/Jerusalem'},assistant:{name:'Maelle',email:'maelle@example.com'},meetings:{},skills:{social:true}};
  const messages=[], modules=new Map(), state={modelCalls:0,modelResult:'{}',threads:[],captured:[],failWrite:false};
  const noop=()=>{};
  const mocks={
    'src/db/client.ts':{getDb:()=>sqlite},
    'src/db/socialSubjects.ts':{FIXED_CATEGORIES:[],getActiveSubjectsForPerson:()=>[],getRecentTopicBeats:()=>[],threadHadSocialTurn:()=>false},
    'src/db/engagementRank.ts':{isCurrentRankOwnerAuthored:()=>false},
    'src/config/userProfile.ts':{getTenantWorkdaysForTimezone:()=>undefined},
    'src/config.ts':{config:{ANTHROPIC_API_KEY:'fixture'}},
    'src/llm/client.ts':{getAnthropicClient:()=>({messages:{create:async()=>{state.modelCalls++; return {content:[{type:'text',text:state.modelResult}]};}}})},
    'src/llm/models.ts':{},
    'src/utils/logger.ts':{__esModule:true,default:Object.fromEntries(['info','debug','warn','error'].map(k=>[k,(...args)=>messages.push([k,...args])]))},
    'src/connections/registry.ts':{getConnection:()=>state.unavailable?undefined:({resolveChannelCounterpart:async()=> 'UCHRIS99'})},
    'src/utils/skillPreferences.ts':{},
    'src/core/social/logEngagement.ts':{},
  };
  function load(rel){
    if(rel==='src/db.ts')return {...load('src/db/people.ts'),getDb:()=>sqlite,getPersonSocialSummary:()=>({live:[],dead:[]}),getEventsByActor:()=>[],findThreadsReadyForCapture:()=>state.threads,markThreadCaptured:id=>state.captured.push(id),getConversationHistory:()=>[{role:'user',content:'We discussed our project for tomorrow.',timestamp:new Date().toISOString()}]};
    if(Object.hasOwn(mocks,rel))return mocks[rel];
    if(modules.has(rel))return modules.get(rel).exports;
    if(!compiled.has(rel)){
      const snapshot = process.env.PERSON_MEMORY_SNAPSHOT && path.join(root,process.env.PERSON_MEMORY_SNAPSHOT,rel);
      let source = snapshot && fs.existsSync(snapshot) ? fs.readFileSync(snapshot,'utf8') : before ? cp.execFileSync('git',['show',before+':'+rel],{cwd:root,encoding:'utf8'}) : fs.readFileSync(path.join(root,rel),'utf8');
      if(rel==='src/memory/capturePass.ts')source+='\nexport const testCapture = { applyDelta, parseDelta };';
      compiled.set(rel,ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText);
    }
    const mod={exports:{}};modules.set(rel,mod);
    const req=s=>s.startsWith('.')?load(path.posix.normalize(path.posix.join(path.posix.dirname(rel),s))+'.ts'):s==='fs'?{...fs,promises:{...fs.promises,writeFile:async(...args)=>{if(state.failWrite)throw Error('fixture disk unavailable');return fs.promises.writeFile(...args);}}}:require(s);
    vm.runInNewContext('(function(require,module,exports){'+compiled.get(rel)+'\n})',{Date,console,Set,Map,Buffer,setTimeout,clearTimeout,process:{env:process.env,cwd:()=>disk}},{filename:rel})(req,mod,mod.exports);
    return mod.exports;
  }
  function ctx(authority='owner',surface=authority==='owner'?'owner_dm':'colleague_dm') {return {profile,authority,surface,senderRole:surface==='owner_dm'?'owner':'colleague',userId:authority==='owner'?'UOWNER99':'UCHRIS99',channel:'slack',channelId:'DFIXTURE'};}
  const tool=(name,args,authority,surface)=>new(load('src/core/assistant.ts').AssistantSkill)().executeToolCall(name,args,ctx(authority,surface));
  const p=()=>load('src/db/people.ts');
  return {sqlite,disk,profile,state,messages,load,ctx,tool,p,restart:()=>modules.clear(),file:id=>path.join(disk,'config/users/owner_people',id+'.md')};
}
const chris={slack_id:'UCHRIS99',name:'Christian Ray',email:'christian@example.com'};
test('I1 name-only Chris Ray never mints; whole-name candidate offered',async()=>{
  const h=harness([chris]); const r=await h.tool('update_person_memory',{person:'Chris Ray',section:'Residence',text:'Lives in London'});
  assert.equal(r.error,'unresolved_person'); assert.equal(r.created,false);assert.equal(r.candidates[0].name,'Christian Ray');assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM people_memory').get().n,1);
});
test('I1 substring and conflicting email never bind',()=>{
  const h=harness([{name:'Idan Cohen',email:'idan@example.com'},{name:'Chris Ray',email:'one@example.com'}]);
  assert.equal(h.p().resolvePerson({name:'Dan'}),null);
  const r=h.p().resolvePerson({name:'Chris Ray',email:'two@example.com'}); assert.equal(r.created,true);assert.equal(r.row.email,'two@example.com');
});
test('CONTROL exact identity and first engagement email mint remain valid',()=>{
  const h=harness([chris]);assert.equal(h.p().resolvePerson({name:'Christian Ray'}).person_id,'p_UCHRIS99');
  const r=h.p().resolvePerson({name:'New Person',email:'new@external.example'});assert.equal(r.created,true);assert.equal(h.p().resolvePerson({email:'new@external.example'}).person_id,r.person_id);
});
test('I2 resolve and interaction advance last_seen',()=>{
  const h=harness([chris]);h.p().resolvePerson({email:chris.email});assert.notEqual(h.p().getPersonById('p_UCHRIS99').last_seen,'2020-01-01');
  h.sqlite.prepare("UPDATE people_memory SET last_seen='2020-01-01'").run();h.p().appendPersonInteractionById('p_UCHRIS99',{type:'meeting_booked',summary:'Booked project sync'});assert.notEqual(h.p().getPersonById('p_UCHRIS99').last_seen,'2020-01-01');
});
test('I4 owner room write uses owner provenance; room reads remain private',async()=>{
  const h=harness([chris]);const r=await h.tool('update_person_profile',{colleague_name:chris.name,colleague_slack_id:chris.slack_id,working_hours:'mornings'},'owner','room');
  assert.equal(r.updated,true);assert.equal(JSON.parse(h.p().getPersonById('p_UCHRIS99').profile_json)._set_by.working_hours,'owner');
  for(const name of ['get_person_memory','recall_interactions'])assert.equal((await h.tool(name,{person:chris.name,name:chris.name},'owner','room')).error,'not_permitted');
});
test('CONTROL colleague third-party write refused and own operational write accepted',async()=>{
  const h=harness([chris,{slack_id:'UOTHER99',name:'Another Person'}]);
  assert.equal((await h.tool('update_person_profile',{colleague_name:'Another Person',colleague_slack_id:'UOTHER99',state:'Paris'},'colleague','room')).updated,false);
  await h.tool('update_person_profile',{colleague_name:chris.name,colleague_slack_id:chris.slack_id,working_hours:'mornings'},'colleague');assert.equal(JSON.parse(h.p().getPersonById('p_UCHRIS99').profile_json).working_hours,'mornings');
});
test('I5 legacy NULL gender does not steer either renderer',()=>{
  const h=harness([{...chris,last_seen:new Date().toISOString(),gender:'female',gender_set_by:null}]);const p=h.p();assert.match(p.formatThreadPeopleBlock('UCHRIS99',[],'UOWNER99'),/gender=unknown/);assert.match(p.formatPeopleMemoryForPrompt('UOWNER99','Asia/Jerusalem'),/gender: unknown/);
});
test('I8 pronouns replace auto guess with no additional model call',async()=>{
  const h=harness([{...chris,gender:'male',gender_set_by:'auto'}]);await h.load('src/utils/genderDetect.ts').detectAndSaveGender({slackId:chris.slack_id,name:chris.name,pronouns:'she/her'});const r=h.p().getPersonById('p_UCHRIS99');assert.equal(r.gender,'female');assert.equal(r.gender_set_by,'person');assert.equal(h.state.modelCalls,0);
});
test('CONTROL owner-confirmed gender survives contrary pronouns',async()=>{
  const h=harness([{...chris,gender:'male',gender_set_by:'owner',gender_confirmed:1}]);await h.load('src/utils/genderDetect.ts').detectAndSaveGender({slackId:chris.slack_id,name:chris.name,pronouns:'she/her'});assert.equal(h.p().getPersonById('p_UCHRIS99').gender,'male');assert.equal(h.state.modelCalls,0);
});
test('I10 owner profile rejects automatic overwrite; notes retain author',()=>{
  const h=harness([chris]),p=h.p();p.updatePersonProfileById('p_UCHRIS99',{working_hours:'owner window'},'owner');p.updatePersonProfileById('p_UCHRIS99',{working_hours:'auto window'},'auto');assert.equal(JSON.parse(p.getPersonById('p_UCHRIS99').profile_json).working_hours,'owner window');p.appendPersonNoteById('p_UCHRIS99','A durable note','person');assert.equal(JSON.parse(p.getPersonById('p_UCHRIS99').notes)[0].set_by,'person');
});
test('I12 colleague dropped fields are reported and no save claimed',async()=>{
  const h=harness([chris]);const r=await h.tool('update_person_profile',{colleague_name:chris.name,colleague_slack_id:chris.slack_id,role_summary:'I run this'},'colleague');assert.equal(r.updated,false);assert.ok(r.not_saved.includes('role_summary'));
});
test('I6/I7 owner room notes and profile updates use the existing assistant self row',async()=>{
  const h=harness([]);h.load('src/core/assistantSelf.ts').seedAssistantSelf(h.profile);
  const self=h.p().getPersonMemory('SELF:UOWNER99');assert.equal(self.gender,'unknown');
  const social=new(h.load('src/skills/social.ts').SocialSkill)();
  await social.executeToolCall('note_about_self',{note:'A named character inspired her name',topic:'identity'},h.ctx('owner','room'));
  const r=await h.tool('update_person_profile',{colleague_name:'Maelle',language_preference:'English'});
  assert.equal(r.created,false);assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM people_memory').get().n,1);
  const row=h.p().getPersonMemory('SELF:UOWNER99');assert.equal(JSON.parse(row.notes)[0].set_by,'owner');assert.equal(row.last_social_at,null);assert.equal(row.last_initiated_at,null);
  assert.equal(JSON.parse(row.profile_json)._set_by.language_preference,'owner');
  assert.match(h.load('src/core/assistantSelf.ts').formatAssistantSelfForPrompt(h.profile,true),/English/);
});
test('I9 expired unknown-destination trip no longer blocks new trips or reads active',()=>{
  const h=harness([{...chris,currently_traveling:JSON.stringify({location:'Unmapped fixture place',from:'2000-01-01',until:'2000-01-02',source:'owner'})}]);
  assert.equal(h.p().getTravelRecordById('p_UCHRIS99'),null);
  assert.equal(h.p().setCurrentTravelById('p_UCHRIS99',{location:'Paris',from:'2099-01-01',until:'2099-01-02'},'auto'),'applied');
});
test('CONTROL active owner travel blocks lower authority, inclusive last day stays readable',()=>{
  const h=harness([{...chris,currently_traveling:JSON.stringify({location:'Paris',from:'2099-01-01',until:'2099-01-02',source:'owner'})}]);
  assert.equal(h.p().setCurrentTravelById('p_UCHRIS99',{location:'Rome',from:'2099-01-01',until:'2099-01-02'},'auto'),'refused_lower_authority');
  assert.equal(h.p().getTravelRecordById('p_UCHRIS99','2099-01-02').location,'Paris');assert.equal(h.p().getTravelRecordById('p_UCHRIS99','2099-01-03'),null);
});
test('I11 owner name correction survives a later auto sync',async()=>{
  const h=harness([chris]);await h.tool('update_person_profile',{colleague_name:chris.name,colleague_slack_id:chris.slack_id,name:'Yoni Ray'});h.p().upsertPersonMemory({slackId:chris.slack_id,name:chris.name});assert.equal(h.p().getPersonById('p_UCHRIS99').name,'Yoni Ray');
});
test('I13 refused automatic writes log the field and writer authority',()=>{
  const h=harness([{...chris,state:'Paris',state_set_by:'owner'}]);h.p().setCoreFieldWithProvenanceById('p_UCHRIS99','state','Rome','auto');assert.ok(h.messages.some(m=>JSON.stringify(m).includes('refused')&&JSON.stringify(m).includes('auto')));
});
test('I14 malformed capture differs from empty; invented keys are rejected',()=>{
  const h=harness([chris]);const p=h.load('src/memory/capturePass.ts').testCapture.parseDelta;
  assert.equal(p('not json'),null);assert.equal(p('{"timezone":123}'),null);assert.equal(p('{"hallucinated":"fact"}'),null);assert.equal(Object.keys(p('{}')).length,0);assert.equal(p('{"state":"Paris"}').state,'Paris');
});
test('5d capture append preserves newest history beyond 32KB',async()=>{
  const h=harness([chris]);const file=h.file('p_UCHRIS99');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,"# Christian Ray\n\n## What we've discussed\n\n- [2020-01-01] "+'x'.repeat(40000)+'\n- [2026-09-01] LATEST-KEPT\n');
  await h.load('src/memory/capturePass.ts').testCapture.applyDelta(h.profile,chris.slack_id,chris.name,{interaction_summary:'NEW-CAPTURE'});
  const result=fs.readFileSync(file,'utf8');assert.ok(result.includes('LATEST-KEPT'));assert.ok(result.includes('NEW-CAPTURE'));assert.ok(result.length>40000);
});
test('5d booking append preserves newest history beyond 32KB and reports one event',async()=>{
  const h=harness([chris]);const file=h.file('p_UCHRIS99');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,"# Christian Ray\n\n## What we've discussed\n\n- [2020-01-01] "+'x'.repeat(40000)+'\n- [2026-09-01] LATEST-KEPT\n');
  await h.load('src/memory/recordBooking.ts').recordBookingInPersonMemory({profile:h.profile,subject:'Fixture sync',startIso:'2099-02-03T10:00:00Z',attendees:[{email:chris.email,name:chris.name}],mutation:'booked'});
  const result=fs.readFileSync(file,'utf8');assert.ok(result.includes('LATEST-KEPT'));assert.ok(result.includes('Fixture sync'));
  const row=h.p().getPersonById('p_UCHRIS99'),log=JSON.parse(row.interaction_log);assert.equal(log.length,1);assert.ok(result.includes('['+log[0].date.split('T')[0]+']'));
  const read=await h.tool('get_person_memory',{person:chris.name});assert.equal(read.recent_bookings.length,1);assert.ok(!read.content.includes('Fixture sync'));
});
test('5d concurrent full-file appends retain both and repeated line is idempotent',async()=>{
  const h=harness([chris]),m=h.load('src/memory/peopleMemory.ts');const params={profile:h.profile,personId:'p_UCHRIS99',displayName:chris.name,section:"What we've discussed",append:true};
  await Promise.all([m.writePersonSection({...params,text:'FIRST'}),m.writePersonSection({...params,text:'SECOND'})]);await m.writePersonSection({...params,text:'SECOND'});
  const raw=fs.readFileSync(h.file('p_UCHRIS99'),'utf8');assert.ok(raw.includes('FIRST'));assert.equal(raw.split('SECOND').length-1,1);
});
test('5d timeline replace and free-text Travel save refuse honestly',async()=>{
  const h=harness([chris]);for(const section of ["What we've discussed",'Travel']){const r=await h.tool('update_person_memory',{person:chris.name,section,text:'replace everything'});assert.equal(r.ok,false);assert.ok(r.not_saved.includes(section));}
});
test('5d partial capture preserves sibling fields and refused owner values',async()=>{
  const h=harness([{...chris,state:'London',timezone:'Europe/London',profile_json:JSON.stringify({working_hours:'owner window',response_speed:'fast',_set_by:{working_hours:'owner',response_speed:'auto'}})}]);
  await h.load('src/memory/capturePass.ts').testCapture.applyDelta(h.profile,chris.slack_id,chris.name,{state:'Paris',working_hours:'bad auto window'});
  const raw=fs.readFileSync(h.file('p_UCHRIS99'),'utf8');assert.ok(raw.includes('Europe/London'));assert.ok(raw.includes('owner window'));assert.ok(raw.includes('fast'));assert.ok(!raw.includes('bad auto window'));
});
test('5d owner correction reaches mirror; failed mirror retains DB and same-write recovery refreshes',async()=>{
  const h=harness([chris]);const args={colleague_name:chris.name,colleague_slack_id:chris.slack_id,language_preference:'Hebrew'};
  h.state.failWrite=true;const failed=await h.tool('update_person_profile',args);assert.equal(failed.mirror_synced,false);assert.equal(JSON.parse(h.p().getPersonById('p_UCHRIS99').profile_json).language_preference,'Hebrew');
  h.state.failWrite=false;h.restart();const retried=await h.tool('update_person_profile',args);assert.equal(retried.mirror_synced,true);assert.equal(retried.created,false);assert.ok(fs.readFileSync(h.file('p_UCHRIS99'),'utf8').includes('Hebrew'));
});
test('5d travel read suppresses stale prose and returns structured future window',async()=>{
  const h=harness([{...chris,currently_traveling:JSON.stringify({location:'Paris',from:'2099-01-01',until:'2099-01-02',source:'owner'})}]);const file=h.file('p_UCHRIS99');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'# Christian Ray\n\n## Travel\nHe will visit OLD-TRIP in June.\n');
  const r=await h.tool('get_person_memory',{person:chris.name});assert.equal(r.currently_traveling?.location,'Paris');assert.ok(!r.content.includes('OLD-TRIP'));assert.ok(r.content.includes('2099-01-02'));
});
test('5d work history and unknown-kind durable notes survive routine churn',()=>{
  const h=harness([chris]),p=h.p();p.appendPersonInteractionById('p_UCHRIS99',{type:'meeting_booked',summary:'WORK HISTORY'});p.appendPersonNoteById('p_UCHRIS99','DURABLE WORK FACT','owner');
  for(let i=0;i<205;i++)p.appendPersonInteractionById('p_UCHRIS99',{type:'social_chat',summary:'routine '+i});for(let i=0;i<55;i++)p.appendPersonNoteById('p_UCHRIS99','routine '+i,'auto');
  const row=p.getPersonById('p_UCHRIS99');assert.ok(row.interaction_log.includes('WORK HISTORY'));assert.ok(row.notes.includes('DURABLE WORK FACT'));assert.equal(JSON.parse(row.interaction_log).filter(i=>i.type==='social_chat').length,200);
});
test('5d catalogs suppress a legacy twin while retaining the source files',async()=>{
  const h=harness([chris]),file=h.file('p_UCHRIS99');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'# Christian Ray\n\n## Residence\nParis');fs.writeFileSync(h.file('christian-ray'),'# Christian Ray\n\n## Residence\nParis');const m=h.load('src/memory/peopleMemory.ts');assert.equal((await m.listPersonFiles(h.profile)).length,1);assert.equal(m.formatPeopleCatalogSync(h.profile).split('Christian Ray').length-1,1);assert.ok(fs.existsSync(h.file('christian-ray')));
});
test('5d empty fields report not_saved without introducing clear semantics',async()=>{
  const h=harness([{...chris,profile_json:JSON.stringify({working_hours:'retain me'})}]);const r=await h.tool('update_person_profile',{colleague_name:chris.name,colleague_slack_id:chris.slack_id,working_hours:''});assert.equal(r.updated,false);assert.ok(r.not_saved.includes('working_hours'));assert.equal(JSON.parse(h.p().getPersonById('p_UCHRIS99').profile_json).working_hours,'retain me');
});
test('CONTROL pronoun canonical forms remain supported',()=>{
  const d=harness().load('src/utils/genderDetect.ts').detectGenderFromPronouns;assert.equal(d('he/him'),'male');assert.equal(d('he'),'male');assert.equal(d('she'),'female');assert.equal(d('she / her'),'female');assert.equal(d('they/them'),'unknown');assert.equal(d(undefined),'unknown');
});
test('I8 mixed structured declarations do not guess one gender',()=>{
  assert.equal(harness().load('src/utils/genderDetect.ts').detectGenderFromPronouns('he/she'),'unknown');
});
test('CONTROL unavailable capture transport does not mutate or call a model',async()=>{
  const h=harness([chris]);h.state.unavailable=true;h.state.threads=[{thread_ts:'fixture',channel_id:'DFIXTURE'}];await h.load('src/memory/capturePass.ts').runCapturePass(h.profile);assert.equal(h.state.modelCalls,0);assert.equal(h.state.captured.length,0);assert.equal(h.p().getPersonById('p_UCHRIS99').profile_json,'{}');
});
test('I3 email merge chooses latest canonical external rather than caller',()=>{
  const h=harness([{person_id:'p_old',name:'Older',email:'old@example.com',last_seen:'2020-01-01'},{person_id:'p_recent',name:'Recent',email:'canonical@example.com',last_seen:'2026-09-01'}]);
  const r=h.p().setPersonEmail('p_old','canonical@example.com',{overwrite:true,by:'owner'});assert.equal(r.personId,'p_recent');assert.equal(h.p().getPersonById('p_old'),null);assert.equal(h.p().getPersonByEmail('canonical@example.com').person_id,'p_recent');
});
test('CONTROL Slack canonical row survives external email merge',()=>{
  const h=harness([{person_id:'p_external',name:'External',email:'external@example.com',last_seen:'2099-01-01'},chris]);const r=h.p().setPersonEmail('p_external',chris.email,{overwrite:true,by:'owner'});assert.equal(r.personId,'p_UCHRIS99');assert.equal(h.p().getPersonById('p_external'),null);
});
test('I10 merge preserves higher-authority profile field and tag',()=>{
  const h=harness([{person_id:'p_a',name:'A',email:'one@example.com',profile_json:JSON.stringify({working_hours:'auto',_set_by:{working_hours:'auto'}})},{person_id:'p_b',name:'B',email:'one@example.com',profile_json:JSON.stringify({working_hours:'owner',_set_by:{working_hours:'owner'}})}]);assert.equal(h.p().mergePersonRows('p_a','p_b'),true);const p=JSON.parse(h.p().getPersonById('p_a').profile_json);assert.equal(p.working_hours,'owner');assert.equal(p._set_by.working_hours,'owner');
});
test('CONTROL legacy profile reads do not invent provenance',async()=>{
  const h=harness([{...chris,profile_json:JSON.stringify({working_hours:'legacy'})}]);await h.tool('get_person_memory',{person:chris.name});assert.equal(JSON.parse(h.p().getPersonById('p_UCHRIS99').profile_json)._set_by,undefined);
});
test('I14 real capture loop logs malformed separately, still closes its attempt',async()=>{
  const h=harness([chris]);h.state.threads=[{thread_ts:'fixture',channel_id:'DFIXTURE'}];h.state.modelResult='{ "hallucinated": "fact" }';await h.load('src/memory/capturePass.ts').runCapturePass(h.profile);assert.ok(h.messages.some(m=>String(m[1]).includes('malformed profile capture')));assert.ok(!h.messages.some(m=>String(m[1]).includes('no new deltas')));assert.deepEqual(h.state.captured,['fixture']);assert.equal(h.p().getPersonById('p_UCHRIS99').profile_json,'{}');
});
test('CONTROL real empty capture closes normally with no facts',async()=>{
  const h=harness([chris]);h.state.threads=[{thread_ts:'fixture',channel_id:'DFIXTURE'}];await h.load('src/memory/capturePass.ts').runCapturePass(h.profile);assert.ok(h.messages.some(m=>String(m[1]).includes('no new deltas')));assert.deepEqual(h.state.captured,['fixture']);
});
test('I3 canonical lookup uses actual recency across SQLite and ISO timestamp formats',()=>{
  const h=harness([{person_id:'p_iso',name:'ISO',email:'same@example.com',last_seen:'2026-09-12T01:00:00Z'},{person_id:'p_sql',name:'SQL',email:'same@example.com',last_seen:'2026-09-12 23:00:00'}]);assert.equal(h.p().getPersonByEmail('same@example.com').person_id,'p_sql');
});
test('I15 location model output must be a whole valid IANA zone',async()=>{
  const h=harness();h.state.modelResult='America/New_York trailing junk';assert.equal(await h.load('src/utils/locationTz.ts').inferTimezoneFromState('Unmapped fixture town'),null);
});
test('CONTROL valid location model output remains accepted with one existing call',async()=>{
  const h=harness();h.state.modelResult='America/New_York';assert.equal(await h.load('src/utils/locationTz.ts').inferTimezoneFromState('Unmapped fixture town'),'America/New_York');assert.equal(h.state.modelCalls,1);
});
test('CONTROL booking mirror failure keeps both attendee work histories and reports failure',async()=>{
  const h=harness([chris,{name:'External Person',email:'external@fixture.example'}]);h.state.failWrite=true;await h.load('src/memory/recordBooking.ts').recordBookingInPersonMemory({profile:h.profile,subject:'Recorded despite disk failure',startIso:'2099-01-01T12:00:00Z',attendees:[{email:chris.email},{email:'external@fixture.example'}],mutation:'booked'});
  assert.ok(h.p().getPersonByEmail(chris.email).interaction_log.includes('Recorded despite disk failure'));assert.ok(h.p().getPersonByEmail('external@fixture.example').interaction_log.includes('Recorded despite disk failure'));assert.equal(h.messages.filter(m=>String(m[1]).includes('writePersonSection failed')).length,2);
});
test('CONTROL human-authoritative gender remains visible in both renderers',()=>{
  for(const provenance of [{gender_set_by:'person'},{gender_set_by:'owner'},{gender_set_by:null,gender_confirmed:1}]){
    const h=harness([{...chris,last_seen:new Date().toISOString(),gender:'female',...provenance}]);assert.match(h.p().formatThreadPeopleBlock('UCHRIS99',[],'UOWNER99'),/gender=female/);assert.match(h.p().formatPeopleMemoryForPrompt('UOWNER99','Asia/Jerusalem'),/gender: female/);
  }
});
test('CONTROL ordinary markdown section replacement preserves other sections',async()=>{
  const h=harness([chris]),m=h.load('src/memory/peopleMemory.ts'),params={profile:h.profile,personId:'p_UCHRIS99',displayName:chris.name};await m.writePersonSection({...params,section:'Residence',text:'Old residence'});await m.writePersonSection({...params,section:"What we've discussed",text:'Keep this event'});await m.writePersonSection({...params,section:'Residence',text:'New residence'});const raw=fs.readFileSync(h.file('p_UCHRIS99'),'utf8');assert.ok(raw.includes('New residence'));assert.ok(raw.includes('Keep this event'));assert.ok(!raw.includes('Old residence'));
});
test('CONTROL owner log_interaction still appends a legitimate event',async()=>{
  const h=harness([chris]);assert.equal((await h.tool('log_interaction',{colleague_name:chris.name,colleague_slack_id:chris.slack_id,type:'coordination',summary:'Confirmed next steps'})).logged,true);assert.ok(h.p().getPersonById('p_UCHRIS99').interaction_log.includes('Confirmed next steps'));
});
for (const [field, invalid, error] of [
  ['timezone','IST','invalid_timezone'],
  ['email','not-an-email','invalid_email'],
  ['currently_traveling',{location:'Paris',from:'not-a-date',until:'2099-01-03'},'invalid_travel_window'],
]) test(`I1 completion ${field}: invalid new keyed target discloses creation and retry creates no duplicate`,async()=>{
  const h=harness(),args={colleague_name:'New Keyed Person',colleague_slack_id:'UNEWKEY9',[field]:invalid};
  const first=await h.tool('update_person_profile',args);assert.equal(first.error,error);assert.equal(first.created,true);assert.equal(first.updated,false);assert.ok(first.not_saved.includes(field));
  const row=h.p().getPersonMemory('UNEWKEY9');assert.ok(row);assert.equal(row[field],null);assert.equal(JSON.parse(row.profile_json||'{}')[field],undefined);assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM people_memory').get().n,1);
  const retry=await h.tool('update_person_profile',args);assert.equal(retry.created,false);assert.equal(retry.updated,false);assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM people_memory').get().n,1);assert.equal(h.p().getPersonMemory('UNEWKEY9')[field],null);
});
test('I1 completion unresolved social note reports no creation and changes no rows',async()=>{
  const h=harness(),social=new(h.load('src/skills/social.ts').SocialSkill)();
  const result=await social.executeToolCall('note_about_person',{colleague_name:'Unresolved Person',note:'Do not invent a person',topic:'gaming'},h.ctx());assert.equal(result.error,'unknown_colleague');assert.equal(result.created,false);assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM people_memory').get().n,0);
});
test('CONTROL completion valid profile fields still apply on an existing keyed person',async()=>{
  for(const [field,value] of [['timezone','Europe/Paris'],['email','new-valid@fixture.example'],['currently_traveling',{location:'Paris',from:'2099-01-01',until:'2099-01-03'}]]){
    const h=harness([chris]),result=await h.tool('update_person_profile',{colleague_name:chris.name,colleague_slack_id:chris.slack_id,[field]:value});assert.equal(result.updated,true);assert.equal(result.created,false);assert.ok(!result.not_saved?.includes(field));const stored=h.p().getPersonMemory(chris.slack_id)[field];assert.equal(field==='currently_traveling'?JSON.parse(stored).location:stored,field==='currently_traveling'?'Paris':value);assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM people_memory').get().n,1);
  }
});
test('CONTROL completion valid social note still persists with owner provenance',async()=>{
  const h=harness([chris]),social=new(h.load('src/skills/social.ts').SocialSkill)();const result=await social.executeToolCall('note_about_person',{colleague_name:chris.name,colleague_slack_id:chris.slack_id,note:'Enjoys a game',topic:'gaming'},h.ctx());assert.equal(result.saved,true);assert.equal(result.created,false);assert.equal(JSON.parse(h.p().getPersonMemory(chris.slack_id).notes)[0].set_by,'owner');assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM people_memory').get().n,1);
});
test('B1 identity ambiguity survives display cap and preserves explicit keyed writes',async()=>{
  const rows=[{person_id:'p_first',name:'Dan',email:'dan1@example.com',last_seen:'2026-09-12'},...Array.from({length:9},(_,i)=>({person_id:'p_noise'+i,name:'Daniel'+i,email:`noise${i}@example.com`,last_seen:'2026-09-11'})),{person_id:'p_last',name:'Dan',email:'dan2@example.com',last_seen:'2020-01-01'}];
  const h=harness(rows);assert.equal(h.p().searchPeopleMemory('Dan').length,10);assert.equal(h.p().findPersonByName('Dan').match,null);assert.equal(h.p().findPersonByName('Dan').candidates.length,2);assert.equal(h.p().resolvePerson({name:'Dan'}),null);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM people_memory').get().n,11);
  assert.equal(h.p().resolvePerson({email:'dan2@example.com',name:'Dan'}).person_id,'p_last');
});
test('B2 concurrent full operational projections finish with accepted sibling facts',async()=>{
  const h=harness([chris]),base={colleague_name:chris.name,colleague_slack_id:chris.slack_id};
  const results=await Promise.all([h.tool('update_person_profile',{...base,working_hours:'mornings',language_preference:'English'}),h.tool('update_person_profile',{...base,language_preference:'Hebrew'})]);
  assert.ok(results.every(r=>r.mirror_synced));const raw=fs.readFileSync(h.file('p_UCHRIS99'),'utf8');assert.ok(raw.includes('mornings'));assert.ok(raw.includes('Language preference: Hebrew.'));assert.ok(!raw.includes('Language preference: English.'));
  h.restart();assert.ok((await h.tool('get_person_memory',{person:chris.name})).content.includes('Hebrew'));
});
test('B2 capture Workplace projection reads latest accepted siblings inside queue',async()=>{
  const h=harness([chris]),apply=h.load('src/memory/capturePass.ts').testCapture.applyDelta;
  await Promise.all([apply(h.profile,chris.slack_id,chris.name,{role_summary:'Old role',working_hours:'mornings'}),apply(h.profile,chris.slack_id,chris.name,{role_summary:'Current role'})]);
  const raw=fs.readFileSync(h.file('p_UCHRIS99'),'utf8');assert.ok(raw.includes('Current role'));assert.ok(!raw.includes('Old role'));
});
test('CONTROL queued projection recovers after disk failure and preserves append plus assessment boundaries',async()=>{
  const h=harness([chris]),m=h.load('src/memory/peopleMemory.ts');h.state.failWrite=true;
  const args={colleague_name:chris.name,colleague_slack_id:chris.slack_id,working_hours:'mornings',language_preference:'Hebrew'};
  assert.equal((await h.tool('update_person_profile',args)).mirror_synced,false);h.state.failWrite=false;
  await Promise.all([h.tool('update_person_profile',args),m.writePersonSection({profile:h.profile,personId:'p_UCHRIS99',displayName:chris.name,section:"What we've discussed",text:'- [2026-09-12] Keep this',append:true})]);
  h.p().updatePersonProfileById('p_UCHRIS99',{role_summary:'Owner assessment'},'owner');await h.load('src/memory/capturePass.ts').testCapture.applyDelta(h.profile,chris.slack_id,chris.name,{role_summary:'Auto attempt'});
  const raw=fs.readFileSync(h.file('p_UCHRIS99'),'utf8');assert.ok(raw.includes('Hebrew'));assert.ok(raw.includes('Keep this'));assert.ok(!raw.includes('Owner assessment'));assert.ok(!raw.includes('Auto attempt'));
});
test('B3 explicit human handle wins assistant-name collision through every shared write tool',async()=>{
  const h=harness([{slack_id:'UOTHER99',name:'Maelle',email:'human@example.com'}]);h.load('src/core/assistantSelf.ts').seedAssistantSelf(h.profile);
  const selfBefore=h.p().getPersonMemory('SELF:UOWNER99'),args={colleague_slack_id:'UOTHER99',colleague_name:'Maelle'};
  await h.tool('update_person_profile',{...args,language_preference:'Hebrew'});await h.tool('log_interaction',{...args,type:'coordination',summary:'Human coordination'});await h.tool('confirm_gender',{...args,gender:'female'});
  await new(h.load('src/skills/social.ts').SocialSkill)().executeToolCall('note_about_person',{...args,note:'Human note',topic:'gaming'},h.ctx());
  const human=h.p().getPersonMemory('UOTHER99'),self=h.p().getPersonMemory('SELF:UOWNER99');assert.ok(human.profile_json.includes('Hebrew'));assert.ok(human.interaction_log.includes('Human coordination'));assert.equal(human.gender,'female');assert.ok(human.notes.includes('Human note'));for(const field of ['profile_json','notes','interaction_log','gender'])assert.equal(self[field],selfBefore[field]);
});
test('B3 name-only SELF collision is ambiguous, explicit email selects its human',()=>{
  const h=harness([{slack_id:'UOTHER99',name:'Maelle',email:'human@example.com'}]);h.load('src/core/assistantSelf.ts').seedAssistantSelf(h.profile);const resolve=h.load('src/utils/resolvePersonTarget.ts').resolvePersonTarget,base={isOwner:true,ownerDomain:'example.com',assistantSelf:{slackId:'SELF:UOWNER99',name:'Maelle'},name:'Maelle'};
  assert.equal(resolve(base),null);assert.equal(resolve({...base,email:'human@example.com'}).personId,'p_UOTHER99');assert.equal(resolve({...base,rawSlackId:'SELF:UOWNER99'}).personId,'p_SELF_UOWNER99');
});
test('CONTROL unambiguous SELF name resolves, colleague cannot select owner SELF',()=>{
  const h=harness([chris]);h.load('src/core/assistantSelf.ts').seedAssistantSelf(h.profile);const resolve=h.load('src/utils/resolvePersonTarget.ts').resolvePersonTarget,base={isOwner:true,ownerDomain:'example.com',assistantSelf:{slackId:'SELF:UOWNER99',name:'Maelle'},name:'Maelle'};
  assert.equal(resolve(base).personId,'p_SELF_UOWNER99');assert.equal(resolve({...base,isOwner:false,rawSlackId:'SELF:UOWNER99'}),null);
});
test('B4 dated history dedup removes only the represented date and leaves disk intact',async()=>{
  const h=harness([{...chris,interaction_log:JSON.stringify([{date:'2026-09-12T10:00:00Z',type:'social_chat',summary:'Discussed roadmap'}])}]),file=h.file('p_UCHRIS99');fs.mkdirSync(path.dirname(file),{recursive:true});const original="# Christian Ray\r\n\r\n## What we've discussed\r\n- [2025-09-12] Discussed roadmap\r\n- [2026-09-12] Discussed roadmap\r\n- [2026-09-12] Another event\r\n";fs.writeFileSync(file,original);
  const r=await h.tool('get_person_memory',{person:chris.name});assert.ok(r.content.includes('[2025-09-12] Discussed roadmap'));assert.ok(!r.content.includes('[2026-09-12] Discussed roadmap'));assert.ok(r.content.includes('Another event'));assert.equal(fs.readFileSync(file,'utf8'),original);
});
test('B6 ambiguous DB names never select a canonical file but explicit file keys do',async()=>{
  const h=harness([{person_id:'p_a',name:'Dan',email:'a@example.com'},{person_id:'p_b',name:'Dan',email:'b@example.com'}]);for(const id of ['p_a','p_b']){fs.mkdirSync(path.dirname(h.file(id)),{recursive:true});fs.writeFileSync(h.file(id),'# Dan\n\n## Residence\nPRIVATE-'+id);}
  assert.ok(!(await h.tool('get_person_memory',{person:'Dan'})).content?.includes('PRIVATE-'));assert.ok((await h.tool('get_person_memory',{person:'p_b'})).content.includes('PRIVATE-p_b'));
});
test('B6 legacy fallback requires a unique whole-name match',async()=>{
  const h=harness(),m=h.load('src/memory/peopleMemory.ts');fs.mkdirSync(path.dirname(h.file('fixture')),{recursive:true});
  for(const [slug,name] of [['dan-one','Dan One'],['dan-two','Dan Two'],['daniel-only','Daniel Only']])fs.writeFileSync(h.file(slug),'# '+name+'\n\n## Residence\nLegacy fact');
  assert.equal(await m.resolvePersonSlug(h.profile,'Dan'),null);assert.equal(await m.resolvePersonSlug(h.profile,'Dani'),null);assert.equal(await m.resolvePersonSlug(h.profile,'Dan One'),'dan-one');assert.equal(await m.resolvePersonSlug(h.profile,'dan-two'),'dan-two');
});
test('B3 near-name suggestions do not block the configured full SELF name',async()=>{
  const h=harness([{slack_id:'UCHRIS99',name:'Chris Gray',email:'chris@example.com'}]);h.profile.assistant.name='Maelle Gray';h.load('src/core/assistantSelf.ts').seedAssistantSelf(h.profile);
  const lookup=h.p().findPersonByName('Maelle Gray');assert.equal(lookup.match,null);assert.equal(lookup.candidates[0].name,'Chris Gray');
  const result=await h.tool('update_person_profile',{colleague_name:'Maelle Gray',language_preference:'Hebrew'});assert.equal(result.updated,true);assert.ok(h.p().getPersonMemory('SELF:UOWNER99').profile_json.includes('Hebrew'));assert.ok(!h.p().getPersonMemory('UCHRIS99').profile_json.includes('Hebrew'));assert.equal(lookup.status,'not_found');
});
test('B6 near-name suggestions do not block a unique genuine legacy file',async()=>{
  const h=harness([{slack_id:'UCHRIS99',name:'Chris Gray',email:'chris@example.com'}]),file=h.file('maelle-gray');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'# Maelle Gray\n\n## Residence\nLegacy preserved');
  assert.equal(await h.load('src/memory/peopleMemory.ts').resolvePersonSlug(h.profile,'Maelle Gray'),'maelle-gray');assert.ok((await h.tool('get_person_memory',{person:'Maelle Gray'})).content.includes('Legacy preserved'));
});
test('CONTROL unavailable database refuses name fallback while explicit canonical file resolves',async()=>{
  const h=harness(),file=h.file('p_explicit');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'# Alex Person\n\n## Residence\nExplicit');const memory=h.load('src/memory/peopleMemory.ts');h.sqlite.close();assert.equal(await memory.resolvePersonSlug(h.profile,'Alex Person'),null);assert.equal(await memory.resolvePersonSlug(h.profile,'p_explicit'),'p_explicit');
});
module.exports={harness,chris};
