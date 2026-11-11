const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./fixtures/yael-lifecycle.cjs');

const original = [{ name: 'Alex', email: 'Hello@External.test' }, { name: 'Tal', email: 'tal@example.test' }];
const action = { tool: 'create_meeting', args: { subject: 'Rebranding', start: '2026-11-18T10:00:00-05:00',
  end: '2026-11-18T10:40:00-05:00', attendees: original } };

test('only the explicit addresses approved on this row reach the executor as trusted roster', async () => {
  const h = harness({ details: { deferred_action: action } });
  assert.equal((await h.resolve()).ok, true);
  assert.deepEqual(h.effects.executes[0].context.approvedBookingAttendeeEmails, ['hello@external.test', 'tal@example.test']);
  assert.equal(h.effects.sends.length, 1);
  await h.resolve();
  assert.equal(h.effects.executes.length, 1);
  assert.equal(h.effects.sends.length, 1);
});

test('an accepted amended roster replaces the first roster and omits name-only or malformed entries', async () => {
  const h = harness({ details: { deferred_action: action, counter: {
    attendees: [' NEW@External.test ', 'No address', { name: 'Alex', email: 'invalid@' }, null],
  } } });
  assert.equal((await h.resolve()).ok, true);
  assert.deepEqual(h.effects.executes[0].context.approvedBookingAttendeeEmails, ['new@external.test']);
});

test('reject callback cannot acquire approved identity through arguments', async () => {
  const h = harness({ details: { deferred_action: null, callbacks: {
    on_approve: action, on_reject: { ...action, args: { ...action.args, approvedBookingAttendeeEmails: ['forged@test.example'] } },
  } } });
  assert.equal((await h.resolve({ verdict: 'reject' })).ok, true);
  await h.flush();
  assert.equal(h.effects.executes.length, 1);
  assert.equal(h.effects.executes[0].context.approvedBookingAttendeeEmails, undefined);
});

function replacementHarness(options = {}) {
  return harness({ details: { deferred_action: action }, row: { terminal_dm_msg_ts: 'owner.1' }, ...options });
}

function classifiedAssent(h, text) {
  return { threadTs:'owner.1', currentUserMessage:text, typedUserMessage:text,
    standaloneBookingApproval:{ requestId:h.row().id, requestDetailsJson:h.row().details_json, quote:text } };
}

for (const text of ['Sí', 'Да', 'Ja', 'نعم', 'Yes, please.', 'Yes', 'כן']) {
  test('classified standalone assent replays exact recipients once: '+text, async () => {
    const h = replacementHarness();
    const ctx = classifiedAssent(h,text);
    const result = await h.resolveTool({},ctx);
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.deepEqual(h.effects.executes[0].args.attendees,original);
    await h.resolveTool({},ctx);
    assert.equal(h.effects.executes.length,1);
    assert.equal(h.effects.sends.length,1);
  });
}
for (const [label, mutate, args] of [
  ['wrong subject', c => { c.standaloneBookingApproval.requestId = 'req_other'; }],
  ['stale card', c => { c.standaloneBookingApproval.requestDetailsJson = '{}'; }],
  ['missing sender words', c => { c.typedUserMessage = ''; }],
  ['partial quote', c => { c.typedUserMessage += ' but invite a different person'; }],
  ['wrong sender', c => { c.userId = 'UNOTOWNER'; }],
  ['wrong surface', c => { c.surface = 'group_channel'; }],
  ['different transport', c => { c.channel = 'email'; }],
  ['another thread', c => { c.threadTs = 'other.1'; }],
  ['changed callback', () => {}, {data:{tool:'message_colleague',args:{message:'unrelated',target_slack_id:'UOTHER'}}}],
  ['model changed the verdict', () => {}, {verdict:'reject'}],
  ['model supplied an amendment', () => {}, {verdict:'amend',counter:{duration_min:60}}],
]) test('classified standalone assent refuses '+label, async () => {
  const h = replacementHarness();
  const ctx = classifiedAssent(h,'Sí');
  mutate(ctx);
  const result = await h.resolveTool(args ?? {},ctx);
  assert.notEqual(result.ok,true);
  assert.equal(h.row().state,'awaiting_owner');
  assert.equal(h.effects.executes.length,0);
  assert.equal(h.effects.sends.length,0);
});
test('classified standalone assent cannot release a prior identity question after restart',async()=>{
  const h = replacementHarness();
  assertHeld(h,await h.resolveTool({}, {threadTs:'owner.1',currentUserMessage:'That was the wrong person.'}));
  h.restart();
  assertHeld(h,await h.resolveTool({}, classifiedAssent(h,'Sí')));
});
test('classified standalone assent cannot be manufactured by tool arguments',async()=>{
  const h = replacementHarness();
  const {standaloneBookingApproval,...ctx} = classifiedAssent(h,'Sí');
  assertHeld(h,await h.resolveTool({standaloneBookingApproval,confirmedStandaloneApproval:true},ctx));
});
test('classified standalone assent refuses replacement data at the resolver',async()=>{
  const h = replacementHarness();
  const result = await h.resolve({verdict:'approve',data:{tool:'create_meeting',args:{...action.args,subject:'Other meeting'}}},
    {confirmedStandaloneApproval:true,ownerDecisionMessage:'Sí',expectedOwnerDecisionDetails:h.row().details_json});
  assert.equal(result.effect,'approve_needs_exact_plan');
  assert.deepEqual(h.effectiveAction().args,action.args);
  assert.equal(h.effects.executes.length,0);
});
test('classified standalone assent is rechecked inside the request lock',async()=>{
  const h = replacementHarness();
  const ctx = classifiedAssent(h,'Да');
  let begin,done;
  const started = new Promise(resolve=>{begin=resolve;});
  const canFinish = new Promise(resolve=>{done=resolve;});
  const holding = h.lock(async()=>{
    begin();
    await canFinish;
    h.update(h.row().id,{details:{deferred_action:{...action,args:{...action.args,subject:'Changed meeting'}}}});
  });
  await started;
  const pending = h.resolveTool({},ctx);
  done();
  await holding;
  assert.equal((await pending).effect,'contextual_decision_changed');
  assert.equal(h.effects.executes.length,0);
  assert.equal(h.effects.sends.length,0);
});

