// Real ingress, transcription/TTS, destination eligibility and whole postReply.
// processMessage/orchestrator/gate decisions are explicit seams, not model-obedience claims.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),cp=require('node:child_process'),ts=require('typescript'),{EventEmitter}=require('node:events');
const root=path.resolve(__dirname,'..'),before=process.env.SLACK_VOICE_BEFORE==='1',snapshot=process.env.SLACK_VOICE_SOURCE_ROOT;
function harness(opts={}){
 const s={uploads:[],posts:[],history:[],turns:[],tts:[],jobs:[],seen:new Set(),files:new Map(),delivered:0,external:false,unavailable:false,gate:[],errors:[],dependencyOptions:[],timers:[]};
 const config={OPENAI_API_KEY:opts.noKey?'':'fixture'};
 const logger={info(){},warn(){},debug(){},error(...args){s.errors.push(args);}};
 const owner='UOWNER',sender=opts.colleague?'UPEER':owner,channel=opts.room||'D1';
 const profile={user:{slack_user_id:owner,email:'owner@example.com',timezone:'UTC'},assistant:{slack:{bot_token:'fixture'}}};
 const client={
  auth:{test:async()=>({ok:true,team_id:'T1'})},users:{info:async({user})=>({ok:true,user:{id:user,team_id:s.external?'TOTHER':'T1',real_name:user}})},
  conversations:{info:async()=>{if(s.unavailable)throw Error('unavailable');return {ok:true,channel:channel==='D1'?{is_im:true,user:sender}:{is_mpim:channel==='G1',is_channel:channel==='C1',is_ext_shared:s.external}};}},
  files:{uploadV2:async p=>{s.uploads.push(p);if(opts.uploadError)throw Error('unknown upload result');return {ok:true,files:[{ok:true}]};}},
  chat:{postMessage:async p=>{s.posts.push(p);if(opts.textError)throw Error('text failed');return {ok:true,ts:'9.1'};}},reactions:{add:async()=>{throw Error('voice must not react');}},
 };
 const app={client,message:fn=>{s.dm=fn;}};
 const disk={writeFileSync:(p,b)=>s.files.set(p,Buffer.from(b)),readFileSync:p=>{if(!s.files.has(p))throw Error('ENOENT');return s.files.get(p);},statSync:p=>({size:s.files.get(p).length}),unlinkSync:p=>s.files.delete(p)};
 class Form{constructor(){this.fields={};}append(k,v){this.fields[k]=v;}getBuffer(){return this.fields.file;}getHeaders(){return {};}}
 class OpenAI{constructor(){this.audio={speech:{create:async p=>{s.tts.push(p);if(opts.change==='external')s.external=true;if(opts.change==='unavailable')s.unavailable=true;if(opts.ttsError)throw Error('TTS failed');return {arrayBuffer:async()=>Buffer.from(p.input)};}}};}}
 const ext={fs:disk,path,os:{tmpdir:()=>'/fixture'},'form-data':Form,'ffmpeg-static':'fixture',openai:OpenAI,
  child_process:{execFile:(_bin,args,options,cb)=>{if(typeof options==='function')cb=options;const child=new EventEmitter();s.dependencyOptions.push({stage:'ffmpeg',callbackType:typeof cb});if(opts.stall==='ffmpeg')return child;disk.writeFileSync(args.at(-1),disk.readFileSync(args[1]));queueMicrotask(()=>{cb(null,'','');child.emit('close');});return child;}},
  https:{request:(_p,callback)=>{s.dependencyOptions.push({stage:'whisper',options:_p});const req=new EventEmitter();req.write=b=>{req.bytes=b;};req.end=()=>{if(opts.stall==='whisper')return;queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=opts.whisperError?500:200;callback(res);res.emit('data',opts.emptyTranscript?'':req.bytes);res.emit('end');});};return req;}},
 };
 const mocks={
  'src/config.ts':{config},'src/utils/logger.ts':{__esModule:true,default:logger},
  'src/llm/client.ts':{},'src/core/threadActions.ts':{},'src/vision/index.ts':{},
  'src/db.ts':{appendToConversation:(...a)=>s.history.push(a)},
  'src/connectors/slack/inboundReplayRegistry.ts':{registerInboundReplay:(_id,fn)=>{s.replay=fn;}},
  'src/connectors/slack/processedDedup.ts':{markProcessed:id=>{if(s.seen.has(id))return false;s.seen.add(id);return true;}},
  'src/connectors/slack/app/helpers.ts':{is1on1DM:id=>id.startsWith('D')},
  'src/connectors/slack/app/fileIngestion.ts':{isSlackDocFile:()=>false,isSlackImageFile:()=>false},
  'src/connectors/slack/threadHistory.ts':{},
  'src/connections/slack/formatting.ts':{formatForSlack:t=>t},'src/connections/slack/messaging.ts':{setAssistantStatus:async()=>{}},
  'src/utils/guards/runOutputGates.ts':{runDeliberationGuard:async t=>t,runOutputGates:async(t,p)=>{s.gate.push(p);return opts.gatedReply||t;}},
  'src/connectors/slack/inboundQueue.ts':{},'src/utils/threadActivity.ts':{recordMaelleMessage(){}},
  'src/core/social/logEngagement.ts':{},'src/core/social/generateCoda.ts':{},'src/core/social/stateMachine.ts':{},
  'src/utils/shadowNotify.ts':{shadowNotify:async()=>{}},
 };
 const actual=['src/voice/index.ts','src/connectors/slack/app/handlers.ts','src/connectors/slack/postReply.ts','src/connections/slack/eligibility.ts'];
 const cache=new Map();
 function load(rel){if(mocks[rel])return mocks[rel];if(cache.has(rel))return cache.get(rel).exports;assert.ok(actual.includes(rel),rel);
  const source=process.env.SLACK_AUDIO_BEFORE==='1'&&rel==='src/connectors/slack/postReply.ts'?fs.readFileSync(path.join(process.env.SLACK_AUDIO_BEFORE_ROOT||path.join(root,'artifacts/workshop-verification/v5-readiness-20260923/slackmaster/attempt-1/snapshot'),rel),'utf8'):before&&rel==='src/voice/index.ts'?cp.execFileSync('git',['show',`ea5e69c:${rel}`],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(snapshot||root,rel),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,mod={exports:{}};cache.set(rel,mod);
  const req=p=>{if(!p.startsWith('.'))return ext[p]||require(p);const r=path.posix.normalize(path.posix.join(path.posix.dirname(rel),p));return load(actual.includes(r+'/index.ts')||mocks[r+'/index.ts']?r+'/index.ts':r+'.ts');};
  vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{console,Buffer,AbortController,setTimeout:(fn,ms)=>{s.timers.push(ms);return setTimeout(fn,ms);},clearTimeout,setImmediate:fn=>s.jobs.push(fn),fetch:async (url,options)=>{s.dependencyOptions.push({stage:'download',options});if(opts.stall==='download')return new Promise(()=>{});if(opts.downloadError)throw Error('download unavailable');const b=Buffer.from(String(url).slice(6));return {ok:true,status:200,headers:{get:()=> 'audio/webm'},arrayBuffer:async()=>opts.stall==='download-body'?new Promise(()=>{}):b};}},{filename:rel})(req,mod,mod.exports);return mod.exports;
 }
 async function reply(p={}){
  const role=opts.room?'colleague':opts.colleague?'colleague':'owner';
  return load('src/connectors/slack/postReply.ts').postOrchestratorReply({app,profile,result:{reply:opts.reply||'Source answer.'},role,senderId:sender,channelId:channel,threadTs:'1.1',history:[],userMessage:p.text||'Hello',voiceInput:p.voiceInput!==false,isMpim:channel==='G1',isChannel:channel==='C1',isOwnerInGroup:channel==='G1'&&!opts.colleague,
   say:async msg=>{if(!await load('src/connections/slack/eligibility.ts').readInternalSlackConversation(client,'fixture',channel,sender))throw Error('text eligibility withheld');return client.chat.postMessage(msg);},onDelivered:()=>{s.delivered++;if(opts.callbackError)throw Error('callback failed');}});
 }
 const ctx={app,profile,getSenderRole:id=>id===owner?'owner':'colleague',resolveSlackMentions:async t=>t,processMessage:async p=>{s.turns.push(p);await reply(p);}};
 const handlers=load('src/connectors/slack/app/handlers.ts');handlers.registerDmHandler(ctx);handlers.registerInboundReplayHandler(ctx);
 const event={user:sender,channel,ts:'2.2',thread_ts:'1.1',subtype:'file_share',files:[{mimetype:'audio/webm',url_private:'audio:שלום'}]};
 async function ingress(replay=false){if(replay)await s.replay({message:event,channelId:channel,postThreadTs:'1.1'});else{await s.dm({message:event,client});while(s.jobs.length)await s.jobs.shift()();}}
 return {s,ingress,reply,post:p=>load('src/connectors/slack/postReply.ts').postOrchestratorReply({...p,app}),voice:load('src/voice/index.ts'),app};
}
module.exports={harness};
if(require.main===module){
for(const colleague of [false,true])for(const change of ['external','unavailable'])test(`voice ${colleague?'colleague':'owner'} destination ${change} during TTS releases no bytes`,async()=>{const h=harness({colleague,change});await h.ingress();assert.equal(h.s.uploads.length,0);assert.equal(h.s.posts.length,0);assert.equal(h.s.history.length,0);assert.equal(h.s.delivered,0);});
for(const room of ['G1','C1'])test(`audio upload ${room} becoming shared is refused`,async()=>{const h=harness({room,change:'external'});await h.reply();assert.equal(h.s.uploads.length,0);assert.equal(h.s.history.length,0);});
for(const colleague of [false,true])test(`legitimate ${colleague?'colleague':'owner'} transcription through gated audio delivery`,async()=>{const h=harness({colleague,gatedReply:'Safe answer.'});await h.ingress();assert.equal(h.s.turns[0].text,'[Voice message]: שלום');assert.equal(h.s.turns[0].senderId,colleague?'UPEER':'UOWNER');assert.equal(h.s.gate[0].role,colleague?'colleague':'owner');assert.equal(h.s.tts[0].input,'Safe answer.');assert.equal(h.s.uploads[0].file.toString(),'Safe answer.');assert.equal(h.s.uploads[0].thread_ts,'1.1');assert.equal(h.s.history.length,1);assert.equal(h.s.delivered,1);assert.equal(h.s.files.size,0);});
test('reconnect duplicate input produces one audio answer',async()=>{const h=harness();await h.ingress();await h.ingress();assert.equal(h.s.uploads.length,1);});
test('fresh replay recovers eligible audio and original thread',async()=>{const h=harness();await h.ingress(true);assert.equal(h.s.uploads.length,1);assert.equal(h.s.uploads[0].thread_ts,'1.1');assert.equal(h.s.turns[0].voiceInput,true);});
test('replay newly external destination during TTS stays withheld',async()=>{const h=harness({change:'external'});await h.ingress(true);assert.equal(h.s.uploads.length,0);assert.equal(h.s.history.length,0);});
for(const option of ['downloadError','whisperError','emptyTranscript','noKey'])test(`ingestion ${option} gives failure notice without fabricated answer`,async()=>{const h=harness({[option]:true});await h.ingress();assert.equal(h.s.uploads.length,0);assert.equal(h.s.posts.length,1);assert.equal(h.s.history.length,0);});
test('TTS preparation failure still falls back to gated text',async()=>{const h=harness({ttsError:true});await h.ingress();assert.equal(h.s.posts.length,1);assert.equal(h.s.history.length,1);assert.equal(h.s.delivered,1);});
for(const colleague of [false,true])test(`unknown upload ${colleague?'colleague':'owner'} cannot generate second answer or confirmed history`,async()=>{const h=harness({colleague,uploadError:true});await h.ingress();assert.equal(h.s.uploads.length,1);assert.equal(h.s.posts.length,0);assert.equal(h.s.history.length,0);assert.equal(h.s.delivered,0);await h.ingress();assert.equal(h.s.uploads.length,1,'same-process duplicate event must not retry uncertain send');});
test('unknown upload on recovery ends without second answer',async()=>{const h=harness({uploadError:true});await h.ingress(true);assert.equal(h.s.posts.length,0);assert.equal(h.s.history.length,0);});
test('fallback text failure records no delivery',async()=>{const h=harness({ttsError:true,textError:true});await h.ingress();assert.equal(h.s.history.length,0);assert.equal(h.s.delivered,0);});
test('audio callback failure never sends second reply',async()=>{const h=harness({callbackError:true});await h.ingress();assert.equal(h.s.uploads.length,1);assert.equal(h.s.posts.length,0);});
test('long voice response remains text',async()=>{const h=harness({reply:Array(76).fill('word').join(' ')});await h.ingress();assert.equal(h.s.tts.length,0);assert.equal(h.s.posts.length,1);});
test('text input remains text',async()=>{const h=harness();await h.reply({voiceInput:false});assert.equal(h.s.tts.length,0);assert.equal(h.s.posts.length,1);});
for(const room of ['G1','C1'])test(`room ${room} file shares do not enter DM voice handler`,async()=>{const h=harness({room});await h.ingress();assert.equal(h.s.turns.length,0);assert.equal(h.s.uploads.length,0);});
}
