// Actual modules with a closed dependency allowlist. Model responses are scripted:
// this proves routing, receipts and deletion boundaries, never semantic obedience.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),before=process.env.GATE206_BEFORE;
function load(rel,deps,extra='') {const p=before&&fs.existsSync(path.join(before,rel))?path.join(before,rel):path.join(root,rel);const code=ts.transpileModule(fs.readFileSync(p,'utf8')+'\n'+extra,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;const m={exports:{}};vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{Date,setTimeout,clearTimeout},{filename:rel})(n=>{assert.ok(Object.hasOwn(deps,n),'unlisted dependency '+n);return deps[n]},m,m.exports);return m.exports;}
const log={__esModule:true,default:{info(){},warn(){},debug(){},error(){}}},usage={logLlmUsage(){}},models=require('./load-test-models.cjs');
const turn=load('src/core/orchestrator/turnHelpers.ts',{'@anthropic-ai/sdk':{},luxon:require('luxon'),'../../llm/client':{getAnthropicClient:()=>({})},'../../utils/usageLog':usage,'../../utils/logger':log,'../../utils/attendeeAvailability':{ATTENDEE_REASON_PREFIXES:[]}});
const receipt='[find_available_slots 2026-09-14 dur=15m → 1 slots: 10:00 calendars_read=levana.b@example.com]';
const draft='You are right about the times. I could not read Levana’s calendar for that search.';
const clean='You are right about the times.';
const profile={user:{name:'Idan Cohen',slack_user_id:'UOWNER',email:'owner@example.com',timezone:'Asia/Jerusalem'},assistant:{name:'Maelle'}};
const ctx=extra=>({profile,result:{toolSummaries:[]},history:[{role:'assistant',content:receipt+'\nI found options.',toolSummaries:[receipt]}],userMessage:'Those times do not work.',senderId:'UPEER',role:'colleague',channelId:'DPEER',threadTs:'1.2',...extra});

