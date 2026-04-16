// One-shot cleanup (v1.6.8): strip operational interaction types from every
// people_memory.interaction_log.
//
// Background: before v1.6.8, `message_colleague` and `initiateCoordination`
// wrote entries to a person's interaction_log like "Sent message on behalf
// of Idan: '...'" and "Coordinating 'Plans and Onboarding' with Idan".
// Those entries persist forever — so the LLM re-surfaces old coord subjects
// and message content long after the underlying job is cancelled, e.g. the
// "Plans and Onboarding" hallucination after a full purge.
//
// From v1.6.8 onward:
//   - We stopped writing operational types (code change, coord.ts + outreach.ts)
//   - The prompt builder filters these types out at read time (people.ts)
//
// This script is the DB side — it prunes existing rows so they don't sit
// there costing tokens and confusing future reasoning.
//
// Dropped types: message_sent, message_received, coordination, meeting_booked,
// conversation. Kept types: social_chat, other.
//
// Prints preview, then commits in a transaction. Safe to re-run; idempotent.
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(__dirname, '..', 'data', 'maelle.db');
const db = new Database(dbPath);

console.log(`DB: ${dbPath}\n`);

const OPERATIONAL_TYPES = new Set([
  'message_sent', 'message_received', 'coordination', 'meeting_booked', 'conversation',
]);

const rows = db.prepare(
  `SELECT slack_id, name, interaction_log FROM people_memory`
).all();

let touched = 0;
let entriesRemoved = 0;
const updates = [];
for (const r of rows) {
  let log;
  try { log = JSON.parse(r.interaction_log || '[]'); }
  catch { log = []; }
  if (!Array.isArray(log) || log.length === 0) continue;
  const cleaned = log.filter(e => !OPERATIONAL_TYPES.has(e.type));
  const removed = log.length - cleaned.length;
  if (removed === 0) continue;
  touched++;
  entriesRemoved += removed;
  updates.push({ slack_id: r.slack_id, name: r.name, cleaned: JSON.stringify(cleaned), removed, kept: cleaned.length });
  console.log(`- ${r.name ?? r.slack_id} (${r.slack_id}): removing ${removed} operational entries, keeping ${cleaned.length} relational`);
}

if (touched === 0) {
  console.log('\nNothing to clean. Every interaction_log is already relational-only.');
  db.close();
  process.exit(0);
}

console.log(`\n${touched} rows touched, ${entriesRemoved} entries removed in total.`);

const tx = db.transaction(() => {
  const stmt = db.prepare(
    `UPDATE people_memory SET interaction_log = @cleaned, updated_at = datetime('now') WHERE slack_id = @slack_id`
  );
  for (const u of updates) stmt.run({ slack_id: u.slack_id, cleaned: u.cleaned });
});
tx();
db.close();
console.log('Done. Restart Maelle if it was running.');
