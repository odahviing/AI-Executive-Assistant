#!/usr/bin/env node
// Second verification of the timezone fix: stress-test with multiple meeting
// times on the owner's real calendar. Confirms blocks in both directions
// (11:00 meeting AND afternoon meetings) — addressing the concern that the
// fix might have masked one bug while creating another.

import dotenv from 'dotenv';
dotenv.config({ override: true });
import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DateTime } from 'luxon';

const profile = yaml.load(readFileSync(resolve(process.cwd(), 'config', 'users', 'idan.yaml'), 'utf-8'));
const { getFreeBusy, getCalendarEvents } = await import('../dist/connectors/graph/calendar.js');

const tz = profile.user.timezone;
const email = profile.user.email;
const date = '2026-04-26';

// Pull events + raw free/busy for the whole day
console.log(`=== Calendar events for ${date} ===`);
const events = await getCalendarEvents(email, date, date, tz);
for (const ev of events) {
  const startLocal = ev.start?.dateTime ? DateTime.fromISO(ev.start.dateTime, { zone: ev.start.timeZone }).toFormat('HH:mm') : '?';
  const endLocal = ev.end?.dateTime ? DateTime.fromISO(ev.end.dateTime, { zone: ev.end.timeZone }).toFormat('HH:mm') : '?';
  console.log(`  ${startLocal}-${endLocal} ${ev.showAs.padEnd(7)} ${ev.subject}`);
}

console.log();
console.log(`=== getFreeBusy raw response (UTC) ===`);
const busy = await getFreeBusy(email, [email], `${date}T00:00`, `${date}T23:59`, tz);
for (const slot of busy[email] ?? []) {
  const startUtc = DateTime.fromISO(slot.start, { zone: 'utc' }).toFormat('HH:mm \'UTC\'');
  const endUtc = DateTime.fromISO(slot.end, { zone: 'utc' }).toFormat('HH:mm \'UTC\'');
  const startLocal = DateTime.fromISO(slot.start, { zone: 'utc' }).setZone(tz).toFormat('HH:mm');
  const endLocal = DateTime.fromISO(slot.end, { zone: 'utc' }).setZone(tz).toFormat('HH:mm');
  const startLocalShort = DateTime.fromISO(slot.start, { zone: 'utc' }).setZone(tz).toFormat('dd HH:mm');
  const endLocalShort = DateTime.fromISO(slot.end, { zone: 'utc' }).setZone(tz).toFormat('dd HH:mm');
  console.log(`  ${startUtc}-${endUtc}  =  ${startLocalShort}-${endLocalShort} local  status=${slot.status}`);
}

// Key checks
console.log();
console.log(`=== findAvailableSlots sanity checks ===`);

async function check(label, searchFromLocal, searchToLocal, shouldBeAvailable, shouldBeBlocked) {
  const { findAvailableSlots } = await import('../dist/connectors/graph/calendar.js');
  const slots = await findAvailableSlots({
    userEmail: email,
    timezone: tz,
    durationMinutes: 40,
    attendeeEmails: [],
    searchFrom: DateTime.fromISO(`${date}T${searchFromLocal}`, { zone: tz }).toISO(),
    searchTo: DateTime.fromISO(`${date}T${searchToLocal}`, { zone: tz }).toISO(),
    profile,
    autoExpand: false,
  });
  const availableLocal = slots.map(s => DateTime.fromISO(s.start).setZone(tz).toFormat('HH:mm'));
  console.log(`\n[${label}] window ${searchFromLocal}-${searchToLocal}`);
  console.log(`  returned slots: ${availableLocal.join(', ') || '(none)'}`);

  let ok = true;
  for (const t of shouldBeAvailable) {
    if (!availableLocal.includes(t)) {
      console.log(`  ❌ expected ${t} to be available, but it was blocked`);
      ok = false;
    }
  }
  for (const t of shouldBeBlocked) {
    if (availableLocal.includes(t)) {
      console.log(`  ❌ expected ${t} to be BLOCKED, but it was returned as available`);
      ok = false;
    }
  }
  if (ok) console.log(`  ✅ all expectations met`);
  return ok;
}

// 1. Morning: 11:00 meeting should block 11:00 and nearby.
//    10:15+40m=10:55 (ok before the 11:00 meeting). 10:30+40m=11:10 (conflicts).
await check('Morning vs 11:00-12:00 meeting', '09:00', '13:00', ['10:00', '10:15'], ['11:00', '10:30']);

// 2. Afternoon: home day ends 15:30, plus 15:30+ is "Donnie Time" block.
//    So 15:00 slots fine (before work-hours cutoff is 15:30), but 15:30+ blocked.
//    Since 40min slots starting at 14:45 would run into Donnie Time, expect those blocked too.
await check('Afternoon vs 15:30-21:00 Donnie block', '13:00', '17:00', [], ['15:30', '16:00', '16:30']);
