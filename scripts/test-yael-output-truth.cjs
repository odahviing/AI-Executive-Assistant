const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),cp=require('node:child_process'),vm=require('node:vm'),ts=require('typescript');
const {DateTime}=require('luxon');
const {harness,profile,verdict}=require('./test-gatekeeper-readiness.cjs');
const rev=process.argv.includes('--source-revision')?process.argv[process.argv.indexOf('--source-revision')+1]:null;
const sourceAt=process.argv.indexOf('--source-root');const sourceRoot=sourceAt<0?null:process.argv[sourceAt+1];
const source=p=>sourceRoot&&fs.existsSync(sourceRoot+'/'+p.split('/').pop())?fs.readFileSync(sourceRoot+'/'+p.split('/').pop(),'utf8'):rev?cp.execFileSync('git',['show',`${rev}:${p}`],{encoding:'utf8'}):fs.readFileSync(p,'utf8');
const ctx={profile,result:{toolSummaries:[],bookingOccurred:false},history:[],userMessage:'yes',senderId:'UYAEL',channelId:'DYAEL',threadTs:'1',role:'colleague'};
const hedge='That outcome is not confirmed.';
const draft='There was a problem identifying the meeting at 09:00.';
for(const [name,reply,type] of [['failed-to-approval','Idan approved the meeting at 09:00.','permission_granted'],['pending-to-done','Moved the meeting at 09:00.','book'],['hebrew-approval','עידן אישר את הפגישה ב-09:00.','permission_granted'],['russian-completion','Встреча перенесена на 09:00.','book']]){
 for(const [surface,extra] of [['colleague',{}],['room',{channelId:'CROOM',senderId:'UOWNER',role:'colleague'}],['unknown',{role:undefined}]]) test(`${name}-${surface}`,async()=>{
 const seen=[];const h=harness([verdict(false,reply)],{
 'src/utils/claimChecker.ts':{checkReplyClaims:async input=>{seen.push(input);return {claimed_action:input.reply===reply,action_type:type}},genericHonestHedge:()=>hedge},
 'src/db/requests.ts':{getLatestRequestForThread:()=>null,getRequestsForThread:()=>[{subject:'Meeting',state:'awaiting_owner',outcome_json:null}]}
 });
 assert.equal(await h.gates.runOutputGates(draft,{...ctx,...extra}),hedge);assert.ok(seen.some(x=>x.reply===reply));assert.equal(h.forbidden.length,0);
 });
}
for(const [name,text,rows] of [['approved-recap','Idan approved; the move is still pending.',[{subject:'Meeting',state:'resolved',outcome_json:JSON.stringify({approved:true,replayed:false})}]],['plain-information','The office is on floor three.',[]],['honest-failure',draft,[]]]) test(`preserved-${name}`,async()=>{
 const seen=[];const h=harness([verdict(true)],{'src/utils/claimChecker.ts':{checkReplyClaims:async x=>{seen.push(x);return {claimed_action:false}},genericHonestHedge:()=>hedge},'src/db/requests.ts':{getLatestRequestForThread:()=>null,getRequestsForThread:()=>rows}});
 assert.equal(await h.gates.runOutputGates(text,ctx),text);
 });
