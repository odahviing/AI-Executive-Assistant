// Actual SearchSkill -> provider fetch and research PLAN/GATHER/READ execution.
// Provider/LLM responses are isolated fixtures; no network or application boot.
const assert=require('node:assert/strict'),{test}=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const root=path.resolve(__dirname,'..');
const source=process.argv.includes('--before')?'artifacts/workshop-verification/full-review-20260919/librarian/search-before/src/skills/general.ts':'src/skills/general.ts';
const code=ts.transpileModule(fs.readFileSync(path.join(root,source),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
function harness(o={}){
 const calls=[],timeouts=[],planner=[];
 const config={TAVILY_API_KEY:o.provider==='tavily'||!o.provider?'fixture':'',BRAVE_SEARCH_API_KEY:o.provider==='brave'?'fixture':''};
 const noop=()=>{};
 const mocks={
  '../config':{config},'../llm/models':{},'../utils/logger':{__esModule:true,default:{info:noop,warn:noop,error:noop}},
  '../utils/extractJson':{extractFirstJsonObject:s=>s},
  '../llm/client':{getAnthropicClient:()=>({messages:{create:async x=>{planner.push(x);if(o.plannerFails)throw Error('planner unavailable');return {content:[{type:'text',text:JSON.stringify({queries:o.queries||['query'],recency_days:o.plannerDays})}]};}}})},
 };
 class Clock extends Date {constructor(...a){super(...(a.length?a:['2026-09-19T12:00:00Z']));}static now(){return Date.parse('2026-09-19T12:00:00Z');}}
 const fetch=async(url,init)=>{
  const req={url:String(url),init,body:init.body?JSON.parse(init.body):null};calls.push(req);
  if(o.hang)return new Promise((resolve,reject)=>{if(init.signal)init.signal.addEventListener('abort',()=>reject(Error('timeout')),{once:true});});
  if(o.throwFetch)throw Error('provider unavailable');
  const status=o.httpStatus||200;
  const extract=req.url.includes('/extract');
  let data;
  if(extract){const requested=req.body.urls[0];data=o.extractions?.[requested]??o.extract??{results:[{url:requested,raw_content:'Grounded article content for '+requested}]};}
  else if(req.url.includes('tavily'))data=o.searches?.[req.body.query]??o.search??{answer:'Grounded answer',results:[{url:'https://source.example/a',title:'A',content:'Search snippet'}]};
  else if(req.url.includes('brave'))data={web:{results:[{url:'https://source.example/brave',title:'Brave result',description:'Grounded description'}]}};
  else data={AbstractText:'Evergreen description',AbstractURL:'https://source.example/ddg'};
  return {ok:status===200,status,json:async()=>data,text:async()=>JSON.stringify(data)};
 };
 const mod={exports:{}};
 vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{fetch,AbortSignal:{timeout:ms=>{timeouts.push(ms);const c=new AbortController();if(o.hang)setTimeout(()=>c.abort(),5);return c.signal;}},Date:Clock,console,Set,Map},{filename:source})(s=>{if(!(s in mocks))throw Error('Unexpected require '+s);return mocks[s];},mod,mod.exports);
 const skill=new mod.exports.SearchSkill();
 return {api:mod.exports,calls,timeouts,planner,tool:(name,args)=>skill.executeToolCall(name,args,{senderRole:o.role||'owner',channel:'slack'})};
}
for(const provider of ['brave','ddg']){
 test('S1 '+provider+' hung fallback aborts and tool returns unavailable',async()=>{const h=harness({provider,hang:true});const result=await Promise.race([h.tool('web_search',{query:'stable background'}),new Promise(r=>setTimeout(()=>r({hung:true}),50))]);assert.equal(result.hung,undefined);assert.match(result.error,/unavailable/);assert.equal(h.timeouts[0],8000);});
 test('S1 '+provider+' successful evergreen fallback retains sourced content',async()=>{const h=harness({provider});const r=await h.tool('web_search',{query:'stable background'});assert.equal(r.error,undefined);assert.equal(h.calls.length,1);assert.ok(provider==='brave'?r.results[0].url:r.url);});
}
test('S1 empty Tavily evergreen fallback is bounded too',async()=>{const h=harness({search:{results:[]}});const r=await h.tool('web_search',{query:'evergreen'});assert.equal(r.abstract,'Evergreen description');assert.deepEqual(h.timeouts,[8000,8000]);});
test('S1 provider HTTP error remains explicit failure',async()=>{const h=harness({httpStatus:429});assert.match((await h.tool('web_search',{query:'x'})).error,/unavailable/);});
test('S2 Brave recency reaches provider freshness parameter',async()=>{const h=harness({provider:'brave'});await h.tool('web_search',{query:'recent funding',time_range_days:7});assert.equal(new URL(h.calls[0].url).searchParams.get('freshness'),'2026-09-12to2026-09-19');});
test('S2 Brave evergreen has no freshness constraint',async()=>{const h=harness({provider:'brave'});await h.tool('web_search',{query:'background'});assert.equal(new URL(h.calls[0].url).searchParams.has('freshness'),false);});
test('S2 DDG-only recency refuses unsourced date substitution',async()=>{const h=harness({provider:'ddg'});const r=await h.tool('web_search',{query:'this week',time_range_days:7});assert.equal(r.error,'recency_filter_unavailable');assert.equal(h.calls.length,0);assert.equal(r.abstract,undefined);});
test('S2 empty Tavily recent result never falls back to undated DDG',async()=>{const h=harness({search:{results:[]}});const r=await h.tool('web_search',{query:'this week',time_range_days:7});assert.equal(r.error,'recency_filter_unavailable');assert.equal(h.calls.length,1);});
test('S2 Tavily still forwards recency and preserves citations',async()=>{const h=harness();const r=await h.tool('web_search',{query:'recent',time_range_days:7});assert.equal(h.calls[0].body.days,7);assert.equal(h.calls[0].body.topic,'news');assert.equal(r.results[0].url,'https://source.example/a');});
test('S2 colleague search follows same provider recency policy',async()=>{const h=harness({provider:'ddg',role:'colleague'});assert.equal((await h.tool('web_search',{query:'latest',time_range_days:7})).error,'recency_filter_unavailable');});
test('S3 empty extracted page returns failure rather than success-shaped content',async()=>{const h=harness({extract:{results:[{url:'https://source.example/a',raw_content:''}]}});const r=await h.tool('web_extract',{url:'https://source.example/a'});assert.match(r.error,/No content/);assert.equal(r.content,undefined);});
test('S3 whitespace extracted page returns failure',async()=>{const h=harness({extract:{results:[{raw_content:' \n\t '}]}});assert.match((await h.tool('web_extract',{url:'https://source.example/a'})).error,/No content/);});
test('S3 missing extracted text returns failure',async()=>{const h=harness({extract:{results:[{url:'https://source.example/a'}]}});assert.match((await h.tool('web_extract',{url:'https://source.example/a'})).error,/No content/);});
test('S3 successful extraction preserves URL text images and existing cap',async()=>{const h=harness({extract:{results:[{url:'https://source.example/canonical',raw_content:'a'.repeat(9000),images:['https://source.example/image']}]}});const r=await h.tool('web_extract',{url:'https://source.example/a'});assert.equal(r.url,'https://source.example/canonical');assert.match(r.content,/Content truncated/);assert.equal(r.images.length,1);assert.equal(h.timeouts[0],45000);});
test('S3 zero extracted pages remains explicit failure',async()=>{const h=harness({extract:{results:[]}});assert.match((await h.tool('web_extract',{url:'https://source.example/a'})).error,/No content/);});
test('research empty extraction remains absent from sources and readings',async()=>{const h=harness({extract:{results:[{raw_content:' '}]}});const r=await h.tool('web_research',{goal:'research this'});assert.equal(r.sources.length,0);assert.equal(r.readings.length,0);assert.match(r.note,/could not be read/);});
test('research partial extraction cites only successfully read sources',async()=>{const a='https://source.example/a',b='https://source.example/b';const h=harness({search:{results:[{url:a},{url:b}]},extractions:{[a]:{results:[]},[b]:{results:[{raw_content:'B content'}]}}});const r=await h.tool('web_research',{goal:'research this'});assert.equal(r.sources.length,1);assert.equal(r.sources[0].url,b);assert.equal(r.readings[0].url,b);});
test('research round robin reads across planned query angles',async()=>{const h=harness({queries:['q1','q2'],searches:{q1:{results:[{url:'https://source.example/a'},{url:'https://source.example/b'},{url:'https://source.example/c'}]},q2:{results:[{url:'https://source.example/d'}]}}});const r=await h.tool('web_research',{goal:'research'});assert.deepEqual(Array.from(r.readings,x=>x.url),['https://source.example/a','https://source.example/d','https://source.example/b']);assert.deepEqual(h.timeouts,[8000,8000,8000,8000,8000]);});
test('research planner failure retains raw-goal fallback and explicit recency',async()=>{const h=harness({plannerFails:true});const r=await h.tool('web_research',{goal:'the original goal',recency_days:3});assert.equal(r.queries_used[0],'the original goal');assert.equal(h.calls[0].body.days,3);assert.equal(r.sources.length,1);});
test('research search unavailable ends with no fabricated readings',async()=>{const h=harness({throwFetch:true});const r=await h.tool('web_research',{goal:'research'});assert.equal(r.sources.length,0);assert.equal(r.readings.length,0);});
test('raw Tavily domain max and timeout inputs preserved',async()=>{const h=harness();await h.api.tavilySearch('query','basic',14,{includeDomains:['source.example'],excludeDomains:['exclude.example'],maxResults:15},12000);assert.deepEqual(h.calls[0].body.include_domains,['source.example']);assert.equal(h.calls[0].body.max_results,15);assert.equal(h.timeouts[0],12000);});
