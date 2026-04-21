#!/usr/bin/env node
// Reproduce: find 55-min slots across next week. Owner says "most of the week
// is clear" but Maelle returned Sunday-only options. Trace what the tool
// actually returns.
import dotenv from 'dotenv';
dotenv.config({ override: true });
import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DateTime } from 'luxon';

const profile = yaml.load(readFileSync(resolve(process.cwd(), 'config', 'users', 'idan.yaml'), 'utf-8'));
const { findAvailableSlots, pickSpreadSlots } = await import('../dist/connectors/graph/calendar.js');

const tz = profile.user.timezone;
const email = profile.user.email;
const from = DateTime.fromISO('2026-04-26T00:00', { zone: tz }).toISO();
const to = DateTime.fromISO('2026-05-02T23:59', { zone: tz }).toISO();

console.log(`=== findAvailableSlots, 55min, 26 Apr - 2 May ===`);
const slots = await findAvailableSlots({
  userEmail: email,
  timezone: tz,
  durationMinutes: 55,
  attendeeEmails: [],
  searchFrom: from,
  searchTo: to,
  profile,
  autoExpand: true,
});

console.log(`Raw candidates: ${slots.length}`);
for (const s of slots) {
  const local = DateTime.fromISO(s.start).setZone(tz).toFormat('EEE dd MMM HH:mm');
  console.log(`  ${local}  (${s.day_type ?? '?'})`);
}

console.log();
console.log(`=== pickSpreadSlots output (count=3, the coord default) ===`);
const picked = pickSpreadSlots(slots, tz, 3);
for (const s of picked) {
  const local = DateTime.fromISO(s).setZone(tz).toFormat('EEE dd MMM HH:mm');
  console.log(`  ${local}`);
}
