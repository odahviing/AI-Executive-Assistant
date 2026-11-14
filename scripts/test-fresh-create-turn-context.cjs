// Actual classifier, private Slack context and orchestrator-to-skill dispatch. No live services.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const before = process.env.MAELLE_CREATE_CONTEXT_SOURCE_ROOT;
// Reuse the isolated entry-point loaders and substitute their service boundaries.
function fixtureSource(name, end) {
  return fs.readFileSync(path.join(__dirname, name), 'utf8').split(end)[0];
}
const loadClassifier = new Function('require', '__dirname',
  fixtureSource('test-classifier-context-participants.cjs', 'const profile =')
    .replace('path.join(repo, rel)', 'path.join(process.env.MAELLE_APPROVAL_SOURCE_ROOT || repo, rel)')
    + '\nreturn loadClassifier;')(require, __dirname);
const builderSource = fixtureSource('test-turn-context-boundaries.cjs', "test('room framing")
  .replace('const modules = new Map();', 'install(mocks); const modules = new Map();')
  .replace('path.join(root, file)', "path.join(beforeRoot && file.endsWith('/buildTurnContext.ts') ? beforeRoot : root, file)");
const dispatchSource = fixtureSource('test-skill-context-interactive.cjs', 'module.exports =')
  .replace('const orchestrator = compile', "deps['./buildTurnContext'] = { buildTurnContext }; const orchestrator = compile")
  .replace('return structuredClone(next.result);', 'return execute(args, context);')
  .replace('compile(read(orchestratorPath)', "compile(beforeRoot ? fs.readFileSync(path.join(beforeRoot, orchestratorPath), 'utf8') : read(orchestratorPath)");
const makeBuilder = new Function('require', '__dirname', 'install', 'beforeRoot', builderSource + '\nreturn fixture;');
const makeDispatch = new Function('require', '__dirname', 'buildTurnContext', 'execute', 'beforeRoot', dispatchSource + '\nreturn run;');
const newSubject = 'Customer success with Ayalla';
const priorSubject = 'Customer success status with Alex';
const senderText = 'and after book a meeting with <@UELINOR> and <@UAYALA> 25 mins\nright after the meeting with Alex\n“' + newSubject + '”';
const expanded = senderText.replace('<@UELINOR>', 'Elinor Avny (slack_id: UELINOR)').replace('<@UAYALA>', 'Ayala Geni (slack_id: UAYALA)');
const names = ['Elinor Avny', 'Ayala Geni'];
const addresses = ['elinor.avny@example.test', 'ayala.geni@example.test'];
const receipt = "[move_meeting OK — Moved '" + priorSubject + "' to Monday 11:15. [busy] event_id=fixture…] mutated=book attendee_check=noted";
const prose = 'Moved "' + priorSubject + '" to Monday. Elinor still shows as busy.';
function delivered(summary = receipt, reply = prose) {
  return {role:'assistant', toolSummaries:[summary], content:summary + '\n' + reply};
}
async function run(t, opts={}) {
  let observed, request;
  const history = opts.history || [delivered()];
  const step = {name:'create_meeting',args:{subject:newSubject,relaxed:true},result:{ok:true}};
  const output = opts.output === undefined ? {subjectQuote:newSubject, priorSubjectQuote:priorSubject, sourceMessageIndex:Math.min(history.length,4)-1} : opts.output;
  const builder = makeBuilder(require, __dirname, mocks=>{
    mocks['src/core/social/classifyTurn.ts'] = {classifyTurn:loadClassifier()};
    mocks['src/memory/resolveAttendeeEmails.ts'].resolveAttendeeEmail = ({slack_id})=>({email: opts.missing ? '' : addresses[['UELINOR','UAYALA'].indexOf(slack_id)] || ''});
    mocks['src/llm/client.ts'] = {getAnthropicClient:()=>({messages:{create:async args=>{
      request=args;
      return {stop_reason:'tool_use',usage:{},content:[{type:'tool_use',name:'classify_turn',input:{
        kind:'task',scopes:['meetings'],meeting_action:'execute',standalone_courtesy:false,meeting_continuation:false,
        meeting_people:names,meeting_people_groups:[names],
        ...(output ? {independent_ordinary_create:output} : {})
      }}]};
    }}})};
  },before)(t);
  const dispatch=makeDispatch(require,__dirname, params=>builder.run(params), async (args,context)=>{
    observed=context.ordinaryCreateAfterOtherMeeting;
    return step.result;
  },before);
  await dispatch([step],{profile:builder.profile,userId:'UOWNER',channelId:'DOWNER',threadTs:'thread',userMessage:expanded,
    rawUserMessage:expanded,typedUserMessage:senderText,conversationHistory:history,...opts.input});
  return {value:observed ? JSON.parse(JSON.stringify(observed)) : undefined,request};
}
test('distinct personally titled Ayalla create carries a check on the exact two attendees into live skill dispatch',async t=>{
  const {value}=await run(t);
  assert.deepEqual(value,{subject:newSubject,attendeeEmails:[...addresses].sort()});
});
test('private candidate passes earlier visit instruction to classifier without changing the four signed indices', async t=>{
  const waiver='For these visits this week trust me on availability.';
  const history=[{role:'user',content:waiver},{role:'assistant',content:'Acknowledged.'},{role:'user',content:'A prior request.'},
    {role:'assistant',content:'Question.'},{role:'user',content:'Move the Alex meeting.'},delivered()];
  const {value,request}=await run(t,{history,output:null});
  assert.equal(value,undefined);assert.ok(request.system.includes(waiver));assert.equal(request.system.includes('[0] user: '+waiver),false);
});
for (const [name, opts] of [
  ['missing receipt',{history:[{role:'assistant',content:prose}]}],
  ['unattested receipt prefix',{history:[{role:'assistant',content:prose,toolSummaries:[receipt]}]}],
  ['failed receipt',{history:[delivered(receipt.replace(' OK ',' FAILED '))]}],
  ['same prior receipt unrelated subject',{history:[delivered(receipt.replace(priorSubject,'Another event'))]}],
  ['prior title present only in receipt',{history:[delivered(receipt,'Done.')] }],
  ['unavailable literal mention identity',{missing:true}],
  ['typed title absent',{input:{typedUserMessage:'Please book after Alex'}}],
  ['same operation assent',{input:{typedUserMessage:'yes book it anyway',userMessage:'yes book it anyway',rawUserMessage:'yes book it anyway'},output:null}],
  ['titleless explicit single-step waiver',{input:{typedUserMessage:'Book anyway with Elinor',userMessage:'Book anyway with Elinor'},output:null}],
  ['private owner identity mismatch',{input:{userId:'UACTIVE'}}],
  ['colleague',{input:{senderRole:'colleague',authority:'colleague',surface:'colleague_dm'}}],
  ['shared room',{input:{isMpim:true,surface:'room',senderRole:'colleague',authority:'colleague'}}],
  ['older owner evidence exceeds bound',{history:[{role:'user',content:'x'.repeat(4100)},...Array.from({length:3},()=>({role:'assistant',content:'Earlier'})),delivered()]}],
]) test(name+' produces no restriction',async t=>assert.equal((await run(t,opts)).value,undefined));
