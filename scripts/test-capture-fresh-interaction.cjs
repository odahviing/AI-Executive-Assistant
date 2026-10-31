// Exercise the complete background capture producer with isolated provider/store boundaries.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm'),ts=require('typescript');
const root=path.resolve(__dirname,'..');
const profile={user:{slack_user_id:'OWNER',name:'Owner Example'},assistant:{name:'Maelle'}};
const old={role:'user',content:'OLD_PAYPAL_ASK',ts:'1790802500.767259'}, fresh={role:'user',content:'CURRENT_STARZ_ASK',ts:'1793144415.671989'};
function fixture({messages=[old,fresh],captured='2026-10-01 00:00:00',counterpart='PERSON',offline=false,missingConnection=false,missingPerson=false}={}){
 const state={calls:[],writes:[],marks:[],unknown:[],messages};const deps={
 'luxon':require('luxon'),'../config':{config:{ANTHROPIC_API_KEY:'fixture'}},'../llm/models':{HAIKU:{model:'fixture'}},
 '../llm/client':{getAnthropicClient:()=>({messages:{create:async args=>{state.calls.push(args);if(offline)throw Error('provider unavailable');return{content:[{type:'text',text:args.max_tokens===800?'{"interaction_summary":"Current response fixture"}':'[]'}]}}}})},
 '../connections/registry':{getConnection:()=>missingConnection?null:{resolveChannelCounterpart:async()=>counterpart}},
 '../db':{findThreadsReadyForCapture:()=>[{thread_ts:'thread',channel_id:'DM',captured_at:captured}],getConversationHistory:()=>messages,markThreadCaptured:t=>state.marks.push(t),getPersonMemory:()=>missingPerson?null:{person_id:'p_PERSON',name:'Person',profile_json:'{}'},appendPersonInteraction:(id,entry)=>state.writes.push({id,...entry}),recordSocialCaptureUnknown:(...args)=>state.unknown.push(args)},
 './peopleMemory':{readPersonMemory:async()=>''},'../core/assistantSelf':{selfSlackId:()=> 'SELF'},'../utils/timezoneValidator':{},'../utils/extractJson':{extractFirstJsonObject:x=>x},
 '../db/socialSubjects':{FIXED_CATEGORIES:[],getActiveSubjectsForPerson:()=>[],getAllSubjectsForPerson:()=>[],getRecentTopicBeats:()=>[],threadHadSocialTurn:()=>false},
 '../utils/logger':Object.fromEntries(['info','warn','error','debug'].map(k=>[k,()=>{}]))};
 const source=fs.readFileSync(process.env.CAPTURE_BEFORE||path.join(root,'src/memory/capturePass.ts'),'utf8');const box={exports:{},Date,require:id=>{assert.ok(Object.hasOwn(deps,id),'unexpected import '+id);return deps[id]}};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,box);
 return {state,run:()=>box.exports.runCapturePass(profile),capture:()=>state.calls.find(c=>c.max_tokens===800),social:()=>state.calls.find(c=>c.max_tokens!==800)};
}
test('regression reopened old thread sends only new exchange to profile capture',async()=>{const h=fixture();await h.run();const p=h.capture().messages[0].content;assert.ok(!p.includes('OLD_PAYPAL_ASK'));assert.ok(p.includes('CURRENT_STARZ_ASK'));assert.equal(h.state.writes.length,1);assert.equal(h.state.messages.length,2);});
test('regression retry with no uncaptured stamps does not reappend interaction',async()=>{const h=fixture({captured:'2026-10-29 00:00:00'});await h.run();assert.equal(h.capture(),undefined);assert.equal(h.state.writes.length,0);assert.equal(h.state.marks.length,1);});
test('regression unknown earlier assistant receipt is not new but receipt following current turn survives',async()=>{const h=fixture({messages:[old,{role:'assistant',content:'OLD_UNSTAMPED'},fresh,{role:'assistant',content:'CURRENT_UNSTAMPED'}]});await h.run();const p=h.capture().messages[0].content;assert.ok(!p.includes('OLD_UNSTAMPED'));assert.ok(p.includes('CURRENT_UNSTAMPED'));});
test('regression invalid captured watermark withholds freshness instead of replaying old thread',async()=>{const h=fixture({captured:'invalid'});await h.run();assert.equal(h.capture(),undefined);assert.equal(h.state.writes.length,0);});
test('preserved first capture includes existing transcript and writes canonical interaction',async()=>{const h=fixture({captured:null});await h.run();assert.match(h.capture().messages[0].content,/OLD_PAYPAL_ASK/);assert.equal(h.state.writes[0].type,'conversation');assert.equal(h.state.marks.length,1);});
test('preserved new conversation and completion response are retained',async()=>{const h=fixture({messages:[fresh,{role:'assistant',content:'COMPLETED',ts:'1793144432.761000'}]});await h.run();assert.match(h.capture().messages[0].content,/CURRENT_STARZ_ASK/);assert.match(h.capture().messages[0].content,/COMPLETED/);assert.equal(h.state.writes.length,1);});
test('preserved provider failure records unknown and applies no person facts',async()=>{const h=fixture({offline:true});await h.run();assert.equal(h.state.writes.length,0);assert.equal(h.state.unknown.length,1);});
test('preserved unavailable connection leaves pending capture retryable',async()=>{const h=fixture({missingConnection:true});await h.run();assert.equal(h.state.calls.length,0);assert.equal(h.state.marks.length,0);});
test('preserved room or unresolved counterpart cannot write person memory',async()=>{const h=fixture({counterpart:null});await h.run();assert.equal(h.state.calls.length,0);assert.equal(h.state.writes.length,0);});
test('preserved social reconciliation retains complete thread independently of profile freshness',async()=>{const h=fixture();await h.run();assert.match(h.social().messages[0].content,/OLD_PAYPAL_ASK/);assert.match(h.social().messages[0].content,/CURRENT_STARZ_ASK/);});
test('regression UTC ISO watermark equals SQLite cutoff and excludes equality',async()=>{const h=fixture({messages:[{...fresh,ts:'1793144415.000'},{role:'assistant',content:'NEW_AFTER_EQUAL',ts:'1793144416.0'}],captured:new Date(1793144415000).toISOString()});await h.run();assert.ok(!h.capture().messages[0].content.includes('CURRENT_STARZ_ASK'));assert.match(h.capture().messages[0].content,/NEW_AFTER_EQUAL/);});