test('a claim quoted from older history cannot veto a current text edit',async()=>{
 const h=harness({verdict:{claimed_action:true,claim_quote:'Daniel weekly was updated.',action_type:'permission_granted'}});
 const reply='I moved the registration link to the end of your post.';
 const result=await h.checker.checkReplyClaims({reply,toolSummaries:['[update_meeting FAILED]'],bookingOccurred:false,ownerFirstName:'Idan'});
 assert.equal(result.claimed_action,false);assert.equal(result.failed_open,true);
 assert.ok(h.calls[0].messages[0].content.includes('exact offending words from the CURRENT DRAFT'));
});
test('a source-bound phantom-send claim still invokes the factual remedy',async()=>{
 const reply='I sent the invitation to Alex.';
 const h=harness({verdict:{claimed_action:true,claim_quote:reply,action_type:'message'}});
 const result=await h.checker.checkReplyClaims({reply:reply+' It is confirmed.',toolSummaries:[],bookingOccurred:false,ownerFirstName:'Idan'});
 assert.equal(result.claimed_action,true);assert.equal(result.action_type,'message');
});
function harness(opts={}){const calls=[];const client={messages:{create:async req=>{calls.push(req);if(opts.error)throw Error('fixture unavailable');if(req.tools)return {stop_reason:'tool_use',content:[{type:'tool_use',name:'verdict',input:opts.rewrite??{verdict:'rewrite',minimalRedaction:clean,minimalRedactionPreservesRest:true}}]};const prompt=req.messages[0].content;const enabled=prompt.includes('EARLIER CALENDAR READ RECEIPTS:')&&prompt.includes(opts.receipt??receipt);return {content:[{type:'text',text:opts.malformed?'broken':JSON.stringify(require('./fixtures/action-claim-verdict.cjs')(opts.verdict??(enabled&&!opts.keep?{claimed_action:true,action_type:'denied_calendar_read',target_name:'levana.b@example.com',action_summary:'Denied the earlier calendar read'}:{claimed_action:false}),req))}]};}}};
const checker=load('src/utils/claimChecker.ts',{'@anthropic-ai/sdk':{},'../llm/client':{getAnthropicClient:()=>client},'../llm/models':models,'./logger':log,'./extractJson':{extractFirstJsonObject:s=>s},'./usageLog':usage,'./detectMessageLanguage':{detectMessageLanguage:()=> 'en'}});
const gates=load('src/utils/guards/runOutputGates.ts',{'../../llm/client':{getAnthropicClient:()=>client},'../../core/requests/types':{FREEFORM_OWNER_FLAG_SUBKIND:'freeform_owner_flag'},'../../llm/models':models,'../../core/orchestrator/turnHelpers':turn,'../../connections/slack/formatting':{formatForSlack:s=>s},'../logger':log,'../usageLog':usage,'../claimChecker':checker,'../availabilityGate':{freshHardBlockedSlots:()=>[]},'../humanGate':{runHumanGate:async()=>({ok:true})},'../dateVerifier':{verifyDates:async()=>({ok:true,mismatches:[]})},'../securityGate':{filterColleagueReply:async o=>({reply:o.reply,filtered:false})},'../../db/requests':{getLatestRequestForThread:()=>null},'../../db':{getPersonMemory:()=>({email:'peer@example.com'})}},'export {runOwnerFactCheckAndMaybeRewrite as __fact};');return {calls,gates,checker};}
for(const [id,extra] of [['colleague-dm',{}],['colleague-room',{isMpim:true}],['owner-room',{senderId:'UOWNER',isMpim:true,isOwnerInGroup:true}],['email',{transport:'email'}]])test('regression '+id+' historical denial routes through existing fact call',async()=>{const h=harness();const out=await h.gates.runOutputGates(draft,ctx(extra));assert.equal(out,clean);const detect=h.calls.filter(c=>c.messages[0].content.includes('EARLIER CALENDAR READ RECEIPTS:'));assert.equal(detect.length,1);assert.ok(detect[0].messages[0].content.includes(receipt));assert.equal(h.calls.filter(c=>c.tools).length,1);});
for(const [id,extra] of [['no-history',{history:[]}],['prose-only',{history:[{role:'assistant',content:'I read Levana’s calendar.'}]}],['newer-failed',{history:[...ctx().history,{role:'assistant',content:'[find_available_slots FAILED: timeout]\nCould not check.',toolSummaries:['[find_available_slots FAILED: timeout]']}]}],['newer-unknown',{history:[...ctx().history,{role:'assistant',content:'[find_available_slots 2026-09-15: 1 slots attendee_partial=1]\nUnknown.',toolSummaries:['[find_available_slots 2026-09-15: 1 slots attendee_partial=1]']}]}],['same-row-later-failure',{history:[{role:'assistant',content:receipt+' [find_available_slots FAILED: timeout]\nUnknown.',toolSummaries:[receipt,'[find_available_slots FAILED: timeout]']}]}],['current-failure',{result:{toolSummaries:['[find_available_slots FAILED: timeout]']}}],['expired-history-window',{history:[...ctx().history,...Array.from({length:12},()=>({role:'user',content:'later'}))]}]])test('preserved '+id+' cannot turn old receipt into current access',async()=>{const h=harness();assert.equal(await h.gates.__fact(ctx(extra),draft),draft);assert.equal(h.calls.filter(c=>c.tools).length,0);});
for(const [id,opts] of [['semantic-keep',{keep:true}],['judge-unavailable',{error:true}],['malformed-json',{malformed:true}]])test('preserved '+id+' keeps original',async()=>{const h=harness(opts);assert.equal(await h.gates.__fact(ctx(),draft),draft);});
for(const [id,r] of [['veto',{verdict:'keep'}],['empty',{verdict:'rewrite',minimalRedaction:'',minimalRedactionPreservesRest:true}],['additions',{verdict:'rewrite',minimalRedaction:'Everyone is available.',minimalRedactionPreservesRest:true}],['unattested',{verdict:'rewrite',minimalRedaction:clean}],['reasoning-only',{verdict:'rewrite',message:'model reasoning'}]])test('regression denial rewrite '+id+' safely keeps original',async()=>{const h=harness({rewrite:r});const out=await h.checker.rewriteOwningTheMiss({draft,actionType:'denied_calendar_read',targetName:'levana.b@example.com',ownerFirstName:'Idan',toolSummaries:[receipt]});assert.equal(out,null);});
test('regression exact target receipt required despite false classifier flag',async()=>{const h=harness({verdict:{claimed_action:true,action_type:'denied_calendar_read',target_name:'external@example.com'}});assert.equal(await h.gates.__fact(ctx(),draft),draft);assert.equal(h.calls.filter(c=>c.tools).length,0);});
test('regression multilingual instructions and bounded deletion use actual checker',async()=>{const h=harness();await h.gates.__fact(ctx(),draft);const prompt=h.calls[0].messages[0].content;assert.ok(prompt.includes('any language'));for(const p of ['Present inability','different interval','exact identity','never name similarity'])assert.ok(prompt.includes(p));});
test('preserved owner private does not invoke colleague fact mode',async()=>{const h=harness({keep:true});assert.equal(await h.gates.runOutputGates(draft,ctx({senderId:'UOWNER',role:'owner',channelId:'DOWNER'})),draft);assert.ok(!h.calls.some(c=>c.messages[0].content.includes('EARLIER CALENDAR READ RECEIPTS:')));});
for(const [id,status] of [['read','free'],['outage','unknown']])test('preserved producer '+id+' summary carries only confirmed calendars',()=>{const line=turn.summarizeToolCall('find_available_slots',{duration_minutes:15},{slots:[{start:'2026-09-14T10:00:00+03:00',end:'2026-09-14T10:15:00+03:00',attendee_status:[{email:'levana.b@example.com',status}]}]},'Asia/Jerusalem');assert.equal(line.includes('calendars_read=levana.b@example.com'),status==='free');});
test('owner decision candidates retain checked attendees and their individual conflicts', () => {
 const summary = turn.summarizeToolCall('find_available_slots', {duration_minutes:25}, {
  slots: [], owner_approval_candidates: [{start:'2026-10-19T13:30:00+03:00', end:'2026-10-19T13:55:00+03:00',
   attendee_status:[{email:'einav@example.com',status:'free'},{email:'requester@example.com',status:'busy'},{email:'external@example.com',status:'unknown'}],
   attendee_conflicts:[{email:'requester@example.com',reason:'busy',assumed:false}],broken_rules:['free_time_floor']}],
 }, 'Asia/Jerusalem');
 assert.ok(summary.includes('owner_decision_required (unapproved)'));
 assert.ok(summary.includes('attendee_status=einav@example.com:free+requester@example.com:busy+external@example.com:unknown'));
 assert.ok(summary.includes('attendee_conflicts=requester@example.com:busy'));
 assert.ok(summary.includes('calendars_read=einav@example.com+requester@example.com'));
 assert.ok(!summary.includes('calendars_read=external@example.com'));
 assert.ok(summary.includes('owner_status=decision_required owner_rules=free_time_floor'));
 assert.ok(!summary.includes('owner_status=available'));
});
test('normal search receipts preserve owner availability alongside additional people', () => {
 const summary = turn.summarizeToolCall('find_available_slots', {duration_minutes:25}, {
  slots:[{start:'2026-10-22T12:00:00+03:00',end:'2026-10-22T12:25:00+03:00',
   attendee_status:[{email:'einav@example.com',status:'free'},{email:'oran@example.com',status:'busy'}]}],
 }, 'Asia/Jerusalem');
 assert.ok(summary.includes('owner_status=available'));
 assert.ok(summary.includes('attendee_status=einav@example.com:free+oran@example.com:busy'));
});
test('recovered and held options preserve their owner conditions in the receipt', () => {
 const summary = turn.summarizeToolCall('find_available_slots', {duration_minutes:25}, {
  _relaxed_recovery:true,
  slots:[{start:'2026-10-22T12:00:00+03:00',end:'2026-10-22T12:25:00+03:00',
   broken_rules:['disturbs_floating_block','free_time_floor'],less_preferred_label:'less preferred'},
   {start:'2026-10-22T13:00:00+03:00',end:'2026-10-22T13:25:00+03:00',on_hold:true}],
 }, 'Asia/Jerusalem');
 assert.ok(summary.includes('owner_status=conditional owner_rules=disturbs_floating_block+free_time_floor preference=less preferred'));
 assert.ok(summary.includes('owner_status=conditional held=true'));
 assert.ok(!summary.includes('owner_status=available'));
});
for(const [lang,whole,remaining] of [['Hebrew','את צודקת. לא יכולתי לקרוא את הלוח של לבנה בחיפוש ההוא.','את צודקת.'],['Russian','Вы правы. Я не смогла прочитать календарь Леваны в том поиске.','Вы правы.'],['Spanish','Tienes razón. No pude consultar el calendario de Levana en esa búsqueda.','Tienes razón.']])test('regression '+lang+' controlled verdict deletes only clause',async()=>{const h=harness({rewrite:{verdict:'rewrite',minimalRedaction:remaining,minimalRedactionPreservesRest:true}});assert.equal(await h.gates.__fact(ctx(),whole),remaining);});
for(const [id,text] of [['current-outage','I read Levana’s calendar earlier, but I cannot access it now.'],['different-window','I could not confirm Levana’s calendar for next month.'],['disputed-slot','Those times still do not work for Levana.'],['external','I could not check the external attendee’s calendar.']])test('preserved false detector '+id+' existing veto keeps truthful reply',async()=>{const h=harness({verdict:{claimed_action:true,action_type:'denied_calendar_read',target_name:'levana.b@example.com',action_summary:'scripted false detector'},rewrite:{verdict:'keep'}});assert.equal(await h.gates.__fact(ctx(),text),text);assert.equal(h.calls.filter(c=>c.tools).length,1);});
test('regression persisted history replay is read-only and repeatable',async()=>{const context=ctx(),saved=JSON.stringify(context);for(let i=0;i<2;i++){const h=harness();assert.equal(await h.gates.__fact(context,draft),clean);}assert.equal(JSON.stringify(context),saved);});
test('final owner personal fact rejects new unchecked prose',async()=>{const h=harness({verdict:{claimed_action:true,action_type:'invented_fact',target_name:'Idan',action_summary:'unbacked habit'},rewrite:{verdict:'rewrite',message:'Let me check with Idan.',noUnfoundedOwnerClaim:true}});assert.equal(await h.gates.__fact(ctx(),'Idan always works through lunch.'),"I don't have confirmed information about that.");});

