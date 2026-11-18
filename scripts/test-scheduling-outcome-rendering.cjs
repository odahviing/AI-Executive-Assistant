const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, dependencies) {
  const source = fs.readFileSync(process.env.OUTCOME_BEFORE_ROOT ? path.join(process.env.OUTCOME_BEFORE_ROOT, file) : file, 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { Date }, { filename: file })(
    name => {
      assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency ' + name);
      return dependencies[name];
    }, module, module.exports,
  );
  return module.exports;
}

const rendering = load('src/core/orchestrator/schedulingOptions.ts', { luxon: require('luxon') });
const evidence = [{ tool: 'find_available_slots', slots: [
  { start: '2026-11-19T10:15:00-05:00', end: '2026-11-19T10:40:00-05:00', presentation_local: 'Thu 19 Nov 17:15 GMT+2' },
  { start: '2026-11-19T10:45:00-05:00', end: '2026-11-19T11:10:00-05:00', presentation_local: 'Thu 19 Nov 17:45 GMT+2' },
] }];
const { options } = rendering.schedulingOptions(evidence, 'America/New_York', false);

test('an options heading without its actual choices is incomplete',()=>{
 assert.equal(rendering.renderSchedulingParts([{kind:'options',text:'These times work.',options:[]}],options),undefined);
 assert.match(rendering.renderSchedulingParts([{kind:'options',text:'These times work.',options:[1,2]},
  {kind:'blocked',text:'I could not identify the lunch event. Which day is it?',options:[]}],options),/17:15, 17:45 · 25 min\nI could not identify/);
});
test('owner choices use one owner clock unless the owner requested another zone',()=>{
 const own=rendering.schedulingOptions(evidence,'America/New_York',true);
 const text=rendering.renderSchedulingParts([{options:[1,2]}],own.options);
 assert.match(text,/10:15/);assert.doesNotMatch(text,/17:15|GMT\+2/);assert.match(text,/25 min/);
 const requested=rendering.schedulingOptions(evidence,'America/New_York',true,'Asia/Jerusalem');
 assert.match(rendering.renderSchedulingParts([{options:[1,2]}],requested.options),/17:15/);
});

test('a selected opening does not silently add another time from the same search', () => {
  assert.equal(rendering.renderSchedulingParts([{ text: 'This 25-minute opening works.', options: [1] }], options),
    'This 25-minute opening works.\nThu 19 Nov (GMT+2) · 17:15 · 25 min');
});

test('a vacation day omitted from the answer stays omitted despite identical calendar qualifications', () => {
  const {options: choices} = rendering.schedulingOptions([{tool:'find_available_slots',slots:[
    {start:'2026-11-24T09:15:00-05:00',end:'2026-11-24T09:40:00-05:00',attendees:[{email:'requester@example.test',status:'busy'}]},
    {start:'2026-11-25T09:15:00-05:00',end:'2026-11-25T09:40:00-05:00',attendees:[{email:'requester@example.test',status:'busy'}]},
  ]}], 'America/New_York', false);
  assert.equal(rendering.renderSchedulingParts([{text:'Tuesday works if you can move your other meeting.',options:[1]}], choices),
    'Tuesday works if you can move your other meeting.\nTue 24 Nov (EST) · 09:15 · 25 min');
});

test('separate text and options retain the existing format', () => {
  assert.equal(rendering.renderSchedulingParts([{ text: 'אפשר ב־' }, { options: [1, 2] }], options),
    'אפשר ב־\nThu 19 Nov (GMT+2) · 17:15, 17:45 · 25 min');
});

test('invalid option identities and malformed fields produce no partially valid reply', () => {
  for (const parts of [[{ options: [99] }], [{ text: 5, options: [1] }], [{}], [{ options: [] }]]) {
    assert.equal(rendering.renderSchedulingParts(parts, options), undefined);
  }
});

test('model day groups retain each verified option once without duplicate date headings', () => {
  const result = rendering.renderSchedulingParts([
    { text: 'Two openings.', options: [1] },
    { text: 'Thu 19 Nov (GMT+2)' },
    { options: [2] },
  ], options);
  assert.equal(result, 'Two openings.\nThu 19 Nov (GMT+2) · 17:15, 17:45 · 25 min');
});

test('calendar overlap facts distinguish a real conflict from a five-minute gap',()=>{
 const entries=[{tool:'get_calendar',events:[
  {subject:'Chris',date:'2026-11-12',start:'12:30',end:'13:10',durationMinutes:40},
  {subject:'Lunch',date:'2026-11-12',start:'13:00',end:'13:25',durationMinutes:25},
  {subject:'Scott',date:'2026-11-12',start:'13:30',end:'13:55',durationMinutes:25},
 ]}];
 const result=rendering.calendarOverlapEvidence(entries,'America/New_York');
 assert.deepEqual(JSON.parse(JSON.stringify(result[0].computedOverlaps)),[{first:'Chris',second:'Lunch',date:'2026-11-12',minutes:10}]);
});

test('an empty optional list preserves the concise answer instead of reviving the planner draft',()=>{
 assert.equal(rendering.renderSchedulingParts([{text:'You are already included.',options:[]},{text:'Which time works?'}],options),'You are already included.\nWhich time works?');
 assert.equal(rendering.renderSchedulingParts([{text:'Book it?',options:[99]}],options),undefined);
});

test('calendar gaps merge overlapping events and remain observations rather than validated slots',()=>{
 const events=[['Standup','09:00','09:30'],['Review','11:00','11:55'],['Lunch','12:30','14:00'],['Michal','14:00','14:40'],['Duplicate','14:00','14:40'],['Lori','15:00','15:40']]
  .map(([subject,start,end])=>({subject,date:'2026-11-16',start,end,status:'busy'}));
 const result=rendering.calendarOverlapEvidence([{tool:'get_calendar',scope:'owner_calendar',events}], 'America/New_York')[0];
 assert.deepEqual(JSON.parse(JSON.stringify(result.computedGaps)).map(x=>[x.start.slice(11,16),x.end.slice(11,16),x.minutes]),[['09:30','11:00',90],['11:55','12:30',35],['14:40','15:00',20]]);
 assert.match(result.gapScope,/not validated meeting slots/);
});
for(const scope of ['shared_with_requester_only','owner_calendar'])test('partial views and all-day busy entries cannot manufacture owner openings: '+scope,()=>{
 const events=[{date:'2026-11-16',start:'09:00',end:'09:30'},{date:'2026-11-16',start:'12:00',end:'13:00'},
 ...(scope==='owner_calendar'?[{date:'2026-11-16',allDay:true,status:'busy'}]:[])];
 const result=rendering.calendarOverlapEvidence([{tool:'get_calendar',scope,events}], 'America/New_York')[0];
 assert.equal(result.computedGaps?.length??0,0);
});

// The planner's finish schema is pure: loading it requires no model or I/O dependency.
test('the scheduling finish contract renders in the existing planner turn',()=>{
 const module=load('src/core/orchestrator/schedulingFinish.ts',{});
 const tool=module.schedulingFinishTool();
 assert.equal(tool.name,'finish_scheduling');
 assert.ok(tool.input_schema.required.includes('parts'));
 assert.equal(Object.keys(module).length,1);
});
