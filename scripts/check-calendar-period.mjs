#!/usr/bin/env node
// Check Graph calendar events for a given date range.
import dotenv from 'dotenv';
dotenv.config({ override: true });
import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const profile = yaml.load(readFileSync(resolve(process.cwd(), 'config', 'users', 'idan.yaml'), 'utf-8'));
const { getCalendarEvents } = await import('../dist/connectors/graph/calendar.js');

const email = profile.user.email;
const tz = profile.user.timezone;
const args = process.argv.slice(2);
const from = args[0] ?? '2026-04-19';
const to = args[1] ?? '2026-04-19';

const events = await getCalendarEvents(email, from, to, tz);
console.log(`=== ${email} events ${from} → ${to} (${events.length}) ===`);
for (const ev of events) {
  console.log(`  ${ev.start?.dateTime?.slice(0,16) ?? '?'} — ${ev.subject} (showAs=${ev.showAs}, cat=${(ev.categories||[]).join('|') || '—'})`);
}
