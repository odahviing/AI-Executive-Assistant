import { DateTime } from 'luxon';

type Locale = 'en' | 'he';
type Status = { email: string; status: string; kind: string };
type Slot = {
  start: string; end: string; attendee_status?: Status[]; less_preferred_label?: string;
  broken_rule_label?: string; broken_rules?: string[]; attendee_conflicts?: unknown[];
  on_hold?: unknown; per_attendee_local?: { local_iso: string }[];
  matches_time_preference?: boolean;
};
interface Display {
  locale: Locale;
  owner: string;
  zoneFor: (start: string) => string;
  singleZoneOptions?: boolean;
  requestedMinutes?: number;
}

// Render only disclosures supported in both languages. A richer tool result
// (e.g. a hold or an assumed-hours conflict) stays with the normal composer.
export function renderOpenTimes(slots: Slot[], display: Display, attendees: string[], viewer: string | null | undefined,
  nameFor: (email: string) => string): string | undefined {
  const { locale, owner, zoneFor } = display;
  const he = locale === 'he';
  if (!slots.length) return;
  const rows: Array<{ day: string; clock: string; instant: number; facts: string[] }> = [];
  const named = new Map<string, string>();
  let minutes: number | undefined;
  for (const slot of slots) {
    if (slot.on_hold || slot.less_preferred_label || slot.broken_rules?.length || slot.broken_rule_label || slot.attendee_conflicts?.length
      || slot.matches_time_preference === false) return;
    const zone = zoneFor(slot.start);
    const start = DateTime.fromISO(slot.start, { zone }).setLocale(locale);
    const end = DateTime.fromISO(slot.end, { zone }).setLocale(locale);
    const length = end.diff(start, 'minutes').minutes;
    if (!Number.isSafeInteger(length) || length < 1 || (minutes !== undefined && minutes !== length)
      || start.offset !== end.offset || !start.hasSame(end, 'day')
      || !display.singleZoneOptions && slot.per_attendee_local?.some(p => DateTime.fromISO(p.local_iso, { setZone: true }).offset !== start.offset)) return;
    minutes = length;
    const statuses = slot.attendee_status ?? [];
    if (attendees.some(email => !statuses.some(entry => entry.email.toLowerCase() === email.toLowerCase()))) return;
    const facts: string[] = [];
    for (const entry of statuses) {
      if (entry.kind === 'internal' && entry.status === 'free') continue;
      const self = !!viewer && entry.email.toLowerCase() === viewer;
      const name = self ? '' : nameFor(entry.email);
      if (!self) {
        if (named.has(name) && named.get(name) !== entry.email.toLowerCase()) return;
        named.set(name, entry.email.toLowerCase());
      }
      const calendar = he ? self ? 'ביומן שלך' : 'ביומן של ' + name : self ? 'your calendar' : name + '’s calendar';
      switch (entry.kind === 'external' ? 'unknown' : entry.status) {
        case 'busy': facts.push(he ? calendar + ' כבר יש פגישה' : calendar + ' shows busy'); break;
        case 'tentative': facts.push(he ? calendar + ' יש פגישה זמנית' : calendar + ' shows tentative'); break;
        case 'oof': facts.push(he ? calendar + ' מסומנת היעדרות' : calendar + ' shows out of office'); break;
        case 'unknown': facts.push(he ? self ? 'לא הצלחתי לבדוק את היומן שלך' : 'לא הצלחתי לבדוק את היומן של ' + name
          : 'I couldn’t check ' + calendar); break;
        default: return;
      }
    }
    rows.push({ day: start.toFormat(he ? 'ccc d.M' : 'ccc d LLL') + ' (' + start.toFormat('ZZZZ') + ')',
      clock: start.toFormat('HH:mm'), instant:start.toMillis(), facts });
  }
  // Selection keeps the scheduling preference ranking. Presentation is
  // chronological, so one day does not reappear across a confusing list.
  // Per-option qualifications stay attached when rows move.
  if (display.singleZoneOptions) {
    // For an ordinary availability question show the actual usable choices.
    // Keep uncertainty when none are confirmed free. Other presentations
    // retain their full ranked results and per-person disclosures.
    const confirmed = rows.filter(row => !row.facts.length);
    if (confirmed.length) rows.splice(0, rows.length, ...confirmed);
  }
  rows.sort((a,b) => a.instant - b.instant);
  const shared = rows[0].facts.filter(fact => rows.every(row => row.facts.includes(fact)));
  const groups: Array<{ day: string; clocks: string[]; caveat: string }> = [];
  for (const row of rows) {
    const caveat = row.facts.filter(fact => !shared.includes(fact)).join(he ? ' וגם ' : ', ');
    const last = groups[groups.length - 1];
    if (last?.day === row.day && last.caveat === caveat) last.clocks.push(row.clock);
    else groups.push({ day: row.day, clocks: [row.clock], caveat });
  }
  const noJointOpening = display.singleZoneOptions && rows.every(row => row.facts.length > 0);
  const lines = [he ? 'ל־' + owner + ' יש חלונות של ' + minutes + ' דקות:' : owner + ' has these ' + minutes + '-minute openings:'];
  if (display.requestedMinutes && display.requestedMinutes !== minutes) {
    lines[0] = he ? `ביקשת ${display.requestedMinutes} דקות. אלה האפשרויות ל־${minutes} דקות ביומן של ${owner}:`
      : `You asked for ${display.requestedMinutes} minutes. Here are ${owner}’s ${minutes}-minute options:`;
  }
  if (noJointOpening) {
    lines[0] = he ? `לא מצאתי חלון משותף מאומת. ל${owner} יש אפשרויות של ${minutes} דקות:`
      : `I couldn’t confirm a shared opening. ${owner} has these ${minutes}-minute options:`;
    if (display.requestedMinutes && display.requestedMinutes !== minutes) {
      lines[0] = (he ? `ביקשת ${display.requestedMinutes} דקות. ` : `You asked for ${display.requestedMinutes} minutes. `) + lines[0];
    }
  }
  groups.forEach((group, index) => lines.push((groups[index - 1]?.day === group.day ? '' : group.day + ' · ')
    + group.clocks.join(', ') + (group.caveat ? ' — ' + group.caveat : '')));
  if (shared.length) lines.push((he ? 'בכל האפשרויות: ' : 'For all of these: ') + shared.join(', ') + '.');
  lines.push(noJointOpening ? he ? 'לבדוק יום אחר, או שאחת השעות בכל זאת מתאימה?' : 'Should I check another day, or could one of these work?'
    : he ? rows.length === 1 ? 'השעה הזאת מתאימה?' : 'איזו שעה מתאימה?' : rows.length === 1 ? 'Does that time work?' : 'Which time works?');
  return lines.join('\n');
}

