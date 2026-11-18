import { DateTime } from 'luxon';
import type { OfferedSlot } from './offeredSlotsStash';

// A bare clock following an actual offer updates its time. This carries
// request context only. It grants neither booking nor outreach authority.
const weekdays = new Set<string>();
for (const locale of ['en', 'he', 'ru', 'ar']) {
  for (let day = 1; day <= 7; day++) {
    const date = DateTime.utc(2024, 1, day).setLocale(locale);
    for (const style of ['cccc', 'ccc']) weekdays.add(date.toFormat(style).toLocaleLowerCase());
  }
}

export function isClockReply(message: string): boolean {
  return clockReply(message)!==undefined;
}

/** The literal clock in a bounded clock-only reply; never a conversion. */
export function clockReply(message:string):string|undefined {
  const clock = /(?<!\d)(?:[01]?\d|2[0-3]):[0-5]\d(?!\d)/;
  const match=clock.exec(message);
  if (!match) return;
  const rest = message.replace(clock, '').trim().replace(/^[,\s]+|[,?؟？\s]+$/g, '').toLocaleLowerCase();
  return !rest || weekdays.has(rest) ? match[0].padStart(5,'0') : undefined;
}

// Compare the clocks actually displayed to the clocks of verified offers.
// If both zones explain the reply equally well, keep both readings.
export function displayedOfferZone(text: string, slots: OfferedSlot[], zones: string[]): string | undefined {
  const clocks = [...text.matchAll(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/g)]
    .map(m => m[1].padStart(2, '0') + ':' + m[2]);
  if (!clocks.length) return;
  const matching = [...new Set(zones)].filter(zone => {
    const offered = new Set(slots.map(s => DateTime.fromISO(s.startIso, {zone}).toFormat('HH:mm')));
    return clocks.every(clock => offered.has(clock));
  });
  return matching.length === 1 ? matching[0] : undefined;
}
