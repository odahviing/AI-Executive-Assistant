// Run: node --test scripts/test-classifier-context-participants.cjs
// Baseline replay: node scripts/test-classifier-context-participants.cjs --before
//
// Captures the real classifyTurn system prompt through an isolated Anthropic
// client. Exercises source validation and captures continuation guidance;
// neither proves that a live model will classify continuation correctly.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const ts = require('typescript');

const repo = path.resolve(__dirname, '..');
const revisionAt = process.argv.indexOf('--source-revision');
const sourceRevision = revisionAt >= 0 ? process.argv[revisionAt + 1] : null;

function source(rel) {
  if (process.argv.includes('--before')) return fs.readFileSync(path.join(repo, 'artifacts/workshop-verification/opportunities-20261026/librarian/classifyTurn.before.ts'), 'utf8');
  if (sourceRevision) return cp.execFileSync('git', ['show', `${sourceRevision}:${rel}`], { cwd: repo, encoding: 'utf8' });
  return fs.readFileSync(path.join(repo, rel), 'utf8');
}

function loadClassifier() {
  const rel = 'src/core/social/classifyTurn.ts';
  const code = ts.transpileModule(source(rel), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: path.join(repo, rel),
  }).outputText;
  const noop = () => {};
  const deps = {
    '../../utils/logger': { __esModule: true, default: { info: noop, warn: noop, error: noop } },
    '../../utils/usageLog': { logLlmUsage: noop },
    '../../db/socialSubjects': { FIXED_CATEGORIES: ['work', 'personal'] },
    '../../llm/models': require('./load-test-models.cjs'),
  };
  const isolatedRequire = name => {
    assert.ok(Object.hasOwn(deps, name), `unexpected classifyTurn dependency: ${name}`);
    return deps[name];
  };
  const module = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {}, { filename: rel })(isolatedRequire, module, module.exports);
  return module.exports.classifyTurn;
}


const profile = {user:{name:'Owner Example'},assistant:{name:'Maelle'},skills:{}};

