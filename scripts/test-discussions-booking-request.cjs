const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, profile } = require('./fixtures/yael-lifecycle.cjs');

const action = { tool: 'create_meeting', args: {
  subject: 'Rebranding with Einav, Tal, Alex, Daniel and Simon',
  start: '2026-11-18T10:00:00-05:00', end: '2026-11-18T10:40:00-05:00',
  attendees: [{ name: 'Einav', email: 'einav@example.test' },
    { name: 'Tal', email: 'tal@example.test' }, { name: 'Alex', email: 'hello@external.test' },
    { name: 'Daniel', email: 'daniel@example.test' }, { name: 'Simon', email: 'simon@example.test' }],
  category: 'Meeting',
} };
const details = { deferred_action: action, honest_hard_reason: 'Already busy with Einav & Idan, Weekly.' };
const source = 'Daniel asks for Rebranding at 17:00 your time; book over the weekly?';
const owner = { ...profile, user: { ...profile.user, timezone: 'America/New_York' } };

test('the owner sees who requested which booking and an explicit decision, with the approved interval and roster', async () => {
  const h = harness({ details, row: { requester_name: 'Daniel Sharabi', description: source } });
  const text = await h.preview({ profile: owner });
  assert.match(text, /Daniel Sharabi.*book.*Rebranding[^\n]*\?/);
  assert.ok(text.indexOf('Daniel Sharabi') < text.indexOf('Already busy'));
  assert.match(text, /Already busy with Einav & Idan, Weekly/);
  assert.match(text, /10:00.*10:40/);
  for (const person of action.args.attendees) assert.ok(text.includes(person.email));
  assert.doesNotMatch(text, /17:00 your time/);
  assert.equal(h.effects.executes.length, 0);
});

test('a missing requester never fabricates a person and the booking question survives a missing reason', async () => {
  const h = harness({ details: { deferred_action: action }, row: {
    requester_name: null, requester_slack_id: null, description: source,
  } });
  const text = await h.preview({ profile: owner });
  assert.match(text, /book.*Rebranding[^\n]*\?/i);
  assert.match(text, /original reason.*unavailable/);
  assert.doesNotMatch(text, /Daniel Sharabi|17:00 your time/);
});

test('a counter uses the accepted subject without attributing the changed terms to the original requester', async () => {
  const h = harness({ details: { ...details, counter: { subject: 'Updated title' } },
    row: { requester_name: 'Daniel Sharabi', description: source } });
  const text = await h.preview({ profile: owner });
  assert.match(text, /Updated title[^\n]*\?/);
  assert.doesNotMatch(text, /Rebranding|17:00 your time/);
});

test('the original non-booking question is delivered unchanged', async () => {
  const h = harness({ details: { deferred_action: null }, row: { description: 'May Daniel publish the report?' } });
  assert.equal(await h.preview(), 'May Daniel publish the report?');
});

test('a refused owner replacement keeps the original requester separate from the booking on retry', async () => {
  const replacement = { tool: 'create_meeting', args: { ...action.args, subject: 'Budget review with Tal',
    attendees: [{ name: 'Tal', email: 'tal@budget.test' }] } };
  const h = harness({ details, toolResult: { error: 'calendar_offline' },
    row: { terminal_dm_msg_ts: 'owner.1', requester_name: 'Daniel Sharabi' } });
  const pending = await h.resolveTool({ data: replacement }, { threadTs: 'owner.1',
    currentUserMessage: 'Instead, book a budget review with Tal at tal@budget.test at the same time.' });
  assert.equal(pending.effect, 'approve_needs_attendee_identity');
  assert.match(pending.reason, /Name <email>/);
  assert.equal(h.row().state, 'awaiting_owner');
  assert.equal(h.effects.executes.length, 0);
  assert.equal(h.effects.sends.length, 0);
  h.restart();
  const originalCard = await h.preview();
  assert.match(originalCard, /Original request from Daniel Sharabi\. Should I book “Rebranding/);
  assert.doesNotMatch(originalCard, /Budget review|tal@budget.test/);
  const result = await h.resolveTool({ data: replacement }, { threadTs: 'owner.1',
    currentUserMessage: 'Tal <tal@budget.test>' });
  assert.equal(result.ok, false);
  assert.equal(h.effects.executes.length, 1);
  assert.equal(h.effects.executes[0].args.subject, replacement.args.subject);
  assert.deepEqual(h.effects.executes[0].args.attendees, replacement.args.attendees);
  assert.equal(h.row().state, 'awaiting_owner');
  h.restart();
  assert.equal(h.effectiveAction().args.subject, replacement.args.subject);
  const text = await h.preview();
  assert.match(text, /Original request from Daniel Sharabi\. Should I book “Budget review with Tal”\?/);
  assert.match(text, /Tal <tal@budget.test>/);
  assert.doesNotMatch(text, /Daniel Sharabi asked me to book|Rebranding|hello@external.test/);
  assert.equal(h.effects.executes.length, 1);
  assert.equal(h.effects.sends.length, 0);
});

test('the original requester stays visible when the current booking has an active counter', async () => {
  const h = harness({ details: { ...details, counter: { subject: 'Changed by the owner' } },
    row: { requester_name: 'Daniel Sharabi' } });
  const text = await h.preview();
  assert.match(text, /Original request from Daniel Sharabi\. Should I book “Changed by the owner”\?/);
  assert.doesNotMatch(text, /Rebranding/);
});
