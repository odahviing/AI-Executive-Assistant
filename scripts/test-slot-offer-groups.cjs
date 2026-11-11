const assert = require('node:assert/strict');
const { test } = require('node:test');
const { run } = require('./test-garage-recovery-summary.cjs');

test('repeated attendee conflict refers to every original slot once', async () => {
  const { out } = await run({ clean: true, busy: true });
  assert.ok(out.slots.length > 1);
  assert.deepEqual(Array.from(out.shared_attendee_fact_groups[0]), Array.from(out.slots, (_, i) => i + 1));
});

test('clean slots keep individual clocks without conflict groups', async () => {
  const { out } = await run({ clean: true });
  assert.ok((out.slots ?? out).every(slot => slot.start && slot.end));
  assert.equal(out.shared_attendee_fact_groups, undefined);
});