const alex = 'Customer success status with Alex';
const ayalla = 'Customer success with Ayalla';
const ordinaryCreate = {
  senderRole: 'owner', inspectIndependentOrdinaryCreate: true,
  message: `and after book a meeting with Dana and Lee 25 mins\nright after the meeting with Alex\n“${ayalla}”`,
  meetingContextMessages: [
    { role: 'user', content: 'Move it to 11:15.' },
    { role: 'assistant', content: `Moved "${alex}" to 11:15. I booked it anyway, as you asked.` },
  ],
};
const titleEvidence = { subjectQuote: ayalla, priorSubjectQuote: alex, sourceMessageIndex: 1 };
const classifiedCreate = {
  meeting_action: 'execute', meeting_continuation: false, standalone_courtesy: false,
  meeting_people: ['Dana', 'Lee'], meeting_people_groups: [['Dana','Lee']], independent_ordinary_create: titleEvidence,
};
test('independent booking after a completed move produces source-bound titles on the existing call', async () => {
  const { result, captured, calls } = await run(classifiedCreate, ordinaryCreate);
  assert.deepEqual(result.independentOrdinaryCreate, titleEvidence);
  assert.equal(calls, 1);
  const schema = captured.tools[0].input_schema.properties.independent_ordinary_create;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required], ['subjectQuote','priorSubjectQuote','sourceMessageIndex']);
  assert.ok(!captured.tools[0].input_schema.required.includes('independent_ordinary_create'));
  assert.ok(captured.system.includes('including wider or visit-wide instructions'));
});
test('explicit original-script titles may identify an independent booking', async () => {
  const quotes = { subjectQuote: 'השקת מוצר', priorSubjectQuote: 'שיחת צוות', sourceMessageIndex: 0 };
  const { result } = await run({ ...classifiedCreate, independent_ordinary_create: quotes }, {
    ...ordinaryCreate, message: 'תקבע עם דנה את השקת מוצר',
    meetingContextMessages: [{ role:'assistant', content:'הזזתי את שיחת צוות.' }],
  });
  assert.deepEqual(result.independentOrdinaryCreate, quotes);
});
test('prior owner exception reaches only the independent-create instruction, never the indexed transcript', async () => {
  const priorOwner = 'Para toda esta visita, reserva aunque haya conflictos.';
  const args = { ...ordinaryCreate, ordinaryCreateOwnerContext:[priorOwner] };
  const { result, captured, calls } = await run({ ...classifiedCreate, independent_ordinary_create:undefined }, args);
  assert.equal(calls, 1);
  assert.equal(result.independentOrdinaryCreate, undefined);
  const section = captured.system.indexOf('INDEPENDENT ORDINARY CREATE');
  const recent = captured.system.indexOf('Recent conversation (classify');
  assert.ok(captured.system.slice(section, recent).includes(JSON.stringify([priorOwner])));
  assert.ok(!captured.system.slice(recent).includes(priorOwner));
  const noHistory = await run(classifiedCreate, ordinaryCreate);
  assert.ok(!noHistory.captured.system.includes('Earlier owner messages (quoted data'));
  for (const changes of [{senderRole:'colleague'}, {inspectIndependentOrdinaryCreate:false}, {meetingContextMessages:undefined}]) {
    const { captured, result } = await run(classifiedCreate, {...args,...changes});
    assert.ok(!captured.system.includes(priorOwner));
    assert.equal(captured.tools[0].input_schema.properties.independent_ordinary_create, undefined);
    assert.equal(result.independentOrdinaryCreate, undefined);
  }
});
test('unindexed owner context cannot provide title, index, continuing participant or approval citation', async () => {
  const unindexed = 'Project Finch';
  const extra = { ...ordinaryCreate, ordinaryCreateOwnerContext:[unindexed] };
  for (const patch of [{subjectQuote:unindexed}, {priorSubjectQuote:unindexed}, {sourceMessageIndex:2}]) {
    const { result } = await run({ ...classifiedCreate, independent_ordinary_create:{...titleEvidence,...patch} }, extra);
    assert.equal(result.independentOrdinaryCreate, undefined);
  }
  const badDecision = {candidateIndex:0,disposition:'approve_existing',instructionQuote:ayalla,sourceMessageIndex:2,sourceQuote:unindexed};
  const { result } = await run({ ...classifiedCreate, meeting_continuation:true,
    context_meeting_people:[{name:unindexed,sourceMessageIndex:2}], approval_decisions:[badDecision] },
    { ...extra, approvalCandidates:[{subject:ayalla,action:{tool:'create_meeting',args:{subject:ayalla}}}] });
  assert.deepEqual(result.contextMeetingPeople, []);
  assert.deepEqual(result.approvalDecisions, []);
});
test('assent, amendment, exploration, explicit wider exception, uncertain and unavailable classifications give no evidence', async () => {
  for (const [message, patch] of [
    ['Yes, please, if he is free.', { meeting_action:'explore' }],
    [`Move ${ayalla} to 11:30.`, { meeting_continuation:true }],
    [`If possible, book ${ayalla}.`, { meeting_action:'explore' }],
    [`Book ${ayalla} and ignore all conflicts for this visit.`, { independent_ordinary_create:undefined }],
    [`Yes, book ${ayalla}.`, { standalone_approval_quote:`Yes, book ${ayalla}.` }],
    [ordinaryCreate.message, { meeting_continuation:undefined }],
    [ordinaryCreate.message, { approval_decisions:[{}] }],
    [ordinaryCreate.message, { context_meeting_people:[{ name:'Dana',sourceMessageIndex:0 }] }],
  ]) {
    const { result } = await run({ ...classifiedCreate, ...patch }, { ...ordinaryCreate, message });
    assert.equal(result.independentOrdinaryCreate, undefined);
  }
  const { result } = await run(classifiedCreate, ordinaryCreate, { stop_reason:'max_tokens' });
  assert.equal(result.independentOrdinaryCreate, undefined);
});
test('rejects invented title, ungrounded prior title, unsigned provenance, stale index and same subject', async () => {
  for (const patch of [{subjectQuote:'Generated title'}, {priorSubjectQuote:'Earlier generated title'},
    {sourceMessageIndex:0}, {sourceMessageIndex:1.5}, {subjectQuote:'  '}, {priorSubjectQuote:''}]) {
    const { result } = await run({ ...classifiedCreate, independent_ordinary_create:{ ...titleEvidence, ...patch } }, ordinaryCreate);
    assert.equal(result.independentOrdinaryCreate, undefined);
  }
  const { result } = await run({ ...classifiedCreate, independent_ordinary_create:{ ...titleEvidence, subjectQuote:alex.toUpperCase() } },
    { ...ordinaryCreate, message:`Book ${alex.toUpperCase()} again` });
  assert.equal(result.independentOrdinaryCreate, undefined);
  for (const extra of [{senderRole:'colleague'}, {inspectIndependentOrdinaryCreate:false}, {senderRole:undefined},
    {message:ordinaryCreate.message.padEnd(4001)}, {meetingContextMessages:[...ordinaryCreate.meetingContextMessages,{role:'user',content:alex}]}]) {
    const {result,captured}=await run(classifiedCreate,{...ordinaryCreate,...extra});
    assert.equal(result.independentOrdinaryCreate,undefined);
    assert.equal(captured.tools[0].input_schema.properties.independent_ordinary_create,undefined);
  }
});
async function run(raw, extra = {}, response = {}) {
  let captured; let calls = 0;
  const result = await loadClassifier()({
    anthropic:{messages:{create:async request => { calls++; captured=request; return {stop_reason:'tool_use',content:[{type:'tool_use',name:'classify_turn',input:raw}],usage:{},...response}; }}},
    message:'What about Thursday afternoon?', profile,needIntent:false,needScopes:false,needMeetingPeople:true,
    meetingContextMessages:[{role:'user',content:'Find time with Dana and Lev'},{role:'assistant',content:'Perhaps add Sara'}],
    recentContext:'DUPLICATE CONTEXT MUST NOT APPEAR', ...extra,
  });
  return { result:JSON.parse(JSON.stringify(result)), captured, calls };
}
test('one colleague classification carries a selected internal hold separately from booking', async () => {
  const offer = 'ביום חמישי אפשר ב-17:15 או ב-17:45.';
  const message = 'תשמרי לי את 17:15 כרגע, ביום רביעי אגיד אם המועמד עבר.';
  const { result, captured, calls } = await run(holdResponse(selectedHold), {
    senderRole: 'colleague', message, meetingContextMessages: [{ role: 'assistant', content: offer }],
    holdOfferText: offer, holdSelectionText: message, holdCandidates,
  });
  assert.equal(calls, 1);
  assert.equal(captured.messages[0].content, message);
  assert.ok(captured.system.includes(offer));
  assert.equal(result.meetingAction, 'hold');
  assert.deepEqual(result.selectedHoldCandidateIndices, [0]);
  assert.equal(result.standaloneCourtesy, false);
  assert.equal(result.standaloneApprovalQuote, undefined);
  const schema = captured.tools[0].input_schema;
  assert.ok(schema.properties.meeting_action.enum.includes('hold'));
  assert.ok(schema.required.includes('meeting_action'));
  assert.match(captured.system, /previously offered slot internally now/);
  assert.match(captured.system, /actual calendar invitation is execute/);
  assert.match(captured.system, /colleague already sent it, is scheduling status \(explore\)/);
});
const holdCandidates = ['15', '45'].map(minute => ({
  startIso: `2026-11-19T10:${minute}:00-05:00`,
  endIso: minute === '15' ? '2026-11-19T10:40:00-05:00' : '2026-11-19T11:10:00-05:00',
  display: `Thursday 2026-11-19 10:${minute} [America/New_York]`, localDisplays: [`Thursday 2026-11-19 17:${minute} [Asia/Jerusalem]`],
}));
const selectedHold = { candidateIndex: 0, offeredClock: '17:15', selectedDate: '2026-11-19', selectionQuote: '17:15', timeZone:'Asia/Jerusalem', offerZoneQuote:'' };
const secondHold = { ...selectedHold, candidateIndex:1, offeredClock:'17:45', selectionQuote:'17:45' };
function holdResponse(selection, mode = 'single') {
  return { meeting_action: 'hold', selected_holds: { mode, selections: Array.isArray(selection) ? selection : [selection] } };
}
const holdArgs = { senderRole: 'colleague', message: 'Hold 17:15 now, Wednesday is my reply deadline.',
  holdSelectionText: 'Hold 17:15 now, Wednesday is my reply deadline.', holdOfferText: 'Thursday:\n17:15\n17:45', holdCandidates };
