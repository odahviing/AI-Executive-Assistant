// Execute the calendar detector's real parser and scope boundary with controlled
// provider responses. Semantic quality is measured separately by Vertex replay.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),at=process.argv.indexOf('--source-file');
function harness(response){
 const calls=[],noop=()=>{},mod={exports:{}},deps={
  '@anthropic-ai/sdk':{},'../llm/models':require('./load-test-models.cjs'),
  './logger':{__esModule:true,default:{warn:noop,info:noop,debug:noop}},'./usageLog':{logLlmUsage:noop},
  './extractJson':{extractFirstJsonObject:text=>text.slice(text.indexOf('{'),text.lastIndexOf('}')+1)},
  './detectMessageLanguage':{detectMessageLanguage:()=> 'en'},
  '../llm/client':{getAnthropicClient:()=>({messages:{create:async request=>{calls.push(request);return {content:[{type:'text',text:typeof response==='string'?response:JSON.stringify(response)}]};}}})},
 };
 const file=at<0?path.join(root,'src/utils/claimChecker.ts'):path.resolve(process.argv[at+1]);
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
 vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{Date,setTimeout,clearTimeout})(name=>{assert.ok(deps[name],name);return deps[name]},mod,mod.exports);
 return {...mod.exports,calls};
}
const reply='Idan is busy at 08:30. I can ask him about another time.';
const input={reply,ownerFirstName:'Idan',toolSummaries:[],mode:'slot_grounding',slotGroundingContext:{groundedToolLines:[],observations:[
 {tool:'find_available_slots',results:[{start:'2026-11-12T08:30:00-05:00',owner_available:true,attendees:[{email:'peer@example.test',status:'busy'}]}]},
]}};
for(const [label,response,flag]of [
 ['unsupported owner attribution',{claim_quote:'Idan is busy at 08:30.',fact_subject:'owner',verdict:'unsupported'},true],
 ['supported statement despite legacy true',{claim_quote:reply,fact_subject:'owner',verdict:'supported',claimed_action:true},false],
 ['inconclusive evidence',{claim_quote:reply,fact_subject:'owner',verdict:'unknown',claimed_action:true},false],
 ['legacy presence boolean',{claim_quote:reply,claimed_action:true,action_type:'ungrounded_slot_claim'},false],
 ['invented quote',{claim_quote:'Idan is free tomorrow.',fact_subject:'owner',verdict:'unsupported'},false],
 ['missing quote',{fact_subject:'owner',verdict:'unsupported'},false],
 ['missing subject',{claim_quote:reply,verdict:'unsupported'},false],
 ['no claim',{fact_subject:'none',verdict:'no_calendar_claim'},false],
 ['malformed legacy positive','{"claimed_action":true,"action_type":"ungrounded_slot_claim",}',false],
])test('calendar evidence contract: '+label,async()=>{
 const h=harness(response),result=await h.checkReplyClaims(input);
 assert.equal(result.claimed_action,flag);
 if(flag)assert.equal(result.action_type,'ungrounded_slot_claim');
 assert.equal(h.calls.length,1);
 assert.ok(h.calls[0].messages[0].content.includes(JSON.stringify(input.slotGroundingContext.observations)));
});
test('personal-fact checker cannot veto a calendar reason',async()=>{
 const h=harness({claim_quote:reply,claimed_action:true,action_type:'ungrounded_slot_claim'});
 assert.equal((await h.checkReplyClaims({...input,mode:'owner_fact'})).claimed_action,false);
});

for(const [label,domain,type,verdict,quote,expected]of [
 ['invented personal fact','personal_fact','invented_fact','unsupported','Idan always enjoys driving calls.',true],
 ['policy requirement is not owner assent','policy_requirement','permission_granted','unsupported','No owner approval is required.',false],
 ['calendar does not become a personal fact','calendar_fact','invented_fact','unsupported','Idan is free at 17:00.',false],
 ['unconfirmed grant','owner_decision','permission_granted','unsupported','Idan approved this.',true],
 ['unconfirmed send','completed_action','message','unsupported','I sent this.',true],
 ['supported send','completed_action','message','supported','I sent this.',false],
 ['unknown referent','owner_decision','permission_granted','unknown','Idan approved this.',false],
 ['cross-domain label','personal_fact','book','unsupported','Idan is free at 17:00.',false],
])test('owner fact domain contract: '+label,async()=>{
 const h=harness({claim_domain:domain,action_type:type,verdict,claim_quote:quote});
 assert.equal((await h.checkReplyClaims({...input,mode:'owner_fact',reply:quote})).claimed_action,expected);
});