function replaceRoster(h, attendees, message, context = {}) {
  return h.resolveTool({ data: { tool: 'create_meeting', args: { ...action.args, subject: 'Budget', attendees } } },
    { threadTs: 'owner.1', currentUserMessage: message, ...context });
}

test('an owner replacement by name runs normal resolution and the sanitized decision survives a failed write and restart', async () => {
  const h = replacementHarness({ toolResult: { error: 'calendar_offline' } });
  const guessed = { name: 'Daniel', optional: true };
  assertHeld(h, await replaceRoster(h, [guessed], 'Replace Alex and Tal with Daniel for the budget review.'));
  await replaceRoster(h, [guessed], '- Daniel');
  assert.equal(h.row().state, 'awaiting_owner');
  assert.deepEqual(h.effects.executes[0].args.attendees, [{ name: 'Daniel', optional: true }]);
  assert.deepEqual(h.effects.executes[0].context.approvedBookingAttendeeEmails, []);
  h.restart();
  await h.resolve();
  assert.deepEqual(h.effects.executes[1].args.attendees, [{ name: 'Daniel', optional: true }]);
  assert.deepEqual(h.effects.executes[1].context.approvedBookingAttendeeEmails, []);
  assert.equal(h.effects.sends.length, 0);
});

test('a replacement cannot swap existing people and addresses or elevate a substring of a human email', async () => {
  const h = replacementHarness();
  const roster = [{ name: 'Daniel', email: original[0].email }, { name: 'Jo', email: 'jo@external.test' }, original[1]];
  const r = await replaceRoster(h, roster, 'Invite Daniel and Jo. My address is mjo@external.test.');
  assertHeld(h, r);
});

test('a new address the owner supplied in the current message remains literal on replacement', async () => {
  const h = replacementHarness();
  const roster = [{ name: 'Daniel', email: 'hello@design.test' }];
  assertHeld(h, await replaceRoster(h, roster, 'Daniel <mailto:Hello@Design.test|Hello@Design.test>'));
  const r = await replaceRoster(h, roster, 'Daniel <mailto:Hello@Design.test|Hello@Design.test>');
  assert.equal(r.ok, true);
  assert.deepEqual(h.effects.executes[0].args.attendees, roster);
  assert.deepEqual(h.effects.executes[0].context.approvedBookingAttendeeEmails, ['hello@design.test']);
});