for (const [name, message, pick, expected] of [
  ['numeric ordinal omitted from quoted selection', 'Hold option 2.', { ...selectedHold, position:1, selectionQuote:'option' }, undefined],
  ['numeric selector omitted using a neighboring clause', 'Hold it. Option 2.', { ...selectedHold, position:1, selectionQuote:'Hold' }, undefined],
  ['Arabic numeric option survives classifier substring omission', 'احجز الخيار ٢.', { ...selectedHold, position:1, selectionQuote:'الخيار' }, undefined],
  ['separate quantity and duration leave an explicit ordinal intact', 'Hay 3 candidatos. Reserva la opción 2 para 25 minutos.',
    { ...secondHold, position:2, selectionQuote:'opción 2' }, 1],
  ['extra unrelated clock does not become an ordinal', 'Hold option 2. I will call at 12:30.',
    { ...secondHold, position:2, selectionQuote:'2' }, 1],
  ['another option clock cannot be hidden in a second clause', 'Hold 17:15. Or should it be 17:45?', selectedHold, undefined],
  ['unresolved clock in the same selection clause', 'Hold 17:15 or 12:30?', selectedHold, undefined],
  ['separate non-offered deadline', 'Hold 17:15 for now. I will confirm by 12:30 on Wednesday.', selectedHold, 0],
  ['deadline has its own time zone', 'Guarda 17:15 Asia/Jerusalem; confirmaré a las 12:30 America/New_York.', selectedHold, 0],
  ['explicit action time zone differs from model evidence', 'Hold 17:15 America/New_York.', selectedHold, undefined],
  ['ordinary slash in the subject leaves the selected time intact', 'Hold 17:15 for the SDR/BDR interview.', selectedHold, 0],
  ['a slash in the subject cannot mask a different known zone', 'Hold 17:15 America/New_York for the SDR/BDR interview.', selectedHold, undefined],
  ['unknown explicit action time zone', 'Reserva 17:15 America/Unresolved.', selectedHold, undefined],
  ['explicit action zone correctly maps the slot instant', 'תשמרי את 17:15 Asia/Jerusalem.', selectedHold, 0],
]) {
  test('authenticated hold instruction: ' + name, async () => {
    const { result } = await run(holdResponse(pick), { ...holdArgs, message, holdSelectionText:message });
    assert.equal(result.meetingAction, expected === undefined ? 'explore' : 'hold');
    assert.deepEqual(result.selectedHoldCandidateIndices, expected === undefined ? undefined : [expected]);
  });
}
test('spoken ordinal follows the delivered order when stash order differs', async () => {
  const message = 'Guarda la segunda opción por ahora.';
  const { result } = await run(holdResponse({
    ...selectedHold, selectionQuote: 'segunda', position: 2,
  }), { ...holdArgs, message, holdSelectionText: message, holdOfferText: 'Jueves:\n17:45\n17:15' });
  assert.equal(result.meetingAction, 'hold');
  assert.deepEqual(result.selectedHoldCandidateIndices, [0]);
});
test('quoting a genuine first numeric selection cannot hide a numeric correction in another sentence', async () => {
  const message = 'Hold option 1. Actually make it option 2.';
  for (const exclusion of [undefined, ['Actually make it option 2']]) {
    const response = holdResponse({ ...selectedHold, position:1, selectionQuote:'1' });
    response.selected_holds.incidentalNumberClauses = exclusion;
    const { result } = await run(response, { ...holdArgs, message, holdSelectionText:message });
    assert.equal(result.meetingAction, 'explore');
    assert.equal(result.selectedHoldCandidateIndices, undefined);
  }
});
test('a separately grounded background count permits the numeric selection, a guessed or missing clause does not', async () => {
  const message = 'Tenemos 2 candidatos. Reserva la opción 1.';
  for (const [ancillary, expected] of [
    [['Tenemos 2 candidatos'], 'hold'], [undefined, 'explore'], [['2'], 'explore'], [['Reserva la opción 1'], 'explore'],
  ]) {
    const response = holdResponse({ ...selectedHold, position:1, selectionQuote:'1' });
    response.selected_holds.incidentalNumberClauses = ancillary;
    const { result } = await run(response, { ...holdArgs, message, holdSelectionText:message });
    assert.equal(result.meetingAction, expected);
  }
});
test('a later conflicting numbered clause cannot be dismissed as an earlier count', async () => {
  const message = 'Hold option 1. Actually make it option 2 please.';
  for (const [pick, exclusion] of [
    [{ ...selectedHold, position:1, selectionQuote:'1' }, 'Actually make it option 2 please'],
    [{ ...secondHold, position:2, selectionQuote:'2' }, 'Hold option 1'],
  ]) {
    const response = holdResponse(pick);
    response.selected_holds.incidentalNumberClauses = [exclusion];
    const { result } = await run(response, { ...holdArgs, message, holdSelectionText:message });
    assert.equal(result.meetingAction, 'explore');
    assert.equal(result.selectedHoldCandidateIndices, undefined);
  }
});
test('two separately named holds and a collective choice retain only requested windows', async () => {
  for (const [message, classification] of [
    ['Hold 17:15 and 17:45.', holdResponse([selectedHold, secondHold], 'each')],
    ['Guarda las dos opciones.', holdResponse([selectedHold,secondHold].map((slot, i) =>
      ({ ...slot, selectionQuote:'las dos opciones', position:i+1 })), 'all_offered')],
  ]) {
    const { result } = await run(classification, { ...holdArgs, message, holdSelectionText:message });
    assert.equal(result.meetingAction, 'hold');
    assert.deepEqual(result.selectedHoldCandidateIndices, [0, 1]);
  }
});
const enumeratedPicks = [selectedHold, secondHold].map((slot, i) => ({
  ...slot, position:i+1, selectionQuote:String(i+1),
}));
for (const [name, message, locale, expected] of [
  ['explicit English joined choices', 'Hold option 1 and option 2.', 'en', 'hold'],
  ['Spanish joined choices', 'Guarda la opción 1 y la opción 2.', 'es', 'hold'],
  ['Russian joined choices', 'Оставь вариант 1 и вариант 2.', 'ru', 'hold'],
  ['later replacement', 'Hold option 1. Actually make it option 2.', 'en', 'explore'],
  ['same-clause replacement', 'Hold option 1 instead of option 2.', 'en', 'explore'],
  ['alternatives', 'Hold option 1 or option 2.', 'en', 'explore'],
  ['negated second term', 'Hold option 1 and not option 2.', 'en', 'explore'],
  ['prefix expresses an uncertain choice', 'Choose between option 1 and option 2.', 'en', 'explore'],
  ['negated instruction before joined options', 'Do not hold option 1 and option 2.', 'en', 'explore'],
  ['qualification after a list', 'Hold option 1 and option 2 only if approved.', 'en', 'explore'],
  ['invalid supplied locale', 'Hold option 1 and option 2.', 'invalid_tag', 'explore'],
]) {
  test('additive hold binding: ' + name, async () => {
    const response = holdResponse(enumeratedPicks, 'each');
    response.selected_holds.listLocale = locale;
    const { result } = await run(response, { ...holdArgs, message, holdSelectionText:message });
    assert.equal(result.meetingAction, expected);
    assert.deepEqual(result.selectedHoldCandidateIndices, expected === 'hold' ? [0,1] : undefined);
  });
}
test('Hebrew clock choices use the supplied locale conjunction, and an unrecognized connector stays unresolved', async () => {
  for (const [list, expected] of [['17:15 ו-17:45','hold'],['17:15 וגם 17:45','explore'],['17:15 או 17:45','explore']]) {
    const message = 'תשמרי ' + list;
    const response = holdResponse([selectedHold, secondHold], 'each');
    response.selected_holds.listLocale = 'he';
    const { result } = await run(response, { ...holdArgs, message, holdSelectionText:message });
    assert.equal(result.meetingAction, expected);
  }
});
for (const [message, quote, expected] of [
  ['Hold both.', 'both', 'hold'], ['תשמרי את שתיהן.', 'את שתיהן', 'hold'],
  ['Hold option 2.', 'option 2', 'explore'],
  ['Hold option 1. Actually make it option 2.', 'option', 'explore'],
  ['Hold option 1 or option 2.', 'option 2', 'explore'],
  ['Hold 17:15 or 17:45.', '17:45', 'explore'],
  ['Hold either one or the other.', 'other', 'explore'],
  ['Hold 17:15 and 17:45.', 'Hold', 'explore'],
]) {
  test('collective hold binding: ' + message, async () => {
    const response = holdResponse([selectedHold,secondHold].map((slot, i) =>
      ({ ...slot, selectionQuote:quote, position:i+1 })), 'all_offered');
    const { result } = await run(response, { ...holdArgs, message, holdSelectionText:message });
    assert.equal(result.meetingAction, expected);
    assert.deepEqual(result.selectedHoldCandidateIndices, expected === 'hold' ? [0,1] : undefined);
  });
}
test('unsettled alternatives and invalid additive selections supply no hold windows', async () => {
  const message = 'Hold 17:15 or 17:45?';
  for (const classification of [
    { ...holdResponse([selectedHold, secondHold], 'each'), meeting_action:'explore' },
    holdResponse([selectedHold, { ...secondHold, candidateIndex:0 }], 'each'),
    holdResponse([selectedHold, selectedHold], 'each'),
  ]) {
    const { result } = await run(classification, { ...holdArgs, message, holdSelectionText:message });
    assert.equal(result.meetingAction, 'explore');
    assert.equal(result.selectedHoldCandidateIndices, undefined);
  }
});
for (const [name, selection, args, response] of [
  ['different offered time', { ...selectedHold, candidateIndex: 1 }],
  ['model changed user clock', { ...selectedHold, candidateIndex: 1, offeredClock: '17:45', selectionQuote: '17:45' }],
  ['missing identity', undefined],
  ['wrong day', { ...selectedHold, selectedDate: '2026-11-18' }],
  ['explicit current date and clock on a different day', selectedHold,
    { message:'Hold 2026-11-18 17:15', holdSelectionText:'Hold 2026-11-18 17:15' }],
  ['wrong presentation zone', { ...selectedHold, timeZone:'America/New_York' }],
  ['invented zone quote', { ...selectedHold, offerZoneQuote:'Central European time' }],
  ['missing authenticated current text', selectedHold, { holdSelectionText: undefined }],
  ['clock present only in transport framing', selectedHold, { holdSelectionText: 'Wednesday' }],
  ['no delivered offer', selectedHold, { holdOfferText: undefined }],
  ['clock absent from latest reply', selectedHold, { holdOfferText: 'Thursday 17:45' }],
  ['same clock offered on two days', selectedHold, { holdCandidates: [...holdCandidates, {
    ...holdCandidates[0], startIso:'2026-11-20T10:15:00-05:00', endIso:'2026-11-20T10:40:00-05:00',
    display:'Friday 2026-11-20 10:15 [America/New_York]', localDisplays:['Friday 2026-11-20 17:15 [Asia/Jerusalem]'] }] }],
  ['model uses ordinal instead of explicit clock', { ...selectedHold, position: 1 }],
  ['user numbered pick disagrees with model ordinal', { ...selectedHold, position: 1, selectionQuote: '2' },
    { message: 'Hold option 2.', holdSelectionText: 'Hold option 2.' }],
  ['multiple clocks in current selection', selectedHold, { message: 'Hold 17:15 or 17:45', holdSelectionText: 'Hold 17:15 or 17:45' }],
  ['partial tool response', selectedHold, {}, { stop_reason: 'max_tokens' }],
]) {
  test('unbound hold becomes exploration: ' + name, async () => {
    const { result } = await run(holdResponse(selection), { ...holdArgs, ...args }, response);
    assert.equal(result.meetingAction, 'explore');
    assert.equal(result.selectedHoldCandidateIndices, undefined);
  });
}
test('colleague hold value is unavailable on the owner path', async () => {
  const { result, captured } = await run({ meeting_action: 'hold' }, { senderRole: 'owner' });
  assert.equal(result.meetingAction, undefined);
  assert.ok(!captured.tools[0].input_schema.properties.meeting_action.enum.includes('hold'));
});
test('existing colleague execution, discovery and unknown values retain their meanings', async () => {
  for (const action of ['execute', 'explore', 'none', 'invalid', undefined]) {
    const { result } = await run({ meeting_action: action }, { senderRole: 'colleague' });
    assert.equal(result.meetingAction, action === 'invalid' ? undefined : action);
  }
});
test('grounded historical roster survives continuation as separate sourced entries', async()=>{
  const {result,captured,calls}=await run({meeting_people:[],meeting_continuation:true,context_meeting_people:[{name:'Dana',sourceMessageIndex:0},{name:'Lev',sourceMessageIndex:0}]});
  assert.deepEqual(result.contextMeetingPeople,[{name:'Dana',sourceMessageIndex:0},{name:'Lev',sourceMessageIndex:0}]);
  assert.deepEqual(result.meetingPeople,[]); assert.equal(calls,1);
  assert.ok(!captured.system.includes('DUPLICATE CONTEXT'));
  assert.ok(captured.system.includes('[0] user: Find time with Dana and Lev'));
  assert.ok(captured.system.includes('Replace Lev with Sara'));
});
test('assistant, missing, negative, fractional and fabricated source entries are rejected',async()=>{
  const {result}=await run({meeting_continuation:true,context_meeting_people:[{name:'Sara',sourceMessageIndex:1},{name:'Dana',sourceMessageIndex:20},{name:'Dana',sourceMessageIndex:-1},{name:'Dana',sourceMessageIndex:0.5},{name:'Nobody',sourceMessageIndex:0},null]});
  assert.deepEqual(result.contextMeetingPeople,[]);
});
test('false, absent or malformed continuation fails closed',async()=>{
  for(const flag of [false,undefined,'true']) {
    const {result}=await run({meeting_continuation:flag,context_meeting_people:[{name:'Dana',sourceMessageIndex:0}]});
    assert.deepEqual(result.contextMeetingPeople,[]);
  }
});
test('current explicit names remain independent legitimate path',async()=>{
  const {result}=await run({meeting_people:['Sara'],meeting_continuation:false});
  assert.deepEqual(result.meetingPeople,['Sara']);
});
test('no supplied authenticated context cannot admit historical names',async()=>{
  const {result,captured}=await run({meeting_continuation:true,context_meeting_people:[{name:'Dana',sourceMessageIndex:0}]},{meetingContextMessages:undefined});
  assert.deepEqual(result.contextMeetingPeople,[]);
  assert.equal(captured.tools[0].input_schema.properties.context_meeting_people,undefined);
});
test('unicode exact-copy sources are preserved',async()=>{
  const {result}=await run({meeting_continuation:true,context_meeting_people:[{name:'עינב',sourceMessageIndex:0}]},{meetingContextMessages:[{role:'user',content:'פגישה עם עינב'}]});
  assert.deepEqual(result.contextMeetingPeople,[{name:'עינב',sourceMessageIndex:0}]);
});
test('unavailable classifier leaves explicit default and no historical roster',async()=>{
  const {result}=await run({}, {anthropic:{messages:{create:async()=>{throw new Error('fixture unavailable');}}}});
  assert.deepEqual(result.meetingPeople,[]);
  assert.deepEqual(result.contextMeetingPeople ?? [],[]);
});
test('owner and colleague extraction share source validation without persisted carryover',async()=>{
  for(const senderRole of ['owner','colleague']) {
    const accepted=await run({meeting_continuation:true,context_meeting_people:[{name:'Dana',sourceMessageIndex:0}]},{senderRole});
    assert.equal(accepted.result.contextMeetingPeople.length,1);
    const next=await run({meeting_people:['Sara']},{senderRole});
    assert.deepEqual(next.result.contextMeetingPeople,[]);
    assert.deepEqual(next.result.meetingPeople,['Sara']);
  }
});

