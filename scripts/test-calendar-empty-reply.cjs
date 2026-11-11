const test = require('node:test');
const assert = require('node:assert/strict');
const { run, msg, held } = require('./test-fallback-held-send-verb.cjs');
const read = (name, result) => ({name, args: {}, result});
const move = result => ({name: 'move_meeting', args: {meeting_id: 'event-1'}, result});
const booked = {ok: true, moved: 'Planning', meetingId: 'event-1'};
const refused = {error: 'unavailable'};
for (const [name, steps, expected] of [
  ['slots', [read('find_available_slots', [])], /calendar results/i],
  ['work-overrides', [read('get_work_schedule_overrides', {overrides: []})], /calendar results/i],
  ['partial', [move(booked), move(refused)], /calendar change.*another calendar change failed/i],
  ['observed', [move({_calendar_verification:'desired_state_observed', meetingId:'event-1'})], /already at the requested time/i],
  ['unconfirmed', [move({_calendar_verification:'unavailable', meetingId:'event-1'})], /couldn.t confirm whether/i],
  ['unchanged', [move({unchanged:true, meetingId:'event-1'})], /already at the requested time/i],
  ['aggregate-partial', [move({ok:false,outcomes:[booked, {meeting_id:'event-2',error:'unavailable'}]})], /calendar change went through.*couldn't confirm all/i],
  ['aggregate-observed', [move({ok:true,outcomes:[
    {...booked, unchanged:true}, {...booked, meetingId:'event-2', _calendar_verification:'desired_state_observed'},
  ]})], /requested meeting times are confirmed/i],
  ['held-control', [msg('Dana', held)], /scheduled the message/],
  ['failed-control', [move(refused)], /didn.t go through/i],
]) test(name, async () => assert.match(await run(steps), expected));

const batch = (...events) => move({outcomes: events});
const observed = meetingId => ({ok:true, unchanged:true, meetingId});
const complete = batch(observed('event-1'), observed('event-2'));
const incomplete = batch(observed('event-3'), {meeting_id:'event-4', error:'unavailable'});
test('mixed-batch-preserves-partial-confirmation-without-causal-write', async () => {
  const reply = await run([complete, incomplete]);
  assert.match(reply, /some.*times.*confirmed/i);
  assert.match(reply, /couldn't confirm all/i);
  assert.doesNotMatch(reply, /the requested meeting times are confirmed|change went through/i);
});
test('confirmed-batch-plus-unknown-single', async () => {
  const reply = await run([complete, move({_calendar_verification:'unavailable',meetingId:'event-5'})]);
  assert.match(reply, /some.*times.*confirmed/i);
  assert.match(reply, /couldn't confirm whether/i);
  assert.doesNotMatch(reply, /the requested meeting times are confirmed/i);
});
for (const [lang, text, expected] of [
  ['he','אפשר לקבוע את הפגישה?',/קבעתי/],
  ['ru','Назначь встречу',/назначила/i],
  ['ar','احجزي الاجتماع',/حجزت/],
  ['en','Book the meeting',/booked the meeting/i],
]) test('read-and-book-'+lang, async () => {
  const reply = await run([read('get_work_schedule_overrides',{overrides:[]}),read('create_meeting',{ok:true,meetingId:'created-1'})],{text});
  assert.match(reply,expected);
});
test('independent-work-stays-visible', async () => {
  const reply = await run([move(booked), msg('Dana',held)]);
  assert.match(reply, /moved the meeting/);
  assert.match(reply, /scheduled the message/);
});