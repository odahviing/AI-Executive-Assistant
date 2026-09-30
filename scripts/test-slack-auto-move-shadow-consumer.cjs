// Actual producer -> SQLite association -> Slack consumers -> durable shadowNotify.
// Closed transport/model/image I/O; no live writes or LLM calls.
const fs=require('fs'),path=require('path'),vm=require('vm'),Module=require('module'),ts=require('typescript');
const {test}=require('node:test'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
const file=path.join(__dirname,'test-auto-move-producer-thread.cjs'),fixtureModule=new Module(file,module);
fixtureModule.filename=file;fixtureModule.paths=module.paths;
fixtureModule._compile(fs.readFileSync(file,'utf8').split("test('two moves create")[0]+'\nmodule.exports=fixture;',file);
function load(rel,deps,globals={}) {
 const before=process.env.MAELLE_SLACK_MOVE_SOURCE_ROOT, name=before&&fs.existsSync(path.join(before,rel))?path.join(before,rel):path.join(root,rel);
 const m={exports:{}},js=ts.transpileModule(fs.readFileSync(name,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 vm.runInNewContext('(function(require,module,exports){'+js+'\n})',{console,Date,Map,Set,...globals})(id=>{assert.ok(id in deps,'unexpected '+id);return deps[id];},m,m.exports);return m.exports;
}
const flush=()=>new Promise(r=>setImmediate(r));
async function fixture(o={}) {
 const f=fixtureModule.exports(o),h=f.h,history=[],sent=[],timers=[],mirrors=[];
 await f.move(); await f.move('meeting-2');
 const jobs=h.db.prepare('SELECT * FROM outreach_jobs ORDER BY rowid').all();
 // Isolated transport's producer fixture returns one static ts. Give its two confirmed
 // receipts distinct native Slack timestamps to represent real separate DM roots.
 jobs.forEach((j,i)=>h.db.prepare('UPDATE outreach_jobs SET dm_message_ts=? WHERE id=?').run('notice.'+(i+1),j.id));
 h.profile.assistant.slack={bot_token:'fixture'};
 const logger={__esModule:true,default:{info(){},debug(){},warn(){},error(){}}};
 const shadowModule=load('src/utils/shadowNotify.ts',{
 '../connections/registry':{getConnection:()=>o.noConnection?null:{resolveDirectChannelId:async()=> 'DOWNER',sendDirect:async(id,text,opts)=>{f.ownerSends.push({id,text,opts});return {ok:true,ref:'DOWNER',ts:'extra.'+f.ownerSends.length};},postToChannel:async(id,text,opts)=>{f.posts.push({id,text,opts});if(o.shadowThrow)throw Error('unknown');return o.shadowFail?{ok:false,reason:'error'}:{ok:true,ref:id,ts:'consumer.'+f.posts.length};}}},
 '../db/requests':h.reqs,'../db/conversations':{appendToConversation:(...x)=>history.push(x)},'./logger':logger,'./ownerDailyThread':{getOrCreateOwnerDailyThread:async()=>({channel:'DOWNER',rootTs:'daily'})}});
 const shadow={shadowNotify:async(profile,p)=>{mirrors.push(p);return shadowModule.shadowNotify(profile,p);}};
 const db=o.lookupFails?{getAutoMoveRequestIdForOutreachThread(){throw Error('offline');}}:h.jobs;
 const post=load('src/connectors/slack/postReply.ts',{
 '../../utils/logger':logger,'../../db':{appendToConversation(){}},'../../connections/slack/formatting':{formatForSlack:x=>x},'../../connections/slack/messaging':{setAssistantStatus:async()=>{}},'../../config':{config:{}},'../../voice':{shouldRespondWithAudio:()=>false},
 '../../utils/guards/runOutputGates':{runDeliberationGuard:async x=>x,runOutputGates:async()=> 'Safe delivered reply',runCodaGates:async()=>({ship:true})},
 './inboundQueue':{isThreadActive:()=>false,getThreadInboundRevision:()=>0},'../../utils/threadActivity':{getLastMaelleMessage:()=>null,recordMaelleMessage(){}},
 '../../core/social/generateCoda':{composeSocialCoda:async()=>({text:'Social sentence',historyContent:'Social sentence'})},'../../core/social/stateMachine':{isSocialInitiationDue:()=>true},'../../core/social/logEngagement':{reserveCodaAttempt:()=>true,recordCodaDelivered(){}},
 '../../utils/shadowNotify':shadow,'../../db/jobs':db,
 },{setTimeout:fn=>{timers.push(fn);return {unref(){}};}});
 const reply=async(thread='notice.1',extra={})=>post.postOrchestratorReply({app:{},profile:h.profile,result:{reply:'PRIVATE RAW DRAFT',...(o.coda?{socialCoda:{personSlackId:'COLLEAGUE',directive:{mode:'raise_new'}}}:{})},say:async p=>{sent.push(p);return {ok:true,ts:'reply.1'};},role:'colleague',senderId:'COLLEAGUE',channelId:'DCOLLEAGUE',threadTs:thread,userMessage:'Confirmed',history:[],...extra});
 const media=load('src/connectors/slack/app/fileIngestion.ts',{
 '../../../vision':{downloadSlackImage:async()=>({data:'safe'}),buildImageBlock:()=>({type:'image'})},'../../../utils/imageGuard':{},'../../../utils/shadowNotify':shadow,'../../../utils/attendeeScope':{getOwnerDomain:()=> 'example.com'},'../../../utils/logger':logger,'./helpers':{},'../../../db/jobs':db,
 });
 async function image(thread='notice.1',extra={}) {
  await media.processImageFileShare({profile:h.profile,app:{client:{users:{info:async()=>({user:{profile:{email:o.external?'peer@outside.test':'peer@example.com'},real_name:'Colleague'}})}}},getSenderRole:()=> 'colleague',scanAndPrepareImage:async()=>o.refuse?null:{type:'image'},processMessage:async()=>{}},{files:[{mimetype:'image/png',url_private:'https://fixture/image'}],message:{user:'COLLEAGUE'},channelId:'DCOLLEAGUE',threadTs:thread,ts:'image.1',client:{chat:{postMessage:async()=>({ok:true})}},...extra});
  await flush();
 }
 async function react(thread='notice.1',extra={}) {
  let handler;
  const handlers=load('src/connectors/slack/app/handlers.ts',{'../../../config':{config:{}},'../../../llm/client':{},'../../../core/threadActions':{},'../../../db':{},'../../../voice':{},'../../../utils/logger':logger,'../inboundReplayRegistry':{},'../processedDedup':{},'./helpers':{},'./fileIngestion':{},'../../../connections/slack/eligibility':{readInternalSlackConversation:async()=>({})},'../threadHistory':{},'../recentOutboundContext':h.load('src/connectors/slack/recentOutboundContext.ts'),'../../../utils/shadowNotify':shadow,'../../../db/jobs':db,'../../../db/requests':h.reqs});
  handlers.registerReactionHandler({profile:h.profile,botUserId:'BOT',app:{event:(_e,fn)=>handler=fn}});
  await handler({event:{item:{type:'message',channel:extra.channel||'DCOLLEAGUE',ts:thread},user:extra.sender||'COLLEAGUE',reaction:'thumbsup'},client:{}});
 }
 return {...f,jobs,history,sent,mirrors,reply,image,react,fire:async()=>{for(const fn of timers)fn();await flush();}};
}
test('actual producer + normal first replies: same colleague two moves keep exactly two roots',async()=>{const f=await fixture();await f.reply();await f.reply('notice.2');assert.equal(f.ownerSends.length,2);assert.deepEqual(f.posts.slice(-2).map(x=>x.opts.threadTs),['root.1','root.2']);assert.ok(f.history.every(x=>x[1]==='DOWNER'));assert.ok(!JSON.stringify(f.mirrors).includes('PRIVATE RAW DRAFT'));});
test('actual clean image first followup and later reply reuse move root',async()=>{const f=await fixture();await f.image();await f.reply();assert.equal(f.ownerSends.length,2);assert.ok(f.posts.slice(-2).every(x=>x.opts.threadTs==='root.1'));assert.equal(f.posts.at(-2).opts.attachments[0].sourceUrl,'https://fixture/image');});
test('actual reaction first followup uses delivered exact move thread and does not duplicate on replay',async()=>{const f=await fixture();await f.react();assert.equal(f.ownerSends.length,2);assert.equal(f.posts.at(-1).opts.threadTs,'root.1');const n=f.posts.length;await f.react();assert.equal(f.posts.length,n);});
test('social trailer preserves move grouping without another root',async()=>{const f=await fixture({coda:true});await f.reply();await f.fire();assert.equal(f.ownerSends.length,2);assert.equal(f.mirrors.at(-1).action,'Social coda');assert.equal(f.posts.at(-1).opts.threadTs,'root.1');});
for(const mode of ['unrelated','ambiguous','wrong-event','lookup-unavailable'])test('preserved ordinary route for '+mode,async()=>{const f=await fixture({lookupFails:mode==='lookup-unavailable'});let thread='notice.1';if(mode==='unrelated')thread='new-topic';if(mode==='ambiguous')f.h.db.prepare('UPDATE outreach_jobs SET dm_message_ts=?').run(thread);if(mode==='wrong-event')f.h.db.prepare('UPDATE requests SET outcome_external_event_id=? WHERE subkind=?').run('other','auto_move');await f.reply(thread);assert.equal(f.ownerSends.length,3);assert.equal(f.mirrors.at(-1).autoMoveRequestId,undefined);assert.ok(f.ownerSends.every(x=>x.id==='OWNER'));});
for(const surface of ['isMpim','isChannel'])test('preserved '+surface+' never attaches room to move',async()=>{const f=await fixture();await f.reply('notice.1',{[surface]:true,channelId:'ROOM'});assert.equal(f.mirrors.at(-1).autoMoveRequestId,undefined);assert.ok(f.ownerSends.every(x=>x.id==='OWNER'));});
for(const mode of ['external','refuse'])test('preserved media privacy '+mode,async()=>{const f=await fixture({[mode]:true});await f.image();assert.equal(f.mirrors.length,0);assert.equal(f.ownerSends.length,2);});
for(const mode of ['shadowFail','shadowThrow','noConnection'])test('unavailable shadow '+mode+' never adds root or affects colleague reply',async()=>{const f=await fixture({[mode]:true});await f.reply();assert.equal(f.ownerSends.length,2);assert.equal(f.sent.length,1);assert.equal(f.history.length,0);});
test('preserved owner context never mirrored as colleague move response',async()=>{const f=await fixture();await f.reply('notice.1',{senderId:'OWNER',role:'owner'});assert.equal(f.mirrors.length,0);});
test('unrelated reactor cannot borrow colleague association',async()=>{const f=await fixture();await f.react('notice.1',{sender:'OTHER'});assert.equal(f.mirrors.at(-1).autoMoveRequestId,undefined);});

