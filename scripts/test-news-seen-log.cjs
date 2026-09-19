// Actual news module and actual brief composer; isolated dependencies, no live calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { DateTime, Settings } = require('luxon');
const root = path.resolve(__dirname, '..');
const sourcePath = process.env.NEWS_SOURCE_FIXTURE || path.join(root, 'src/skills/news.ts');
Settings.now = () => Date.parse('2026-09-19T01:00:00Z');
const profile = {user:{name:'News Fixture',company:'Reflectiz',email:'owner@reflectiz.com',timezone:'UTC',language:'en'},assistant:{name:'Maelle'}};
const source = (url, title='Current report') => ({url,title,snippet:'Evidence from the search snippet.'});
const captures = [];
function harness({log='',results=[],summary='• Current story [daily.example]',modelFail=false,readFail=false,writeFail=false,zone='UTC',prefs='',plan={goals:['Market news']},prefsUnavailable=false}={}) {
  const state={log,requests:[],writes:[],searches:[],warnings:[]};
  const p={...profile,user:{...profile.user,timezone:zone}};
  const dependencies={
    fs:{existsSync:()=>!!state.log,mkdirSync:()=>{},readFileSync:()=>{if(readFail)throw Error('unreadable');return state.log;},promises:{writeFile:async(_file,text)=>{if(writeFail)throw Error('disk full');state.log=text;state.writes.push(text);}}},
    path,luxon:{DateTime},'../llm/models':{MODEL_HAIKU:'fixture',SONNET:{model:'fixture'}},
    '../llm/client':{getAnthropicClient:()=>({messages:{create:async req=>{state.requests.push(req);if(modelFail)throw Error('model unavailable');const input=JSON.stringify(req);return {content:[{type:'text',text:input.includes('You plan a personalized')?JSON.stringify(plan):input.includes('Which numbered sources')?'[]':input.includes('These news items')?summary:'Brief fixture'}]};}}})},
    './general':{tavilySearch:async(...args)=>{state.searches.push(args);return {results};}},
    '../utils/skillPreferences':{readSkillPreferences:()=>prefs,readSkillPreferencesSnapshot:()=>prefsUnavailable?{ok:false,error:'read_failed'}:{ok:true,text:prefs,revision:'fixture',exists:!!prefs},formatSkillPreferencesBlock:()=>prefs},
    '../utils/logger':{info:()=>{},warn:(...args)=>state.warnings.push(args)},
    '../utils/extractJson':{extractFirstJsonObject:t=>t},
    '../utils/calendarListingFormat':{calendarListingFormatRule:()=>''},
  };
  function load(file,addition='') {
    const compiled=ts.transpileModule(fs.readFileSync(file,'utf8')+addition,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
    const sandbox={exports:{},URL,Intl,setTimeout,clearTimeout,process:{cwd:()=>'/isolated-news-review'},require:name=>{
      if(Object.hasOwn(dependencies,name))return dependencies[name];
      if(file.endsWith('briefs.ts'))return {}; // non-composer dependencies are not called
      throw Error('Unmocked dependency: '+name);
    }};
    vm.runInNewContext(compiled,sandbox,{filename:file});return sandbox.exports;
  }
  const news=load(sourcePath);dependencies['../skills/news']=news;
  return {state,profile:p,news,brief:()=>load(path.join(root,'src/tasks/briefs.ts'),'\nexport const newsReviewCompose = generateBriefingText;').newsReviewCompose,
    tool:args=>new news.NewsSkill().executeToolCall('news',args,{profile:p,senderRole:'owner',authority:'owner',surface:'owner_dm',channel:'slack'}),
    gather:()=>news.gatherNews(p,{topic:'Market news'}),
    write:(sources,text)=>news.writeSeenLog(p,{goals:['Market news'],sources},text===undefined?{}:{briefText:text})};
}
function capture(name,h){captures.push({name,requests:h.state.requests,searches:h.state.searches});}
const mixed='## 2026-09-13\n• FRESH-CONTROL\n\n## 2026-09-12\n• EXPIRED-STORY';
test('expired seen sections are pruned on read without a write',()=>{const h=harness({log:mixed});assert.equal(h.news.readSeenLog(h.profile),'## 2026-09-13\n• FRESH-CONTROL');assert.equal(h.state.log,mixed);});
test('control current seen sections remain available',()=>{const log='## 2026-09-19\n• CURRENT';const h=harness({log});assert.equal(h.news.readSeenLog(h.profile),log);});
test('owner timezone selects the inclusive seven local days',()=>{const log='## 2026-09-12\n• LOCAL-CONTROL\n\n## 2026-09-11\n• TOO-OLD';const h=harness({log,zone:'America/Los_Angeles'});assert.equal(h.news.readSeenLog(h.profile),'## 2026-09-12\n• LOCAL-CONTROL');});
test('expired history does not trigger dedup model call',async()=>{const h=harness({log:'## 2026-09-01\n• EXPIRED',results:[{url:'https://daily.example/current',content:'Current evidence'}]});const bundle=await h.gather();capture('expired-gather',h);assert.equal(bundle.sources.length,1);assert.equal(h.state.requests.length,0);});
test('recent history reaches classifier while expired history is absent',async()=>{const h=harness({log:mixed,results:[{url:'https://daily.example/current',content:'Current evidence'}]});await h.gather();capture('dedup-model-input',h);const req=JSON.stringify(h.state.requests);assert.ok(req.includes('FRESH-CONTROL'));assert.ok(!req.includes('EXPIRED-STORY'));});
test('actual morning compose input excludes expired log and carries snippet evidence',async()=>{const h=harness({log:mixed});await h.brief()([],h.profile,{}, {goals:[],sources:[source('https://daily.example/current')]});capture('morning-compose-input',h);const req=JSON.stringify(h.state.requests);assert.ok(req.includes('Evidence from the search snippet.'));assert.ok(req.includes('FRESH-CONTROL'));assert.ok(!req.includes('EXPIRED-STORY'));});
test('on-demand system guidance excludes expired log',()=>{const h=harness({log:mixed});const prompt=new h.news.NewsSkill().getSystemPromptSection(h.profile,['news'],true);assert.ok(prompt.includes('FRESH-CONTROL'));assert.ok(!prompt.includes('EXPIRED-STORY'));});
test('control unavailable seen file returns empty and gather stays usable',async()=>{const h=harness({log:mixed,readFail:true,results:[{url:'https://daily.example/current'}]});assert.equal(h.news.readSeenLog(h.profile),'');assert.equal((await h.gather()).sources.length,1);assert.equal(h.state.writes.length,0);});
for(const [name,shown,unshown] of [
 ['query identity','https://youtube.com/watch?v=shown','https://youtube.com/watch?v=unshown'],
 ['path case identity','https://daily.example/Report','https://daily.example/report'],
 ['path prefix identity','https://daily.example/report-long','https://daily.example/report'],
])test('shown-only matching preserves '+name,async()=>{const h=harness();await h.write([source(shown,'SHOWN'),source(unshown,'UNSHOWN')],'<'+shown+'|source>');capture(name,h);const input=JSON.stringify(h.state.requests);assert.ok(input.includes('SHOWN'));assert.ok(!input.includes('UNSHOWN'));assert.equal(h.state.writes.length,1);});
test('control normalized tracking citation logs the displayed source',async()=>{const h=harness();await h.write([source('http://www.daily.example/Report/?utm_source=feed','TRACKED')],'<https://daily.example/Report|source>');assert.ok(JSON.stringify(h.state.requests).includes('TRACKED'));assert.equal(h.state.writes.length,1);});
test('control uncited bundle writes nothing',async()=>{const h=harness();await h.write([source('https://daily.example/report')],'No news shown.');assert.equal(h.state.requests.length,0);assert.equal(h.state.writes.length,0);});
test('successful empty summary is no new stories and writes nothing',async()=>{const h=harness({summary:'',log:'## 2026-09-19\n• ALREADY COVERED'});await h.write([source('https://daily.example/report')]);assert.equal(h.state.writes.length,0);assert.equal(h.state.log,'## 2026-09-19\n• ALREADY COVERED');});
test('control model failure preserves title fallback',async()=>{const h=harness({modelFail:true});await h.write([source('https://daily.example/report','TITLE-FALLBACK')]);assert.ok(h.state.log.includes('TITLE-FALLBACK'));assert.equal(h.state.writes.length,1);});
test('control successful summary persists and repeated writes serialize',async()=>{const h=harness();await Promise.all([h.write([source('https://daily.example/a')]),h.write([source('https://daily.example/b')])]);assert.equal(h.state.writes.length,2);assert.ok(JSON.stringify(h.state.requests[1]).includes('Current story'));});
test('control write failure remains non-fatal and leaves prior log',async()=>{const h=harness({log:'## 2026-09-19\n• PRIOR',writeFail:true});await h.write([source('https://daily.example/report')]);assert.equal(h.state.log,'## 2026-09-19\n• PRIOR');assert.equal(h.state.writes.length,0);});
process.on('exit',()=>{if(process.env.NEWS_CAPTURE_FILE)fs.writeFileSync(process.env.NEWS_CAPTURE_FILE,JSON.stringify({limitation:'Captured mocked model inputs prove inclusion, not model obedience or live factual accuracy.',captures},null,2));});

test('control valid Slack citation preserves parentheses without marking its prefix seen',async()=>{
  const h=harness();await h.write([source('https://daily.example/report_(2026)','PARENTHESIS-SHOWN'),source('https://daily.example/report_(2026','PARTIAL-UNSHOWN')],'<https://daily.example/report_(2026)|report>');
  assert.equal(h.state.writes.length,1);const input=JSON.stringify(h.state.requests);assert.ok(input.includes('PARENTHESIS-SHOWN'));assert.ok(!input.includes('PARTIAL-UNSHOWN'));
});
test('settings planner receives full owner text and Tavily receives source filters and recency',async()=>{
  const prefs='OWNER-DISPLAY-RULE: Brief Hebrew bullets, prefer outlet.example, avoid blocked.example.';
  const h=harness({prefs,plan:{goals:['Market news'],preferred_domains:['outlet.example'],avoid_domains:['blocked.example']},results:[{url:'https://outlet.example/report',content:'search evidence'}]});
  const bundle=await h.news.gatherNews(h.profile,{meetingCompanies:['Acme'],recencyDays:3});
  assert.ok(JSON.stringify(h.state.requests[0]).includes(prefs));assert.ok(JSON.stringify(h.state.requests[0]).includes('Acme'));
  assert.equal(h.state.searches[0][0],'Market news');assert.equal(h.state.searches[0][2],3);
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.searches[0][3])),{maxResults:15,includeDomains:['outlet.example'],excludeDomains:['blocked.example']});
  await h.brief()([],h.profile,{},bundle);capture('settings-to-search-and-morning-display',h);assert.ok(JSON.stringify(h.state.requests.at(-1)).includes(prefs));
  assert.ok(new h.news.NewsSkill().getSystemPromptSection(h.profile,['news'],true).includes(prefs));
});
test('preferred source miss retries broadly while retaining exclusions',async()=>{
  const h=harness({prefs:'Prefer outlet.example; avoid blocked.example',plan:{goals:['Market news'],preferred_domains:['outlet.example'],avoid_domains:['blocked.example']}});
  await h.news.gatherNews(h.profile);assert.equal(h.state.searches.length,2);assert.equal(h.state.searches[1][3].includeDomains,undefined);assert.deepEqual(Array.from(h.state.searches[1][3].excludeDomains),['blocked.example']);capture('preferred-source-fallback',h);
});
test('control explicit raw gather retains compose settings without a tool-emitted policy',async()=>{
  const prefs='OWNER-SETTING avoid blocked.example';const h=harness({prefs,results:[{url:'https://blocked.example/report',content:'search evidence'}]});
  const bundle=await h.gather();assert.equal(h.state.requests.length,0);assert.equal(h.state.searches[0][3].excludeDomains,undefined);assert.equal(bundle.sources.length,1);
  const prompt=new h.news.NewsSkill().getSystemPromptSection(h.profile,['news'],true);assert.ok(prompt.includes(prefs));capture('explicit-topic-current-limit',h);
});