test('personal fact check leaves calendar claims to the dedicated final checker',async()=>{
  const human='I will be on vacation Wednesday and Thursday; please find another day.';
  const h=harness({verdict:{claimed_action:true,action_type:'ungrounded_slot_claim',action_summary:'scripted availability flag'},rewrite:{verdict:'keep'}});
  const context=ctx({userMessage:human,colleagueName:'Yael',history:[],result:{toolSummaries:['[find_available_slots 2026-11-24 dur=25m: 1 slots owner_status=available attendee_status=peer@example.com:busy]']}});
  const reply='Tuesday is open for Idan, but your calendar is busy. Shall I look for another day?';
  assert.equal(await h.gates.__fact(context,reply),reply);
  const calls=h.calls.map(c=>c.messages[0].content);
  assert.equal(calls.length,1);
  assert.ok(calls[0].includes(human));
  assert.ok(calls[0].includes('peer@example.com'));
  assert.ok(calls[0].includes('Reader: Yael'));
});

test('unavailable final evidence check restores the original answer after a style rewrite',async()=>{
 const original='No invitation has been sent. Which time should I use?';
 const h=harness({malformed:true});
 const answer=await h.gates.__fact(ctx(), 'Which time should I use?',original);
 assert.equal(answer,original);
 assert.ok(!answer.includes('confirmed information'));
});

