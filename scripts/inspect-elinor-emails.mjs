#!/usr/bin/env node
// 124h verification: (1) actual attendee addresses on the booked Elinor
// biweekly, (2) which of the three candidate addresses Graph free/busy
// actually resolves. Read-only.
import dotenv from 'dotenv';
dotenv.config({ override: true });
import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const profile = yaml.load(readFileSync(resolve(process.cwd(), 'config', 'users', 'idan.yaml'), 'utf-8'));
const { getCalendarEvents, getFreeBusy } = await import('../dist/connectors/graph/calendar.js');

const email = profile.user.email;
const tz = profile.user.timezone;

const events = await getCalendarEvents(email, '2026-06-15', '2026-06-15', tz);
for (const ev of events) {
  if (!/elinor/i.test(ev.subject ?? '')) continue;
  console.log(`EVENT: ${ev.subject} @ ${ev.start?.dateTime}`);
  console.log(`  organizer: ${JSON.stringify(ev.organizer?.emailAddress ?? null)}`);
  for (const a of ev.attendees ?? []) {
    console.log(`  attendee: ${a?.emailAddress?.address} (${a?.emailAddress?.name ?? '?'}) status=${a?.status?.response ?? '?'}`);
  }
}

const candidates = ['elinor.a@reflectiz.com', 'elinor.avny@reflectiz.com', 'elinor@reflectiz.com'];
for (const c of candidates) {
  try {
    const fb = await getFreeBusy(email, [c], '2026-06-15', '2026-06-16', tz);
    const slots = fb[c] ?? fb[c.toLowerCase()] ?? null;
    console.log(`FREEBUSY ${c}: ${slots === null ? 'NO DATA RETURNED (address did not resolve)' : slots.length + ' intervals'}`);
    if (Array.isArray(slots)) {
      for (const s of slots.slice(0, 6)) console.log(`    ${s.status} ${s.start} → ${s.end}`);
    }
  } catch (err) {
    console.log(`FREEBUSY ${c}: THREW ${String(err).slice(0, 120)}`);
  }
}