test('direct-topic existing call supplies standing domains to Tavily with no planner',async()=>{
 const h=harness({prefs:'Prefer outlet.example. Avoid blocked.example.'});await h.tool({topic:'Exact requested topic',preferred_domains:['outlet.example'],avoid_domains:['blocked.example']});
 assert.equal(h.state.searches[0][0],'Exact requested topic');assert.deepEqual(Array.from(h.state.searches[0][3].includeDomains||[]),['outlet.example']);assert.deepEqual(Array.from(h.state.searches[0][3].excludeDomains||[]),['blocked.example']);assert.equal(h.state.requests.length,0);capture('direct-topic-standing-policy',h);
});
test('request-only override does not alter saved defaults for next direct-topic call',async()=>{
 const prefs='Prefer outlet.example; avoid blocked.example and unrelated.example';const h=harness({prefs});
 await h.tool({topic:'Topic',preferred_domains:['blocked.example'],avoid_domains:['unrelated.example']});
 await h.tool({topic:'Topic',preferred_domains:['outlet.example'],avoid_domains:['blocked.example','unrelated.example']});
 assert.deepEqual(Array.from(h.state.searches[0][3].includeDomains||[]),['blocked.example']);assert.deepEqual(Array.from(h.state.searches[0][3].excludeDomains||[]),['unrelated.example']);
 assert.deepEqual(Array.from(h.state.searches[2][3].includeDomains||[]),['outlet.example']);assert.deepEqual(Array.from(h.state.searches[2][3].excludeDomains||[]),['blocked.example','unrelated.example']);assert.equal(h.state.requests.length,0);assert.equal(h.state.writes.length,0);assert.ok(new h.news.NewsSkill().getSystemPromptSection(h.profile,['news'],true).includes(prefs));capture('one-request-source-override',h);
});
for(const [label,args] of [['missing',{}],['invalid',{preferred_domains:[],avoid_domains:['invalid']}],['incomplete',{preferred_domains:[]}],['over-cap',{preferred_domains:[],avoid_domains:Array.from({length:9},(_,i)=>'blocked'+i+'.example')}],['contradiction',{preferred_domains:['blocked.example'],avoid_domains:['blocked.example']}]])test('settings policy '+label+' returns explicit error without broad search',async()=>{
 const h=harness({prefs:'Do not use blocked.example'});const result=await h.tool({topic:'Topic',...args});assert.equal(result.error,'invalid_news_source_policy');assert.equal(h.state.searches.length,0);assert.equal(h.state.requests.length,0);
});
test('control deliberately empty effective source lists allow unrestricted direct-topic search',async()=>{
 const h=harness({prefs:'Display two concise bullets.'});const result=await h.tool({topic:'Topic',preferred_domains:[],avoid_domains:[]});assert.equal(result.error,undefined);assert.equal(h.state.searches.length,1);assert.equal(h.state.searches[0][3].includeDomains,undefined);assert.equal(h.state.requests.length,0);
});
test('unavailable standing preferences return explicit error without searching',async()=>{
 const h=harness({prefsUnavailable:true});const result=await h.tool({topic:'Topic',preferred_domains:[],avoid_domains:[]});assert.equal(result.error,'news_preferences_unavailable');assert.equal(h.state.searches.length,0);
});
test('tool-emitted domains reject blocked provider results while preserving allowed source',async()=>{
 const h=harness({prefs:'Avoid blocked.example',results:[{url:'https://sub.blocked.example/a',content:'blocked'},{url:'https://allowed.example/a',content:'allowed'}]});
 const result=await h.tool({topic:'Topic',preferred_domains:[],avoid_domains:['blocked.example']});assert.deepEqual(Array.from(result.sources,x=>x.url),['https://allowed.example/a']);capture('provider-domain-enforcement',h);
});
test('gather merges tracking variants but preserves distinct content query and path case',async()=>{
 const urls=['https://www.daily.example/Report?utm_source=one','http://daily.example/Report/?utm_source=two','https://daily.example/watch?v=one','https://daily.example/watch?v=two','https://daily.example/report'];const h=harness({results:urls.map(url=>({url,content:'evidence'}))});
 const result=await h.gather();assert.deepEqual(Array.from(result.sources,x=>x.url),[urls[0],urls[2],urls[3],urls[4]]);
});
test('capture actual source-policy tool schema and already-loaded owner settings',()=>{
 const h=harness({prefs:'OWNER-SOURCE-PREFERENCES'}),skill=new h.news.NewsSkill();const tool=skill.getTools(h.profile)[0];const prompt=skill.getSystemPromptSection(h.profile,['news'],true);assert.ok(prompt.includes('OWNER-SOURCE-PREFERENCES'));const general=skill.getSystemPromptSection(h.profile,['general'],true),offscope=skill.getSystemPromptSection(h.profile,['meetings'],true),colleague=skill.getSystemPromptSection(h.profile,['news'],false);assert.ok(general.includes('OWNER-SOURCE-PREFERENCES'));assert.ok(!offscope.includes('OWNER-SOURCE-PREFERENCES'));assert.equal(colleague,'');captures.push({name:'actual-tool-contract-and-news-prompt',tools:[tool],prompt,general,offscope,colleague,chars:{tools:JSON.stringify([tool]).length,prompt:prompt.length,general:general.length,offscope:offscope.length,colleague:colleague.length}});assert.ok(tool.input_schema.properties.preferred_domains);assert.ok(tool.input_schema.properties.avoid_domains);
});

