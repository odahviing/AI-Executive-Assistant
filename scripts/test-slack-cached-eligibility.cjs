const fs=require('fs'),path=require('path'),vm=require('vm'),ts=require('typescript'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..'), dir=path.join(root,'artifacts/workshop-verification/region-notice-rulings-20260929/slackmaster');
const source=fs.readFileSync(process.argv.includes('--before')?path.join(dir,'before-index.ts'):path.join(root,'src/connections/slack/index.ts'),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const row={slack_id:'UPAUL001',name:'Paul',state:'London',email:'paul@example.com'};
function harness(info={ok:true,user:{id:row.slack_id}},members=[],rows=[row],listResult) {
 let calls=0; const mod={exports:{}};
 const mocks={'./messaging':{},'./formatting':{},'./eligibility':{},'../../db':{searchPeopleMemory:()=>rows},'../../utils/logger':{default:{info(){},warn(){},error(){}},__esModule:true}};
 vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{})(s=>mocks[s],mod,mod.exports);
 const app={client:{users:{info:async()=>{calls++;if(info instanceof Error)throw info;return info},list:async()=>listResult??({ok:true,members})}}};
 const conn=mod.exports.createSlackConnection(app,'fixture',{user:{email:'owner@example.com'}});
 return {run:surface=>conn.executeToolCall('find_slack_user',{name:'Paul'},{surface}),calls:()=>calls};
}
const tests=[];const test=(id,fn)=>tests.push([id,fn]);
for(const surface of ['owner_dm','colleague_dm','room']){
 test('deleted-'+surface,async()=>{const r=await harness({ok:true,user:{deleted:true}}).run(surface);assert.equal(r.count,0)});
 test('active-'+surface,async()=>{const r=await harness().run(surface);assert.equal(r.count,1);if(surface==='room')assert.equal(r.matches[0].email,undefined);else assert.equal(r.matches[0].email,row.email)});
}
test('guest',async()=>assert.equal((await harness({ok:true,user:{is_restricted:true}}).run('owner_dm')).count,1));
test('bot',async()=>assert.equal((await harness({ok:true,user:{is_bot:true}}).run('owner_dm')).count,0));
test('not-found',async()=>{const e=Object.assign(Error('not found'),{data:{error:'user_not_found'}});assert.equal((await harness(e).run('owner_dm')).count,0)});
for(const code of ['ratelimited','account_inactive'])test(code,async()=>{const e=Object.assign(Error(code),{data:{error:code}});const r=await harness(e).run('owner_dm');assert.ok(r.error);assert.equal(r.count,undefined)});
test('missing-user',async()=>assert.ok((await harness({ok:true}).run('owner_dm')).error));
test('list-active',async()=>assert.equal((await harness(undefined,[{id:'UPAUL002',real_name:'Paul',deleted:false}],[]).run('owner_dm')).count,1));
test('list-deleted',async()=>assert.equal((await harness(undefined,[{id:'UPAUL002',real_name:'Paul',deleted:true}],[]).run('owner_dm')).count,0));
test('fresh-retry',async()=>{const h=harness();await h.run('room');await h.run('room');assert.equal(h.calls(),2)});
test('list-unavailable',async()=>assert.ok((await harness(undefined,[],[],{ok:false}).run('owner_dm')).error));
test('list-malformed',async()=>assert.ok((await harness(undefined,[],[],{ok:true}).run('owner_dm')).error));
(async()=>{let passed=0,failed=0;for(const [id,fn]of tests){try{await fn();console.log('PASS '+id);passed++}catch(e){console.log('FAIL '+id+': '+e.message);failed++}}console.log(JSON.stringify({passed,failed}));process.exitCode=failed?1:0})()