test('an ungrounded address-only substitution stays pending without changing the stored decision', async () => {
  const h = replacementHarness();
  const r = await replaceRoster(h, [{ email: 'unknown@external.test' }], 'Book the budget review instead.');
  assert.equal(r.ok, false);
  assert.equal(r.effect, 'approve_needs_attendee_identity');
  assert.equal(h.row().state, 'awaiting_owner');
  assert.equal(h.effectiveAction().args.subject, action.args.subject);
  assert.equal(h.effects.executes.length, 0);
  assert.equal(h.effects.sends.length, 0);
});

test('keep Alex and add Daniel preserves the unique approved inbox by name across restart', async () => {
  const h = replacementHarness({ toolResult: { error: 'calendar_offline' } });
  const changed = [{ name: 'Alex' }, { name: 'Daniel' }];
  assertHeld(h, await replaceRoster(h, changed, 'Keep Alex, remove Tal and add Daniel.'));
  await replaceRoster(h, changed, '- Alex\n- Daniel');
  assert.deepEqual(h.effects.executes[0].args.attendees, [original[0], { name: 'Daniel' }]);
  h.restart();
  await h.resolve();
  assert.deepEqual(h.effects.executes[1].context.approvedBookingAttendeeEmails, ['hello@external.test']);
  assert.equal(h.effects.sends.length, 0);
});

test('keep Alex and add Daniel can identify the existing invitee by the exact approved inbox alone', async () => {
  const h = replacementHarness();
  const changed = [{ email: original[0].email.toLowerCase() }, { name: 'Daniel' }];
  assertHeld(h, await replaceRoster(h, changed, 'Keep Alex, remove Tal and add Daniel.'));
  const r = await replaceRoster(h, changed, '- Alex\n- Daniel');
  assert.equal(r.ok, true);
  assert.deepEqual(h.effects.executes[0].args.attendees, [original[0], { name: 'Daniel' }]);
  assert.deepEqual(h.effects.executes[0].context.approvedBookingAttendeeEmails, ['hello@external.test']);
});

test('an address-only replacement cannot select between competing identities shown with that inbox', async () => {
  const attendees = [original[0], { name: 'Another person', email: original[0].email }];
  const h = replacementHarness({ details: { deferred_action: { ...action, args: { ...action.args, attendees } } } });
  const r = await replaceRoster(h, [{ email: original[0].email }], 'Keep one of them.');
  assert.equal(r.effect, 'approve_needs_attendee_identity');
  assert.equal(h.effects.executes.length, 0);
  assert.equal(h.effects.sends.length, 0);
});

test('competing approved inboxes for Alex require clarification before any write', async () => {
  const attendees = [original[0], { name: 'Alex', email: 'second@example.test' }];
  const h = replacementHarness({ details: { deferred_action: { ...action, args: { ...action.args, attendees } } } });
  const r = await replaceRoster(h, [{ name: 'Alex' }, { name: 'Daniel' }], 'Keep Alex and add Daniel.');
  assert.equal(r.effect, 'approve_needs_attendee_identity');
  assert.equal(h.effects.executes.length, 0);
  assert.equal(h.effects.sends.length, 0);
  assert.equal(h.row().state, 'awaiting_owner');
  assert.equal(h.effectiveAction().args.attendees.length, 2);
});

for (const identifier of [{ email: 'unconfirmed@elsewhere.test' }, { slack_id: 'UDIFFALEX' }]) {
  test('a conflicting ungrounded '+Object.keys(identifier)[0]+' cannot silently choose between people called Alex', async () => {
    const h = replacementHarness();
    const r = await replaceRoster(h, [{ name: 'Alex', ...identifier }], 'Use the other Alex.');
    assert.equal(r.effect, 'approve_needs_attendee_identity');
    assert.equal(h.effects.executes.length, 0);
    assert.equal(h.effects.sends.length, 0);
  });
}

test('owner can explicitly replace the approved Alex with another Alex by email', async () => {
  const h = replacementHarness();
  const next = { name: 'Alex', email: 'new@elsewhere.test' };
  const r = await replaceRoster(h, [next], 'Alex <new@elsewhere.test>');
  assert.equal(r.ok, true);
  assert.deepEqual(h.effects.executes[0].args.attendees, [next, original[1]]);
  assert.deepEqual(h.effects.executes[0].context.approvedBookingAttendeeEmails, [next.email, original[1].email]);
});