test('a false action flag cannot erase a useful offer before independent review',async()=>{
 const draft='I can hold Thursday for you. Which time should I hold: 16:00 or 16:30?';
 const h=harness({verdict:{claimed_action:true,action_type:'book',action_summary:'Claimed an invitation'},rewrite:{verdict:'keep'}});
 assert.equal(await h.gates.__fact(ctx(),draft),draft);
 assert.equal(h.calls.filter(call=>call.tools).length,1);
});
test('a genuinely false action sentence is removed while the next decision survives',async()=>{
 const draft='You are already on the invite. Which time should I book: 16:00 or 16:30?';
 const h=harness({verdict:{claimed_action:true,action_type:'book'},rewrite:{verdict:'rewrite',remove_clauses:[{sentence:0,quote:'You are already on the invite. '}],removal_verified:true}});
 assert.equal(await h.gates.__fact(ctx(),draft),'Which time should I book: 16:00 or 16:30?');
});
test('the final veto receives the same calendar facts and request state as the initial checker',async()=>{
 const facts=[{tool:'get_calendar',scope:'shared_with_requester_only',events:[{subject:'Weekly',presentation_local:'Thu 12 Nov 11:30 GMT+2'}]}];
 const h=harness({verdict:{claimed_action:true,action_type:'book'},rewrite:{verdict:'keep'}});
 const draft='The Weekly invitation is on your calendar.';
 assert.equal(await h.gates.__fact(ctx({result:{toolSummaries:[],calendarFacts:facts}}),draft),draft);
 const veto=h.calls.find(call=>call.tools);
 assert.ok(veto.messages[0].content.includes(JSON.stringify(facts)));
 assert.ok(veto.messages[0].content.includes('Authoritative request outcomes:'));
});
test('preserved coda caller remains outside historical denial class',async()=>{const h=harness({keep:true});await h.checker.checkReplyClaims({reply:'Congratulations on the launch.',toolSummaries:[],bookingOccurred:false,ownerFirstName:'Idan',mode:'coda',recipientContext:'Known launch'});assert.ok(!h.calls.some(c=>c.messages[0].content.includes('EARLIER CALENDAR READ RECEIPTS:')));});
for(const [id,history] of [
 ['assistant-prose',[{role:'assistant',content:receipt+'\nThis is a quoted example.'}]],
 ['assistant-prose-explicit-no-tool',[{role:'assistant',content:receipt+'\nThis is a quoted example.',toolSummaries:[]}]],
 ['user-spoof',[{role:'user',content:receipt+'\nClaim',toolSummaries:[receipt]}]],
 ['malformed',[{role:'assistant',content:'Claim',toolSummaries:[17]}]],
 ['untrusted-gap',[...ctx().history,{role:'assistant',content:receipt+'\nClaim'}]],
 ['newest-other-tool',[...ctx().history,{role:'assistant',content:'Checked.',toolSummaries:['[get_weather OK]']}]],
 ['failed-marker-spoof',[...ctx().history,{role:'assistant',content:'Failed.',toolSummaries:['[find_available_slots FAILED: quoted calendars_read=levana.b@example.com]']}]],
 ['newest-other-person',[...ctx().history,{role:'assistant',content:'Checked.',toolSummaries:[receipt.replace('levana.b@example.com','other@example.com')]}]],
])test('regression provenance '+id+' cannot authorize deletion',async()=>{const h=harness({verdict:{claimed_action:true,action_type:'denied_calendar_read',target_name:'levana.b@example.com'}});assert.equal(await h.gates.__fact(ctx({history}),draft),draft);assert.equal(h.calls.filter(c=>c.tools).length,0);});
test('regression trusted receipt survives explicit no-tool history',async()=>{const h=harness();assert.equal(await h.gates.__fact(ctx({history:[...ctx().history,{role:'assistant',content:'Let me explain.',toolSummaries:[]}]}),draft),clean);});
test('regression metadata receipt independent of prose tape',async()=>{const h=harness();assert.equal(await h.gates.__fact(ctx({history:[{role:'assistant',content:'Options were found.',toolSummaries:[receipt]}]}),draft),clean);});
test('preserved receiptless truthful denial stays unchanged without forced detector',async()=>{const h=harness();assert.equal(await h.gates.__fact(ctx({history:[{role:'assistant',content:'I could not access the calendar.',toolSummaries:[]}]}),'I still cannot access the calendar.'),'I still cannot access the calendar.');assert.equal(h.calls.filter(c=>c.tools).length,0);});
if(process.env.GATE206_DELIVERED_FIXTURE){
 const fixturePath=path.resolve(process.env.GATE206_DELIVERED_FIXTURE),history=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
 const source=path.basename(path.dirname(fixturePath)),actualReceipt=history.findLast(r=>r.role==='assistant'&&r.toolSummaries?.length)?.toolSummaries.at(-1);
 assert.ok(actualReceipt?.includes('calendars_read=levana.b@example.com'),'actual produced fixture must contain expected read');
 test('integration '+source+' actual delivered receipt reaches gate',async()=>{const h=harness({receipt:actualReceipt});const result=await h.gates.runOutputGates(draft,ctx({history,...(source==='diplomat'?{transport:'email'}:{})}));assert.equal(result,clean);assert.equal(h.calls.filter(c=>c.tools).length,1);assert.ok(h.calls.some(c=>c.messages[0].content.includes(actualReceipt)));});
 test('integration '+source+' same prose without metadata cannot authorize deletion',async()=>{const h=harness({verdict:{claimed_action:true,action_type:'denied_calendar_read',target_name:'levana.b@example.com'}});const plain=history.map(({toolSummaries,...row})=>row);assert.equal(await h.gates.__fact(ctx({history:plain}),draft),draft);assert.equal(h.calls.filter(c=>c.tools).length,0);});
 test('integration '+source+' actual receipt false detector veto preserves current failure',async()=>{const truthful='I read the calendar earlier, but access is unavailable now.';const h=harness({receipt:actualReceipt,verdict:{claimed_action:true,action_type:'denied_calendar_read',target_name:'levana.b@example.com'},rewrite:{verdict:'keep'}});assert.equal(await h.gates.__fact(ctx({history}),truthful),truthful);});
}

