#!/usr/bin/env node
// Debug: what does Graph's free/busy say for Idan on Sun 26 Apr 10:00-12:00 local?
// (The slot Maelle offered was Sun 26 Apr 11:00 Israel time.)

import dotenv from 'dotenv';
dotenv.config({ override: true });
import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const profile = yaml.load(readFileSync(resolve(process.cwd(), 'config', 'users', 'idan.yaml'), 'utf-8'));

const { getFreeBusy, getCalendarEvents } = await import('../dist/connectors/graph/calendar.js');

const email = profile.user.email;
const tz = profile.user.timezone;
console.log(`Owner: ${email}, tz: ${tz}`);
console.log();

const date = '2026-04-26';
console.log(`=== getFreeBusy for ${email} on ${date} ===`);
try {
  const fb = await getFreeBusy(email, [email], `${date}T08:00`, `${date}T14:00`, tz);
  console.log(JSON.stringify(fb, null, 2));
} catch (err) {
  console.error('getFreeBusy err:', String(err));
}

console.log();
console.log(`=== getCalendarEvents for ${email} on ${date} (whole day) ===`);
try {
  const events = await getCalendarEvents(email, date, date, tz);
  for (const ev of events) {
    console.log(JSON.stringify({
      subject: ev.subject,
      start: ev.start,
      end: ev.end,
      showAs: ev.showAs,
      type: ev.type,
      seriesMasterId: ev.seriesMasterId,
      isRecurring: !!ev.recurrence,
    }, null, 2));
  }
  if (events.length === 0) console.log('(no events)');
} catch (err) {
  console.error('getCalendarEvents err:', String(err));
}