test('a literal owner-selected member ID resolves the chosen Alex rather than carrying another mailbox', async () => {
  const member = { name: 'Different Alex', email: 'member@directory.test' };
  const h = replacementHarness({ people: { UDIFFALEX: member } });
  const r = await replaceRoster(h, [{ name: 'Alex', slack_id: 'UDIFFALEX' }], 'Alex <@UDIFFALEX>');
  assert.equal(r.ok, true);
  assert.deepEqual(h.effects.executes[0].args.attendees, [member, original[1]]);
  assert.deepEqual(h.effects.executes[0].context.approvedBookingAttendeeEmails, [member.email, original[1].email]);
});

test('an unknown owner-selected member ID cannot fall back to the old Alex or ordinary name search', async () => {
  const h = replacementHarness({ people: { UUNKNOWN: null } });
  const r = await replaceRoster(h, [{ name: 'Alex', slack_id: 'UUNKNOWN' }], '<@UUNKNOWN>');
  assert.equal(r.effect, 'approve_needs_attendee_identity');
  assert.equal(h.effects.executes.length, 0);
  assert.equal(h.effects.sends.length, 0);
});

function assertHeld(h, result, stored = action) {
  assert.equal(result.effect, 'approve_needs_attendee_identity');
  assert.match(result.reason, /Name <email>/i);
  assert.equal(h.row().state, 'awaiting_owner');
  assert.deepEqual(JSON.parse(JSON.stringify(h.effectiveAction())), stored);
  assert.equal(h.effects.executes.length, 0);
  assert.equal(h.effects.sends.length, 0);
  assert.equal(h.effects.closes.length, 0);
}

const updated = 'alex@newcompany.test';
for (const [label, text, attendees] of [
  ['ordinary prose with an omitted inbox', 'Replace the current invitee with Alex at '+updated+'.', [{name:'Alex'}]],
  ['ordinary prose with a stale unchanged roster', 'Replace Alex with '+updated, original],
  ['negated pair echoed by tool', "Don't invite Alex <"+updated+">", [{name:'Alex', email:updated}]],
  ['quoted pair echoed by tool', '> Alex <'+updated+'>', [{name:'Alex', email:updated}]],
  ['unrelated owner inbox echoed as invitee', 'CC me at '+updated+' for the notes.', [{name:'Alex', email:updated}]],
  ['bare mailbox with two previously approved people', updated, [{name:'Alex'}]],
  ['multiple unassociated mailboxes', updated+'\nother@example.test', [{name:'Alex'}, {name:'Tal'}]],
  ['competing pair answers for the same attendee', 'Alex <'+updated+'>\nAlex <other@example.test>', [{name:'Alex'}]],
  ['pair vs conflicting third model address', 'Alex <'+updated+'>', [{name:'Alex',email:'invented@example.test'}]],
  ['newly supplied tool-only address', 'Book a budget review with Daniel.', [{name:'Daniel',email:'invented@example.test'}]],
]) test(label+' asks before saving or dispatching', async () => {
  const h = replacementHarness();
  assertHeld(h, await replaceRoster(h, attendees, text));
});

test('bare approve does not lose a contradictory address in the actual owner message', async () => {
  const h = replacementHarness();
  const result = await h.resolveTool({}, {threadTs:'owner.1', currentUserMessage:'Use Alex at '+updated+' instead.'});
  assertHeld(h, result);
});

for (const [label, entry] of [['omitted address', {name:'Alex'}], ['stale saved address', original[0]]]) {
  test('an explicit named answer with '+label+' binds the actual owner address', async () => {
    const h = replacementHarness();
    const result = await replaceRoster(h, [entry], 'Alex <'+updated+'>');
    assert.equal(result.ok, true);
    assert.deepEqual(h.effects.executes[0].args.attendees, [{name:'Alex', email:updated}, original[1]]);
  });
}

test('two explicit pairs bind by name even if arguments reverse their order', async () => {
  const h = replacementHarness();
  const result = await replaceRoster(h, [{name:'Tal'}, {name:'Alex'}], 'Alex <'+updated+'>\nTal <tal@newcompany.test>');
  assert.equal(result.ok, true);
  assert.deepEqual(h.effects.executes[0].args.attendees, [{name:'Tal',email:'tal@newcompany.test'}, {name:'Alex',email:updated}]);
});

test('a standalone mailbox after restart can correct the sole previously bound person', async () => {
  const sole = {...action, args:{...action.args, attendees:[original[0]]}};
  const h = replacementHarness({ details:{deferred_action:sole}, toolResult:{error:'calendar_offline'} });
  await h.resolve();
  h.restart();
  await h.resolveTool({}, {threadTs:'owner.1', currentUserMessage:updated});
  assert.deepEqual(h.effects.executes[1].args.attendees, [{name:'Alex',email:updated}]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.effectiveAction().args.attendees)), [{name:'Alex',email:updated}]);
  assert.equal(h.effects.sends.length, 0);
});

