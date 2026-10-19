// Full query, summaries, classifier and output gates. Only I/O/model judgments
// are fixtures; input/branch proof is not semantic model-obedience proof.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),Database=require('better-sqlite3'),assert=require('node:assert/strict'),{test}=require('node:test');
const sourceAt=process.argv.indexOf('--source-root'),sourceRoot=sourceAt<0?null:process.argv[sourceAt+1];
const profile={user:{name:'Idan Cohen',slack_user_id:'UOWNER',email:'owner@example.com',timezone:'Asia/Jerusalem'},assistant:{name:'Maelle'}};
const baseRow={id:'req_oran',owner_user_id:'UOWNER',origin_thread_ts:'origin.1',owner_dm_thread_ts:'daily.1',owner_dm_channel:'DOWNER',terminal_dm_msg_ts:'ask.1',state:'resolved',created_at:'2026-10-19 11:03:53',subject:'Oran post decision',outcome_json:JSON.stringify({approved:true,replayed:'message_colleague'}),details_json:JSON.stringify({deferred_action:{tool:'message_colleague',args:{colleague_name:'Oran',message:'PRIVATE PAYLOAD NOT FOR PROJECTION'}}})};
function fixture(options={}){
 const db=new Database(':memory:'),fields=Object.keys(baseRow),calls=[],queries=[],logs=[],cache={};
 db.exec('CREATE TABLE requests ('+fields.map(k=>k+' TEXT').join(',')+')');
 for(const row of options.rows??[baseRow])db.prepare('INSERT INTO requests VALUES ('+fields.map(()=>'?').join(',')+')').run(...fields.map(k=>({...baseRow,...row})[k]??null));
 const changes=db.prepare('SELECT total_changes() AS n').get().n;
 const logger=Object.fromEntries(['info','warn','debug','error'].map(k=>[k,(...a)=>logs.push([k,...a])]));
 const client={messages:{create:async req=>{calls.push(req);
  if(req.tools?.[0]?.input_schema?.properties?.verdict)return {stop_reason:'tool_use',content:[{type:'tool_use',name:'verdict',input:{verdict:'rewrite',minimalRedaction:'The request is recorded.',minimalRedactionPreservesRest:true}}]};
  if(req.tools?.some(t=>t.name==='verdict'))return {content:[{type:'tool_use',name:'verdict',input:{ok:true}}]};
  if(options.modelUnavailable)throw Error('model unavailable');
  return {content:[{type:'text',text:JSON.stringify(options.claim??{claimed_action:false,action_type:null})}]};
 }}};
 const mocks={
  'src/llm/client.ts':{getAnthropicClient:()=>client},'src/llm/models.ts':require('./load-test-models.cjs'),
  'src/utils/logger.ts':{__esModule:true,default:logger},'src/utils/usageLog.ts':{logLlmUsage(){}},
  'src/utils/attendeeAvailability.ts':{ATTENDEE_REASON_PREFIXES:[]},'src/utils/detectMessageLanguage.ts':{detectMessageLanguage:()=> 'en'},
  'src/core/requests/types.ts':{APPROVAL_SUBKINDS:[],FREEFORM_OWNER_FLAG_SUBKIND:'freeform_owner_flag',ORIGIN_SURFACE_REPLAY_TOOLS:['create_meeting','move_meeting','update_meeting','delete_meeting','book_floating_block','promote_timezone_temp']},
  'src/core/requests/activityRevertibility.ts':{ACTIVITY_REVERTIBILITY:{}},'src/db/conversations.ts':{},'src/db/client.ts':{getDb:()=>db},
  'src/connections/slack/formatting.ts':{formatForSlack:s=>s},'src/utils/availabilityGate.ts':{freshHardBlockedSlots:()=>[]},
  'src/utils/dateVerifier.ts':{verifyDates:async()=>({ok:true,mismatches:[]})},'src/db/index.ts':{getPersonMemory:()=>({email:'colleague@example.com'})}
 };
 const actual=new Set(['src/db/requests.ts','src/core/orchestrator/turnHelpers.ts','src/utils/claimChecker.ts','src/utils/humanGate.ts','src/utils/securityGate.ts','src/utils/guards/runOutputGates.ts','src/utils/textScrubber.ts','src/utils/extractJson.ts']);
 function load(rel){if(Object.hasOwn(mocks,rel))return mocks[rel];if(cache[rel])return cache[rel].exports;assert.ok(actual.has(rel),'unexpected import '+rel);
  const preserved=sourceRoot&&path.join(sourceRoot,path.basename(rel)),file=preserved&&fs.existsSync(preserved)?preserved:rel;
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,mod=cache[rel]={exports:{}};
  const req=n=>{if(n==='luxon'||n==='crypto')return require(n);if(n==='@anthropic-ai/sdk')return{};let f=path.posix.normalize(path.posix.join(path.posix.dirname(rel),n))+'.ts';if(f==='src/db.ts')f='src/db/index.ts';return load(f)};
  vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{Date,setTimeout,clearTimeout},{filename:rel})(req,mod,mod.exports);return mod.exports;
 }
 const requests=load('src/db/requests.ts'),original=requests.getRequestsForThread;
 requests.getRequestsForThread=(...args)=>{queries.push(args);return original(...args)};
 const gates=load('src/utils/guards/runOutputGates.ts'),turn=load('src/core/orchestrator/turnHelpers.ts');
 const run=(extra={},draft='The owner decision is recorded; delivery is a separate matter.')=>gates.runOutputGates(draft,{profile,senderId:'UOWNER',role:'owner',channelId:'DOWNER',threadTs:'daily.1',userMessage:'send to Oran',history:[],result:{toolSummaries:[]},...extra});
 return{db,run,calls,queries,logs,turn,close(){if(db.open){assert.equal(db.prepare('SELECT total_changes() AS n').get().n,changes,'gates cannot mutate or replay a request');db.close()}},contexts:()=>calls.filter(c=>!c.tools).map(c=>c.messages[0].content)};
}
for(const threadTs of ['daily.1','ask.1'])test('owner exact '+threadTs+' decision travels actual SQL to actual checker',async()=>{
 const h=fixture();try{const draft='The owner decision is recorded; delivery is a separate matter.';assert.equal(await h.run({threadTs},draft),draft);
 assert.equal(h.queries[0][2],'DOWNER');const p=h.contexts().find(p=>p.includes('AUTHORITATIVE REQUEST OUTCOMES'));assert.ok(p.includes('"subject":"Oran post decision"'));assert.ok(p.includes('"approved":true'));assert.ok(p.includes('"completionConfirmed":false'));assert.ok(p.includes('approved=true is permission only, never completion'));assert.ok(!p.includes('PRIVATE PAYLOAD'));assert.ok(!p.includes('req_oran'));assert.equal(h.calls.length,2);
 }finally{h.close()}
});
for(const [name,extra] of [
 ['colleague',{senderId:'UCOLLEAGUE',role:'colleague'}],['role-spoof',{senderId:'UCOLLEAGUE',role:'owner'}],['owner-wrong-role',{role:'colleague'}],['unknown-role',{role:undefined}],['unknown-sender',{senderId:''}],
 ['email',{transport:'email'}],['mpim',{isMpim:true}],['channel-flag',{isChannel:true}],['owner-in-group',{isOwnerInGroup:true}],['channel-id',{channelId:'CROOM'}],['group-id',{channelId:'GROOM'}],['invalid-id',{channelId:'downer'}],['empty-id',{channelId:''}]
])test('private evidence withheld '+name,async()=>{const h=fixture();try{await h.run(extra);assert.ok(h.queries.length);assert.ok(h.queries.every(q=>q[2]===undefined));assert.ok(h.contexts().every(p=>!p.includes('Oran post decision')))}finally{h.close()}});
for(const [name,extra,rows] of [['wrong-channel',{channelId:'DOTHER'},undefined],['wrong-thread',{threadTs:'guess.1'},undefined],['foreign-owner',{},[{owner_user_id:'UOTHER'}]],['logged',{},[{state:'logged'}]]])test('SQL rejects '+name+' beneath private owner scope',async()=>{const h=fixture({rows});try{await h.run(extra);assert.ok(h.contexts().every(p=>!p.includes('Oran post decision')))}finally{h.close()}});
test('ordinary colleague origin still receives its same minimal decision projection',async()=>{const h=fixture();try{await h.run({senderId:'UCOLLEAGUE',role:'colleague',channelId:'DCOLLEAGUE',threadTs:'origin.1'});assert.ok(h.queries.every(q=>q[2]===undefined));assert.ok(h.contexts().some(p=>p.includes('Oran post decision')));assert.ok(h.contexts().every(p=>!p.includes('PRIVATE PAYLOAD')))}finally{h.close()}});
for(const [state,outcome,expected] of [['awaiting_owner',null,null],['cancelled',{approved:false},false],['resolved',{approved:true,replayed:'message_colleague',verified:false},true]])test('preserved origin lifecycle '+state+' '+expected,async()=>{const h=fixture({rows:[{state,outcome_json:JSON.stringify(outcome)}]});try{await h.run({threadTs:'origin.1'});const p=h.contexts().find(p=>p.includes('AUTHORITATIVE REQUEST OUTCOMES'));assert.ok(p.includes('"state":"'+state+'"'));assert.ok(p.includes('"approved":'+expected));assert.ok(p.includes('"completionConfirmed":false'))}finally{h.close()}});
test('unavailable database remains unknown and unchanged reply safely misses',async()=>{const h=fixture();h.db.close();try{const draft='The outcome is not confirmed.';assert.equal(await h.run({},draft),draft);assert.ok(h.logs.some(x=>JSON.stringify(x).includes('Final truth context unavailable')))}finally{h.close()}});
test('unavailable model does not invent decision or execution',async()=>{const h=fixture({modelUnavailable:true});try{const draft='The outcome is not confirmed.';assert.equal(await h.run({},draft),draft)}finally{h.close()}});
for(const failure of ['failed','unknown'])test('current '+failure+' booking cannot borrow prior create or approval',async()=>{
 const h=fixture({claim:{claimed_action:true,action_type:'book',target_name:null,claim_specifics_mismatch:false}});try{
 const prior=h.turn.summarizeToolCall('create_meeting',{subject:'Older'}, {success:true,event_id:'old'},'UTC');
 const current=h.turn.summarizeToolCall('create_meeting',{subject:'Current'},failure==='failed'?{error:'unavailable'}:{status:'pending'},'UTC');
 assert.ok(prior.includes('mutated=book'));assert.ok(!current.includes('mutated=book'));
 const out=await h.run({history:[{role:'assistant',content:prior,toolSummaries:[prior]}],result:{toolSummaries:[current]}},'The request is recorded. I booked it.');
 assert.equal(out,'The request is recorded.');assert.ok(h.calls.some(c=>c.tools?.[0]?.input_schema?.properties?.verdict));
 }finally{h.close()}
});
for(const type of ['permission_granted','message'])test('unrelated '+type+' verdict is not shielded by approved row or delivery receipt',async()=>{
 const h=fixture({claim:{claimed_action:true,action_type:type,target_name:'Unrelated Person',claim_specifics_mismatch:false}});try{const summary=h.turn.summarizeToolCall('resolve_approval',{approval_id:'req_oran'},{ok:true,state:'resolved',action_summary:'Message sent to Oran.',requester_notify_outcome:'sent'},'UTC');const draft=type==='message'?'The request is recorded. I booked it.':'Unrelated Person has permission to publish anything.';const out=await h.run({result:{toolSummaries:[summary]}},draft);assert.notEqual(out,draft)}finally{h.close()}
});
test('repeated terminal read and fresh loader are read-only with identical evidence',async()=>{for(let restart=0;restart<2;restart++){const h=fixture();try{await h.run();await h.run();assert.equal(h.queries.length,2);assert.ok(h.contexts().every(p=>p.includes('"approved":true')))}finally{h.close()}}});
test('shared daily thread retains distinct request decisions without a blanket grant',async()=>{
 const h=fixture({rows:[baseRow,{id:'req_other',subject:'Different pending request',state:'awaiting_owner',created_at:'2026-10-19 12:00:00',outcome_json:null}],claim:{claimed_action:true,action_type:'permission_granted',target_name:'Different requester'}});
 try{const draft='The different pending request is approved.';assert.notEqual(await h.run({},draft),draft);const p=h.contexts()[0];assert.ok(p.includes('"subject":"Oran post decision"'));assert.ok(p.includes('"subject":"Different pending request"'));assert.ok(p.includes('"approved":true'));assert.ok(p.includes('"approved":null'));assert.ok(p.includes('Require evidence for the SAME request/action'))}finally{h.close()}
});
