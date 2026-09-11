// Reuse the exact existing actual-module/SQLite fixture without registering its
// unrelated tests. Network/model responses alone are fixtures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const filename = path.join(__dirname, 'test-social-lifecycle.cjs');
const box = { require: createRequire(filename), __dirname, process, console };
vm.runInNewContext(fs.readFileSync(filename, 'utf8').split("test('")[0] + '\nglobalThis.harness = harness;', box, { filename });
function setup() {
  const h = box.harness();
  const category = h.subjects.getCategoryByLabel('gaming');
  const add = label => h.subjects.createSubject({ ownerUserId: 'U_OWNER', personSlackId: 'U_PERSON', categoryId: category.id, label, createdBy: 'colleague' });
  h.random(0.1); const pending = add('Pending game');
  h.random(0.2); const other = add('Other game');
  h.db.exec("UPDATE social_subjects SET last_assistant_initiated_at=datetime('now','-2 days'), unanswered_raises=1");
  return { h, pending, other };
}
async function capture(h, decisions) {
  h.capture.responseText = JSON.stringify({ decisions });
  await h.runCapture();
  assert.equal(h.capture.marked, true);
  assert.equal(h.capture.modelCalls, 2, 'existing profile + reconciliation calls only');
  await h.runCapture();
  assert.equal(h.capture.modelCalls, 2, 'no retry');
  h.pick('U_PERSON');
}
for (const action of ['reject', 'match']) test(`unusable ${action} IDs preserve UNKNOWN through capture and picker`, async () => {
  for (const subject_id of ['hallucinated-id', '', '   ', null, 42, [], {}]) {
    const { h, pending } = setup();
    try {
      await capture(h, [{ action, category: 'gaming', subject_id }]);
      assert.ok(h.people.getPersonMemory('U_PERSON').last_social_capture_unknown_at, JSON.stringify(subject_id));
      const stored = h.subjects.getSubjectById(pending.id);
      assert.equal(stored.status, 'live');
      assert.equal(stored.unanswered_raises, 1);
    } finally { h.db.close(); }
  }
});
test('valid explicit rejection kills its shown subject immediately without UNKNOWN', async () => {
  const { h, pending } = setup();
  try {
    h.db.prepare('UPDATE social_subjects SET unanswered_raises=0 WHERE id=?').run(pending.id);
    await capture(h, [{ action: 'reject', subject_id: pending.id }]);
    assert.equal(h.subjects.getSubjectById(pending.id).status, 'dead');
    assert.equal(h.subjects.getSubjectById(pending.id).last_assistant_initiated_at, null);
    assert.equal(h.people.getPersonMemory('U_PERSON').last_social_capture_unknown_at, null);
  } finally { h.db.close(); }
});
test('valid idless work rejection preserves genuine repeated silence', async () => {
  const { h, pending } = setup();
  try {
    await capture(h, [{ action: 'reject' }]);
    assert.equal(h.people.getPersonMemory('U_PERSON').last_social_capture_unknown_at, null);
    assert.equal(h.subjects.getSubjectById(pending.id).status, 'dead');
  } finally { h.db.close(); }
});
test('mixed invalid and valid rejection decisions preserve uncertainty and the real rejection in either order', async () => {
  for (const reverse of [false, true]) {
    const { h, pending, other } = setup();
    try {
      const decisions = [{ action: 'reject', subject_id: 'hallucinated-id' }, { action: 'reject', subject_id: other.id }];
      await capture(h, reverse ? decisions.reverse() : decisions);
      assert.ok(h.people.getPersonMemory('U_PERSON').last_social_capture_unknown_at);
      assert.equal(h.subjects.getSubjectById(pending.id).status, 'live');
      assert.equal(h.subjects.getSubjectById(other.id).status, 'dead');
    } finally { h.db.close(); }
  }
});
test('mixed invalid rejection and real match resolve only the observed subject', async () => {
  const { h, pending, other } = setup();
  try {
    // The feedback contract resolves the most recent raise. Avoid a tied
    // timestamp leaving SQLite free to choose either subject in this control.
    h.db.prepare("UPDATE social_subjects SET last_assistant_initiated_at=datetime('now','-1 day') WHERE id=?").run(other.id);
    await capture(h, [{ action: 'reject', subject_id: 'hallucinated-id' }, { action: 'match', subject_id: other.id, category: 'gaming', sentiment: 'positive' }]);
    assert.ok(h.people.getPersonMemory('U_PERSON').last_social_capture_unknown_at);
    assert.equal(h.subjects.getSubjectById(pending.id).status, 'live');
    assert.equal(h.subjects.getSubjectById(pending.id).unanswered_raises, 1);
    assert.equal(h.subjects.getSubjectById(other.id).last_assistant_initiated_at, null);
  } finally { h.db.close(); }
});
