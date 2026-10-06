const {test}=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./test-slack-thread-boundaries.cjs');
const fail=()=>{throw Object.assign(Error('private provider schema detail'),{status:400});};
const make=opts=>harness({actualFailureReply:true,orchestrator:fail,...opts});
const he=s=>assert.match(s,/[\u0590-\u05ff]/);
for(const [name,params] of [
 ['owner DM',{}],['colleague DM',{senderId:'UCOLLEAGUE',channelId:'DCOLLEAGUE'}],
 ['MPIM',{channelId:'GROOM',isMpim:true,isExplicitMention:true}],
 ['channel',{channelId:'CROOM',isChannel:true,isExplicitMention:true}],
 ['voice',{text:'[Voice message]: כן',voiceInput:true}],['image caption',{text:'תמונה לבדיקה'}]
])test('runner Hebrew '+name,async()=>{const h=make();await h.turn({text:'שלום אפשר עזרה',...params});await h.fire();assert.equal(h.posts.length,1);he(h.posts[0].text);assert.equal(h.posts[0].thread_ts,'100.000001');assert.ok(!h.posts[0].text.includes('private'));});
test('prequeue Hebrew',async()=>{const h=make({prequeueFailure:true});await h.turn({text:'שלום'});assert.equal(h.runs.length,0);assert.equal(h.posts.length,1);he(h.posts[0].text);});
for(const [name,input,pattern] of [['Hebrew','שלום',/[\u0590-\u05ff]/],['Russian','Привет',/[\u0400-\u04ff]/],['Arabic','مرحبا',/[\u0600-\u06ff]/]])for(const overload of [false,true])test('helper '+name+' '+overload,()=>{const h=make();const m=h.load('src/connectors/slack/app/helpers.ts');assert.match(m.failureReply(overload?{status:529}:Error('private'),input),pattern);});
for(const input of ['Hello','Hola','','123','(image attached, no caption)'])test('English default '+JSON.stringify(input),()=>{const m=make().load('src/connectors/slack/app/helpers.ts');assert.equal(m.failureReply(Error('private'),input),"Something's off on my end, give me a minute and try again?");assert.equal(m.failureReply({status:529},input),m.OVERLOAD_REPLY);});
test('merged raw text ignores framing and strips each voice marker',async()=>{const h=make();await h.turn({text:'[Voice message]: כן',framing:{prefix:'A long English synthetic model instruction '.repeat(20)}});await h.turn({text:'[Voice message]: כן',ts:'102.000001'});await h.fire();assert.equal(h.posts.length,1);he(h.posts[0].text);});
test('English processor control',async()=>{const h=make();await h.turn();await h.fire();assert.equal(h.posts.length,1);assert.match(h.posts[0].text,/Something's off/);});
test('delivered tail failure emits no second reply',async()=>{const h=make({orchestrator:async()=>({reply:'ok'}),postReply:async p=>{p.onDelivered();throw Error('tail');}});await h.turn();await h.fire();assert.equal(h.posts.length,0);});
test('merge abort emits no failure reply',async()=>{const h=make({orchestrator:async()=>{throw Error('aborted_for_merge');}});await h.turn();await h.fire();assert.equal(h.posts.length,0);});
test('failed failure send is attempted once',async()=>{const h=make({postFails:true});await h.turn();await h.fire();assert.equal(h.posts.length,1);});
test('ineligible inbound emits nothing',async()=>{const h=make({infoFails:true});await h.turn();assert.equal(h.posts.length,0);assert.equal(h.runs.length,0);});
test('eligibility lost before failure reply emits nothing',async()=>{const h=make({orchestrator:async()=>{h.channels.DOWNER.user='UEXTERNAL';fail();}});await h.turn();await h.fire();assert.equal(h.posts.length,0);});
test('replay Hebrew uses same processor and thread',async()=>{const h=make({actualProcessor:true});h.handlers();await h.load('src/connectors/slack/inboundReplayRegistry.ts').getInboundReplay('UOWNER')({message:{user:'UOWNER',text:'שלום',ts:'101.000001'},channelId:'DOWNER',postThreadTs:'100.000001',source:'dm'});await h.drain();await h.fire();assert.equal(h.posts.length,1);he(h.posts[0].text);assert.equal(h.posts[0].thread_ts,'100.000001');});
