const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');

function load(file) {
  const source=fs.readFileSync(path.join(__dirname,'..',file),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});
  const exports={};
  new Function('require','exports',compiled.outputText)(require,exports);
  return exports;
}
const {bindOfferedDay}=load('src/core/social/bindOfferedDay.ts');
const {renderSchedulingParts,schedulingOptions}=load('src/core/orchestrator/schedulingOptions.ts');

test('a later participant check supersedes owner-only options for the same search',()=>{
 const query={search_from:'2026-11-16T09:00',search_to:'2026-11-16T17:00',duration_minutes:55,meeting_mode:'either'};
 const early={tool:'find_available_slots',query:{...query,attendee_emails:[]},owner_calendar:'checked',slots:[{start:'2026-11-16T09:30:00-05:00',end:'2026-11-16T10:25:00-05:00'}]};
 const later={tool:'find_available_slots',query:{...query,attendee_emails:['chris@example.test','paul@example.test']},owner_calendar:'checked',slots:[{start:'2026-11-16T15:45:00-05:00',end:'2026-11-16T16:40:00-05:00'}]};
 const r=schedulingOptions([early,later],'America/New_York',true);
 assert.equal(r.options.size,1);assert.equal(r.evidence[0].slots,undefined);
 assert.deepEqual(r.evidence[0].superseded_slots,early.slots);
 assert.match(renderSchedulingParts([{options:[1]}],r.options),/15:45/);
 assert.equal(early.slots.length,1,'original evidence retained');
 for(const patch of [{query:{...later.query,duration_minutes:25}},{query:{...later.query,search_to:'2026-11-17T17:00'}},{error:'unavailable',owner_calendar:undefined}]) {
  assert.equal(schedulingOptions([early,{...later,...patch}],'America/New_York',true).options.size,2,'distinct or failed checks do not replace options');
 }
 const empty=schedulingOptions([early,{...later,slots:[]}],'America/New_York',true);
 assert.equal(empty.options.size,0,'a later completed search with no accepted choices still supersedes the preliminary list');
});

test('participant-specific searches for separate appointments remain separate',()=>{
 const base={tool:'find_available_slots',query:{search_from:'2026-11-16',search_to:'2026-11-16',duration_minutes:25},owner_calendar:'checked',slots:[{start:'2026-11-16T09:30:00-05:00',end:'2026-11-16T09:55:00-05:00'}]};
 const r=schedulingOptions([{...base,query:{...base.query,attendee_emails:['adam@example.test']}},{...base,query:{...base.query,attendee_emails:['paul@example.test']}}],'America/New_York',true);
 assert.equal(r.options.size,2);
});

test('an option outside the requested preference needs contextual explanation instead of the plain offer shortcut',()=>{
 const {renderOpenTimes}=load('src/skills/meetings/ops/offerReply.ts');
 const slot={start:'2026-10-25T15:00:00+02:00',end:'2026-10-25T15:40:00+02:00',matches_time_preference:false,attendee_status:[]};
 assert.equal(renderOpenTimes([slot],{locale:'he',owner:'עידן',zoneFor:()=> 'Asia/Jerusalem'},[],null,()=> 'Peer'),undefined);
 assert.ok(renderOpenTimes([{...slot,matches_time_preference:true}],{locale:'he',owner:'עידן',zoneFor:()=> 'Asia/Jerusalem'},[],null,()=> 'Peer'));
});

test('precheck alternatives are real renderable choices and keep their unchecked-attendee qualification',()=>{
 const {options,evidence}=schedulingOptions([{tool:'availability_precheck',availability_scope:'owner_only',other_participants:'not_checked',
  slots:[{start:'2026-11-12T12:00:00-05:00',end:'2026-11-12T12:25:00-05:00',presentation_local:'Thu 12 Nov 12:00 EST',attendees:[{status:'unknown'}]}]}],
  'America/New_York',false);
 assert.equal(options.size,1);assert.equal(evidence[0].availability_scope,'owner_only');
 assert.equal(evidence[0].slots[0].attendees[0].status,'unknown');
 assert.match(renderSchedulingParts([{kind:'options',text:'Idan is free; your availability needs checking.',options:[1]}],options),/12:00 · 25 min/);
});

test('owner-only recovery remains evidence but is not a finished option for known meeting participants',()=>{
 const result={tool:'availability_precheck',availability_scope:'owner_only',other_participants:'not_checked',
  slots:[{start:'2026-11-12T12:00:00-05:00',end:'2026-11-12T12:25:00-05:00',attendees:[{status:'unknown'}]}]};
 const {options,evidence}=schedulingOptions([result],'America/New_York',false,undefined,false);
 assert.equal(options.size,0);assert.equal(evidence[0].slots,undefined);
 assert.deepEqual(evidence[0].unchecked_owner_candidates,result.slots);
 assert.equal(result.slots.length,1,'the original observations remain unchanged');
});