test('no-topic gather retains one existing planner and applies current effective source policy',async()=>{
 const h=harness({prefs:'Standing news settings',plan:{goals:['Planned topic'],preferred_domains:['old.example'],avoid_domains:['other.example']}});
 await h.news.gatherNews(h.profile,{sourcePolicy:{preferredDomains:['request.example'],avoidDomains:['preserved.example']}});assert.equal(h.state.requests.length,1);assert.equal(h.state.searches[0][0],'Planned topic');assert.deepEqual(Array.from(h.state.searches[0][3].includeDomains),['request.example']);assert.deepEqual(Array.from(h.state.searches[1][3].excludeDomains),['preserved.example']);capture('no-topic-effective-policy',h);
});
test('control default morning source policy still follows existing planner settings',async()=>{
 const h=harness({prefs:'Standing news settings',plan:{goals:['Planned topic'],preferred_domains:['old.example'],avoid_domains:['other.example']}});await h.news.gatherNews(h.profile);assert.equal(h.state.requests.length,1);assert.deepEqual(Array.from(h.state.searches[0][3].includeDomains),['old.example']);assert.deepEqual(Array.from(h.state.searches[1][3].excludeDomains),['other.example']);
});
test('control untaught direct-topic call remains usable without source arguments or planner',async()=>{
 const h=harness();await h.tool({topic:'Topic'});assert.equal(h.state.searches.length,1);assert.equal(h.state.requests.length,0);
});

