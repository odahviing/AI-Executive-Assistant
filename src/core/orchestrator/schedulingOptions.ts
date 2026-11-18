import {DateTime} from 'luxon';

interface Option {
  id: number;
  search: number;
  start: number;
  end: number;
  day: string;
  clock: string;
  minutes: number;
  qualifications: string;
}

// Times passed to the writer are references into actual search responses. The writer
// chooses which options answer each request and explains any attendee constraints.
export function schedulingOptions(results: Array<Record<string, unknown>>, ownerZone: string, isOwner: boolean, requestedZone?:string, includeOwnerOnlyAlternatives=true) {
  const options = new Map<number, Option>();
  const queryOf=(result:Record<string,unknown>)=>result.query && typeof result.query==='object'
    ? result.query as Record<string,unknown> : undefined;
  const hasParticipants=(result:Record<string,unknown>)=>{
    const query=queryOf(result);
    return Array.isArray(query?.attendee_emails) && query.attendee_emails.length>0
      || Array.isArray(result.slots) && result.slots.some(slot=>Array.isArray(slot?.attendees)&&slot.attendees.length>0);
  };
  const sameSearch=(a:Record<string,unknown>,b:Record<string,unknown>)=>{
    const first=queryOf(a),last=queryOf(b);
    return first?.search_from && first.search_to && first.duration_minutes && last
      && ['search_from','search_to','search_window_timezone','duration_minutes','moving_event_ids','category',
        'meeting_mode','time_window_is_hard','requester_is_attending'].every(key=>JSON.stringify(first[key])===JSON.stringify(last[key]));
  };
  const evidence = results.map((result, search) => {
    // A preliminary owner-only search is no longer an offered choice after
    // the same window is checked for the actual participants. Retain the
    // observation, but do not let the writer resurrect its unchecked slots.
    if (result.tool==='find_available_slots' && Array.isArray(result.slots) && !hasParticipants(result)) {
      const latest=results.findIndex((next,index)=>index>search && next.tool==='find_available_slots'
        && !next.error && next.owner_calendar==='checked' && hasParticipants(next) && sameSearch(result,next));
      if (latest>=0) {
        const {slots,...rest}=result;
        return {...rest,superseded_slots:slots,superseded_by_search:latest,
          option_status:'Preliminary owner-only observations; use the later participant-aware search for meeting choices.'};
      }
    }
    // Owner-only recovery is a lead for the meeting search, not a finished
    // alternative when known participants still need checking.
    if (result.tool==='availability_precheck' && !includeOwnerOnlyAlternatives && Array.isArray(result.slots)) {
      const {slots,...rest}=result;
      return {...rest,unchecked_owner_candidates:slots};
    }
    if (!['find_available_slots','availability_precheck'].includes(String(result.tool)) || !Array.isArray(result.slots)) return result;
    const slots = result.slots.map(slot => {
      if (!slot || slot.held || typeof slot.start !== 'string' || typeof slot.end !== 'string') return slot;
      const start = DateTime.fromISO(slot.start, {zone:ownerZone});
      const end = DateTime.fromISO(slot.end, {zone:ownerZone});
      if (!start.isValid || !end.isValid || end <= start) return slot;
      const home = start.setLocale('en').toFormat('ccc d LLL HH:mm ZZZZ');
      const local = typeof slot.presentation_local === 'string' && slot.presentation_local || home;
      const requested = requestedZone ? start.setZone(requestedZone) : undefined;
      const primary = isOwner ? requested?.isValid ? requested.setLocale('en').toFormat('ccc d LLL HH:mm ZZZZ') : home : local;
      // This is the output format of renderClockInZone, not human-entered text.
      const parts = /^(.+) (\d{2}:\d{2}) (\S+)$/.exec(primary);
      if (!parts) return slot;
      const [,,clock,zone] = parts;
      const id = options.size + 1;
      const qualifications = JSON.stringify([slot.reasons,slot.attendees,slot.conflicts,slot.preference,slot.matches_time_preference,end.diff(start,'minutes').minutes]);
      options.set(id,{id,search,start:start.toMillis(),end:end.toMillis(),day:parts[1] + ' (' + zone + ')',clock,minutes:end.diff(start,'minutes').minutes,qualifications});
      return {...slot,option:id,rendered_clock:primary,duration_minutes:end.diff(start,'minutes').minutes};
    });
    return {...result,slots};
  });
  // Separate appointments cannot use overlapping options: the owner attends
  // both. Compute this relationship from instants rather than asking prose to
  // infer whether two starts are back to back.
  for(const result of evidence) if(Array.isArray(result.slots)) for(const slot of result.slots) {
    const choice=options.get(slot?.option);
    if(choice) slot.overlaps_other_options=[...options.values()]
      .filter(other=>other.search!==choice.search && choice.start<other.end && other.start<choice.end).map(other=>other.id);
  }
  return {options,evidence};
}