test('bare mailbox cannot authorize a callback selecting a different person', async () => {
  const sole = {...action, args:{...action.args, attendees:[original[0]]}};
  const h = replacementHarness({details:{deferred_action:sole}});
  assertHeld(h, await replaceRoster(h, [{name:'Daniel',email:updated}], updated), sole);
});

test('copying a negated sentence into a novel display name cannot turn it into an affirmative pair', async () => {
  const h = replacementHarness();
  assertHeld(h, await replaceRoster(h, [{name:'Do not invite Alex',email:updated}], 'Do not invite Alex <'+updated+'>'));
});

test('a quoted new full name identifies the person without treating prose as a name', async () => {
  const h = replacementHarness();
  const named = '"Daniel Sharabi" <daniel@example.test>';
  assertHeld(h, await replaceRoster(h, [{name:'Daniel Sharabi'}], named));
  const result = await replaceRoster(h, [{name:'Daniel Sharabi'}], named);
  assert.equal(result.ok, true);
  assert.deepEqual(h.effects.executes[0].args.attendees, [{name:'Daniel Sharabi',email:'daniel@example.test'}]);
});

test('pending identity survives bare Yes and reaction across restart; the exact answer survives an unavailable executor', async () => {
  const sole = {...action, args:{...action.args,attendees:[original[0]]}};
  const h = replacementHarness({details:{deferred_action:sole,missing_fields:['timezone']}, toolResult:{error:'calendar_offline'}});
  const answer = text => h.resolveTool({}, {threadTs:'owner.1', currentUserMessage:text});
  assertHeld(h, await answer('Switch Alex to '+updated+' instead.'), sole);
  h.restart();
  assertHeld(h, await answer('Yes'), sole);
  assertHeld(h, await h.resolve(), sole);
  assert.deepEqual(JSON.parse(h.row().details_json).missing_fields, ['timezone','booking_attendee_identity']);
  await answer(updated);
  assert.deepEqual(JSON.parse(h.row().details_json).missing_fields, ['timezone']);
  assert.deepEqual(h.effects.executes[0].args.attendees, [{name:'Alex',email:updated}]);
  h.restart();
  await h.resolve();
  assert.deepEqual(h.effects.executes[1].args.attendees, [{name:'Alex',email:updated}]);
  assert.equal(h.effects.sends.length, 0);
});

test('a partial answer about Tal cannot discharge an unresolved address for a different invitee', async () => {
  const h = replacementHarness();
  assertHeld(h, await replaceRoster(h, original, 'Use Alex at '+updated+' instead.'));
  h.restart();
  assertHeld(h, await h.resolveTool({}, {threadTs:'owner.1',currentUserMessage:'Tal <tal@example.test>'}));
  const result = await h.resolveTool({}, {threadTs:'owner.1',currentUserMessage:'Alex <'+updated+'>\nTal <tal@example.test>'});
  assert.equal(result.ok, true);
  assert.deepEqual(h.effects.executes[0].args.attendees, [{name:'Alex',email:updated},original[1]]);
});

test('owner can reject an approval waiting for a recipient answer', async () => {
  const h = replacementHarness();
  assertHeld(h, await replaceRoster(h, original, 'Use Alex at '+updated+' instead.'));
  assert.equal((await h.resolve({verdict:'reject'})).ok, true);
  assert.equal(h.effects.executes.length, 0);
  assert.equal(h.row().state, 'cancelled');
});

for (const [label, rows] of [
  ['model-only addition', [{name:'Alex'},original[1],{name:'Daniel'}]],
  ['model-only substitution', [{name:'Alex'},{name:'Simon'}]],
  ['duplicate prior member', [{name:'Alex'}, original[1], {email:original[1].email}]],
  ['changed non-selected inbox', [{name:'Alex'}, {name:'Tal',email:'other@example.test'}]],
]) test('a scoped correction holds a '+label+' before dispatch', async () => {
  const h=replacementHarness();
  assertHeld(h,await replaceRoster(h,rows,'Alex <'+updated+'>'));
});

test('correcting Alex cannot reassign the unchanged inbox of Tal to Alex', async () => {
  const h=replacementHarness();
  assertHeld(h,await replaceRoster(h,[{name:'Alex'}],'Alex <'+original[1].email+'>'));
});