test('on-demand tool does not mark candidates seen before any reply is delivered',async()=>{
 const h=harness({results:[{url:'https://daily.example/report',title:'RETURNED-CANDIDATE',content:'candidate evidence'}]});const result=await h.tool({topic:'Topic'});await new Promise(resolve=>setImmediate(resolve));assert.equal(result.sources.length,1);assert.equal(h.state.writes.length,0);assert.equal(h.state.requests.length,0);
});
test('combined delivered bundles dedup identities before seen-summary source limit',async()=>{
 const h=harness(),first=source('https://daily.example/one','REPEATED-CANDIDATE'),last=source('https://daily.example/two','OTHER-DISPLAYED');await h.write([...Array(9).fill(first),last],'<https://daily.example/one|one> <https://daily.example/two|two>');const input=JSON.stringify(h.state.requests);assert.ok(input.includes('OTHER-DISPLAYED'));assert.equal(input.split('REPEATED-CANDIDATE').length-1,1);assert.equal(h.state.writes.length,1);
});

test('distinct version developments keep both seen-history facts',async()=>{
 const prior='• Orion released version 1 security fixes for its browser platform [daily.example]';const next='• Orion released version 2 security fixes for its browser platform [daily.example]';const h=harness({log:'## 2026-09-19\n'+prior,summary:next});await h.write([source('https://daily.example/version2')]);assert.ok(h.state.log.includes(prior));assert.ok(h.state.log.includes(next));
});
test('control exactly repeated seen-history line remains a single record',async()=>{
 const line='• Orion released version 1 security fixes for its browser platform [daily.example]';const h=harness({log:'## 2026-09-19\n'+line,summary:line});await h.write([source('https://daily.example/version1')]);assert.equal(h.state.log.split(line).length-1,1);
});

