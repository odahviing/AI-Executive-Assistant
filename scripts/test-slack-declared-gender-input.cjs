// Execute both actual Slack callers; isolate transport, DB and detector.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),sourceRoot=process.env.SLACK_GENDER_BEFORE||root;
function setup({optIn=false,failed=false,eligible=true}={}) {
 const calls=[],saved=[];
 const deps={
  '../../../core/orchestrator':{},'../../../core/briefIntent':{},'../../../tasks/briefs':{},
  '../../../db':{upsertPersonMemory:p=>saved.push(p),auditLog(){}},
  '../../../utils/genderDetect':{detectAndSaveGender:async p=>{calls.push(p);}},
  '../coordinator':{handleOutreachReply:async()=>({handled:true})},'../../../vision':{},
  '../../../utils/logger':{__esModule:true,default:{info(){},warn(){}}},'./helpers':{},'../threadHistory':{},
  '../../../connections/slack/eligibility':{readInternalSlackConversation:async()=>eligible},'../socketWatermark':{stampSocketAlive(){}},
 };
 function load(rel){const code=ts.transpileModule(fs.readFileSync(path.join(sourceRoot,rel),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;const m={exports:{}};vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{}, {filename:rel})(n=>{assert.ok(Object.hasOwn(deps,n),'unexpected dependency '+n);return deps[n];},m,m.exports);return m.exports;}
 const profile={assistant:{name:'Maelle',slack:{bot_token:'fixture-token'}},user:{slack_user_id:'UOWNER'},advanced:{self_declared_gender_detection:optIn}};
 const ctx={profile,botUserId:'UBOT',getSenderRole:()=> 'colleague',app:{client:{users:{info:async()=>{if(failed)throw Error('unavailable');return {user:{real_name:'Peer',tz:'UTC',profile:{pronouns:'she/her',image_192:'https://fixture.invalid/photo'}}};}}}}};
 return {calls,saved,ctx,helpers:load('src/connectors/slack/app/helpers.ts'),processor:load('src/connectors/slack/app/processMessage.ts')};
}
function params(surface){return {senderId:'UPEER',text:'אני שמחה',framing:{prefix:'Someone else says: '},channelId:surface==='dm'?'DPEER':'GROOM',ts:'1',threadTs:'1',client:{},say:async()=>{},isMpim:surface==='mpim',isChannel:surface==='channel',isExplicitMention:true};}
test('regression mention caller never supplies photo or credential',async()=>{const h=setup();await h.helpers.resolveSlackMentions(h.ctx,'<@UPEER>');assert.equal(h.calls.length,1);assert.equal(Object.hasOwn(h.calls[0],'imageUrl'),false);assert.equal(Object.hasOwn(h.calls[0],'botToken'),false);});
for(const surface of ['dm','mpim','channel'])test('regression '+surface+' sender never supplies photo or credential',async()=>{const h=setup();await h.processor.processMessage(h.ctx,params(surface));assert.equal(h.calls.length,1);assert.equal(Object.hasOwn(h.calls[0],'imageUrl'),false);assert.equal(Object.hasOwn(h.calls[0],'botToken'),false);});
test('preserved mention pronouns and identity; no self text',async()=>{const h=setup();assert.equal(await h.helpers.resolveSlackMentions(h.ctx,'Hi <@UPEER>'),'Hi Peer (slack_id: UPEER)');assert.equal(h.calls[0].pronouns,'she/her');assert.equal(h.calls[0].slackId,'UPEER');assert.equal(h.calls[0].selfText,undefined);});
for(const optIn of [false,true])test('preserved self text opt-in '+optIn,async()=>{const h=setup({optIn});await h.processor.processMessage(h.ctx,params('dm'));assert.equal(h.calls[0].selfText,optIn?'אני שמחה':undefined);assert.equal(h.calls[0].pronouns,'she/her');});
test('preserved failed directory lookup does not detect or save',async()=>{const h=setup({failed:true});await h.helpers.resolveSlackMentions(h.ctx,'<@UPEER>');await h.processor.processMessage(h.ctx,params('dm'));assert.equal(h.calls.length,0);assert.equal(h.saved.length,0);});
test('preserved unavailable eligibility does not detect',async()=>{const h=setup({eligible:false});await h.processor.processMessage(h.ctx,params('dm'));assert.equal(h.calls.length,0);});
test('preserved owner and bot mentions do not detect',async()=>{const h=setup();await h.helpers.resolveSlackMentions(h.ctx,'<@UOWNER> <@UBOT>');assert.equal(h.calls.length,0);});
