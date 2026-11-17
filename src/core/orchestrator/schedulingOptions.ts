import {DateTime} from 'luxon';

interface Option {
  id: number;
  search: number;
  start: number;
  day: string;
  clock: string;
  alternate: string;
  qualifications: string;
}

// Times passed to the writer are references into actual search responses. The writer
// chooses which options answer each request and explains any attendee constraints.
export function schedulingOptions(results: Array<Record<string, unknown>>, ownerZone: string, isOwner: boolean) {
  const options = new Map<number, Option>();
  const evidence = results.map((result, search) => {
    if (result.tool !== 'find_available_slots' || !Array.isArray(result.slots)) return result;
    const slots = result.slots.map(slot => {
      if (!slot || slot.held || typeof slot.start !== 'string' || typeof slot.end !== 'string') return slot;
      const start = DateTime.fromISO(slot.start, {zone:ownerZone});
      const end = DateTime.fromISO(slot.end, {zone:ownerZone});
      if (!start.isValid || !end.isValid || end <= start) return slot;
      const home = start.setLocale('en').toFormat('ccc d LLL HH:mm ZZZZ');
      const local = typeof slot.presentation_local === 'string' && slot.presentation_local || home;
      const primary = isOwner ? home : local;
      // This is the output format of renderClockInZone, not human-entered text.
      const parts = /^(.+) (\d{2}:\d{2}) (\S+)$/.exec(primary);
      if (!parts) return slot;
      const [,,clock,zone] = parts;
      let alternate = '';
      if (isOwner && local !== home) alternate = local;
      const id = options.size + 1;
      const qualifications = JSON.stringify([slot.reasons,slot.attendees,slot.preference,end.diff(start,'minutes').minutes]);
      options.set(id,{id,search,start:start.toMillis(),day:parts[1] + ' (' + zone + ')',clock,alternate,qualifications});
      return {...slot,option:id};
    });
    return {...result,slots};
  });
  return {options,evidence};
}

export function renderSchedulingParts(parts:unknown, options:Map<number,Option>): string | undefined {
  if (!Array.isArray(parts) || !parts.length) return;
  const output:string[] = [];
  for (const part of parts) {
    if (typeof part?.text === 'string' && part.text.trim() && part.options === undefined) {
      output.push(part.text.trim());
      continue;
    }
    if (part?.text !== undefined || !Array.isArray(part?.options) || !part.options.length) return;
    const rows:Option[] = [];
    for (const id of new Set<number>(part.options)) {
      const row = options.get(id);
      if (!row || (rows.length && (row.search !== rows[0].search || row.qualifications !== rows[0].qualifications))) return;
      rows.push(row);
    }
    const groups = new Map<string, string[]>();
    for (const row of rows.sort((a,b)=>a.start-b.start)) {
      const clocks = groups.get(row.day) ?? [];
      const value = row.clock + (row.alternate ? ' (' + row.alternate + ')' : '');
      if (!clocks.includes(value)) clocks.push(value);
      groups.set(row.day,clocks);
    }
    for (const [day,clocks] of groups) output.push(day + ' · ' + clocks.join(', '));
  }
  return output.join('\n');
}