test('a shared calendar observation survives a false booking claim flag only in its original audience and for that title', async () => {
  const observed = { subject: 'Tentative Slot', reply: 'I see “Tentative Slot” on Thursday. I didn’t send a new invitation.' };
  const h = harness({verdict:{claimed_action:true,action_type:'book',action_summary:'claims a booking'}});
  const result = {toolSummaries:['[get_calendar 2026-11-19→2026-11-19: 1 events]'],sharedMeetingRead:observed};
  const draft = 'The Tentative Slot invitation is already visible.';
  assert.equal(await h.gates.__fact(ctx({result}),draft), observed.reply);
  assert.notEqual(await h.gates.__fact(ctx({result,isChannel:true}),draft), observed.reply);
  assert.notEqual(await h.gates.__fact(ctx({result}),'I booked another meeting.'), observed.reply);
});

test('a failed prose correction preserves the actual current booking without its unsupported claim', async () => {
  const h = harness({verdict:{claimed_action:true,action_type:'invented_fact'},rewrite:{verdict:'rewrite',minimalRedaction:'New unsupported prose',minimalRedactionPreservesRest:true}});
  const action = {tool:'create_meeting',ok:true,subject:'Release schedule',start:'2026-11-10T09:15:00-05:00',end:'2026-11-10T09:40:00-05:00'};
  const result = {toolSummaries:['[create_meeting OK — Booked Release schedule] mutated=book'],mutationActions:[action]};
  const reply = await h.gates.__fact(ctx({result}), 'Booked Release schedule. Idan always enjoys early calls.');
  assert.match(reply, /Booked “Release schedule”/);
  assert.match(reply, /25 minutes/);
  assert.ok(!reply.includes('always enjoys'));
});

