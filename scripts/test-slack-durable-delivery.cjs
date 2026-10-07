// Actual handlers -> processor -> queue -> postReply -> durable SQLite ->
// restart/catch-up/heartbeat, with only provider/model decisions replaced.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const Database=require('better-sqlite3');
const before=process.argv.includes('--before');
if(before)process.env.SLACK_BOUNDARY_SOURCE_ROOT=path.resolve(__dirname,'../artifacts/workshop-verification/approved-four-20261007/slackmaster/before');
const {harness:processor}=require('./test-slack-thread-boundaries.cjs');
const deliveryFixture=require('./fixtures/slack-delivery.cjs');
const source=fs.readFileSync(path.join(__dirname,'test-slack-social-coda-delivery.cjs'),'utf8').split("for (const mode of ['workSendThrows'")[0];
const replyHarness=vm.runInThisContext(`(function(require,__dirname,process){${source}\nreturn harness;})`)(require,__dirname,process);
const flush=()=>new Promise(r=>setImmediate(r));
const surfaces=[['owner','DOWNER','UOWNER',false,false],['colleague','DCOLLEAGUE','UCOLLEAGUE',false,false],['mpim','GROOM','UCOLLEAGUE',true,false],['channel','CROOM','UOWNER',false,true]];
function fixture(t, options={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'slack-durable-path-')),file=path.join(dir,'fixture.db');let db;
 t.after(()=>{db?.close();const resolved=path.resolve(dir),parent=path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith('slack-durable-path-'));
  fs.rmSync(resolved,{recursive:true,force:true});});
 const s={posts:[],incoming:[],visible:[],runs:0,reactions:[]};
 function boot(extra={}) {
  db?.close();db=new Database(file);let h;
  const delivery=deliveryFixture({db,eligible:(...args)=>h.load('src/connections/slack/eligibility.ts').readInternalSlackConversation(...args),threadHistory:{readSlackThread:(...args)=>h.load('src/connectors/slack/threadHistory.ts').readSlackThread(...args)}});
  const reply=replyHarness({delivery});
  h=processor({delivery,actualProcessor:true,...options,...extra,
   orchestrator:async p=>{s.runs++;options.onOrchestrator?.(db);if(options.orchestratorError)throw Error('model unavailable');return {reply:options.reply||'Completed action',toolSummaries:[]};},
   postReply:p=>reply.reply(p),
   history:async()=>({ok:true,messages:s.incoming.map(x=>({...x,reply_count:1}))}),
   replies:async()=>{if(options.historyUnavailable)throw Error('history unavailable');return {ok:true,messages:[...s.incoming,...s.visible]};},
   postResponse:async(p,n)=>{s.posts.push(p);if(options.postResponse)return options.postResponse(p,s.posts.length);return {ok:true,ts:'900.000001'};},
  });
  const react=h.client.reactions.add;
  h.client.reactions.add=async p=>{s.reactions.push(p);return options.reactionResponse?options.reactionResponse(p):react(p);};
  h.handlers();return {h,delivery,reply};
 }
 return {s,boot,get db(){return db;}};
}
async function turn(h,surface,ts='100.000001',extra={}) {
 const [,channelId,senderId,isMpim,isChannel]=surface;
 await h.turn({channelId,senderId,isMpim,isChannel,ts,threadTs:'100.000001',isExplicitMention:isMpim||isChannel,...extra});
 if(h.timers.some(t=>!t.cancelled&&t.ms===1500))await h.fire();
 await flush();
}
function due(f){f.db.prepare("UPDATE slack_delivery_attempts SET nextCheckAt=0 WHERE status IN ('sending','unknown')").run();}
for(const surface of surfaces) {
 test(`CONTROL ${surface[0]} fresh answer stays in original thread`,async t=>{
  const f=fixture(t),{h}=f.boot();await turn(h,surface);assert.equal(f.s.posts.length,1);assert.equal(f.s.posts[0].thread_ts,'100.000001');assert.equal(f.s.runs,1);
 });
 for(const outcome of ['confirmed','unknown','invisible-accepted'])test(`REGRESSION ${surface[0]} ${outcome} restart cannot rerun or resend`,async t=>{
  const f=fixture(t,{postResponse:async()=>{if(outcome==='invisible-accepted')throw Error('timeout after acceptance');return outcome==='unknown'?undefined:{ok:true,ts:'900.000001'};}});
  let p=f.boot();await turn(p.h,surface);p=f.boot();await turn(p.h,surface);
  assert.equal(f.s.posts.length,1);assert.equal(f.s.runs,1);
  assert.equal(p.delivery.api.getSlackDelivery('UOWNER',surface[1],'100.000001').status,outcome==='confirmed'?'confirmed':'unknown');
 });
 test(`REGRESSION ${surface[0]} catch-up cannot replay invisible accepted answer`,async t=>{
  const f=fixture(t,{list:[{id:surface[1],is_im:!surface[3]&&!surface[4],is_mpim:surface[3],is_member:surface[4]}],postResponse:async()=>undefined});
  f.s.incoming=[{user:surface[2],ts:'100.000001',text:'<@UBOT> Please act'}];
  let p=f.boot();await turn(p.h,surface);p=f.boot();due(f);
  await p.h.load('src/core/background.ts').catchUpMissedMessages(p.h.app,p.h.ctx.profile,surface[1],0,true);await p.h.drain();
  if(p.h.timers.some(t=>!t.cancelled&&t.ms===1500))await p.h.fire();await flush();
  assert.equal(f.s.posts.length,1);assert.equal(f.s.runs,1);
  const row=p.delivery.api.getSlackDelivery('UOWNER',surface[1],'100.000001');assert.equal(row.status,'unknown');assert.ok(row.nextCheckAt>Date.now());assert.ok(p.delivery.logs.some(x=>String(x).includes('operator review required')));
 });
}
test('REGRESSION merged burst protects every inbound ID after restart',async t=>{
 const f=fixture(t);let p=f.boot();await p.h.turn({ts:'101.000001',threadTs:'101.000001'});await p.h.turn({ts:'102.000001',threadTs:'102.000001'});await p.h.fire();await flush();
 p=f.boot();await turn(p.h,surfaces[0],'102.000001');await turn(p.h,surfaces[0],'101.000001');assert.equal(f.s.posts.length,1);assert.equal(f.s.runs,1);
 const a=p.delivery.api.getSlackDelivery('UOWNER','DOWNER','101.000001'),b=p.delivery.api.getSlackDelivery('UOWNER','DOWNER','102.000001');assert.equal(a.attemptId,b.attemptId);assert.equal(a.inboundTs.length,2);
});
test('REGRESSION TTL expiry cannot rerun a confirmed answer',async t=>{
 const f=fixture(t),p=f.boot();await turn(p.h,surfaces[0]);for(const timer of p.h.timers.filter(x=>x.ms===600000))timer.fn();await turn(p.h,surfaces[0]);assert.equal(f.s.posts.length,1);assert.equal(f.s.runs,1);
});
test('CONTROL explicit rejection allows one confirmed failure notice',async t=>{
 const f=fixture(t,{postResponse:async(_p,n)=>n===1?{ok:false,error:'not_in_channel'}:{ok:true,ts:'900.000002'}}),p=f.boot();await turn(p.h,surfaces[0]);assert.equal(f.s.posts.length,2);assert.equal(f.s.posts[1].text,'Something failed');
 if(!before){const rows=f.db.prepare('SELECT status FROM slack_delivery_attempts ORDER BY rowid').all();assert.deepEqual(rows.map(x=>x.status),['failed','confirmed']);}
});
test('REGRESSION explicit double rejection is failed and can recover after restart',async t=>{
 let reject=true;const f=fixture(t,{postResponse:async()=>reject?{ok:false}:{ok:true,ts:'900.2'}});let p=f.boot();await turn(p.h,surfaces[0]);assert.equal(p.delivery.api.getSlackDelivery('UOWNER','DOWNER','100.000001')?.status,'failed');reject=false;p=f.boot();await turn(p.h,surfaces[0]);assert.equal(f.s.posts.length,3);assert.equal(p.delivery.api.getSlackDelivery('UOWNER','DOWNER','100.000001').status,'confirmed');
});
test('REGRESSION crashed pre-send boundary stays unknown until exact reconciliation',async t=>{
 const f=fixture(t);let p=f.boot();const a=p.delivery.api.beginSlackDelivery({profileId:'UOWNER',channelId:'DOWNER',threadTs:'100.000001',inboundTs:['100.000001'],nextCheckAt:Date.now()+600000});p=f.boot();await turn(p.h,surfaces[0]);assert.equal(f.s.runs,0);due(f);await p.delivery.module.reconcileSlackDeliveries(p.h.app,'UOWNER','fixture','UBOT');assert.equal(p.delivery.api.getSlackDelivery('UOWNER','DOWNER','100.000001').status,'unknown');assert.equal(f.s.posts.length,0);
});
for(const evidence of ['exact','other-bot','unrelated','unavailable','ineligible'])test(`REGRESSION heartbeat ${evidence} evidence is exact and keeps unknown due`,async t=>{
 const f=fixture(t,{postResponse:async()=>undefined,historyUnavailable:evidence==='unavailable'});let p=f.boot();await turn(p.h,surfaces[0]);const attempt=p.delivery.api.getSlackDelivery('UOWNER','DOWNER','100.000001');assert.ok(attempt);
 f.s.visible=[{user:evidence==='other-bot'?'OTHER':'UBOT',ts:'900.1',client_msg_id:evidence==='unrelated'?'different':attempt.attemptId}];
 p=f.boot(evidence==='ineligible'?{infoFails:true}:{});due(f);
 await p.h.load('src/core/background.ts').catchUpMissedMessages(p.h.app,p.h.ctx.profile,'DOWNER',Date.now(),true);
 const row=p.delivery.api.getSlackDelivery('UOWNER','DOWNER','100.000001');assert.equal(row.status,evidence==='exact'?'confirmed':'unknown');assert.equal(f.s.posts.length,1);assert.equal(f.s.runs,1);
 if(evidence==='exact'){assert.equal(row.messageTs,'900.1');assert.equal(row.nextCheckAt,null);}else assert.ok(row.nextCheckAt>Date.now());
});
test('REGRESSION unavailable persistence fails closed before orchestration or send',async t=>{
 const f=fixture(t),p=f.boot();f.db.exec('DROP TABLE slack_delivery_inbound');await assert.rejects(turn(p.h,surfaces[0]));assert.equal(f.s.posts.length,0);assert.equal(f.s.runs,0);
});
test('REGRESSION unknown failure notice is held across restart',async t=>{
 const f=fixture(t,{orchestratorError:true,postResponse:async()=>undefined});let p=f.boot();await turn(p.h,surfaces[0]);p=f.boot();await turn(p.h,surfaces[0]);assert.equal(f.s.posts.length,1);assert.equal(f.s.runs,1);assert.equal(p.delivery.api.getSlackDelivery('UOWNER','DOWNER','100.000001').status,'unknown');
});
for(const status of ['confirmed','unknown'])test(`REGRESSION reaction ${status} survives restart without text fallback`,async t=>{
 const f=fixture(t,{reply:'Got it',reactionResponse:async()=>{if(status==='unknown')throw Error('reaction timeout');return {ok:true};}});let p=f.boot();await turn(p.h,surfaces[0]);p=f.boot();await turn(p.h,surfaces[0]);
 assert.equal(f.s.runs,1);assert.equal(f.s.posts.length,0);const row=p.delivery.api.getSlackDelivery('UOWNER','DOWNER','100.000001');assert.equal(row.status,status);assert.equal(row.messageTs,null);
});
test('CONTROL explicitly refused reaction permits text answer',async t=>{
 const f=fixture(t,{reply:'Got it',reactionResponse:async()=>{const e=Error('invalid reaction');e.code='slack_webapi_platform_error';e.data={ok:false,error:'invalid_name'};throw e;}}),p=f.boot();await turn(p.h,surfaces[0]);assert.equal(f.s.posts.length,1);assert.equal(f.s.posts[0].text,'Got it');
});
test('REGRESSION confirmation persistence failure cannot trigger second response or restart replay',async t=>{
 const f=fixture(t);let p=f.boot();f.db.exec("CREATE TRIGGER fail_confirmation BEFORE UPDATE ON slack_delivery_attempts WHEN NEW.status='confirmed' BEGIN SELECT RAISE(ABORT,'fixture completion unavailable'); END");
 await turn(p.h,surfaces[0]);assert.equal(p.delivery.api.getSlackDelivery('UOWNER','DOWNER','100.000001')?.status,'sending');assert.equal(f.s.posts.length,1);
 f.db.exec('DROP TRIGGER fail_confirmation');p=f.boot();await turn(p.h,surfaces[0]);assert.equal(f.s.runs,1);assert.equal(f.s.posts.length,1);due(f);await p.delivery.module.reconcileSlackDeliveries(p.h.app,'UOWNER','fixture','UBOT');assert.equal(p.delivery.api.getSlackDelivery('UOWNER','DOWNER','100.000001').status,'unknown');
});
test('REGRESSION pre-send persistence failure releases no transport bytes',async t=>{
 const f=fixture(t,{onOrchestrator:db=>db.exec("CREATE TRIGGER IF NOT EXISTS fail_begin BEFORE INSERT ON slack_delivery_attempts BEGIN SELECT RAISE(ABORT,'fixture claim unavailable'); END")}),p=f.boot();await turn(p.h,surfaces[0]);assert.equal(f.s.posts.length,0);assert.equal(f.s.runs,1);
});
test('REGRESSION operator confirmed resolution closes due work without re-answer',async t=>{
 const f=fixture(t,{postResponse:async()=>undefined});let p=f.boot();await turn(p.h,surfaces[0]);const a=p.delivery.api.getSlackDelivery('UOWNER','DOWNER','100.000001');assert.ok(a);
 assert.equal(p.delivery.api.resolveSlackDelivery({...a,expectedStatus:'unknown',status:'confirmed',messageTs:'evidence-ts'}),true);
 p=f.boot();await turn(p.h,surfaces[0]);assert.equal(f.s.runs,1);assert.equal(f.s.posts.length,1);assert.equal(p.delivery.api.listDueSlackDeliveries('UOWNER',Date.now()+99999999).length,0);
 assert.equal(p.delivery.api.resolveSlackDelivery({...a,expectedStatus:'unknown',status:'failed'}),false,'stale operator action cannot undo confirmation');
});
test('REGRESSION operator evidence of nonacceptance permits explicit replay and stale CAS is harmless',async t=>{
 let uncertain=true;const f=fixture(t,{postResponse:async()=>uncertain?undefined:{ok:true,ts:'901.1'}});let p=f.boot();await turn(p.h,surfaces[0]);const a=p.delivery.api.getSlackDelivery('UOWNER','DOWNER','100.000001');assert.ok(a);
 assert.equal(p.delivery.api.resolveSlackDelivery({...a,expectedStatus:'unknown',status:'failed'}),true);uncertain=false;p=f.boot();await turn(p.h,surfaces[0]);assert.equal(f.s.posts.length,2);const b=p.delivery.api.getSlackDelivery('UOWNER','DOWNER','100.000001');assert.equal(b.status,'confirmed');assert.notEqual(a.attemptId,b.attemptId);assert.equal(p.delivery.api.resolveSlackDelivery({...a,expectedStatus:'unknown',status:'failed'}),false);
});
for(const status of ['confirmed','unknown'])test(`REGRESSION durable audio ${status} cannot reupload after restart`,async t=>{
 const {harness:voice}=require('./test-slack-voice-readiness.cjs');
 const f=fixture(t);let p=f.boot();let v=voice({delivery:p.delivery,uploadError:status==='unknown'});p.h=processor({delivery:p.delivery,postReply:input=>v.post(input)});
 await turn(p.h,surfaces[0],'100.000001',{voiceInput:true});assert.equal(v.s.uploads.length,1);
 const a=p.delivery.api.getSlackDelivery('UOWNER','DOWNER','100.000001');assert.ok(a);assert.equal(a.status,status);assert.equal(a.messageTs,null);
 p=f.boot();v=voice({delivery:p.delivery,uploadError:status==='unknown'});p.h=processor({delivery:p.delivery,postReply:input=>v.post(input)});await turn(p.h,surfaces[0],'100.000001',{voiceInput:true});assert.equal(v.s.uploads.length,0);assert.equal(p.h.runs.length,0);
});
for(const replay of [false,true])test(`REGRESSION held media ${replay?'replay':'live'} ingress cannot transcribe or send notices again`,async()=>{
 const {harness:voice}=require('./test-slack-voice-readiness.cjs');const delivery=deliveryFixture();const a=delivery.api.beginSlackDelivery({profileId:'UOWNER',channelId:'D1',threadTs:'1.1',inboundTs:['2.2'],nextCheckAt:Date.now()+600000});delivery.api.resolveSlackDelivery({...a,expectedStatus:'sending',status:'unknown',nextCheckAt:Date.now()+600000});
 const v=voice({delivery});await v.ingress(replay);assert.equal(v.s.dependencyOptions.length,0);assert.equal(v.s.turns.length,0);assert.equal(v.s.uploads.length,0);assert.equal(v.s.posts.length,0);delivery.db.close();
});
test('REGRESSION slow confirmed send resolves same attempt after heartbeat marks unknown',async t=>{
 let p;const f=fixture(t,{postResponse:async()=>{p.delivery.api.listDueSlackDeliveries('UOWNER',Date.now()+9999999);return {ok:true,ts:'late.1'};}});p=f.boot();await turn(p.h,surfaces[0]);const a=p.delivery.api.getSlackDelivery('UOWNER','DOWNER','100.000001');assert.ok(a);assert.equal(a.status,'confirmed');assert.equal(a.messageTs,'late.1');assert.equal(a.nextCheckAt,null);
});
for(const [kind,channel] of [['dm','DOWNER'],['message','GROOM'],['app_mention','CROOM']])test(`REGRESSION ${kind} ingress held attempt skips all preprocessing`,async t=>{
 const f=fixture(t),p=f.boot();p.delivery.api.beginSlackDelivery({profileId:'UOWNER',channelId:channel,threadTs:'100.000001',inboundTs:['100.000001'],nextCheckAt:Date.now()+600000});
 await p.h.event(kind,{channel,ts:'100.000001'});assert.equal(p.h.received.length,0);assert.equal(f.s.runs,0);assert.equal(f.s.posts.length,0);
});
test('REGRESSION queued batch rechecks durable hold acquired after ingress',async t=>{
 const f=fixture(t),p=f.boot();await p.h.turn();p.delivery.api.beginSlackDelivery({profileId:'UOWNER',channelId:'DOWNER',threadTs:'100.000001',inboundTs:['101.000001'],nextCheckAt:Date.now()+600000});await p.h.fire();assert.equal(f.s.runs,0);assert.equal(f.s.posts.length,0);
});
test('REGRESSION atomic send claim refuses competing attempt after orchestration',async t=>{
 let p;const f=fixture(t,{onOrchestrator:()=>p.delivery.api.beginSlackDelivery({profileId:'UOWNER',channelId:'DOWNER',threadTs:'100.000001',inboundTs:['100.000001'],nextCheckAt:Date.now()+600000})});p=f.boot();await turn(p.h,surfaces[0]);assert.equal(f.s.runs,1);assert.equal(f.s.posts.length,0);
});
for(const kind of ['document','image','voice','replay'])test(`REGRESSION ${kind} actual send adapter retains exact client correlation`,async()=>{
 const ts=require('typescript');const relative=kind==='image'?'src/connectors/slack/app/fileIngestion.ts':'src/connectors/slack/app/handlers.ts';
 const file=path.resolve(process.env.SLACK_BOUNDARY_SOURCE_ROOT||path.join(__dirname,'..'),relative),body=fs.readFileSync(file,'utf8');
 const ast=ts.createSourceFile(file,body,ts.ScriptTarget.Latest,true);let selected;
 function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)===(kind==='replay'?'catchUpSay':'sayFn')&&kind!=='document')selected=node.initializer;
  if(kind==='document'&&ts.isPropertyAssignment(node)&&node.name.getText(ast)==='say'&&ts.isArrowFunction(node.initializer))selected=node.initializer;ts.forEachChild(node,visit);}
 visit(ast);assert.ok(selected);const posts=[],client={chat:{postMessage:async p=>{posts.push(p);return {ok:true,ts:'2.2'};}}};
 const fn=vm.runInNewContext(ts.transpileModule(`(${selected.getText(ast)})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{client,app:{client},assistant:{slack:{bot_token:'fixture'}},channelId:'D1',threadTs:'1.1',postThreadTs:'1.1'});
 await fn({text:'Fixture',thread_ts:'1.1',client_msg_id:'exact-id'});assert.equal(posts[0].client_msg_id,'exact-id');assert.equal(posts[0].thread_ts,'1.1');
});
test('REGRESSION unknown prequeue failure notice remains held on restart',async t=>{
 const f=fixture(t,{prequeueFailure:true,postResponse:async()=>undefined});let p=f.boot();await turn(p.h,surfaces[0]);p=f.boot();await turn(p.h,surfaces[0]);assert.equal(f.s.posts.length,1);assert.equal(f.s.runs,0);assert.equal(p.delivery.api.getSlackDelivery('UOWNER','DOWNER','100.000001').status,'unknown');
});
test('REGRESSION Slack already-reacted receipt confirms ack without duplicate text',async t=>{
 const f=fixture(t,{reply:'Got it',reactionResponse:async p=>{if(p.name!=='+1')return {ok:true};const e=Error('already reacted');e.code='slack_webapi_platform_error';e.data={ok:false,error:'already_reacted'};throw e;}}),p=f.boot();await turn(p.h,surfaces[0]);assert.equal(f.s.posts.length,0);assert.equal(p.delivery.api.getSlackDelivery('UOWNER','DOWNER','100.000001').status,'confirmed');
});
