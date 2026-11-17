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
  assert.match(renderSchedulingParts([{options:[1]}],options),/08:00, 10:00/);
  assert.doesNotMatch(renderSchedulingParts([{options:[1]}],options),/09:00|11:00/);
});