test('booking fallback uses only successful current results and stays inside private conversations', async () => {
  const h = harness({verdict:{claimed_action:true,action_type:'book'}});
  const action = {tool:'create_meeting',ok:true,subject:'Release schedule',start:'2026-11-10T09:15:00-05:00',end:'2026-11-10T09:40:00-05:00'};
  assert.equal(h.checker.confirmedBookingNotice('Booked', [{...action,ok:false}], 'America/New_York'), undefined);
  assert.equal(h.checker.confirmedBookingNotice('Booked', [{...action,start:'2026-11-10T09:15'}], 'America/New_York'), undefined);
  assert.equal(h.checker.confirmedBookingNotice('Booked', undefined, 'America/New_York'), undefined);
  const result = {toolSummaries:[],mutationActions:[action]};
  assert.ok(!(await h.gates.__fact(ctx({result,isChannel:true,channelId:'CPEER'}),'I booked it')).includes('Release schedule'));
});

test('a verified move survives an unsupported secondary notification claim',async()=>{
 const h=harness({verdict:{claimed_action:true,action_type:'message',target_name:'Yael',action_summary:'Invite notification is not receipted'}});
 const action={tool:'move_meeting',ok:true,eventId:'weekly',subject:'Yael weekly',start:'2026-11-10T09:15:00-05:00',end:'2026-11-10T09:55:00-05:00'};
 const reply=await h.gates.__fact(ctx({result:{toolSummaries:['[move_meeting OK] mutated=book'],mutationActions:[action]}}),'Moved Yael weekly. The invite is on its way.');
 assert.match(reply,/Moved “Yael weekly”/);assert.match(reply,/40 minutes/);assert.doesNotMatch(reply,/invite|verified information/);
 assert.equal(h.checker.confirmedBookingNotice('Moved',[action,{...action,ok:false}],'Asia/Jerusalem'),undefined);
 assert.equal(h.checker.confirmedBookingNotice('Cancelled',[action,{tool:'delete_meeting',ok:true,eventId:'weekly'}],'Asia/Jerusalem'),undefined);
});