export function renderUnavailableTime(results: Array<{ start: string; available: boolean; broken_rule?: string;
  broken_rules?: string[]; error?: string }>, display: Display): string | undefined {
  if (results.length !== 1) return;
  const [slot] = results;
  if (slot.available !== false || slot.error || !slot.broken_rule || slot.broken_rules?.some(reason => reason !== slot.broken_rule)) return;
  const { locale, owner, zoneFor } = display;
  const he = locale === 'he';
  const time = DateTime.fromISO(slot.start, { zone: zoneFor(slot.start) }).setLocale(locale);
  if (!time.isValid) return;
  const label = time.toFormat(he ? 'ccc d.M HH:mm ZZZZ' : 'ccc d LLL HH:mm ZZZZ');
  switch (slot.broken_rule) {
    case 'outside_owner_work_hours':
      return he ? label + ' מחוץ לשעות העבודה של ' + owner + '. לפנות אליו כדי לבדוק אם זה בכל זאת אפשרי?'
        : label + ' is outside ' + owner + '’s usual hours. Would you like me to ask about an exception?';
    case 'owner_busy_collision':
      return he ? 'יש ל' + owner + ' פגישה אחרת ב' + label + '. לבדוק שעה אחרת, או לשאול אותו אם אפשר בכל זאת?'
        : owner + ' already has a meeting at ' + label + '. Shall I find another time or ask him about this one?';
    default: return;
  }
}

/** Format an already-visible shared event as an observation, without attributing its creation. */
export function sharedMeetingRead(event: Record<string, unknown>, ownerZone: string, viewerZone: string | undefined, language: string | null, owner: string) {
  const {subject, _localDate: date, _localStartTime: time, _durationMin: minutes} = event;
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 250 || /[\r\n<>]/.test(subject)
      || event.isAllDay !== false || typeof date !== 'string' || typeof time !== 'string'
      || typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes <= 0 || minutes >= 1440) return;
  const start = DateTime.fromISO(date + 'T' + time, {zone:ownerZone});
  if (!start.isValid || start.getPossibleOffsets().length !== 1) return;
  const local = start.setZone(viewerZone || ownerZone);
  if (!local.isValid) return;
  const end = local.plus({minutes});
  if (!local.hasSame(end,'day')) return;
  const clock = local.toFormat('HH:mm') + '–' + end.toFormat('HH:mm');
  const he = language === 'Hebrew';
  if (!he && language && language !== 'English') return;
  const day = local.setLocale(he ? 'he' : 'en').toFormat('ccc d LLL');
  const zone = viewerZone ? (he ? 'לפי השעון שלך' : 'your time') : ownerZone;
  const reply = he
    ? `״${subject}״ מופיעה ביומן של ${owner}, ${day}, ${clock} (${zone}). לא שלחתי זימון חדש.`
    : `“${subject}” is on ${owner}’s calendar for ${day}, ${clock} (${zone}). I didn’t send a new invitation.`;
  return {subject,reply};
}
