// Actual Slack lookup, Connection adapter and shared name predicate; SDK is a fixture.
const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),cp=require('node:child_process'),ts=require('typescript');
const root=path.resolve(__dirname,'..'), before=process.env.SLACK_IDENTITY_BEFORE==='1';
const snapshot=process.env.SLACK_IDENTITY_SOURCE_ROOT;
function directory(pages){
 const requests=[],cache=new Map(), mocks={
  'src/utils/logger.ts':{__esModule:true,default:{info(){},warn(){},error(){}}},
  'src/connections/slack/eligibility.ts':{},'src/connections/slack/formatting.ts':{formatForSlack:s=>s},'src/db.ts':{},
 };
 function load(rel){
  if(mocks[rel])return mocks[rel];if(cache.has(rel))return cache.get(rel).exports;
  assert.ok(['src/connections/slack/index.ts','src/connections/slack/messaging.ts','src/memory/resolveAttendeeEmails.ts'].includes(rel),rel);
  const source=before&&rel==='src/connections/slack/messaging.ts'?cp.execFileSync('git',['show',`ea5e69c:${rel}`],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(snapshot||root,rel),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const mod={exports:{}};cache.set(rel,mod);
  const req=s=>s.startsWith('.')?load(path.posix.normalize(path.posix.join(path.posix.dirname(rel),s))+'.ts'):require(s);
  vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{console},{filename:rel})(req,mod,mod.exports);return mod.exports;
 }
 const conn=load('src/connections/slack/index.ts').createSlackConnection({client:{users:{list:async args=>{requests.push(args);const p=pages[requests.length-1];if(p instanceof Error)throw p;return p;}}}},'fixture',{user:{slack_user_id:'UOWNER'}});
 return {requests,find:q=>conn.findUserByName(q)};
}
const m=(id,real_name,name,display_name)=>({id,real_name,name,profile:{email:id.toLowerCase()+'@example.com',display_name}});
const page=members=>({ok:true,members});
test('reject substring-only real name, username and display alias',async()=>{
 for(const member of [m('UONE','Daniel Cohen','xyz','xyz'),m('UONE','X Y','daniel','X'),m('UONE','X Y','xyz','Daniel')])assert.equal((await directory([page([member])]).find('Dan')).length,0);
});
test('legitimate canonical whole token remains canonical',async()=>{const r=await directory([page([m('UONE','Dan Cohen','dan','Dan')])]).find('Dan');assert.equal(r.length,1);assert.equal(r[0].name,'Dan Cohen');});
test('legitimate unique display alias survives canonical projection',async()=>{const r=await directory([page([m('UONE','Daniel Cohen','dc','Dani')])]).find('Dani');assert.equal(r.length,1);assert.equal(r[0].name,'Daniel Cohen');});
test('legitimate unique username survives canonical projection',async()=>{const r=await directory([page([m('UONE','Daniel Cohen','dc_ops','Daniel')])]).find('dc_ops');assert.equal(r.length,1);assert.equal(r[0].id,'UONE');});
test('mixed real-name and display alias retain both identities',async()=>assert.equal((await directory([page([m('UONE','Dani Cohen','dc','Dani Cohen'),m('UTWO','Daniel Levy','dl','Dani')])]).find('Dani')).length,2));
test('reject substring impostor while retaining exact alias',async()=>{const r=await directory([page([m('UONE','Daniel Cohen','dc','Dani'),m('UTWO','Daniel Levy','dl','Dan')])]).find('Dan');assert.equal(r.length,1);assert.equal(r[0].id,'UTWO');});
test('duplicate page identities do not create false ambiguity',async()=>{const person=m('UONE','Dan Cohen','dc','Dan');assert.equal((await directory([page([person,person])]).find('Dan')).length,1);});
test('all pages retain mixed ambiguity',async()=>{const d=directory([{...page([m('UONE','Dani Cohen','dc','Dani Cohen')]),response_metadata:{next_cursor:'page2'}},page([m('UTWO','Daniel Levy','dl','Dani')])]);assert.equal((await d.find('Dani')).length,2);assert.equal(d.requests[1].cursor,'page2');});
test('incomplete directory failure cannot prove uniqueness',async()=>{const d=directory([{...page([m('UONE','Dan Cohen','dc','Dan')]),response_metadata:{next_cursor:'page2'}},Error('unavailable')]);assert.equal((await d.find('Dan')).length,0);});
test('cursor loop cannot prove uniqueness',async()=>{const p={...page([m('UONE','Dan Cohen','dc','Dan')]),response_metadata:{next_cursor:'same'}};assert.equal((await directory([p,p]).find('Dan')).length,0);});
test('explicit failed API response cannot prove uniqueness',async()=>assert.equal((await directory([{ok:false,members:[m('UONE','Dan Cohen','dc','Dan')]}]).find('Dan')).length,0));
test('empty input, deleted and bot accounts stay excluded',async()=>{const p=page([{...m('UONE','Dan Cohen','dc','Dan'),deleted:true},{...m('UTWO','Dan Levy','dl','Dan'),is_bot:true}]);assert.equal((await directory([p]).find('Dan')).length,0);assert.equal((await directory([p]).find(' ')).length,0);});
test('Unicode whole tokens preserve Hebrew names',async()=>{const r=await directory([page([m('UONE','דני כהן','dc','דני')])]).find('דני');assert.equal(r.length,1);});