test('the ordinary availability renderer groups the same day even when ranking interleaves dates',()=>{
 const {renderOpenTimes}=load('src/skills/meetings/ops/offerReply.ts');
 const slots=['2026-11-11T13:00','2026-11-12T16:00','2026-11-09T16:30','2026-11-11T16:00'].map(t=>({start:t+':00+02:00',end:require('luxon').DateTime.fromISO(t+':00+02:00').plus({minutes:25}).toISO(),attendee_status:[]}));
 const text=renderOpenTimes(slots,{locale:'en',owner:'Idan',zoneFor:()=> 'Asia/Jerusalem'},[],null,()=> 'Peer');
 assert.equal(text.match(/Wed 11 Nov/g).length,1);assert.match(text,/13:00, 16:00/);assert.ok(text.indexOf('Mon 9 Nov')<text.indexOf('Wed 11 Nov'));
});

test('a broad viewed calendar keeps later-event recall without granting unique mutation identity',()=>{
 const ledger=load('src/utils/threadEventLedger.ts');
 const events=Array.from({length:60},(_,i)=>({eventId:'event-'+i,subject:'Meeting '+i,dateIso:'2026-11-'+(i<30?'16':'18')}));
 ledger.recordViewedThreadEvents('broad',events);assert.equal(ledger.getViewedThreadEvents('broad').length,60);
 assert.ok(ledger.getViewedThreadEvents('broad').some(e=>e.eventId==='event-59'));
});

test('owner options use the owner clock and actual duration even when attendees are abroad',()=>{
 const {options}=schedulingOptions([{tool:'find_available_slots',slots:[{start:'2026-11-10T09:15:00-05:00',end:'2026-11-10T10:10:00-05:00',presentation_local:'Tue 10 Nov 16:15 GMT+2'}]}],'America/New_York',true);
 const text=renderSchedulingParts([{text:'Simon',options:[1]}],options);
 assert.match(text,/09:15/);assert.doesNotMatch(text,/16:15|GMT\+2/);assert.match(text,/55 min/);assert.match(text,/EST/);
});

test('a collective hold binds only the actual displayed intervals under the named day',()=>{
  const candidates=['12:30','13:15','15:15','16:30'].map(time=>{
    const start='2026-10-21T'+time+':00+03:00';
    return {startIso:start,endIso:new Date(Date.parse(start)+25*60000).toISOString(),
      display:'2026-10-21 '+time+' [Asia/Jerusalem]',presentationZone:'Asia/Jerusalem'};
  });
  const request='שמרי לי את שלוש האפשרויות ביום רביעי';
  const heading='יום רביעי 21.10: 12:30–12:55, 15:15–15:40, 16:30–16:55';
  const offer='יום שלישי 20.10: 16:30–16:55\n'+heading;
  const pick={request,dayQuote:'רביעי',heading,date:'2026-10-21',zone:'Asia/Jerusalem',locale:'he',count:3};
  assert.deepEqual(bindOfferedDay(pick,candidates,offer,request),[0,2,3]);
  for(const change of [{date:'2026-10-28'},{zone:'America/New_York'},{count:2},{heading:heading.slice(0,-1)},{request:'שמרי לי'}]) {
    assert.equal(bindOfferedDay({...pick,...change},candidates,offer,request),undefined);
  }
  assert.equal(bindOfferedDay(pick,candidates,offer+'\nיום רביעי 28.10: 12:30–12:55',request),undefined);
});

test('a compact list keeps all chosen clocks and keeps meetings and availability qualifications separate',()=>{
  const slot=(hour,status)=>({start:'2026-11-18T'+hour+':00:00-05:00',end:'2026-11-18T'+hour+':25:00-05:00',
    attendees:[{email:'peer@example.test',status}]});
  const {options}=schedulingOptions([{tool:'find_available_slots',slots:[slot('08','free'),slot('09','busy'),slot('10','free')]},
    {tool:'find_available_slots',slots:[slot('11','free')]}],'America/New_York',false);
  const output=renderSchedulingParts([{text:'Wednesday options'},{options:[3,1]},{text:'Your calendar shows busy at'},{options:[2]}],options);
  assert.match(output,/08:00, 10:00/);
  assert.match(output,/shows busy at\n[^\n]+09:00/);
  assert.equal(renderSchedulingParts([{options:[1,2]}],options),undefined);
  assert.equal(renderSchedulingParts([{options:[1,4]}],options),undefined);
  assert.equal(renderSchedulingParts([{options:[99]}],options),undefined);
  assert.match(renderSchedulingParts([{options:[1]}],options),/08:00/);
  assert.doesNotMatch(renderSchedulingParts([{options:[1]}],options),/09:00|10:00|11:00/);
});
