#!/usr/bin/env node
// Verify: after the timezone fix, findAvailableSlots for Sun 26 Apr should
// exclude 11:00 Israel (since "Amazia & Idan - Weekly" is on that time).

import dotenv from 'dotenv';
dotenv.config({ override: true });
import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DateTime } from 'luxon';

const profile = yaml.load(readFileSync(resolve(process.cwd(), 'config', 'users', 'idan.yaml'), 'utf-8'));

const { findAvailableSlots } = await import('../dist/connectors/graph/calendar.js');

const tz = profile.user.timezone;
const searchFrom = DateTime.fromISO('2026-04-26T09:00', { zone: tz }).toISO();
const searchTo   = DateTime.fromISO('2026-04-26T14:00', { zone: tz }).toISO();

console.log(`Searching for 40-min slots on Sun 26 Apr, 09:00-14:00 Israel`);
console.log();

const slots = await findAvailableSlots({
  userEmail: profile.user.email,
  timezone: tz,
  durationMinutes: 40,
  attendeeEmails: ['amazia.k@reflectiz.com'],
  searchFrom,
  searchTo,
  profile,
  autoExpand: false,
});

console.log(`Returned ${slots.length} slots:`);
for (const s of slots) {
  const startLocal = DateTime.fromISO(s.start).setZone(tz).toFormat('EEE d MMM HH:mm');
  console.log(`  ${startLocal}  (${s.start})`);
}

// Specifically check: is 11:00 Israel in the results?
const has11 = slots.some(s => {
  const startLocal = DateTime.fromISO(s.start).setZone(tz);
  return startLocal.hour === 11 && startLocal.day === 26;
});
console.log();
console.log(has11 ? '❌ 11:00 STILL PRESENT — fix did not work' : '✅ 11:00 correctly excluded');