export function renderSchedulingParts(parts:unknown, options:Map<number,Option>): string | undefined {
  if (!Array.isArray(parts) || !parts.length) return;
  const output:string[] = [];
  const emitted = new Set<number>();
  const dayHeadings = new Set([...options.values()].map(option=>option.day));
  const currentGroups = new Map<string,{index:number;rows:Option[]}>();
  const addText = (text:string|undefined) => {
    const trimmed = text?.trim();
    if (!trimmed || dayHeadings.has(trimmed)) return;
    output.push(trimmed);
    currentGroups.clear();
  };
  for (const part of parts) {
    if (part?.kind === 'options' && (!Array.isArray(part.options) || !part.options.length)) return;
    if (part?.text !== undefined && typeof part.text !== 'string') return;
    if (part?.options === undefined) {
      if (!part?.text?.trim()) return;
      addText(part.text);
      continue;
    }
    if (!Array.isArray(part.options)) return;
    if (!part.options.length) {
      // An optional empty selection is ordinary prose, not a failed whole
      // answer. Rejecting it revived the planner's much longer draft.
      addText(part.text);
      continue;
    }
    const rows:Option[] = [];
    for (const id of new Set<number>(part.options)) {
      const row = options.get(id);
      if (!row || (rows.length && (row.search !== rows[0].search || row.qualifications !== rows[0].qualifications))) return;
      rows.push(row);
    }
    // Calendar qualifications do not include every human constraint (such as
    // a stated vacation day). Render only the selected options; formatting
    // must never introduce another time the writer deliberately left out.
    if (rows.every(row=>emitted.has(row.id))) continue;
    addText(part.text);
    for (const row of rows.sort((a,b)=>a.start-b.start)) {
      if (emitted.has(row.id)) continue;
      emitted.add(row.id);
      const key = JSON.stringify([row.search,row.qualifications,row.day]);
      let group = currentGroups.get(key);
      if (!group) {
        group = {index:output.length,rows:[]};
        currentGroups.set(key,group);
        output.push('');
      }
      group.rows.push(row);
      const clocks = [...new Set(group.rows.sort((a,b)=>a.start-b.start)
        .map(option=>option.clock))];
      output[group.index] = row.day + ' · ' + clocks.join(', ') + ' · ' + row.minutes + ' min';
    }
  }
  return output.length ? output.join('\n') : undefined;
}

/** Interval arithmetic belongs to code, using only the already scoped calendar view. */
export function calendarOverlapEvidence(evidence:Array<Record<string,unknown>>,zone:string) {
  return evidence.map(entry=>{
    if(entry.tool!=='get_calendar'||!Array.isArray(entry.events))return entry;
    const events=entry.events.flatMap(event=>{
      if(event.allDay||event.cancelled||event.status==='free'||!event.date||!event.start||!event.end)return [];
      const start=DateTime.fromISO(event.date+'T'+event.start,{zone});
      if(!start.isValid||start.getPossibleOffsets().length!==1)return [];
      let end=typeof event.durationMinutes==='number' ? start.plus({minutes:event.durationMinutes})
        : DateTime.fromISO(event.date+'T'+event.end,{zone});
      if(end<=start && typeof event.durationMinutes!=='number')end=end.plus({days:1});
      return end.isValid&&end>start?[{event,start:start.toMillis(),end:end.toMillis()}]:[];
    });
    const overlaps=[];
    for(let i=0;i<events.length;i++)for(let j=i+1;j<events.length;j++){
      const a=events[i],b=events[j];
      if(a.start<b.end&&b.start<a.end)overlaps.push({first:a.event.subject,second:b.event.subject,
        date:a.event.date,minutes:(Math.min(a.end,b.end)-Math.max(a.start,b.start))/60000});
    }
    const gaps:Array<{date:string;start:string;end:string;minutes:number}> = [];
    // A shared-invitation view omits the rest of the owner's calendar. Only
    // the authenticated owner's complete read can describe gaps between events.
    if(entry.scope==='owner_calendar') {
      for(const date of new Set(events.map(row=>row.event.date))) {
        if(entry.events.some(event=>event.date===date && event.allDay && !event.cancelled && event.status!=='free')) continue;
        const day=events.filter(row=>row.event.date===date).sort((a,b)=>a.start-b.start);
        let until=day[0]?.end;
        for(const row of day.slice(1)) {
          if(row.start>until) gaps.push({date,start:DateTime.fromMillis(until,{zone}).toISO()!,
            end:DateTime.fromMillis(row.start,{zone}).toISO()!,minutes:(row.start-until)/60000});
          until=Math.max(until,row.end);
        }
      }
    }
    return {...entry,computedOverlaps:overlaps,overlapScope:'Only these timed events overlap among the observed events; adjacent events and gaps are not overlaps. All-day entries are separate.',
      computedGaps:gaps,gapScope:'Gaps between observed timed events only, not validated meeting slots. They exclude neither travel nor policy/attendee constraints. Use the normal slot search for a meeting or hold; no gap before the first or after the last event is inferred.'};
  });
}