test('an omitted name-only member keeps the approved role and directory lookup on cold retry', async () => {
  const tal={name:'Tal',optional:true};
  const h=replacementHarness({details:{deferred_action:{...action,args:{...action.args,attendees:[original[0],tal]}}},toolResult:{error:'calendar_offline'}});
  await replaceRoster(h,[{name:'Alex'}],'Alex <'+updated+'>');
  h.restart();
  await h.resolve();
  for (const execution of h.effects.executes) assert.deepEqual(execution.args.attendees,[{name:'Alex',email:updated},tal]);
  assert.equal(h.effects.executes.length,2);
  assert.equal(h.effects.sends.length,0);
});

test('a bare new member ID cannot choose which of two old people to replace', async () => {
  const h=replacementHarness({people:{UDIFFERENT:{name:'A different person',email:'different@example.test'}}});
  assertHeld(h,await replaceRoster(h,[{name:'Alex',slack_id:'UDIFFERENT'}],'<@UDIFFERENT>'));
});

test('after a full-list question the owner can expressly replace the whole group with one new person', async () => {
  const h=replacementHarness();
  const newPerson={name:'Daniel',email:'daniel@newcompany.test'};
  assertHeld(h,await replaceRoster(h,[newPerson],'Daniel <'+newPerson.email+'>'));
  h.restart();
  assertHeld(h, await h.resolve());
  const result=await replaceRoster(h,[newPerson],'Daniel <'+newPerson.email+'>');
  assert.equal(result.ok,true);
  assert.deepEqual(h.effects.executes[0].args.attendees,[newPerson]);
});

for (const [message, roster] of [
  ['Yes', [{name:'Alex'}]],
  ['כן', [original[0],original[1],{name:'Daniel'}]],
  ['Keep Alex and add Daniel.', [{name:'Alex'},{name:'Daniel'}]],
  ['Keep Alex and Tal; send the paperwork to Daniela.', [original[0],original[1],{name:'Daniel'}]],
]) test('an ordinary approval cannot ground an unmentioned attendee change: '+message, async () => {
  const h=replacementHarness();
  assertHeld(h,await replaceRoster(h,roster,message));
});
test('plain yes accepts a representation-only name roster change without losing approved addresses', async () => {
  const h=replacementHarness();
  const result=await replaceRoster(h,[{name:'Alex'},{name:'Tal'}],'Yes');
  assert.equal(result.ok,true);
  assert.deepEqual(h.effects.executes[0].args.attendees,original);
});

test('keep Tal and add Daniel cannot authorize the callback to drop Tal',async()=>{
  const h=replacementHarness({details:{deferred_action:action,missing_fields:['timezone']}});
  {
    const wrong=[original[0],{name:'Daniel'}];
    assertHeld(h,await replaceRoster(h,wrong,'Keep Tal and add Daniel.'));
    h.restart();
    assertHeld(h,await h.resolve());
    for(const text of ['Yes','Forwarded:\n- Alex\n- Daniel','> - Alex\n> - Daniel','- Alex\n- Alex']) {
      assertHeld(h,await replaceRoster(h,wrong,text));
    }
  }
  const correct=[original[0],original[1],{name:'Daniel'}];
  const result=await replaceRoster(h,correct,'- Tal\n- Alex\n- Daniel');
  assert.equal(result.ok,true);
  assert.deepEqual(h.effects.executes[0].args.attendees,correct);
  assert.deepEqual(JSON.parse(h.row().details_json).missing_fields,['timezone']);
});
test('a name-only bullet cannot discharge a wrong-inbox question',async()=>{
  const h=replacementHarness();
  assertHeld(h,await replaceRoster(h,[{name:'Alex',email:'untrusted@elsewhere.test'}],'Use the other Alex.'));
  assertHeld(h,await replaceRoster(h,[{name:'Alex'}],'- Alex'));
});
test('plain yes on a previously shown counter accepts its exact replacement group',async()=>{
  const changed=[{name:'Daniel'}];
  const h=replacementHarness({details:{deferred_action:action,counter:{attendees:changed}}});
  const result=await h.resolveTool({}, {threadTs:'owner.1',currentUserMessage:'Yes'});
  assert.equal(result.ok,true);
  assert.deepEqual(h.effects.executes[0].args.attendees,changed);
});

