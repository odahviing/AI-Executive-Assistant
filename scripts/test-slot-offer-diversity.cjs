// Actual finder -> spreader with isolated calendar I/O. No production writes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DateTime, Settings } = require('luxon');
const { harness } = require('./test-timezone-owner-interval.cjs');
Settings.now = () => Date.parse('2026-10-01T00:00:00Z');
function fixture(dense = true, busy = []) {
  const h = harness({}, { realDensity: true, extraMocks: {
    'src/connectors/graph/calendarReads.ts': {
      getFreeBusyForDecision: async () => ({ 'owner@example.test': busy }),
      getOwnerEventsForDecision: async () => [], isOutageShaped: () => false, CalendarOfflineError: Error,
    },
  } });
  h.profile.user.timezone = 'UTC';
  h.profile.schedule.work_hours = Object.fromEntries(['Monday','Tuesday','Wednesday','Thursday','Friday'].map(d => [d, ['09:00-18:00']]));
  Object.assign(h.profile.meetings, { offered_slot_count: 8, packing_preference: dense ? 'dense' : 'spread', work_hours_per_free_hour: 0 });
  const pick = (slots, duration = 25, count = 8, anchor, mode) => h.load('src/connectors/graph/calendarReads.ts').pickSpreadSlots(slots, 'UTC', count, anchor, duration, mode);
  const search = (from, to, duration = 25) => h.find(from, to, { timezone: 'UTC', durationMinutes: duration });
  return { ...h, pick, search };
}
for (const dense of [true, false]) for (const duration of [25, 55]) {
  test(`${dense ? 'dense' : 'spread'} ${duration}min preserves eight nonoverlapping options on an open day`, async () => {
    const h = fixture(dense), slots = await h.search('2026-10-19T09:00Z', '2026-10-19T18:00Z', duration);
    const picked = h.pick(slots, duration);
    assert.equal(picked.length, 8, JSON.stringify(picked));
    for (let i = 1; i < picked.length; i++) assert.ok(Date.parse(picked[i]) - Date.parse(picked[i - 1]) >= duration * 60000);
  });
}
test('CONTROL eight offers cover all five available days before adding depth', async () => {
  const h = fixture(), slots = await h.search('2026-10-19T09:00Z', '2026-10-23T18:00Z');
  const picked = h.pick(slots);
  assert.equal(picked.length, 8); assert.equal(new Set(picked.map(s => s.slice(0, 10))).size, 5);
});
test('CONTROL constrained interval returns only real nonoverlapping options without widening', async () => {
  const h = fixture(), slots = await h.search('2026-10-19T10:00Z', '2026-10-19T11:00Z');
  const picked = h.pick(slots);
  assert.equal(picked.length, 2);
  assert.ok(picked.every(s => Date.parse(s) >= Date.parse('2026-10-19T10:00Z') && Date.parse(s) + 25 * 60000 <= Date.parse('2026-10-19T11:00Z')));
  assert.equal((await h.search('2026-10-18T10:00Z', '2026-10-18T11:00Z')).length, 0);
});
test('configured smaller budget keeps enough alternatives on the exhaustive requested day', async () => {
  const h = fixture(); h.profile.meetings.offered_slot_count = 3;
  const slots = await h.search('2026-10-19T09:00Z', '2026-10-23T18:00Z');
  const picked = h.pick(slots, 25, 3, '2026-10-21', 'exhaustive');
  assert.equal(picked.length, 3); assert.ok(picked.every(s => s.startsWith('2026-10-21')));
});
test('CONTROL larger configured count retains ten useful choices when the day permits', async () => {
  const h = fixture(false); h.profile.meetings.offered_slot_count = 10;
  const slots = await h.search('2026-10-19T09:00Z', '2026-10-19T18:00Z');
  assert.equal(h.pick(slots, 25, 10).length, 10);
});
test('dense alternatives retain connective choices near fixed bookings and five-day diversity', async () => {
  const busy = Array.from({ length: 5 }, (_, i) => ({ start: `2026-10-${19+i}T12:00:00Z`, end: `2026-10-${19+i}T12:30:00Z`, status: 'busy' }));
  const h = fixture(true, busy), slots = await h.search('2026-10-19T09:00Z', '2026-10-23T18:00Z', 30);
  const picked = h.pick(slots, 30);
  assert.equal(picked.length, 8); assert.equal(new Set(picked.map(s => s.slice(0,10))).size, 5);
  for (let day = 19; day <= 23; day++) assert.ok(picked.some(s => s.startsWith(`2026-10-${day}T11:30`) || s.startsWith(`2026-10-${day}T12:30`)), JSON.stringify(picked));
  assert.ok(picked.some(s => s.includes('T11:30')) && picked.some(s => s.includes('T12:30')), 'both booking edges remain useful');
  assert.ok(picked.every(s => !['11:15', '12:45'].includes(DateTime.fromISO(s).toFormat('HH:mm'))), 'avoid dead gaps when clean alternatives suffice');
});
