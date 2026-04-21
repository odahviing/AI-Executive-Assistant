#!/usr/bin/env node
// One-off: update the Daily calendar health check routine prompt to include
// categories check + remove NO_ISSUES sentinel pattern in favor of empty-reply.
import Database from 'better-sqlite3';

const db = new Database('data/maelle.db');

const newPrompt = `Check my calendar for today.

1. Real issues only: actual overlapping meetings, meetings outside work hours, missing lunch break. Back-to-back internal meetings with no buffer are EXPECTED (do not flag). Lunch connecting directly to the next meeting is EXPECTED (do not flag).

2. Categories: check every meeting today. If any meeting has no category assigned, pick the best fit from my configured categories based on the event's subject, body, and attendees, and set it. Categories list is in my profile — use it as the source of truth.

3. Reporting:
   - If zero issues AND you set zero categories: reply with an empty response (stay silent).
   - If you set any categories, tell me which meeting got which category in one short sentence each, so I can change it if wrong.
   - If there are real issues, describe them briefly in human tone.

No internal flags, no tool names, no status tokens in your reply. Just human text.`;

const res = db.prepare(
  `UPDATE routines SET prompt = ?, updated_at = datetime('now') WHERE id = ?`
).run(newPrompt, 'routine_1775831458531_pc4y');

console.log('rows updated:', res.changes);
const row = db.prepare(
  `SELECT title, substr(prompt, 1, 180) AS preview FROM routines WHERE id = 'routine_1775831458531_pc4y'`
).get();
console.log('routine:', row.title);
console.log('preview:', row.preview);