const alexOnly = { ...action, args:{...action.args,attendees:[original[0]]} };
for (const result of [
  { status:'ambiguous', match:null, candidates:[{name:'Alex',email:'other@example.test'},{name:'Alex',email:'another@example.test'}] },
  { status:'matched', match:{name:'Alex',email:'other@example.test'}, candidates:[] },
  { status:'not_found', match:null, candidates:[] },
]) {
  for(const [label,reply,hasOverride] of [
    ['name with model echo','That is the wrong Alex. Please invite the other Alex instead.',true],
    ['name without model echo','That is the wrong Alex. Please invite the other Alex instead.',false],
    ['reference without name','That is the wrong person. I meant the other one.',false],
  ]) test(label+' never releases rejected inbox for directory status '+result.status,async()=>{
    const h=replacementHarness({details:{deferred_action:alexOnly},findPersonByName:()=>result});
    const decision=hasOverride ? {data:{tool:'create_meeting',args:{...alexOnly.args,attendees:[{name:'Alex'}]}}} : {};
    assertHeld(h,await h.resolveTool(decision,{threadTs:'owner.1',currentUserMessage:reply}),alexOnly);
    h.restart();
    assertHeld(h,await h.resolve(),alexOnly);
    const corrected=await h.resolveTool({}, {threadTs:'owner.1',currentUserMessage:'Alex <'+updated+'>'});
    assert.equal(corrected.ok,true);
    assert.deepEqual(h.effects.executes[0].args.attendees,[{name:'Alex',email:updated}]);
  });
  test('true unqualified Yes preserves the shown exact inbox for directory status '+result.status,async()=>{
    const h=replacementHarness({details:{deferred_action:alexOnly},findPersonByName:()=>result});
    assert.equal((await h.resolveTool({}, {threadTs:'owner.1',currentUserMessage:'Yes'})).ok,true);
    assert.deepEqual(h.effects.executes[0].args.attendees,[original[0]]);
  });
}
for(const [label, proposed, reply, expected] of [
  ['new named inbox after a group and identity question',[{name:'Daniel',email:'new@elsewhere.test'}],'Daniel <new@elsewhere.test>',[{name:'Daniel',email:'new@elsewhere.test'}]],
  ['two exact inboxes after a group question',[{name:'Daniel'}],'Daniel <new@elsewhere.test>\nJo <jo@elsewhere.test>',[{name:'Daniel',email:'new@elsewhere.test'},{name:'Jo',email:'jo@elsewhere.test'}]],
  ['single name after a group question',[{name:'Daniel'}],'- Daniel',[{name:'Daniel'}]],
  ['two names after a group question',[{name:'Daniel'}],'- Tal\n- Daniel',[original[1],{name:'Daniel'}]],
]) test('cold full list with NO callback repetition: '+label,async()=>{
  const h=replacementHarness();
  assertHeld(h,await replaceRoster(h,proposed,'Please change the group.'));
  h.restart();
  const final=await h.resolveTool({}, {threadTs:'owner.1',currentUserMessage:reply});
  assert.equal(final.ok,true);
  assert.deepEqual(h.effects.executes[0].args.attendees,expected);
});
test('a cold answer with a materially contradictory replacement cannot silently substitute a third person',async()=>{
  const h=replacementHarness();
  assertHeld(h,await replaceRoster(h,[{name:'Daniel'}],'Please change the group.'));
  h.restart();
  assertHeld(h,await replaceRoster(h,[{name:'Jo',email:'jo@different.test'}],'Daniel <new@elsewhere.test>'));
});

