// Structural/output contract for the three find_available_slots narration keys.
// It proves the tool payload wording, not downstream model obedience.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const rel = 'src/skills/meetings/ops/handlers/findAvailableSlots.ts';
const sourceRoot = process.env.INSTRUCTOR_SLOT_NARRATION_SNAPSHOT
  ? path.join(root, process.env.INSTRUCTOR_SLOT_NARRATION_SNAPSHOT)
  : root;
const source = fs.readFileSync(path.join(sourceRoot, rel), 'utf8');
const tree = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true);
const values = new Map();
function walk(node) {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && ['_attendee_conflicts_note', '_no_all_attendee_free_note', '_attendee_unverified_note'].includes(node.left.name.text)) {
    values.set(node.left.name.text, node.right.getText(tree));
  }
  ts.forEachChild(node, walk);
}
walk(tree);
for (const key of ['_attendee_conflicts_note', '_no_all_attendee_free_note', '_attendee_unverified_note']) {
  assert.ok(values.has(key), `missing ${key}`);
}

test('general conflict note describes attached facts without claiming blanket override or off-hours', () => {
  const text = values.get('_attendee_conflicts_note');
  assert.doesNotMatch(text, /searched with override|slots where an attendee is busy or outside their working hours/);
  assert.match(text, /Describe only the attached conflicts/);
});

test('owner fallback scopes accepted-zero evidence to this search instead of an entire day', () => {
  const text = values.get('_no_all_attendee_free_note');
  assert.doesNotMatch(text, /unavailable the ENTIRE day|busy all day/);
  assert.match(text, /no sampled candidate survived this search and its constraints/);
});

test('colleague fallback keeps attendee hours hard and missing calendar status unconfirmed', () => {
  const text = values.get('_attendee_unverified_note');
  assert.doesNotMatch(text, /reason:'off_hours'/);
  assert.match(text, /screened inside each attendee's stored or assumed working hours/);
  assert.match(text, /missing\/unknown status/);
});

test('per-slot quote-line and missing-calendar honesty remain present', () => {
  assert.match(values.get('_attendee_conflicts_note'), /line.*VERBATIM/s);
  assert.match(values.get('_no_all_attendee_free_note'), /line.*verbatim/s);
  assert.match(values.get('_attendee_unverified_note'), /could not confirm/);
});
