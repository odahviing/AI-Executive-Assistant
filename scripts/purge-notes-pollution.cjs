// One-shot cleanup (v1.6.14): strip operational entries from
// people_memory.notes.
//
// Background: before v1.6.14, every inbound colleague message wrote a
// note like `Sent a message to Maelle: "..."` into that contact's notes
// field. notes is supposed to be RELATIONAL context (who they are, what
// we've learned), not a verbatim message log. Heavy contacts had 50+
// such entries (~5kB each), which then loaded into the system prompt
// FOREVER. Yael's notes alone were ~5kB; Ysrael's ~5.7kB.
//
// From v1.6.14 forward: app.ts no longer writes message text to notes;
// log_event already captures it for the briefing. This script is the DB
// side — strips operational entries from existing rows.
//
// Patterns dropped:
//   - starts with `Sent a message to ` (any name)
//   - starts with `Maelle sent message on behalf of`
//
// All other notes (owner-curated via note_about_person) are preserved.
//
// Prints preview, then commits in a transaction.
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(__dirname, '..', 'data', 'maelle.db');
const db = new Database(dbPath);

console.log(`DB: ${dbPath}\n`);

const POLLUTING_PATTERNS = [
  /^Sent a message to /i,
  /^Maelle sent message on behalf of /i,
];

function isPolluting(noteText) {
  return POLLUTING_PATTERNS.some(p => p.test(String(noteText ?? '')));
}

const rows = db.prepare(
  `SELECT slack_id, name, notes FROM people_memory`
).all();

let touched = 0;
let entriesRemoved = 0;
const updates = [];
for (const r of rows) {
  let notes;
  try { notes = JSON.parse(r.notes || '[]'); }
  catch { notes = []; }
  if (!Array.isArray(notes) || notes.length === 0) continue;
  const cleaned = notes.filter(n => !isPolluting(n.note));
  const removed = notes.length - cleaned.length;
  if (removed === 0) continue;
  touched++;
  entriesRemoved += removed;
  updates.push({ slack_id: r.slack_id, cleaned: JSON.stringify(cleaned) });
  console.log(`- ${r.name ?? r.slack_id}: removing ${removed} operational entries, keeping ${cleaned.length} relational`);
}

if (touched === 0) {
  console.log('\nNothing to clean. Every notes field is already relational-only.');
  db.close();
  process.exit(0);
}

console.log(`\n${touched} rows touched, ${entriesRemoved} entries removed in total.`);

const tx = db.transaction(() => {
  const stmt = db.prepare(
    `UPDATE people_memory SET notes = @cleaned, updated_at = datetime('now') WHERE slack_id = @slack_id`
  );
  for (const u of updates) stmt.run(u);
});
tx();
db.close();
console.log('Done. Restart Maelle if it was running.');