for(const changed of [false,true]) test(`unknown-check-${changed?'rejects-rewrite':'preserves-original'}`,async()=>{
 const h=harness([changed?verdict(false,'Idan approved at 09:00.'):verdict(true)],{'src/utils/claimChecker.ts':{checkReplyClaims:async()=>({claimed_action:false,failed_open:true}),genericHonestHedge:()=>hedge},'src/db/requests.ts':{getLatestRequestForThread:()=>null,getRequestsForThread:()=>{throw Error('offline')}}});
 assert.equal(await h.gates.runOutputGates(draft,ctx),changed?hedge:draft);
});
function dates(pair,names){
 const stubs={'luxon':{DateTime},'../llm/client':{getAnthropicClient:()=>({messages:{create:async()=>({content:[{type:'text',text:JSON.stringify({pairs:[pair],weekdayNames:names})}]})}})},'../llm/models':{MODEL_HAIKU:'mock'},'./logger':{__esModule:true,default:{warn(){}}},'./effectiveToday':{getEffectiveToday:()=>DateTime.fromISO('2026-10-07')},'./extractJson':{parseFirstJsonObject:JSON.parse},'./usageLog':{logLlmUsage(){}}};
 const m={exports:{}};const code=ts.transpileModule(source('src/utils/dateVerifier.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 vm.runInNewContext(`(function(require,module,exports){${code}\n})`)(key=>{assert.ok(key in stubs,key);return stubs[key]},m,m.exports);return m.exports;
}
const heb=['יום שני','יום שלישי','יום רביעי','יום חמישי','יום שישי','יום שבת','יום ראשון'];
for(const [name,word,num,expected] of [['short-inconsistent','שלישי',3,'שלישי'],['full-inconsistent','יום שלישי',3,'יום שלישי'],['short-correct','שלישי',2,'שלישי'],['short-incorrect','ראשון',7,'שלישי'],['full-incorrect','יום ראשון',7,'יום שלישי']]) test(`weekday-${name}`,async()=>{
 const span=`${word} 13.10`;const d=dates({span,writtenWeekdayText:word,writtenWeekdayNum:num,isoDate:'2026-10-13'},heb);const v=await d.verifyDates(span,profile);let out=span;for(const mm of v.mismatches)out=out.split(mm.matchedText).join(mm.matchedText.split(mm.writtenWeekday).join(mm.correctWeekday));assert.equal(out,`${expected} 13.10`);
});
test('weekday-English-incorrect',async()=>{const d=dates({span:'Monday 13.10',writtenWeekdayText:'Monday',writtenWeekdayNum:1,isoDate:'2026-10-13'},['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']);assert.equal((await d.verifyDates('Monday 13.10',profile)).mismatches[0].correctWeekday,'Tuesday')});

// Owner private and email use the existing action classifier after voice.
for(const [surface,extra] of [['owner',{senderId:'UOWNER',role:'owner'}],['email',{senderId:'UOWNER',role:'owner',transport:'email'}]]) test(`final-approval-${surface}`,async()=>{
 const invented='Idan approved the meeting at 09:00.';const seen=[];
 const h=harness([verdict(false,invented)],{'src/utils/claimChecker.ts':{checkReplyClaims:async input=>{seen.push(input);return {claimed_action:input.reply===invented,action_type:'permission_granted'}},genericHonestHedge:()=>hedge},'src/db/requests.ts':{getLatestRequestForThread:()=>null,getRequestsForThread:()=>[]}});
 assert.equal(await h.gates.runOutputGates(draft,{...ctx,...extra}),hedge);assert.ok(seen.some(x=>x.reply===invented));
});
// Actual semantic classifier module: fixtures prove prompt input/structured
// verdict handling only. They do not assert production model obedience.
function checkerHarness(response){const calls=[];const deps={'@anthropic-ai/sdk':{},'../llm/client':{getAnthropicClient:()=>({messages:{create:async req=>{calls.push(req);if(response instanceof Error)throw response;return {content:[{type:'text',text:typeof response==='function'?response(req):response}]}}}})},'../llm/models':{MODEL_HAIKU:'fixture',MODEL_SONNET:'fixture',SONNET:{model:'fixture'}},'./logger':{__esModule:true,default:{warn(){},info(){},debug(){}}},'./usageLog':{logLlmUsage(){}},'./detectMessageLanguage':{detectMessageLanguage:()=> 'English'},'./extractJson':{extractFirstJsonObject:s=>s}};
 const m={exports:{}};const code=ts.transpileModule(source('src/utils/claimChecker.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 vm.runInNewContext(`(function(require,module,exports){${code}\n})`,{Date,setTimeout,clearTimeout})(key=>{assert.ok(key in deps,key);return deps[key]},m,m.exports);return {checker:m.exports,calls};}
test('actual-checker-final-outcome-contract',async()=>{const h=checkerHarness(JSON.stringify({claimed_action:false}));const context='Requests: [{"subject":"Meeting","approved":true,"replayed":false}]';await h.checker.checkReplyClaims({reply:'Idan approved, execution pending.',toolSummaries:[],bookingOccurred:false,ownerFirstName:'Idan',mode:'owner_fact',finalOutcomeContext:context});const p=h.calls[0].messages[0].content;assert.ok(p.includes(context));assert.ok(p.includes('approved=true is permission only, never completion'));assert.ok(p.includes('An earlier assistant assertion is never evidence'));});
for(const [name,response] of [['unavailable',Error('offline')],['malformed','invalid']])test(`actual-checker-${name}-unknown`,async()=>{const h=checkerHarness(response);const r=await h.checker.checkReplyClaims({reply:'That is approved.',toolSummaries:[],bookingOccurred:false,ownerFirstName:'Idan',mode:'owner_fact',finalOutcomeContext:'unavailable'});assert.equal(r.failed_open,true)});

for(const [name,original,rewrite,extra,expected] of [
 ['unchanged-short','Thanks.',null,{senderId:'UOWNER',role:'owner'},1],
 ['changed-short','Please wait.','Approved.',{senderId:'UOWNER',role:'owner'},2],
 ['owner-action','The meeting has been moved to the requested time.',null,{senderId:'UOWNER',role:'owner',result:{toolSummaries:['[move_meeting OK] mutated=calendar']}},2],
 ['colleague','The request is still pending.',null,{},2],
])test(`call-budget-${name}`,async()=>{const c=checkerHarness(JSON.stringify({claimed_action:false}));const h=harness([rewrite?verdict(false,rewrite):verdict(true)],{'src/utils/claimChecker.ts':{...c.checker,genericHonestHedge:()=>hedge},'src/db/requests.ts':{getLatestRequestForThread:()=>null,getRequestsForThread:()=>[]}});await h.gates.runOutputGates(original,{...ctx,...extra});const counts={voice:h.calls.length,truth:c.calls.length,total:h.calls.length+c.calls.length};console.log('CALL_COUNTS',name,JSON.stringify(counts));assert.equal(counts.total,expected)});
const {harness:lifecycleHarness}=require('./fixtures/yael-lifecycle.cjs');
for(const [name,options,completed,verified] of [
 ['confirmed-calendar',{tool:'move_meeting',toolResult:{success:true,meetingId:'event-1',booked_start:'2026-09-20T12:00:00Z'}},true,null],
 ['unconfirmed-calendar',{tool:'move_meeting',toolResult:{error:'approved_action_unconfirmed'}},false,false],
 ['tracked-noncalendar',{tool:'message_colleague',row:{owner_dm_channel:'DOWNER',owner_dm_thread_ts:'owner.1'},toolResult:{ok:true,scheduled:true,jobId:'job-1',scheduled_at:'2026-09-20T12:00:00Z',_status:'scheduled_not_sent'}},false,null],
 ['failed-calendar',{tool:'move_meeting',toolResult:{error:'calendar_offline'}},false,null],
])test(`actual-resolver-outcome-${name}`,async()=>{
 const lifecycle=lifecycleHarness(options);const result=await lifecycle.resolve();const row=lifecycle.row();
 const outcome=JSON.parse(row.outcome_json??'{}');
 if(name==='failed-calendar'){assert.equal(row.state,'awaiting_owner');assert.equal(result.ok,false)}
 else {assert.equal(row.state,'resolved',JSON.stringify({result,warnings:lifecycle.effects.warnings}));assert.equal(outcome.replayed,options.tool)}
 if(name==='unconfirmed-calendar')assert.equal(outcome.verified,false);
 if(name==='tracked-noncalendar')assert.ok(result.effect.includes('tracked'));
 let observed;
 const checker=checkerHarness(req=>{
   const p=req.messages[0].content;const line=p.split('Requests: ')[1]?.split('\n')[0];
   observed=JSON.parse(line.split('. Earlier tool receipts:')[0])[0];
   assert.ok(p.includes('completionConfirmed=true'));
   return JSON.stringify({claimed_action:observed.completionConfirmed!==true,action_type:observed.completionConfirmed?'other':'book'});
 });
 const g=harness([verdict(true)],{'src/db/requests.ts':{getLatestRequestForThread:()=>row,getRequestsForThread:()=>[row]},'src/utils/claimChecker.ts':checker.checker});
 const recap='The approved action was completed.';
 const out=await g.gates.runOutputGates(recap,{...ctx,result:{toolSummaries:[]},history:[]});
 assert.equal(observed.replayed,name==='failed-calendar'?null:options.tool);
 assert.equal(observed.verified,verified);
 assert.equal(observed.completionConfirmed,completed);
 assert.equal(out===recap,completed);
 if(!completed)assert.ok(out.includes("not totally sure"));
 assert.deepEqual(lifecycle.unexpected,[]);assert.deepEqual(g.forbidden,[]);
});



