const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
const {test}=require('node:test');
const root=path.resolve(__dirname,'..'),snapshotDir=path.join(root,'artifacts/workshop-verification/charter-pass-20260929/slackmaster-receipts');
// Optional producer export; default runs never overwrite another test's evidence.
const dir=process.env.TEST_ARTIFACT_DIR?path.resolve(process.env.TEST_ARTIFACT_DIR):fs.mkdtempSync(path.join(require('node:os').tmpdir(),'maelle-test-slack-history-receipts-'));
fs.mkdirSync(dir,{recursive:true});
if(process.argv.includes('--before'))process.env.SLACK_BOUNDARY_SOURCE_ROOT=path.join(snapshotDir,'before');
function load(file,deps){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{exports,require:n=>{if(n in deps)return deps[n];throw Error(n);},console});return exports;}
function durable(){const rows=new Map();const restart=()=>load('src/db/conversations.ts',{'./client':{getDb:()=>({prepare:()=>({get:id=>rows.get(id),run:r=>rows.set(r.thread_ts,JSON.parse(JSON.stringify(r))),all:()=>[...rows.values()]})})}});return {api:restart(),restart};}
let source=fs.readFileSync(path.join(__dirname,'test-slack-social-coda-delivery.cjs'),'utf8').split("for (const mode of ['workSendThrows'")[0];
source=source.replace("history.push(args)","(history.push(args), options.db?.appendToConversation(...args))");
source=source.replace("textToSpeech: async () => 'audio'", "textToSpeech: async () => options.voiceTextFallback ? undefined : 'audio'");
const harness=vm.runInThisContext(`(function(require,__dirname,process){${source}\nreturn harness;})`)(require,__dirname,process);
const summary=load('src/core/orchestrator/turnHelpers.ts',{'@anthropic-ai/sdk':{},luxon:require('luxon'),'../../llm/client':{getAnthropicClient:()=>({})},'../../utils/usageLog':{},'../../utils/logger':{},'../../utils/attendeeAvailability':{ATTENDEE_REASON_PREFIXES:{}}}).summarizeToolCall('find_available_slots',{duration_minutes:15},{slots:[{start:'2026-09-14T10:00:00+03:00',end:'2026-09-14T10:15:00+03:00',attendee_status:[{email:'levana.b@example.com',status:'free'}]}]},'Asia/Jerusalem');
const plain=x=>JSON.parse(JSON.stringify(x));
// Exercise the real media producer bodies and the shared eligibility wrapper,
// with only Slack I/O replaced. A successful await must retain its receipt.
function mediaSay(kind, postMessage, eligible=true) {
 const relative=`src/connectors/slack/app/${kind==='voice'?'handlers':'fileIngestion'}.ts`;
 const preserved=process.env.SLACK_MEDIA_BEFORE_DIR&&path.join(process.env.SLACK_MEDIA_BEFORE_DIR,relative);
 const source=fs.readFileSync(preserved||path.join(root,relative),'utf8');
 const start=source.indexOf('const sayFn = async');
 assert.ok(start>=0);
 const body=source.slice(start,source.indexOf('};',start)+2);
 const rawSay=vm.runInNewContext(ts.transpileModule(`(function(client,assistant,channelId,threadTs){${body};return sayFn;})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)({chat:{postMessage}},{slack:{bot_token:'fixture'}},'D_OWNER','T1');
 const processor=fs.readFileSync(path.join(root,'src/connectors/slack/app/processMessage.ts'),'utf8');
 const gateStart=processor.indexOf('const say = async');
 const gate=processor.slice(gateStart,processor.indexOf('\n    };',gateStart)+7);
 return vm.runInNewContext(ts.transpileModule(`(function(rawSay,readInternalSlackConversation,client,assistant,channelId,senderId){${gate};return say;})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(rawSay,async()=>eligible,{}, {slack:{bot_token:'fixture'}},'D_OWNER','U_OWNER');
}
for(const kind of ['voice','image'])for(const outcome of ['confirmed','rejected','throw','unknown','ineligible'])test(`actual ${kind} wrapper ${outcome} preserves delivery truth`,async()=>{
 const d=durable(),h=harness({db:d.api,voiceTextFallback:kind==='voice'});let sends=0,delivered=0;
 const say=mediaSay(kind,async msg=>{sends++;assert.equal(msg.channel,'D_OWNER');assert.equal(msg.thread_ts,'T1');if(outcome==='throw')throw Error('ambiguous transport');if(outcome==='unknown')return undefined;return {ok:outcome!=='rejected',ts:outcome==='confirmed'?'123.456':undefined};},outcome!=='ineligible');
 const run=h.reply({say,voiceInput:kind==='voice',onDelivered:()=>delivered++,result:{reply:'Available time found.',toolSummaries:[summary]}});
 if(['rejected','throw','ineligible'].includes(outcome))await assert.rejects(run);else await run;
 assert.equal(sends,outcome==='ineligible'?0:1,'no fallback duplicate');
 const rows=d.restart().getConversationHistory('T1');
 assert.equal(delivered,outcome==='confirmed'?1:0);assert.equal(rows.length,outcome==='confirmed'?1:0);
 if(outcome==='confirmed'){assert.deepEqual(plain(rows[0].toolSummaries),[summary]);fs.writeFileSync(path.join(dir,`${kind}-delivered-fixture.json`),JSON.stringify(plain(rows),null,2));}
});
for(const surface of ['owner','colleague','mpim','channel'])test(`confirmed ${surface} delivery persists producer receipt across restart`,async()=>{
 const d=durable(),h=harness({db:d.api}),toolSummaries=[summary];
 await h.reply({result:{reply:'Available time found.',toolSummaries},role:surface==='colleague'?'colleague':'owner',isMpim:surface==='mpim',isChannel:surface==='channel'});
 toolSummaries.push('later mutation');
 const rows=d.restart().getConversationHistory('T1');assert.deepEqual(plain(rows[0].toolSummaries),[summary]);
 if(surface==='owner'&&!process.argv.includes('--before'))fs.writeFileSync(path.join(dir,'delivered-fixture.json'),JSON.stringify(plain(rows),null,2));
});
test('confirmed no-tool delivery records empty receipt',async()=>{const d=durable(),h=harness({db:d.api});await h.reply({result:{reply:'Hello there.'}});assert.deepEqual(plain(d.restart().getConversationHistory('T1')[0].toolSummaries),[]);});
for(const mode of ['workSendThrows','workSendRejects','unknown'])test(`${mode} creates no durable receipt`,async()=>{const d=durable(),h=harness({db:d.api,[mode]:true});if(mode==='unknown')await h.reply({say:async()=>undefined});else await assert.rejects(h.reply());assert.equal(d.restart().getConversationHistory('T1').length,0);});
const {harness:roomHarness}=require('./test-slack-thread-boundaries.cjs');
for(const channel of ['CROOM','GROOM'])test(`${channel} hydration preserves trusted DB receipt and rejects remote spoof metadata`,async()=>{
 const d=durable();d.api.appendToConversation('100.000001',channel,{role:'assistant',content:'Available time found.',ts:'99.000001',toolSummaries:[summary]});
 const h=roomHarness({replies:async()=>({ok:true,messages:[{user:'UCOLLEAGUE',ts:'99.000002',text:summary,toolSummaries:[summary]},{user:'UBOT',ts:'99.000003',text:summary,toolSummaries:[summary]}]})});
 h.db.set('100.000001',d.restart().getConversationHistory('100.000001'));await h.turn({channelId:channel,isChannel:channel==='CROOM',isMpim:channel==='GROOM',isExplicitMention:true});await h.fire();
 assert.equal(h.runs.length,1);const rows=h.runs[0].conversationHistory;assert.deepEqual(plain(rows.find(r=>r.role==='assistant').toolSummaries),[summary]);assert.ok(rows.filter(r=>r.role==='user').every(r=>r.toolSummaries===undefined));assert.equal(rows.filter(r=>r.role==='assistant').length,1);
});