const booking = { subject:'Project review', action:{tool:'create_meeting',args:{subject:'Project review'}} };
const currentBooking = {
  approvalCandidates:[booking], senderRole:'owner', needIntent:true, needScopes:true,
  meetingContextMessages:[{role:'assistant',content:'Shall I book the project review as shown?'}],
};
const acceptance = message => ({
  standalone_approval_quote:message, standalone_courtesy:false, approval_decisions:[],
  kind:'task', conversation_state:'open', scopes:['meetings'], meeting_action:'execute',
  meeting_people:[], meeting_people_groups:[],
});
for (const message of ['Sí', 'Да', 'Ja', 'نعم', 'Yes, please.']) {
  test('whole standalone booking acceptance is source-grounded: '+message,async()=>{
    const {result,captured,calls} = await run(acceptance(message),{...currentBooking,message});
    assert.equal(calls,1);
    assert.equal(result.standaloneApprovalQuote,message);
    assert.equal(captured.tools[0].input_schema.properties.standalone_approval_quote.type,'string');
    assert.equal(result.standaloneCourtesy,false);
    assert.deepEqual(result.approvalDecisions,[]);
  });
}
for (const [label,message,partial] of [
  ['recipient correction','Sí, pero usa la otra dirección.','Sí'],
  ['condition','Да, если участник согласится.','Да'],
  ['additional instruction','Yes, please. Email me the agenda.','Yes, please.'],
  ['quoted speech','Er schrieb „Ja“.','Ja'],
  ['history instead of current reply','نعم','Shall I book the project review as shown?'],
  ['fabricated translation','Sí','Yes'],
  ['word not seen beyond input cap','a'.repeat(4000)+'?','a'.repeat(4000)],
]) {
  test('partial or ungrounded acceptance discarded: '+label,async()=>{
    const {result,calls} = await run(acceptance(partial),{...currentBooking,message});
    assert.equal(calls,1);
    assert.equal(result.standaloneApprovalQuote,undefined);
  });
}
const assent = 'Yes, please.';
const evidence = acceptance(assent);
const namedDecision = {candidateIndex:0,instructionQuote:assent,sourceMessageIndex:0,sourceQuote:'project review'};
for (const [label,patch] of [
  ['missing quote',{standalone_approval_quote:undefined}],['non-text quote',{standalone_approval_quote:true}],
  ['missing decisions',{approval_decisions:undefined}],['malformed decisions',{approval_decisions:{}}],
  ['reject',{approval_decisions:[{...namedDecision,disposition:'reject'}]}],
  ['amend',{approval_decisions:[{...namedDecision,disposition:'amend_or_search'}]}],
  ['conflicting named decision',{approval_decisions:[{...namedDecision,disposition:'approve_existing'}]}],
  ['unparseable decision',{approval_decisions:[{}]}],['exploration',{meeting_action:'explore'}],
  ['missing action',{meeting_action:undefined}],['courtesy',{standalone_courtesy:true}],
  ['missing courtesy',{standalone_courtesy:undefined}],['another task',{free_time_inquiry:true}],
  ['social intent',{kind:'social'}],['missing intent',{kind:undefined}],
  ['new participant',{meeting_people:['Another person']}],['malformed participants',{meeting_people:'name'}],
]) {
  test('contradictory or incomplete approval output discarded: '+label,async()=>{
    const {result} = await run({...evidence,...patch},{...currentBooking,message:assent});
    assert.equal(result.standaloneApprovalQuote,undefined);
  });
}
for (const [label,scopeChanges] of [
  ['colleague',{senderRole:'colleague'}],['no pending booking',{approvalCandidates:[]}],
  ['different pending action',{approvalCandidates:[{...booking,action:{tool:'move_meeting',args:{}}}]}],
]) {
  test('standalone schema withheld: '+label,async()=>{
    const {result,captured,calls} = await run(evidence,{...currentBooking,...scopeChanges,message:assent});
    assert.equal(calls,1);
    assert.equal(captured.tools[0].input_schema.properties.standalone_approval_quote,undefined);
    assert.equal(result.standaloneApprovalQuote,undefined);
  });
}
for (const message of ['Yes','כן','thanks','']) {
  test('established zero-call shortcut retained: '+JSON.stringify(message),async()=>{
    const {result,calls} = await run(acceptance(message),{...currentBooking,message});
    assert.equal(calls,0);
    assert.equal(result.standaloneApprovalQuote,undefined);
  });
}
for (const [label,response] of [
  ['truncated',{stop_reason:'max_tokens'}],['empty',{content:[]}],
  ['wrong tool',{content:[{type:'tool_use',name:'unknown',input:evidence}]}],
  ['two calls',{content:Array(2).fill({type:'tool_use',name:'classify_turn',input:evidence})}],
]) {
  test('incomplete or malformed provider response discarded: '+label,async()=>{
    const {result} = await run(evidence,{...currentBooking,message:assent},response);
    assert.equal(result.standaloneApprovalQuote,undefined);
  });
}
