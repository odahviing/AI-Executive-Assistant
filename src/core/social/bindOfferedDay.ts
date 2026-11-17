interface Candidate {
  startIso:string;
  endIso:string;
  display:string;
  localDisplays?:string[];
  presentationZone?:string;
}

/** A whole-day hold selects the times actually shown under that date in the
 * delivered offer. Other stashed times on the same day never acquire authority. */
export function bindOfferedDay(value:unknown, candidates:Candidate[], offer:string, message:string):number[]|undefined {
  const choice = value as {request?:string;dayQuote?:string;heading?:string;date?:string;zone?:string;locale?:string;count?:number} | undefined;
  if (!choice || choice.request !== message || !choice.dayQuote?.trim() || !message.includes(choice.dayQuote)
    || !choice.heading?.trim() || !choice.date || !/^\d{4}-\d{2}-\d{2}$/.test(choice.date) || !choice.zone || !choice.locale) return;
  const lines = offer.split(/\r?\n/).map(line=>line.trim());
  const i = lines.indexOf(choice.heading.trim());
  if (i<0 || lines.lastIndexOf(choice.heading.trim())!==i) return;
  const mark = (value:string) => value.normalize('NFKC').toLocaleLowerCase(choice.locale!).match(/[\p{L}\p{N}]+/gu) ?? [];
  try {
    const noon = new Date(choice.date + 'T12:00:00Z');
    const weekday = new Intl.DateTimeFormat(choice.locale,{weekday:'long',timeZone:'UTC'}).format(noon);
    const shortDay = new Intl.DateTimeFormat(choice.locale,{weekday:'short',timeZone:'UTC'}).format(noon);
    // Both the person and the actual heading must name the weekday. Match an
    // entire date word so a fragment cannot anchor the wrong day.
    const names = new Set([...mark(weekday),...mark(shortDay)].filter(word=>word.length>1));
    const other = new Date(noon.getTime()+86400000);
    for (const word of mark(new Intl.DateTimeFormat(choice.locale,{weekday:'long',timeZone:'UTC'}).format(other))) names.delete(word);
    if (!mark(choice.dayQuote).some(w=>names.has(w)) || !mark(lines[i]).some(w=>names.has(w))) return;
    if (lines.some((line,index)=>index!==i && mark(line).some(w=>names.has(w)))) return;
    const day = Number(choice.date.slice(-2));
    if (!mark(lines[i]).some(w=>/^\d{1,2}$/.test(w) && Number(w)===day)) return;
    const list = [lines[i]];
    for (let k=i+1;k<lines.length && /^[\s*•,·\d:\-–—]+$/.test(lines[k]);k++) list.push(lines[k]);
    const clocks = [...list.join(' ').matchAll(/(?<![\d:])(\d{1,2}:\d{2})(?:\s*[–—-]\s*(\d{1,2}:\d{2}))?(?![\d:])/g)];
    if (!clocks.length || (choice.count !== undefined && choice.count !== clocks.length)) return;
    const fmt = new Intl.DateTimeFormat('en-GB',{timeZone:choice.zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
    const selected:number[] = [];
    for (const [,raw,end] of clocks) {
      const clock = raw.padStart(5,'0');
      const label = choice.date + ' ' + clock + ' [' + choice.zone + ']';
      const ids = candidates.flatMap((c,id)=>c.presentationZone === choice.zone && [c.display,...c.localDisplays ?? []].includes(label)
        && (!end || fmt.format(new Date(c.endIso)) === end.padStart(5,'0')) ? [id] : []);
      if (ids.length !== 1 || selected.includes(ids[0])) return;
      selected.push(ids[0]);
    }
    return selected;
  } catch { return; }
}
