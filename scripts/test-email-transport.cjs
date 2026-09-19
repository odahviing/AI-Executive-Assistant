const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const root = path.resolve(__dirname, '..');
const profile = {user:{email:'owner@example.com',slack_user_id:'UOWNER',timezone:'UTC'},assistant:{email:'assistant@example.com'},channels:{email:{enabled:true,mailbox:'assistant@example.com',owner_aliases:['alias@example.com'],refresh_token:'fixture-token'}}};
const raw = (id,extra={}) => ({id,conversationId:'chain',from:{emailAddress:{address:'owner@example.com'}},body:{contentType:'text',content:'full chain'},uniqueBody:{contentType:'text',content:'new text'},isRead:false,...extra});
const plain = x => JSON.parse(JSON.stringify(x));
function harness(options={}) {
 const files = options.files || new Map(), calls=[], handled=[], notices=[], history=[], modules=new Map(); let timer,auth;
 let now=Date.parse('2026-09-19T12:00Z');
 class Clock extends Date {constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
 const disk={existsSync:f=>files.has(f),mkdirSync:()=>{},readFileSync:f=>{if(!files.has(f))throw Error('ENOENT');return files.get(f);},writeFileSync:(f,v)=>{if(options.diskFailure)throw Error('fixture disk full');files.set(f,v);},unlinkSync:f=>files.delete(f)};
 const logger={info:()=>{},warn:()=>{},error:()=>{}};
 const graph={api:url=>{const c={url,options:{}};const req={select:s=>{c.select=s;return req;},option:(k,v)=>{c.options[k]=v;return req;},middlewareOptions:v=>{c.middlewareOptions=v;return req;},get:()=>exec('get'),post:v=>exec('post',v),update:v=>exec('update',v),delete:()=>exec('delete')};async function exec(method,body){c.method=method;c.body=body;calls.push(c);if(options.graph)return options.graph(c,calls.length);if(method==='get')return {value:[], '@odata.deltaLink':'delta:done'};if(url.endsWith('/createReply'))return {id:'draft',body:{content:'<html><body>quoted chain</body></html>'}};}return req;}};
 const mocks={
  'src/config/index.ts':{config:{AZURE_TENANT_ID:'fixture',AZURE_CLIENT_ID:'fixture',AZURE_CLIENT_SECRET:'fixture'}},
  'src/utils/logger.ts':{__esModule:true,default:logger},
  'src/utils/textScrubber.ts':{scrubInternalLeakage:x=>x},
  'src/connections/registry.ts':{registerConnection:()=>{},getConnection:()=>options.noSlack?undefined:{sendDirect:async(...args)=>{notices.push(args);return {ok:true};}}},
  'src/db/index.ts':{getConversationHistory:()=>[],appendToConversation:(...args)=>history.push(args)},
  'src/memory/recordBooking.ts':{isNonHumanAttendee:()=>false},
  'src/connectors/email/extractParticipants.ts':{extractForwardedParticipants:async()=>({participants:[],timezoneHints:[]})},
  'src/utils/locationTz.ts':{inferTimezoneFromStateStatic:()=>null},
  'src/core/orchestrator/index.ts':{runOrchestrator:async()=>({reply:'Fixture reply'})},
  'src/utils/guards/runOutputGates.ts':{runOutputGates:async reply=>reply},
 };
 function load(rel){
  if(Object.hasOwn(mocks,rel))return mocks[rel];if(modules.has(rel))return modules.get(rel).exports;
  const saved=process.env.DIPLOMAT_SNAPSHOT&&path.join(root,process.env.DIPLOMAT_SNAPSHOT,rel);
  const source=fs.readFileSync(saved&&fs.existsSync(saved)?saved:path.join(root,rel),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const mod={exports:{}};modules.set(rel,mod);
  function req(s){if(s==='fs'||s==='node:fs')return disk;if(s==='@microsoft/microsoft-graph-client')return {...require(s),Client:{initWithMiddleware:o=>{auth=o.authProvider;return graph;}}};if(s.startsWith('.')){let f=path.posix.normalize(path.posix.join(path.posix.dirname(rel),s));return load(fs.existsSync(path.join(root,f+'.ts'))?f+'.ts':f+'/index.ts');}return require(s);}
  vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{process:{cwd:()=>'/fixture'},Date:Clock,console,Map,Set,URLSearchParams,AbortSignal,fetch:options.fetch||(()=>{throw Error('unexpected token fetch');}),setInterval:f=>{timer=f;}},{filename:rel})(req,mod,mod.exports);
  return mod.exports;
 }
 const registry=load('src/connectors/graph/mailInboundRegistry.ts');
 if(!options.noHandler)registry.registerMailInbound(profile.user.slack_user_id,async(...args)=>{handled.push(args[1]);if(options.handlerFailure)throw Error('handler fixture failure');});
 return {load,files,calls,handled,notices,history,auth:()=>auth,advance:ms=>{now+=ms;},startInbound:()=>load('src/connectors/email/inbound.ts').startEmailChannel(profile),start:()=>load('src/connectors/graph/mailPoll.ts').startMailPollTimer(new Map([['fixture',profile]])),tick:async()=>{timer();for(let i=0;i<20;i++)await new Promise(setImmediate);}};
}
test('delta duplicate unread entries across pages trigger one handler and one read mark',async()=>{
 const h=harness({graph:c=>c.method==='get'?(c.url==='page2'?{value:[raw('m')],'@odata.deltaLink':'done'}:{value:[raw('m')],'@odata.nextLink':'page2'}):undefined});h.start();await h.tick();assert.equal(h.handled.length,1);assert.equal(h.calls.filter(c=>c.method==='update').length,1);
});
test('delta final read state suppresses earlier unread duplicate',async()=>{
 const h=harness({graph:c=>({value:[raw('m'),raw('m',{isRead:true})],'@odata.deltaLink':'done'})});h.start();await h.tick();assert.equal(h.handled.length,0);
});
test('delta deleted message cannot be handled from an earlier page',async()=>{
 const h=harness({graph:c=>({value:[raw('m'),{id:'m','@removed':{reason:'deleted'}}],'@odata.deltaLink':'done'})});h.start();await h.tick();assert.equal(h.handled.length,0);
});
test('delta watermark write failure releases no side effects and retries next tick',async()=>{
 const o={diskFailure:true,graph:c=>c.method==='get'?{value:[raw('m')],'@odata.deltaLink':'done'}:undefined},h=harness(o);h.start();await h.tick();assert.equal(h.handled.length,0);o.diskFailure=false;await h.tick();assert.equal(h.handled.length,1);
});
test('legitimate independent messages preserve full and unique bodies and consume watermark',async()=>{
 const h=harness({graph:c=>c.method==='get'?{value:[raw('a'),raw('b')],'@odata.deltaLink':'done'}:undefined});h.start();await h.tick();assert.deepEqual(h.handled.map(x=>x.id),['a','b']);assert.equal(h.handled[0].body,'full chain');assert.equal(h.handled[0].uniqueBody,'new text');assert.ok([...h.files.values()].some(x=>x.includes('done')));
});
test('read mail and own mailbox loopbacks remain ignored',async()=>{
 const h=harness({graph:()=>({value:[raw('read',{isRead:true}),raw('loop',{from:{emailAddress:{address:'ASSISTANT@example.com'}}})],'@odata.deltaLink':'done'})});h.start();await h.tick();assert.equal(h.handled.length,0);
});
test('missing inbound handler never consumes delta',async()=>{const h=harness({noHandler:true});h.start();await h.tick();assert.equal(h.calls.length,0);});
test('handler throw leaves unread and next delta does not repeat the consumed message',async()=>{
 const h=harness({handlerFailure:true,graph:c=>c.method==='get'?{value:c.url==='done'?[]:[raw('m')],'@odata.deltaLink':'done'}:undefined});h.start();await h.tick();await h.tick();assert.equal(h.handled.length,1);assert.equal(h.calls.filter(c=>c.method==='update').length,0);
});
test('restart resumes persisted delta instead of initial inbox replay',async()=>{
 const h=harness();await h.load('src/connectors/graph/mail.ts').listNewMessages(profile);const restarted=harness({files:h.files});await restarted.load('src/connectors/graph/mail.ts').listNewMessages(profile);assert.equal(restarted.calls[0].url,'delta:done');
});
test('410 resync retries exactly once with the same abort budget',async()=>{
 let first=true;const h=harness({graph:c=>{if(first){first=false;throw {statusCode:410};}return {value:[raw('m')],'@odata.deltaLink':'done'};}});const result=await h.load('src/connectors/graph/mail.ts').listNewMessages(profile);assert.equal(result.length,1);assert.equal(h.calls.length,2);assert.equal(h.calls[0].options.signal,h.calls[1].options.signal);
});
test('transient poll failure stays quiet; sustained failures notify at 5 then 10',async()=>{
 const h=harness({graph:()=>{throw Error('transient fixture');}});h.start();for(let i=0;i<4;i++)await h.tick();assert.equal(h.notices.length,0);await h.tick();assert.equal(h.notices.length,1);for(let i=0;i<5;i++)await h.tick();assert.equal(h.notices.length,2);
});
test('revoked auth stops future polls and says reauth plus restart once',async()=>{
 let h;h=harness({graph:()=>{throw new (h.load('src/connectors/graph/mail.ts').MailAuthRevokedError)('fixture');}});h.start();await h.tick();await h.tick();assert.equal(h.calls.length,1);assert.equal(h.notices.length,1);assert.match(h.notices[0][1],/restart/);
});
test('owner and alias sends preserve quote and explicit recipient despite inferred Reply-To',async()=>{
 const h=harness(),connection=h.load('src/connections/email/index.ts').createEmailConnection(profile);for(const to of ['owner@example.com',' ALIAS@example.com ']){const r=await connection.sendDirect(to,'Hello <b> & **world**',{replyToMessageId:'original/id'});assert.equal(r.ok,true);}const patch=h.calls.find(c=>c.method==='update');assert.equal(patch.body.toRecipients[0].emailAddress.address,'owner@example.com');assert.match(patch.body.body.content,/<body><p>Hello &lt;b&gt; &amp; <strong>world<\/strong><\/p>quoted chain/);assert.ok(h.calls[0].url.includes('original%2Fid/createReply'));
});
test('outside to cc bcc and missing reply target are refused before Graph',async()=>{
 const h=harness(),c=h.load('src/connections/email/index.ts').createEmailConnection(profile);for(const [to,opts] of [['outsider@example.net',{replyToMessageId:'m'}],['owner@example.com',{replyToMessageId:'m',cc:['outsider@example.net']}],['owner@example.com',{replyToMessageId:'m',bcc:['outsider@example.net']}],['owner@example.com',{}]])assert.equal((await c.sendDirect(to,'fixture',opts)).ok,false);assert.equal(h.calls.length,0);
});
test('all fanout verbs refuse and unsupported attachments do not invent uploads',async()=>{
 const h=harness(),c=h.load('src/connections/email/index.ts').createEmailConnection(profile);for(const verb of ['sendBroadcast','sendGroupConversation','postToChannel'])assert.equal((await c[verb]()).reason,'not_supported');await c.sendDirect('owner@example.com','fixture',{replyToMessageId:'m',attachments:[{sourceUrl:'fixture:unsupported'}]});assert.equal(h.calls.length,3);
});
test('failed draft patch cleans up and reports send failure without send retry',async()=>{
 const h=harness({graph:c=>{if(c.url.endsWith('/createReply'))return {id:'draft',body:{content:'quote'}};if(c.method==='update')throw Error('patch fixture');}}),c=h.load('src/connections/email/index.ts').createEmailConnection(profile);assert.equal((await c.sendDirect('owner@example.com','fixture',{replyToMessageId:'m'})).reason,'send_failed');assert.deepEqual(h.calls.map(x=>x.method),['post','update','delete']);
});
test('ambiguous send response remains failure without automated send retry',async()=>{
 const h=harness({graph:c=>{if(c.url.endsWith('/createReply'))return {id:'draft'};if(c.url.endsWith('/send'))throw Error('response lost after possible acceptance');}});const c=h.load('src/connections/email/index.ts').createEmailConnection(profile);assert.equal((await c.sendDirect('owner@example.com','fixture',{replyToMessageId:'m'})).ok,false);assert.equal(h.calls.filter(c=>c.url.endsWith('/send')).length,1);
});
test('delegated token rotation survives restart and revoked grant is typed',async()=>{
 const h=harness({fetch:async()=>({ok:true,json:async()=>({access_token:'access',refresh_token:'rotated',expires_in:3600})})});await h.load('src/connectors/graph/mail.ts').listNewMessages(profile);assert.equal(await h.auth().getAccessToken(),'access');assert.ok([...h.files.values()].some(v=>v.includes('rotated')));let spent;const restarted=harness({files:h.files,fetch:async(_url,p)=>{spent=p.body.get('refresh_token');return {ok:false,json:async()=>({error:'invalid_grant'})};}});await restarted.load('src/connectors/graph/mail.ts').listNewMessages(profile);await assert.rejects(restarted.auth().getAccessToken(),e=>e.name==='MailAuthRevokedError');assert.equal(spent,'rotated');
});
test('token persistence failure cannot expose a cached success on the next request',async()=>{
 const h=harness({diskFailure:true,fetch:async()=>({ok:true,json:async()=>({access_token:'access',refresh_token:'rotated',expires_in:3600})})});
 // Initial Graph mock does not invoke authentication; real auth provider is
 // invoked explicitly to isolate refresh publication from request behavior.
 await h.load('src/connectors/graph/mail.ts').listNewMessages(profile).catch(()=>{});
 await assert.rejects(h.auth().getAccessToken(),/disk full/);await assert.rejects(h.auth().getAccessToken(),/disk full/);
});
test('email offer survives restart for 48h, clear is durable, Slack stays ephemeral',()=>{
 const h=harness(),s=h.load('src/utils/offeredSlotsStash.ts');for(const id of ['email:chain','D123'])s.recordOfferedSlots({channelId:id,threadTs:id,timezone:'UTC',slots:[{start:'2026-09-20T10:00:00Z'}]});const r=harness({files:h.files});r.advance(3*3600000);const rs=r.load('src/utils/offeredSlotsStash.ts');assert.equal(rs.getOfferedSlots('email:chain','email:chain').length,1);assert.equal(rs.getOfferedSlots('D123','D123'),null);rs.clearOfferedSlots('email:chain','email:chain');assert.equal(harness({files:h.files}).load('src/utils/offeredSlotsStash.ts').getOfferedSlots('email:chain','email:chain'),null);
});
test('expired email offer never resurrects after restart',()=>{const h=harness();h.load('src/utils/offeredSlotsStash.ts').recordOfferedSlots({channelId:'email:chain',timezone:'UTC',slots:[{start:'2026-09-20T10:00:00Z'}]});const r=harness({files:h.files});r.advance(49*3600000);assert.equal(r.load('src/utils/offeredSlotsStash.ts').getOfferedSlots('email:chain'),null);});

function inboundSendFixture(failure,noSlack=false){return harness({noSlack,graph:c=>{
 if(c.method==='get')return {value:c.url==='done'?[]:[raw('m')],'@odata.deltaLink':'done'};
 if(c.url.endsWith('/createReply'))return {id:'draft',body:{content:'quote'}};
 if(c.url==='/me/messages/draft'&&c.method==='update'&&failure==='prepare')throw Error('prepare failed');
 if(c.url.endsWith('/send')){if(failure==='unknown')throw Error('response lost');if(failure==='rejected')throw {statusCode:403};}
}});}
test('unknown send becomes terminal unconfirmed notice without resend advice or phantom history',async()=>{
 const h=inboundSendFixture('unknown');h.startInbound();h.start();await h.tick();await h.tick();
 assert.equal(h.notices.length,1);assert.match(h.notices[0][1],/unconfirmed/i);assert.doesNotMatch(h.notices[0][1],/forward it again|couldn't answer|retry/i);assert.equal(h.history.length,0);
 assert.equal(h.calls.filter(c=>c.url.endsWith('/send')).length,1);assert.equal(h.calls.filter(c=>c.method==='delete').length,0);assert.ok(h.calls.some(c=>c.url==='/me/messages/m'&&c.method==='update'));
});
test('unknown send with Slack unavailable still ends without retry or history',async()=>{
 const h=inboundSendFixture('unknown',true);h.startInbound();h.start();await h.tick();await h.tick();assert.equal(h.notices.length,0);assert.equal(h.history.length,0);assert.equal(h.calls.filter(c=>c.url.endsWith('/send')).length,1);assert.ok(h.calls.some(c=>c.url==='/me/messages/m'&&c.method==='update'));
});
test('known preparation failure retains failure notice and cleanup',async()=>{
 const h=inboundSendFixture('prepare');h.startInbound();h.start();await h.tick();assert.equal(h.notices.length,1);assert.match(h.notices[0][1],/couldn't answer/);assert.equal(h.history.length,0);assert.equal(h.calls.filter(c=>c.url.endsWith('/send')).length,0);assert.equal(h.calls.filter(c=>c.method==='delete').length,1);
});
test('explicit send rejection remains known failure rather than unconfirmed',async()=>{
 const h=inboundSendFixture('rejected');h.startInbound();h.start();await h.tick();assert.match(h.notices[0][1],/couldn't answer/);assert.equal(h.history.length,0);assert.equal(h.calls.filter(c=>c.method==='delete').length,1);
});
test('accepted send still records history and no failure notice',async()=>{
 const h=inboundSendFixture();h.startInbound();h.start();await h.tick();assert.equal(h.history.length,2);assert.equal(h.notices.length,0);assert.equal(h.calls.filter(c=>c.url.endsWith('/send')).length,1);
});
test('send disables Graph SDK retry middleware for ambiguous HTTP responses',async()=>{
 const h=harness();await h.load('src/connections/email/index.ts').createEmailConnection(profile).sendDirect('owner@example.com','fixture',{replyToMessageId:'m'});
 const call=h.calls.find(c=>c.url.endsWith('/send'));
 const {RetryHandler}=require('@microsoft/microsoft-graph-client');
 const {MiddlewareControl}=require('@microsoft/microsoft-graph-client/lib/src/middleware/MiddlewareControl');
 const retry=new RetryHandler();let writes=0;retry.sleep=async()=>{};retry.setNext({execute:async ctx=>{writes++;ctx.response={status:503,headers:new Headers()};}});
 await retry.execute({request:'https://graph.microsoft.com/v1.0/me/messages/draft/send',options:{method:'POST',headers:new Headers()},middlewareControl:new MiddlewareControl(call.middlewareOptions)});assert.equal(writes,1);
});
