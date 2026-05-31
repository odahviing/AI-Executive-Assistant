#!/usr/bin/env node
/**
 * One-off: load specific external people the owner picked from the suggestion
 * list, mirroring what the live recordBooking path produces (person row +
 * meeting_booked interaction + md "What we've discussed"). Idempotent on email.
 *
 * Run once:  node scripts/load-suggested-people.cjs
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, '..', 'data', 'maelle.db');
const PEOPLE_DIR = path.resolve(__dirname, '..', 'config', 'users', 'idan_people');
const db = new Database(DB_PATH);

const PEOPLE = [
  {
    name: 'Max Attias',
    email: 'max.attias@gmail.com',
    summary: 'Booked "Outside Meeting - Dana Matsliah & Max Attias" at Nono & Mimi, Khayim Barlev St 2, Ness Ziona for Thu 4 Jun 10:00',
    date: '2026-06-04',
  },
  {
    name: 'Natan Amid',
    email: 'natanamid@gmail.com',
    summary: 'Booked "עידן ארי נתן - מודיעין" for Tue 26 May',
    date: '2026-05-26',
  },
];

function newPersonId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const SECTION_TEMPLATE = [
  '## Residence', '', '## Workplace', '', '## Working hours', '',
  '## Communication style', '', "## What we've discussed", '',
].join('\n');

const nowIso = new Date().toISOString();
let created = 0;

for (const p of PEOPLE) {
  const existing = db.prepare(`SELECT person_id FROM people_memory WHERE lower(email) = lower(?)`).get(p.email);
  if (existing) { console.log(`skip (exists): ${p.name}`); continue; }

  const personId = newPersonId();
  const interactionLog = JSON.stringify([{ date: nowIso, type: 'meeting_booked', summary: p.summary }]);
  db.prepare(`
    INSERT INTO people_memory (person_id, slack_id, email, kind, source, name, gender, interaction_log)
    VALUES (?, NULL, ?, 'external', 'calendar', ?, 'unknown', ?)
  `).run(personId, p.email, p.name, interactionLog);

  // md mirror
  try {
    if (!fs.existsSync(PEOPLE_DIR)) fs.mkdirSync(PEOPLE_DIR, { recursive: true });
    const body = `# ${p.name}\n\n${SECTION_TEMPLATE}`.replace(
      /(## What we've discussed\n)/,
      `$1\n- [${p.date}] ${p.summary}\n`,
    );
    fs.writeFileSync(path.join(PEOPLE_DIR, `${personId}.md`), body, 'utf8');
  } catch (e) {
    console.warn(`md write warning for ${p.name}:`, String(e).slice(0, 160));
  }
  console.log(`loaded: ${p.name} (${personId})`);
  created++;
}

console.log(`Done. Created ${created} person(s).`);
db.close();