test('source policy blocks equivalent terminal-dot host and subdomains, preserving unrelated host',async()=>{
 const h=harness({prefs:'Avoid blocked.example',results:[{url:'https://blocked.example./article',content:'blocked dot'},{url:'https://sub.blocked.example./article',content:'blocked subdomain dot'},{url:'https://sub.blocked.example/article',content:'blocked subdomain'},{url:'https://allowed.example/article',content:'allowed'}]});
 const result=await h.tool({topic:'Topic',preferred_domains:[],avoid_domains:['blocked.example']});assert.deepEqual(Array.from(result.sources,s=>s.url),['https://allowed.example/article']);
});
test('source policy admits preferred terminal-dot host and subdomain without broadening',async()=>{
 const urls=['https://preferred.example./article','https://sub.preferred.example./article','https://sub.preferred.example/article'];const h=harness({prefs:'Prefer preferred.example',results:urls.map(url=>({url,content:'allowed'}))});const result=await h.tool({topic:'Topic',preferred_domains:['preferred.example'],avoid_domains:[]});assert.deepEqual(Array.from(result.sources,s=>s.url),urls);assert.equal(h.state.searches.length,1);
});
test('control source policy retains ordinary allowed hosts and preferred subdomains',async()=>{
 const urls=['https://preferred.example/article','https://sub.preferred.example/article'];const h=harness({prefs:'Prefer preferred.example; avoid blocked.example',results:[...urls.map(url=>({url,content:'allowed'})),{url:'https://blocked.example/article',content:'blocked'}]});const result=await h.tool({topic:'Topic',preferred_domains:['preferred.example'],avoid_domains:['blocked.example']});assert.deepEqual(Array.from(result.sources,s=>s.url),urls);assert.equal(h.state.searches.length,1);
});
