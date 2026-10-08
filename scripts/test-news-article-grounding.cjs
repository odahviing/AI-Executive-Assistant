// Actual general/news/brief modules; only transport, configuration, storage and model boundaries mocked.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {EventEmitter}=require('node:events');
const root=path.resolve(__dirname,'..');
const profile={user:{name:'News Fixture',company:'Reflectiz',email:'owner@reflectiz.com',timezone:'UTC',language:'en'},assistant:{name:'Maelle'}};
const incident='https://publisher.example/report';
// Minimal original fixture matching observed live DOM topology, not copied article text.
const html=(body,extra='')=>`<html><body><div role="navigation"><a href="/different-story">Reflectiz launch</a></div><article><h1>Security review</h1><div class="entry-content">${body}</div><div class="post-related">${extra}</div></article></body></html>`;
function fixture({pages={[incident]:{html:html('<p>Seven autonomous testing tools were evaluated.</p>')}},results=[{url:incident,title:'Reflectiz in tool review',content:'Seven tools. Reflectiz launch.'}],goals=['Reflectiz mentions']}={}) {
 const state={requests:[],lookups:[],searches:[],models:[],unexpected:[],aborted:0};
 const transport={request:(url,options,onResponse)=>{
  const req=new EventEmitter(); let ended=false;
  const abort=()=>{ended=true;state.aborted++;req.emit('error',Error('aborted'));};
  options.signal.addEventListener('abort',abort,{once:true});
  req.end=()=>{state.requests.push(String(url));
   const deliver=()=>{if(ended)return; const page=pages[String(url)]||{};
    if(page.hang)return;
    if(page.error){options.signal.removeEventListener('abort',abort);req.emit('error',Error('network'));return;}
    const res=new EventEmitter();res.statusCode=page.status||200;res.headers={'content-type':page.type||'text/html',...(page.location?{location:page.location}:{})};res.complete=!page.incomplete;
    res.destroy=err=>{ended=true;options.signal.removeEventListener('abort',abort);if(err)res.emit('error',err);};
    onResponse(res);
    queueMicrotask(()=>{if(ended)return;res.emit('data',Buffer.from(page.html||''));if(ended)return;options.signal.removeEventListener('abort',abort);res.emit('end');});
   };
   if(require('node:net').isIP(url.hostname.replace(/^\[|\]$/g,'')))queueMicrotask(deliver);
   else options.lookup(url.hostname,{all:true},(err,addresses)=>{if(err){options.signal.removeEventListener('abort',abort);req.emit('error',err);}else{assert.ok(addresses.every(a=>a.address==='93.184.216.34'));queueMicrotask(deliver);}});
  };return req;
 }};
 const dependencies={
  'node:http':transport,'node:https':transport,'node:net':require('node:net'),
  'node:dns':{lookup:(host,opts,cb)=>{state.lookups.push(host);cb(null,host==='private.example'?[{address:'10.0.0.1',family:4}]:host==='mixed.example'?[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}]:[{address:'93.184.216.34',family:4}]);}},
  'ipaddr.js':require('ipaddr.js'),'cheerio':require('cheerio'),
  '../config':{config:{}},'../llm/models':{MODEL_HAIKU:'fixture',SONNET:{model:'fixture'}},
  '../llm/client':{getAnthropicClient:()=>({messages:{create:async req=>{state.models.push(req);return {content:[{type:'text',text:JSON.stringify({goals})}]};}}})},
  '../utils/logger':{info:()=>{},warn:()=>{},error:()=>{}},'../utils/extractJson':{extractFirstJsonObject:t=>t},
  fs:{existsSync:()=>false,promises:{},readFileSync:()=>{throw Error('unexpected disk read');}},path,luxon:require('luxon'),
  '../utils/skillPreferences':{readSkillPreferencesSnapshot:()=>({ok:true,text:'',revision:'fixture'}),formatSkillPreferencesBlock:()=>''},
  '../utils/calendarListingFormat':{calendarListingFormatRule:()=>''},
 };
 function load(file,addition=''){
  const source=fs.readFileSync(file,'utf8')+addition;
  const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  const sandbox={exports:{},URL,Intl,Buffer,AbortSignal,setTimeout,clearTimeout,process:{cwd:()=>'/isolated-news'},require:name=>{
   if(Object.hasOwn(dependencies,name))return dependencies[name];
   if(file.endsWith('briefs.ts'))return {};
   state.unexpected.push(name);throw Error('Unexpected dependency '+name);
  }};
  vm.runInNewContext(compiled,sandbox,{filename:file});return sandbox.exports;
 }
 const general=load(path.join(root,'src/skills/general.ts'));
 dependencies['./general']={...general,tavilySearch:async(...args)=>{state.searches.push(args);return {results};}};
 const news=load(process.env.NEWS_SOURCE_FIXTURE||path.join(root,'src/skills/news.ts'));
 dependencies['../skills/news']=news;
 return {state,general,news,
  gather:async(topic='Reflectiz mentions')=>{const b=await news.gatherNews(profile,topic===null?{meetingCompanies:['Fixture']}:{topic});assert.deepEqual(state.unexpected,[]);return b;},
  tool:()=>new news.NewsSkill().executeToolCall('news',{topic:'Market security'},{profile}),
  compose:b=>load(path.join(root,'src/tasks/briefs.ts'),'\nexport const testCompose = generateBriefingText;').testCompose([],profile,{},b),
 };
}
test('regression: navigation-only mention cannot qualify for company goal',async()=>{assert.equal((await fixture().gather()).sources.length,0);});
test('regression: topic sources contain body evidence, no navigation or search-title attribution',async()=>{const b=await fixture().gather('Market security');assert.equal(b.sources.length,1);assert.equal(b.sources[0].title,'Security review');assert.ok(!JSON.stringify(b.sources).includes('Reflectiz'));});
test('regression: Hebrew navigation is excluded structurally',async()=>{const f=fixture({pages:{[incident]:{html:'<nav>חדשות Reflectiz</nav><article><h1>סקירה</h1><p>כלי בדיקה חדשים</p></article>'}}});assert.equal((await f.gather()).sources.length,0);});
test('preserved: legitimate body-only English mention qualifies',async()=>{const f=fixture({pages:{[incident]:{html:html('<p>Researchers compared Reflectiz with other products.</p>')}}});assert.equal((await f.gather()).sources.length,1);});
test('preserved: legitimate Hebrew body mention qualifies',async()=>{const f=fixture({pages:{[incident]:{html:html('<p>החוקרים השוו את Reflectiz לכלים נוספים.</p>')}}});assert.equal((await f.gather()).sources.length,1);});
test('regression: late body mention survives snippet bound',async()=>{const f=fixture({pages:{[incident]:{html:html('<p>'+('Background. '.repeat(80))+'</p><p>Reflectiz was evaluated.</p>')}},results:[{url:incident,content:'Security review'}]});const b=await f.gather();assert.equal(b.sources.length,1);assert.ok(b.sources[0].snippet.includes('Reflectiz'));});
test('preserved: unrelated article remains available for topic goal',async()=>{assert.equal((await fixture().gather('Market security')).sources.length,1);});
test('regression: unavailable article never falls back to contaminated search snippet',async()=>{const f=fixture({pages:{[incident]:{error:true}}});assert.equal((await f.gather()).sources.length,0);});
test('regression: multiple listing articles are not one source body',async()=>{const f=fixture({pages:{[incident]:{html:'<article>Reflectiz</article><article>Another story</article>'}}});assert.equal((await f.gather()).sources.length,0);});
test('regression: related sidebar within article is excluded',async()=>{const f=fixture({pages:{[incident]:{html:'<article><h1>Tools</h1><p>Security tools reviewed.</p><aside>Reflectiz</aside><div class="post-related">Reflectiz</div></article>'}}});assert.equal((await f.gather()).sources.length,0);});
test('regression: same URL shares one structural read across goals',async()=>{const f=fixture({goals:['Reflectiz mentions','Market security']});const b=await f.gather(null);assert.equal(b.sources.length,1);assert.equal(f.state.requests.length,1);assert.equal(f.state.models.length,1);});
test('regression: actual on-demand consumer receives only article evidence',async()=>{const f=fixture();const out=await f.tool();assert.equal(out.sources.length,1);assert.ok(!JSON.stringify(out.sources).includes('Reflectiz'));assert.equal(f.state.models.length,0);});
test('regression: actual briefing composer input receives only article evidence',async()=>{const f=fixture();await f.compose(await f.gather('Market security'));const input=JSON.stringify(f.state.models.at(-1));assert.ok(input.includes('Seven autonomous testing tools'));assert.ok(!input.includes('Reflectiz in tool review'));assert.ok(!input.includes('Reflectiz launch'));});
for(const url of ['file:///etc/passwd','http://127.0.0.1/a','http://2130706433/a','http://[::1]/a','http://[::ffff:127.0.0.1]/a','http://169.254.169.254/a','https://user:pass@publisher.example/a','https://publisher.example:8443/a','https://private.example/a','https://mixed.example/a'])test('reader rejects unsafe URL '+url,async()=>{const f=fixture();assert.equal(await f.general.readNewsArticle(url,100),null);});
test('reader validates redirect destination',async()=>{const f=fixture({pages:{[incident]:{status:302,location:'http://169.254.169.254/latest'}}});assert.equal(await f.general.readNewsArticle(incident,100),null);assert.equal(f.state.requests.length,1);});
test('reader permits public relative redirect',async()=>{const f=fixture({pages:{[incident]:{status:302,location:'/final'},'https://publisher.example/final':{html:html('<p>Reflectiz body</p>')}}});assert.ok((await f.general.readNewsArticle(incident,100)).content.includes('Reflectiz'));assert.equal(f.state.lookups.length,2);});
test('reader bounds redirect loops',async()=>{const f=fixture({pages:{[incident]:{status:302,location:'/report'}}});assert.equal(await f.general.readNewsArticle(incident,100),null);assert.equal(f.state.requests.length,6);});
test('reader aborts hung response',async()=>{const f=fixture({pages:{[incident]:{hang:true}}});const keepAlive=setTimeout(()=>{},500);const start=Date.now();assert.equal(await f.general.readNewsArticle(incident,20),null);clearTimeout(keepAlive);assert.ok(Date.now()-start<400);assert.equal(f.state.aborted,1);});
for(const [name,page] of [['nonhtml',{type:'application/json',html:'Reflectiz'}],['oversize',{html:'x'.repeat(2*1024*1024+1)}],['incomplete',{html:html('<p>Reflectiz</p>'),incomplete:true}],['unmarked',{html:'<div>Reflectiz</div>'}],['HTTP error',{status:503,html:html('<p>Reflectiz</p>')}]])test('reader withholds '+name,async()=>{const f=fixture({pages:{[incident]:page}});assert.equal(await f.general.readNewsArticle(incident,100),null);});
test('reader uses articleBody instead of broad wrapper related card',async()=>{const f=fixture({pages:{[incident]:{html:'<article><h1>Review</h1><section itemprop="articleBody"><p>Actual tools discussed.</p></section><div class="unrecognized-card"><a>Reflectiz</a></div></article>'}}});assert.equal((await f.gather()).sources.length,0);});
test('reader excludes nested related article inside explicit articleBody',async()=>{const f=fixture({pages:{[incident]:{html:'<article><section itemprop="articleBody"><p>Tool comparison.</p><article><a>Reflectiz related story</a></article></section></article>'}}});assert.equal((await f.gather()).sources.length,0);});
test('reader retains inline linked company mention in explicit body',async()=>{const f=fixture({pages:{[incident]:{html:'<article><h1>Review</h1><section itemprop="articleBody"><p>Researchers compared <a href="https://reflectiz.com">Reflectiz</a> products.</p></section></article>'}}});assert.equal((await f.gather()).sources.length,1);});
test('regression: external redirect cannot bypass self-publisher exclusion',async()=>{const f=fixture({pages:{[incident]:{status:302,location:'https://reflectiz.com/report'},'https://reflectiz.com/report':{html:html('<p>Reflectiz announcement</p>')}}});assert.equal((await f.gather()).sources.length,0);});
test('regression: final citation identifies actual public destination',async()=>{const f=fixture({pages:{[incident]:{status:302,location:'/final'},'https://publisher.example/final':{html:html('<p>Reflectiz assessment</p>')}}});assert.equal((await f.gather()).sources[0].url,'https://publisher.example/final');});
test('preserved: one unavailable candidate leaves useful topic article',async()=>{const f=fixture({results:[{url:incident,content:'Reflectiz launch'},{url:'https://publisher.example/missing',content:'Reflectiz unavailable'}]});assert.equal((await f.gather('Market security')).sources.length,1);});
test('reader retry uses a new ephemeral gather, never persists failed evidence',async()=>{const pages={[incident]:{error:true}};const f=fixture({pages});assert.equal((await f.gather()).sources.length,0);pages[incident]={html:html('<p>Reflectiz body</p>')};assert.equal((await f.gather()).sources.length,1);assert.equal(f.state.requests.length,2);});