test('a confirmed false sentence is removed without deleting the valid outcome and next step',async()=>{
 const whole='No shared time was found. Idan has a medical appointment. Would you like me to ask Idan about 08:30?';
 const h=harness({rewrite:{verdict:'rewrite',remove_clauses:[{sentence:1,quote:'Idan has a medical appointment. '}],removal_verified:true}});
 const out=await h.checker.rewriteOwningTheMiss({draft:whole,deletionOnly:true,actionType:'invented_fact',ownerFirstName:'Idan',toolSummaries:['[find_available_slots: 0 slots]']});
 assert.equal(out,'No shared time was found. Would you like me to ask Idan about 08:30?');assert.equal(h.calls.length,1);
});
for(const remove of [[9],[-1],[0.5],[1,1]])test('invalid clause selection cannot edit a reply '+JSON.stringify(remove),async()=>{
 const h=harness({rewrite:{verdict:'rewrite',remove_clauses:remove.map(sentence=>({sentence,quote:'Idan is on vacation.'})),removal_verified:true}});
 const out=await h.checker.rewriteOwningTheMiss({draft:'The request exists. Idan is on vacation.',deletionOnly:true,actionType:'invented_fact',ownerFirstName:'Idan'});
 assert.equal(out,"I don't have confirmed information about that.");
});

for(const [whole,remove,expected] of [
 ['Moved the meeting to Monday 11:30; the update went out to Alex and Elinor. Elinor is busy then.',
  '; the update went out to Alex and Elinor','Moved the meeting to Monday 11:30. Elinor is busy then.'],
 ['הזזתי את הפגישה ליום שני ב־11:30 ושלחתי הודעה לאלכס. אלינור תפוסה אז.',
  ' ושלחתי הודעה לאלכס','הזזתי את הפגישה ליום שני ב־11:30. אלינור תפוסה אז.'],
])test('a false clause cannot erase the real action sharing its sentence '+expected,async()=>{
 const h=harness({rewrite:{verdict:'rewrite',remove_clauses:[{sentence:0,quote:remove}],removal_verified:true}});
 const answer=await h.checker.rewriteOwningTheMiss({draft:whole,deletionOnly:true,actionType:'message',ownerFirstName:'Idan',toolSummaries:['[move_meeting OK] mutated=book']});
 assert.equal(answer,expected);
});
test('invented or ambiguous clause spans cannot alter the draft',async()=>{
 for(const quote of ['was sent','Booked']){
  const h=harness({rewrite:{verdict:'rewrite',remove_clauses:[{sentence:0,quote}],removal_verified:true}});
  const answer=await h.checker.rewriteOwningTheMiss({draft:'Booked means Booked.',deletionOnly:true,actionType:'message',ownerFirstName:'Idan'});
  assert.equal(answer,"I don't have confirmed information about that.");
 }
});