for (const [label,ctx] of [
  ['generic missing text',{confirmedApprovalReaction:false}],
  ['a reaction by a different identity',{resolvingUserId:'UOTHER'}],
  ['text without affirmative provenance',{ownerDecisionMessage:''}],
  ['a semantic attribution that contradicts its literal reply',{ownerDecisionMessage:'No.',expectedOwnerDecisionDetails:JSON.stringify({deferred_action:alexOnly})}],
]) test(label+' cannot act as a direct approval',async()=>{
  const h=replacementHarness({details:{deferred_action:alexOnly}});
  assertHeld(h,await h.resolve({verdict:'approve'},ctx),alexOnly);
});
test('a real bound owner reaction and a literal Hebrew Yes independently select the shown recipients',async()=>{
  for(const direct of [true,false]){
    const h=replacementHarness({details:{deferred_action:alexOnly}});
    const result=direct?await h.resolve():await h.resolveTool({},{threadTs:'owner.1',currentUserMessage:'כן!'});
    assert.equal(result.ok,true);
    assert.deepEqual(h.effects.executes[0].args.attendees,[original[0]]);
  }
});
for(const [label,status,expected] of [
  ['directory has competing names',{status:'ambiguous',match:null},false],
  ['directory knows another inbox',{status:'matched',match:{email:'different@example.test'}},false],
  ['directory agrees with the shown inbox',{status:'matched',match:{email:original[0].email}},true],
  ['directory has no competing match',{status:'not_found',match:null},true],
]) test('a cold full group name keeps external Alex only when '+label,async()=>{
  const h=replacementHarness({findPersonByName:name=>name==='alex'?status:{status:'matched',match:{email:'daniel@example.test'}}});
  assertHeld(h,await replaceRoster(h,[{name:'Alex'},{name:'Daniel'}],'Change the invitees.'));
  h.restart();
  const result=await h.resolveTool({},{threadTs:'owner.1',currentUserMessage:'- Alex\n- Daniel'});
  if(expected){
    assert.equal(result.ok,true);
    assert.deepEqual(h.effects.executes[0].args.attendees,[original[0],{name:'Daniel'}]);
  }else{
    assertHeld(h,result);
    const exact=await h.resolveTool({},{threadTs:'owner.1',currentUserMessage:'Alex <'+original[0].email+'>\nDaniel <daniel@example.test>'});
    assert.equal(exact.ok,true);
  }
});

const lev = {name:'Alex Levin',email:'alex@design.example'};
const levLine = '"Alex Levin" <alex@design.example>';
const talLine = 'Tal <tal@example.test>';

async function questionedGroup(people) {
  const stored = {...action,args:{...action.args,attendees:people}};
  const h=replacementHarness({details:{deferred_action:stored}});
  assertHeld(h,await h.resolveTool({}, {threadTs:'owner.1',currentUserMessage:'That is the wrong person.'}),stored);
  h.restart();
  return {h,stored};
}
for(const [label,people,answer,expected] of [
  ['one full name',[original[0]],levLine,[lev]],
  ['a different single exact identity',[original[0]],'"Dana Smith" <dana@design.example>',[{name:'Dana Smith',email:'dana@design.example'}]],
  ['one replacement in a complete group',original,levLine+'\n'+talLine,[lev,original[1]]],
  ['unchanged entry typed first',original,talLine+'\n'+levLine,[lev,original[1]]],
]) test('cold identity answer binds '+label+' without a callback',async()=>{
  const {h}=await questionedGroup(people);
  const result=await h.resolveTool({}, {threadTs:'owner.1',currentUserMessage:answer});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(h.effects.executes[0].args.attendees,expected);
});
for(const [label,answer,proposed] of [
  ['partial group',levLine,undefined],
  ['partial callback',levLine,[lev]],
  ['two unrelated renamed slots',levLine+'\n"Dana Smith" <dana@design.example>',undefined],
  ['two changed slots without a unique renamed binding',levLine+'\nTal <new-tal@example.test>',undefined],
  ['existing other inbox reassigned to renamed person','"Alex Levin" <tal@example.test>\nTal <another@example.test>',undefined],
  ['contradictory proposed inbox',levLine+'\n'+talLine,[{name:'Alex',email:'third@example.test'},original[1]]],
  ['unrelated proposed name',levLine+'\n'+talLine,[{name:'Jo',email:lev.email},original[1]]],
  ['negated selection',"Don't invite "+levLine+'\n'+talLine,undefined],
  ['forwarded selection','> '+levLine+'\n'+talLine,undefined],
  ['unqualified acknowledgement','Yes',undefined],
]) test('identity hold preserves the original group on '+label,async()=>{
  const {h,stored}=await questionedGroup(original);
  const data=proposed?{data:{tool:action.tool,args:{...action.args,attendees:proposed}}}:{};
  assertHeld(h,await h.resolveTool(data,{threadTs:'owner.1',currentUserMessage:answer}),stored);
});
test('a stale but compatible callback preserves the owner-supplied full name and destination',async()=>{
  const {h}=await questionedGroup(original);
  const result=await h.resolveTool({data:{tool:action.tool,args:{...action.args,attendees:[{name:'Alex'},original[1]]}}},
    {threadTs:'owner.1',currentUserMessage:levLine+'\n'+talLine});
  assert.equal(result.ok,true);
  assert.deepEqual(h.effects.executes[0].args.attendees,[lev,original[1]]);
});
