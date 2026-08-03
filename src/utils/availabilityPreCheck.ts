/**
 * Availability pre-check (v2.6.5).
 *
 * Background — colleague-path bug: when Yael asked "is Idan free at 12:30
 * 11.5 or 16:00 11.5?", Sonnet eyeballed `get_calendar` events and answered
 * "✅ 12:30 free, ❌ 16:00 busy". Later when Yael picked 12:30, the booking
 * flow ran `find_available_slots` (rule-aware: applies buffer, focus blocks,
 * work hours, categories) and got 0 candidates. SAME calendar data,
 * DIFFERENT verdict — the eyeball check missed buffer collisions / focus-
 * time conflicts that the rule-aware check catches.
 *
 * Fix: when a colleague-path inbound message contains specific time/date
 * patterns AND an availability-question marker, run `checkSlot` — the SAME
 * validator the booking path runs — deterministically for each (date, time)
 * pair BEFORE Sonnet answers. Inject the rule-aware verdicts into the system
 * prompt for that turn so Sonnet's "free/busy" narration matches what the
 * booking flow will accept — for the calendar and category as they stand AT
 * THIS CHECK. That is not an unconditional promise across elapsed turns (see
 * the closing paragraph of `renderPromptBlock` for the two inputs — the
 * lead-time clock and the category guess — that can still legitimately
 * disagree with a LATER real booking call).
 *
 * Best-effort detector — fails open. If we miss a pattern, current behavior
 * stands (Sonnet eyeballs whatever tool she chooses). When we catch one, we
 * upgrade Sonnet's context with deterministic data.
 */

import { DateTime, IANAZone } from 'luxon';
import type { UserProfile } from '../config/userProfile';
import { getOwnerEventsForDecision } from '../connectors/graph/calendar';
import { renderClockInZone } from './timezoneConvert';
import { bookingLeadTimeHours, checkSlot, type RuleViolationKind } from './scheduleRules';
import { armsHardFloor, forgetHardBlockedSlot, hardBlockClassPhrase, recordHardBlockedSlot } from './availabilityGate';
import { blockedSlotAlternativesBlock } from '../skills/meetings/nearbyAlternatives';
import { getAnthropicClient } from '../llm/client';
import { MODEL_HAIKU } from '../llm/models';
import { logLlmUsage } from './usageLog';
import logger from './logger';

// ── Detection regex ────────────────────────────────────────────────────────

// Time pattern — HH:MM (24-hour, with optional leading zero).
const TIME_PATTERN = /\b(\d{1,2}):(\d{2})\b/g;

// Date pattern — two 1-2 digit components + optional year. Day/month ORDER is
// resolved in extractDates (value-based, then owner-locale tiebreaker) — the
// regex itself is order-agnostic. The hours/minutes pattern collides with the
// d/m pair if the year is missing — guarded by the month<=12 check downstream.
const DATE_PATTERN = /\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/g;

// Language-NEUTRAL question mark (Latin + Hebrew share "?"; Arabic "؟"; CJK
// "？"). Structural signal only — NO language words (G7). It just decides
// whether to spend a Haiku call; the Haiku normalizer below is the real,
// language-agnostic detector and returns empty for non-availability messages.
// (Replaced the old English+Hebrew word regex — a clone-limiting check.)
const QUESTION_MARK = /[?？؟]/;

// v3.1.2 (#116) — TZ-cue trigger. One of the three signals that makes this
// pre-check worth a Haiku call at all. Its job is only to notice that a zone may
// be in play ("12:00 Boston (your 19:00)"); WHICH zone, and the conversion, are
// settled downstream — this pattern never decides a frame. Triggers: 3+ char TZ
// abbreviation, common city/country TZ words, an explicit owner-local
// parenthetical ("(your H:MM)" / "his time" / etc.).
const TZ_CUE_PATTERN = new RegExp(
  [
    // TZ abbreviations (word-bounded)
    '\\b(PST|PDT|EST|EDT|CST|CDT|MST|MDT|AKST|AKDT|HST|HDT|UTC|GMT|BST|CET|CEST|EET|EEST|IST|IDT|JST|KST|AEST|AEDT|ACST|ACDT|AWST|NZST|NZDT|CT|ET|PT|MT)\\b',
    // City/country TZ hints (case-insensitive). Keep this conservative to
    // avoid false positives — only well-known time-anchor words.
    '\\b(Boston|New\\s+York|NYC|Manhattan|Los\\s+Angeles|San\\s+Francisco|Chicago|Denver|Seattle|Atlanta|Miami|Toronto|Vancouver|London|Paris|Berlin|Madrid|Rome|Amsterdam|Dublin|Lisbon|Stockholm|Helsinki|Athens|Istanbul|Moscow|Tel\\s+Aviv|Jerusalem|Dubai|Mumbai|Delhi|Bangalore|Hong\\s+Kong|Singapore|Tokyo|Seoul|Beijing|Shanghai|Sydney|Melbourne|Auckland)\\b',
    // Explicit owner-local parenthetical — "(your 19:00)" / "(Idan\'s 19:00)" / "his time" / "my time"
    '\\(\\s*(your|his|her|their|my)[^)]*\\d{1,2}:\\d{2}',
    '\\b(your|his|her|my)\\s+time\\b',
  ].join('|'),
  'i',
);

/**
 * Drop the machine-written transport envelope from a stored history message: the
 * `<<GROUP DM — … >>` group preamble and the `[THREAD PARTICIPANTS: …]` marker
 * the Slack connector prepends. Both are structured, generated strings (not
 * anything a human typed), so matching them literally is language-independent —
 * the participants' names sit INSIDE the delimiters and are never matched.
 */
function stripTransportEnvelope(text: string): string {
  return text
    .replace(/^<<[\s\S]*?>>\s*/, '')
    .replace(/^\[THREAD PARTICIPANTS:[^\]]*\]\s*/, '')
    .trimStart();
}

interface NormalizedSlot {
  /**
   * The clock time EXACTLY as the colleague wrote it — `YYYY-MM-DDTHH:mm`, no
   * offset, no `Z`. Deliberately NOT an instant: see the M14 note on
   * `normalizeAvailabilitySlotsWithHaiku` below. `wallClockOnly` strips anything
   * past the minutes, so a model that emits an offset anyway cannot smuggle its
   * own arithmetic back in.
   */
  wall_clock: string;
  /**
   * IANA name of the zone the stated clock belongs to, when the colleague named
   * a zone or a place ("16:00 CET" → Europe/Brussels) or stated it in the
   * owner's frame ("your 16:00" → the owner's zone). ABSENT when no zone was
   * named — and absent is not a fallback but a FORK: `resolveFrame` then treats
   * the clock as two candidate instants and both get their own verdict, because
   * the 2026-07-27 tape holds one colleague who meant his own clock and one who
   * meant the owner's. Never the server's zone (M13).
   */
  stated_timezone?: string;
  /**
   * v3.3.7 (#125a) — the meeting length the colleague named, when they named
   * one ("11:00-11:15" → 15, "חצי שעה" → 30, "for 45 min" → 45). Absent when
   * only a start time was given. The verdict snaps it to allowed_durations
   * exactly like create_meeting would, so verdict and booking agree.
   */
  duration_minutes?: number;
  /**
   * v3.6.x — true when the colleague is asking HOW MUCH is free at/from this
   * time ("how much is free there?", "how long do we have?"), not whether a
   * specific slot works. We then probe the largest bookable standard duration
   * from this start instead of a yes/no verdict — so the reply states the real
   * free length (the "said 10 min, actually 25" fabrication).
   */
  gap_query?: boolean;
}

/**
 * v3.1.2 (#116) — Haiku-side EXTRACTION of the slots in a multi-TZ availability
 * message. Extraction only: which clock times were proposed, and in whose frame.
 *
 * Why extraction is needed: the colleague might write "12:00 Boston (your 19:00)
 * or 13:00 Boston (20:00 your)". The cheap regex extracts every HH:MM in sight —
 * both the Boston number AND the parenthesized owner-local number — and tests
 * each as if it were owner-local, producing contradictory verdicts.
 *
 * v4.2.x (M14) — why it returns a WALL CLOCK + a ZONE NAME and not an instant.
 * It used to return `instant_iso`, i.e. the MODEL did the offset arithmetic, and
 * on 2026-07-27 that put this pre-check an hour away from the search on the very
 * same phrase: "16:00 CET" reached `find_available_slots`, which converts in code
 * (`reinterpretClockInZone`, findAvailableSlots.ts:266, Europe/Brussels = CEST
 * = +02:00 in August) and correctly landed on 17:00 owner-local — while a bare
 * "16:00" from the same Brussels colleague reached here and was read as 16:00
 * OWNER-local, one hour off, `owner_busy_collision`, recorded into the hard-block
 * ledger, and the output floor then rewrote an honest draft into a false
 * collision claim (log 2026-07-27 :682 vs :743). Two surfaces answering the same
 * question in two frames IS the bug (M2). So the model now only says WHAT was
 * said and IN WHOSE FRAME; `resolveFrame` + luxon do every conversion, with
 * the same helper semantics every booking tool uses.
 *
 * Falls open: any throw / non-JSON / empty list → caller falls back to the
 * regex path (which applies the same frame rule).
 */
async function normalizeAvailabilitySlotsWithHaiku(
  message: string,
  profile: UserProfile,
  recentThread?: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<{ slots: NormalizedSlot[]; category: string | null }> {
  const anthropic = getAnthropicClient();
  const ownerFirst = profile.user.name.split(' ')[0];
  // v3.7.x — category names the same call can infer from the message, so the
  // verdict's checkSlot enforces the SAME per-day/day-type category rules the
  // search enforces (the "confirmed free, but it's over the interview cap" gap).
  const categoryNames = (profile.categories ?? []).map(c => c.name).filter(Boolean);
  const tz = profile.user.timezone;
  const now = DateTime.now().setZone(tz);
  const today = now.toFormat('yyyy-MM-dd');
  const todayWeekday = now.toFormat('EEEE');
  const ownerOffset = now.toFormat('ZZ');

  // v3.3.7 (#125b) — thread context. The DAY a time refers to often lives in
  // an EARLIER message ("מחר יש לי סינק ב-17:00" … next message: "13:00/13:30
  // לא פנוי?"). Without it, time-only asks fell back to TODAY and the verdict
  // was computed for the wrong day (the false "13:30 works" told to Yael).
  //
  // v4.2.x — strip the transport envelope BEFORE the 400-char cut, or the cut
  // eats the very thing this block exists to carry. A group-DM turn arrives
  // prefixed with the machine-written `<<GROUP DM — participants: … >>` preamble
  // (handlers.ts:663, ~364 chars) and optionally `[THREAD PARTICIPANTS: …]`
  // (handlers.ts:1082) — so on EVERY MPIM follow-up, `slice(0, 400)` returned the
  // preamble and about thirty characters of the human's actual words. Measured on
  // the 2026-07-27 incident: the earlier turn read "Bunnings next week -
  // important call- do you have a pref" and the bullet list holding "Tuesday 11
  // August" was cut off, so "Tuesday or Wednesday?" resolved against nothing and
  // the pre-check queried the CURRENT week (log :208, start 2026-07-26) while the
  // conversation was about 11-13 August. Two verdicts, both for the wrong days.
  // Structural strip of a machine-generated envelope, not natural language — the
  // same shape processMessage.ts:434 already uses for the same preamble (G7).
  const threadBlock = (recentThread ?? [])
    .slice(-4)
    .map(m => `${m.role === 'assistant' ? 'YOU' : 'COLLEAGUE'}: ${stripTransportEnvelope(m.content).slice(0, 400)}`)
    .join('\n');

  const systemPrompt = `You extract the specific time slots a colleague proposed in an availability question. You report WHAT was said and IN WHOSE TIMEZONE. You never convert between timezones — code does that.

OWNER context:
- Name: ${ownerFirst}
- Timezone: ${tz} (current offset ${ownerOffset})
- Today's date: ${today} (${todayWeekday})
${threadBlock ? `\nRECENT THREAD (older → newer; for resolving which DAY the times refer to):\n${threadBlock}\n` : ''}
The colleague is proposing specific meeting times. They may state each slot in their OWN timezone (e.g. "12:00 Boston", "16:00 CET"), in ${ownerFirst}'s ("your 19:00", "16:00 his time"), or with no timezone at all. For each distinct slot they proposed, output the clock time EXACTLY AS WRITTEN plus the IANA name of the timezone that clock belongs to.

RULES:
- One entry per slot the colleague actually proposed (not one per number in the message).
- NEVER convert a time between timezones and NEVER compute an offset. Copy the stated clock into \`wall_clock\` as "YYYY-MM-DDTHH:MM" — no offset, no "Z", no shifting. If you find yourself doing arithmetic, you are doing the wrong job.
- \`stated_timezone\` = the IANA zone the stated clock belongs to. Map the abbreviation or place the colleague used to its IANA zone ("CET"/"CEST" → Europe/Brussels, "ET"/"EST"/"EDT" → America/New_York, "Boston" → America/New_York, "London"/"BST" → Europe/London, "IST"/"IDT"/"Israel" → Asia/Jerusalem). When they stated the time in ${ownerFirst}'s own frame ("your 19:00", "his time"), use ${tz}.
- OMIT \`stated_timezone\` entirely when the current message names no timezone and no place for that slot — even if an EARLIER message did. Do NOT guess one and do NOT copy one over from the thread: code reads a zone-less clock in the colleague's own zone, which is what they meant.
- When the message gives both a foreign time AND an explicit ${ownerFirst}-local pair for the SAME slot ("12:00 Boston (your 19:00)"), output the ${ownerFirst}-local clock with stated_timezone=${tz} — it's the most reliable anchor.
- When the colleague named a meeting LENGTH — a range ("11:00-11:15" → start 11:00, duration_minutes 15) or an explicit duration ("for 20 min", "חצי שעה" → 30) — include duration_minutes. Omit it when only a start time was given.
- When the colleague is asking HOW MUCH time is free — the SIZE of a gap ("how much is free there?", "how long do we have then?", "how big is that window?") — rather than whether a specific slot works, set gap_query=true and use the START of the window/slot they mean (resolve "there"/"then" from the RECENT THREAD). Omit gap_query for a normal "does X work?" ask.
- Resolve relative day words in ANY language — "tomorrow"/"מחר", weekday names ("Tuesday"/"ביום שלישי"), "next week" — against today's date above.
- When a time carries NO day in the current message, use the day under discussion in the RECENT THREAD (e.g. the colleague said "tomorrow at 17:00" a message earlier, then asks "13:00/13:30?" — those are TOMORROW). Only when no day reference exists anywhere, assume today.
- If the message contains no specific slot proposals, return an empty list.
${categoryNames.length > 0 ? `- Also set \`category\` to the meeting's TYPE when the message makes it clear — the single best match from: ${categoryNames.join(', ')}. E.g. an external candidate / "interview" / "candidate" → the interview category. Omit when the type is unclear or it's not one of these.` : ''}

Output EXACTLY ONE call to normalize_slots.`;

  try {
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 350,
      system: systemPrompt,
      tools: [{
        name: 'normalize_slots',
        description: 'Report each slot the colleague proposed: the clock time exactly as written, plus the IANA timezone that clock belongs to. Never convert.',
        input_schema: {
          type: 'object' as const,
          properties: {
            slots: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  wall_clock: { type: 'string', description: 'The stated clock time, copied verbatim, as "YYYY-MM-DDTHH:MM". NO offset, NO "Z", never shifted.' },
                  stated_timezone: { type: 'string', description: 'IANA zone the stated clock belongs to, e.g. "Europe/Brussels" for "16:00 CET". OMIT when the message names no timezone and no place for this slot.' },
                  duration_minutes: { type: 'number', description: 'Meeting length in minutes, ONLY when the colleague named one (a range like 11:00-11:15, or "for 20 min"). Omit otherwise.' },
                  gap_query: { type: 'boolean', description: 'true when the colleague asks HOW MUCH time is free at/from this start ("how much is free there?"), not whether a specific slot works. Omit/false otherwise.' },
                },
                required: ['wall_clock'],
              },
            },
            category: { type: 'string', description: 'The meeting TYPE if identifiable from the message, matching one of the owner\'s category names given above (e.g. "Interview"). Omit when unclear.' },
          },
          required: ['slots'],
        },
      }],
      tool_choice: { type: 'tool', name: 'normalize_slots' },
      messages: [{ role: 'user', content: message.slice(0, 4000) }],
    });
    logLlmUsage('availability_tz_normalize', MODEL_HAIKU, resp);
    const toolUse = resp.content.find((b: any) => b.type === 'tool_use') as any;
    const raw = toolUse?.input as { slots?: Array<{ wall_clock?: string; stated_timezone?: string; duration_minutes?: number; gap_query?: boolean }>; category?: string } | undefined;
    const out: NormalizedSlot[] = [];
    for (const entry of raw?.slots ?? []) {
      if (typeof entry?.wall_clock !== 'string') continue;
      const wall = wallClockOnly(entry.wall_clock);
      if (!wall) continue;
      const dur = typeof entry.duration_minutes === 'number' && entry.duration_minutes >= 5 && entry.duration_minutes <= 480
        ? entry.duration_minutes
        : undefined;
      // A zone name is only carried through when `canonicalZone` recognises it. A
      // hallucinated one ("Europe/Bruxelles", "PST") is dropped, which falls the
      // slot back to the requester's own zone — usually the very zone he was
      // abbreviating — rather than to a wrong frame.
      const zone = typeof entry.stated_timezone === 'string'
        ? canonicalZone(entry.stated_timezone)
        : undefined;
      out.push({
        wall_clock: wall,
        ...(zone ? { stated_timezone: zone } : {}),
        ...(dur ? { duration_minutes: dur } : {}),
        ...(entry.gap_query === true ? { gap_query: true } : {}),
      });
    }
    // Validate the category against the owner's real category names — a
    // hallucinated one would silently misfire the cap. Unmatched → null.
    const category = (typeof raw?.category === 'string' && categoryNames.includes(raw.category))
      ? raw.category
      : null;
    return { slots: out, category };
  } catch (err) {
    logger.warn('availabilityPreCheck — Haiku normalize threw, falling back to regex', {
      err: String(err).slice(0, 200),
    });
    return { slots: [], category: null };
  }
}

// ── The frame a stated clock is read in ─────────────────────────────────────

/**
 * Keep only the wall-clock head of an ISO-ish string: `YYYY-MM-DDTHH:MM`.
 *
 * The whole point of the M14 split above is that the model must not do timezone
 * arithmetic — so an offset it emits anyway (habit, or a "helpful" conversion)
 * must not survive into the parse, or the frame this file chose would be silently
 * overridden by the model's. Structured ISO only; no natural language is matched
 * here (G7). Returns null when there is no parseable date+time head.
 */
const WALL_CLOCK_HEAD = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})/;
function wallClockOnly(raw: string): string | null {
  const m = WALL_CLOCK_HEAD.exec(raw.trim());
  if (!m) return null;
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (hour > 23 || minute > 59) return null;
  return `${m[1]}T${String(hour).padStart(2, '0')}:${m[3]}`;
}

/**
 * A handful of IANA identifiers ARE bare abbreviations, and three of them are
 * FIXED-offset zones that never observe DST: `EST` (-05:00), `MST` (-07:00),
 * `HST` (-10:00). So a model that answers "EST" where it meant America/New_York
 * passes `isValidZone` and then lands an hour off for eight months of the year —
 * M14's most-repeated bug class arriving through the one door code still leaves
 * open. Mapped to the real region zones here, before anything converts.
 * (`CET`/`EET`/`MET`/`WET` are bare IANA names too but DO carry the EU DST rules,
 * so they need no mapping; `UTC`/`GMT` are fixed on purpose.) A closed map over
 * IANA identifiers — no natural language is matched (G7).
 */
const LEGACY_FIXED_OFFSET_ZONES: Record<string, string> = {
  EST: 'America/New_York',
  EST5EDT: 'America/New_York',
  CST6CDT: 'America/Chicago',
  MST: 'America/Denver',
  MST7MDT: 'America/Denver',
  PST8PDT: 'America/Los_Angeles',
  HST: 'Pacific/Honolulu',
};

/** The zone name to actually convert with, or undefined when it isn't one. */
function canonicalZone(raw: string): string | undefined {
  const z = raw.trim();
  if (!z) return undefined;
  const mapped = LEGACY_FIXED_OFFSET_ZONES[z.toUpperCase()];
  if (mapped) return mapped;
  return IANAZone.isValidZone(z) ? z : undefined;
}

/**
 * Whose clock is this? — and, when nothing in the message answers that, an honest
 * refusal to pick one silently.
 *
 * A STATED zone settles it: "16:00 CET" is one instant and there is nothing to
 * decide. A BARE clock from someone who does not share the owner's zone is the
 * hard case, and the 2026-07-27 tape holds BOTH conventions:
 *
 *   - Dirk (Europe/Brussels) wrote a bare "16:00" and meant HIS 16:00. This
 *     pre-check read it owner-local, landed an hour off, produced a false
 *     `owner_busy_collision` for 16:00 Israel — the free instant was 17:00, i.e.
 *     16:00 CET (log :776, :782) — recorded it as an established fact, and the
 *     output floor then rewrote an honest "ich halte mir 16:00 CET frei" into a
 *     false collision claim to his face (:743).
 *   - Luke (Australia/Canberra) meant the OWNER's clock. Owner's testimony, and
 *     the thread record shows why: the clock he was answering with was one MAELLE
 *     had offered him in the owner's frame, labelled "(Idan's time)".
 *
 * Two colleagues, opposite conventions, and a bare clock carries no signal that
 * separates them. So neither "his zone" nor "the owner's zone" is a RULE — both
 * are guesses, and a guess that silently becomes an instant is the whole incident.
 * `otherZone` is therefore not a fallback; it is the admission that two readings
 * exist. Both get a real `checkSlot` verdict, the injected block names which clock
 * each one is, and nothing downstream may assert one of them alone.
 *
 * `timezone_set_by` is deliberately NOT consulted, though it was the obvious
 * discriminator: it records how the person's ZONE was established (scraped from
 * their Slack profile vs the owner confirming it), which is a different fact from
 * the CONVENTION they use when writing a bare clock. Luke's Canberra row is
 * correct — reading it is not what got him wrong. And the store holds the
 * counter-example: Shayan Memari is Australia/Canberra with
 * `timezone_set_by:'owner'`, so trusting a CONFIRMED zone more would resolve his
 * bare clock further from the owner's, not closer.
 */
function resolveFrame(
  stated: string | undefined,
  requesterTz: string,
  ownerTz: string,
): { zone: string; otherZone?: string } {
  if (stated && IANAZone.isValidZone(stated)) return { zone: stated };
  // Undecided. The owner's zone LEADS — not because it is likelier, but because
  // every other line in the block, the alternatives search and the ledger are
  // already owner-local, so it is the frame the rest of the turn is expressed in.
  if (requesterTz !== ownerTz && IANAZone.isValidZone(requesterTz)) {
    return { zone: ownerTz, otherZone: requesterTz };
  }
  return { zone: ownerTz };
}

/** A stated wall clock, read in one zone, expressed in the owner's. */
function readClockIn(wall: string, zone: string, ownerTz: string): { date: string; time: string } | null {
  const dt = DateTime.fromISO(wall, { zone }).setZone(ownerTz);
  if (!dt.isValid) return null;
  return { date: dt.toFormat('yyyy-MM-dd'), time: dt.toFormat('HH:mm') };
}

// ── Public API ──────────────────────────────────────────────────────────────

/** One rule-aware answer for ONE exact instant, expressed owner-local. */
interface SlotOutcome {
  date: string;        // YYYY-MM-DD
  time: string;        // HH:MM
  bookable: boolean;
  rejection_reason?: string;
  /**
   * v3.6.x — gap query ("how much is free there?"): maxFreeMinutes is the
   * largest allowed duration that checkSlot passes FROM this exact start.
   * null = every allowed duration was tested and each failed — an ESTABLISHED
   * negative, with `rejection_reason` carrying the smallest duration's kind.
   * A gap pair whose probe never completed pushes no verdict at all, so "null"
   * can never mean "we didn't look".
   */
  maxFreeMinutes?: number | null;
  /**
   * The hard block is an all-day OUT OF OFFICE, not a clash. Both render as
   * `owner_busy_collision`, and "he's booked then" is the wrong sentence for a
   * vacation day: it is a confident wrong reason, and it invites "then what about
   * an hour later", which has the same answer all day. So this bit, not the kind,
   * picks the class phrase and the "offer another DAY" instruction. Read off
   * checkSlot's occupancy, never re-derived.
   */
  outOfOfficeAllDay?: true;
  /**
   * o#189 — the exact meeting length `checkSlot` was run at to reach this
   * verdict: the asked length (snapped to allowed durations) for a normal ask,
   * or the smallest allowed duration for a gap query's "nothing fits" verdict
   * (the last, smallest probe in the descending sweep). Set only alongside
   * `rejection_reason`, so the hard-block ledger can carry the SAME length —
   * the live re-verification refuter (runOutputGates.ts) then re-probes at
   * this length instead of an unconditional smallest-allowed-duration, which
   * would not reproduce a block a longer ask tripped on a tail overlap.
   */
  durationMin?: number;
}

interface SlotVerdict extends SlotOutcome {
  /** The ask was "how MUCH is free from here", not "does this slot work". */
  gapQuery?: boolean;
  /**
   * v4.2.2 — the clock the asker actually wrote (`HH:MM`). Present only alongside
   * `other`, because that is the only place a reply has to quote what they SAID in
   * order to say which of the two readings it answered.
   */
  statedClock?: string;
  /**
   * v4.2.2 — the SECOND reading of a bare clock whose frame is undecided (see
   * `resolveFrame`): the same stated clock read in the ASKER's zone instead of the
   * owner's, with its own independent `checkSlot` verdict.
   *
   * Present ⇒ this pre-check does not know which instant the asker meant, and no
   * consumer may treat the primary reading as the answer. The renderer prints both
   * and requires the reply to name the clock it used; the hard-block ledger arms
   * only when BOTH readings are HARD-blocked (`armsHardFloor` — a hard reading paired
   * with an owner-overridable one is still an undecided frame), so the output floor
   * can never assert a refusal that depends on which frame we guessed.
   */
  other?: SlotOutcome & { zone: string };
}

export interface AvailabilityPreCheckResult {
  /** True when at least one slot was tested. */
  ran: boolean;
  /** Per-slot verdicts for the system prompt block. Empty when ran=false. */
  verdicts: SlotVerdict[];
  /**
   * Pre-rendered prompt block, ready to inject. Empty string when no
   * verdicts to share. Owner reads this in the system prompt before
   * answering.
   */
  promptBlock: string;
}

/**
 * Detect (date, time) pairs in a colleague-path message and run `checkSlot`
 * for each against that week's real events. Returns a result object with
 * verdicts + a pre-rendered prompt block.
 *
 * Fails open: if anything throws, returns `{ ran: false, ... }`. The main
 * orchestrator path is unaffected.
 */
export async function precheckAvailability(params: {
  message: string;
  profile: UserProfile;
  durationMinutes?: number;  // default 25 (from profile.meetings.allowed_durations[1])
  // v3.3.7 (#125b) — last few thread messages so the Haiku normalizer can
  // resolve WHICH DAY a bare time refers to ("מחר" said a message earlier).
  recentThread?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /**
   * v4.2.x — the IANA zone the ASKER writes from (his people-store `timezone`).
   * Its only job is to tell this pre-check whether a bare clock is AMBIGUOUS at
   * all: when the asker shares the owner's zone (or has no stored zone) there is
   * exactly one reading and everything below is byte-identical to before, and when
   * he does not, a zone-less clock has two readings and `resolveFrame` returns
   * both. It is never used to silently re-frame a clock — that was the 4.2.1
   * attempt, and it is wrong in the opposite direction (see `resolveFrame`).
   * Optional and validated: unknown / not a real IANA zone → the owner's zone.
   */
  requesterTimezone?: string;
  // v4.2.x — thread identity, for the alternatives block's offered-slots binding
  // (nearbyAlternatives → recordProposedAlternatives). BOTH optional on purpose:
  // the recorder returns early without a channelId (ops/helpers.ts:89), so a caller
  // that doesn't have one degrades to "alternatives offered, not bound" and nothing
  // throws. No guard here refuses their absence.
  channelId?: string;
  threadTs?: string;
  /**
   * v4.3.x (gh#158) — the turn's resolved-attendee list (buildTurnContext's
   * `resolvedMeetingAttendees`): non-empty ONLY when the message names someone
   * OTHER than the owner (that resolver explicitly excludes the owner's own
   * name). This whole pre-check answers exactly one question — "is the OWNER
   * free at time Y" — by running `checkSlot` against the OWNER's calendar
   * (`eventsForWeek` below always fetches `profile.user.email`). It has no
   * concept of a THIRD PARTY's calendar at all. When the turn names one ("does
   * Levana free tomorrow at 10am?"), this pre-check would still silently
   * answer about the owner's own hours/calendar and inject that as settled
   * ground truth — which is exactly what happened: "outside your usual
   * hours... not a hard conflict" answered a question about Levana with a
   * fact about the owner, and repeated on every re-ask because the wrong-
   * subject verdict was already "confirmed" in context. Bail out here (fail
   * open, per this file's own G6 philosophy) and let the normal tool path
   * (find_available_slots / get_free_busy / check_join_availability) run its
   * real, attendee-aware check on the named person instead.
   */
  namedAttendeeEmails?: string[];
}): Promise<AvailabilityPreCheckResult> {
  const empty: AvailabilityPreCheckResult = { ran: false, verdicts: [], promptBlock: '' };

  if (!params.message || params.message.trim().length === 0) return empty;
  if (params.namedAttendeeEmails && params.namedAttendeeEmails.length > 0) {
    // v4.3.x (gh#158) — the bail above skips this whole pre-check for a turn that
    // names someone OTHER than the owner, but a hard-block ledger entry for the
    // OWNER (recordHardBlockedSlot, written only by this file, on an EARLIER turn
    // that WAS about his own calendar) can still be armed for up to 45 minutes
    // (availabilityGate's TTL_MS). Its only reader, runOutputGates'
    // runAvailabilityFloorAndMaybeRewrite, has no attendee-awareness at all — it
    // fires on every reply and asks Haiku whether THIS draft presents one of the
    // stored INSTANTS as workable. So a reply about a named colleague at the same
    // clock time this turn names would be judged against a fact that was never
    // about them, and rewritten into a false "that doesn't work" about the OWNER's
    // calendar. Forget any stored instant this message ALSO names — cost-free
    // regex extraction, no Haiku spend, no verdict computed — so the floor has
    // nothing stale to fire on for this turn.
    //
    // Pure removal: `recordHardBlockedSlot` is not called here, so this can only
    // make the floor LESS likely to act, never grant, relax or widen anything, and
    // it cannot reach a booking tool either way — the floor's own remedy is a
    // tool-less text rewrite (runOutputGates.ts's `rewriteBlockedSlotClaim` call),
    // never a re-check or a mutation. If a LATER turn really is about the owner at
    // this same instant, its own checkSlot call re-arms the ledger fresh, exactly
    // like every other invalidation rule on it (availabilityGate.ts's ledger doc).
    forgetNamedInstantsFromHardBlockLedger(params.message, params.profile, params.requesterTimezone);
    return empty;
  }

  // Language-NEUTRAL cheap gate (G7 — no language words): spend a Haiku call
  // only when the message carries a schedulable signal — a time, a TZ cue, or a
  // question mark. That's the whole gate; the Haiku normalizer is the real,
  // language-agnostic detector and returns empty for non-availability messages.
  // A miss here → no pre-check → she answers as before (status quo), never a
  // wrong injection (G6).
  const hasSchedulableSignal =
    QUESTION_MARK.test(params.message)
    || TZ_CUE_PATTERN.test(params.message)
    || extractTimes(params.message).length > 0;
  if (!hasSchedulableSignal) return empty;

  const tz = params.profile.user.timezone;
  // The zone a zone-less clock in this message belongs to. Resolved ONCE here and
  // threaded through both extraction paths and the renderer, so the frame that
  // decided the verdict is the same frame the verdict is stated in.
  const requesterTz = params.requesterTimezone && IANAZone.isValidZone(params.requesterTimezone.trim())
    ? params.requesterTimezone.trim()
    : tz;
  const today = DateTime.now().setZone(tz).toFormat('yyyy-MM-dd');
  const durationMinutes = params.durationMinutes ?? params.profile.meetings.allowed_durations[1] ?? 25;

  // v3.1.2 (#116) — multi-TZ path. Haiku reads the message and reports which
  // clock times were proposed and, per slot, which zone the colleague stated them
  // in. Eliminates the dual-extraction bug where regex pulled both the foreign
  // and owner-local numbers and tested each as if it were owner-local.
  // v3.3.7 (#125b) — Haiku is the PRIMARY extraction path whenever the message
  // carries a time at all (was TZ-cue-only). The regex path can't resolve
  // relative day words ("מחר" in a prior message), so it resolved time-only asks
  // to TODAY — the wrong-day "13:30 works" verdict (#125). Regex stays below as
  // the fail-open fallback when Haiku errors/returns empty. Cost-bounded: one
  // Haiku call, only on messages carrying a schedulable signal.
  // v4.2.x (M14) — the CONVERSION is here, not in Haiku. `resolveFrame` decides
  // whose clock a stated time is (or reports that it cannot) and luxon does the
  // arithmetic, so this pre-check and `find_available_slots` cannot land on two
  // different instants for one phrase the way they did on 2026-07-27.
  let pairs: Pair[] = [];
  // v3.7.x — category the normalizer inferred, threaded into checkSlot so the
  // verdict enforces per-day/day-type category caps (matches the search).
  let detectedCategory: string | null = null;
  {
    // The gate above already confirmed a schedulable signal (incl. a bare "?"
    // gap question with no time), so always let the language-agnostic Haiku
    // normalizer read it — it returns empty for non-availability messages.
    const { slots, category } = await normalizeAvailabilitySlotsWithHaiku(params.message, params.profile, params.recentThread);
    detectedCategory = category;
    if (slots.length > 0) {
      const seen = new Set<string>();
      // The frame each slot was resolved in, logged below. Without it the tape
      // showed only the owner-local result, so an hour-off verdict (2026-07-27)
      // was indistinguishable from a correct one — the one thing a log review of
      // this class of bug needs to see.
      const frames: string[] = [];
      for (const slot of slots) {
        const frame = resolveFrame(slot.stated_timezone, requesterTz, tz);
        const primary = readClockIn(slot.wall_clock, frame.zone, tz);
        if (!primary) continue;
        // The second reading exists only when the frame is undecided AND the two
        // zones actually disagree about this instant — two zones on the same offset
        // (or a DST edge that collapses them) produce one instant, so there is
        // nothing ambiguous to report and the slot renders as a settled one.
        const otherRead = frame.otherZone ? readClockIn(slot.wall_clock, frame.otherZone, tz) : null;
        const other = otherRead && frame.otherZone
          && (otherRead.date !== primary.date || otherRead.time !== primary.time)
          ? { ...otherRead, zone: frame.otherZone }
          : null;
        // `wall_clock` is `YYYY-MM-DDTHH:MM` by construction (wallClockOnly), so
        // this is a structured slice, not a locale-dependent format.
        const statedClock = slot.wall_clock.slice(11);
        frames.push(
          `"${statedClock}" ${slot.stated_timezone ? `${frame.zone} (stated)` : 'frame NOT stated'}`
          + ` → ${primary.date}T${primary.time} ${tz}`
          + (other ? ` OR ${other.date}T${other.time} ${tz} (read as ${other.zone})` : ''),
        );
        const key = `${primary.date}T${primary.time}|${other ? `${other.date}T${other.time}` : ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({
          date: primary.date, time: primary.time,
          ...(slot.duration_minutes ? { durationMin: slot.duration_minutes } : {}),
          ...(slot.gap_query ? { gapQuery: true } : {}),
          ...(other ? { other, statedClock } : {}),
        });
      }
      logger.info('availabilityPreCheck — Haiku normalized instants', {
        instant_count: slots.length, pair_count: pairs.length,
        requesterTz, ownerTz: tz, frames,
      });
    }
  }

  // Regex fallback path. Runs when Haiku errored or returned nothing usable.
  if (pairs.length === 0) {
    // Owner locale order for ambiguous DD/MM vs MM/DD (Americas → month-first,
    // everywhere else → day-first) lives inside extractRawPairs — shared with the
    // named-attendee bail's ledger-forget above so the two extractions cannot
    // drift. Heuristic (fails open — the real slot search re-interprets on
    // Sonnet's reading anyway), no new profile field needed.
    pairs = extractRawPairs(params.message, tz, today);
    if (pairs.length === 0) return empty;
    // v4.2.2 — every clock this path can extract is a BARE one (it has no zone
    // signal at all), so the frame is undecided in exactly the sense resolveFrame
    // describes, and it forks the same way. Both earlier versions asserted a single
    // reading and each was wrong for one of the two colleagues on the tape: pre-4.2
    // read owner-local (the Dirk hour-off), 4.2.1 read requester-local (which
    // re-frames a clock Maelle herself offered in the owner's frame — the Luke
    // echo). A colleague in the owner's own zone still gets one reading, so this
    // whole block is a no-op for him.
    const fallbackFrame = resolveFrame(undefined, requesterTz, tz);
    const fallbackOtherZone = fallbackFrame.otherZone;
    if (fallbackOtherZone) {
      pairs = pairs.map(p => {
        const otherRead = readClockIn(`${p.date}T${p.time}`, fallbackOtherZone, tz);
        return otherRead && (otherRead.date !== p.date || otherRead.time !== p.time)
          ? { ...p, other: { ...otherRead, zone: fallbackOtherZone }, statedClock: p.time }
          : p;
      });
      logger.info('availabilityPreCheck — regex fallback: bare clocks, frame undecided; checking both readings', {
        requesterTz, ownerTz: tz,
        pairs: pairs.map(p => `${p.date}T${p.time}${p.other ? ` OR ${p.other.date}T${p.other.time}` : ''}`),
      });
    }
  }

  const verdicts: SlotVerdict[] = [];
  // The durations `checkSlot` ACTUALLY validated, per tested pair — not what
  // anyone asked for. The alternatives search reads the longest of them, so an
  // offered option is at least as long as the meeting that was refused.
  const testedDurations: number[] = [];

  // v3.3.7 (#125a) — verdicts now come from `checkSlot`, the SAME validator
  // the booking path runs on a named time (planMeeting). The previous
  // per-pair narrow findAvailableSlots had two faithfulness holes:
  //   (a) autoExpand silently widened the ±1-min window to a 7-day search;
  //   (b) the focus-time floor computed against WINDOW-scoped busy — a
  //       ~27-min window can't see the rest of the day, so the floor never
  //       fired and a floor-blocked slot read as BOOKABLE... which the
  //       booking flow then refused (the "13:30 works" → walk-back class).
  // checkSlot evaluates against the slot's full WEEK of events (one
  // per-turn-memoized fetch per week), exactly like write-time validation —
  // closing that hole. Two other inputs to the SAME checkSlot still can drift
  // from what a later booking call sees: `within_lead_time`'s clock and the
  // category guessed below (no real subject/body exists yet) — see the
  // closing paragraph of `renderPromptBlock`, which is honest about both.
  //
  // v4.2.x — the GAP branch runs it too; it was the last caller of the
  // narrow-window findAvailableSlots the paragraph above removed, and it had a
  // third hole on top of (a) and (b): `searchFrom === searchTo` is a ZERO-WIDTH
  // window, and the walker's `cursor + durationMs <= searchEnd` guard is false
  // on entry for any non-zero duration (findAvailableSlots.ts:850). Zero
  // iterations, every time — `maxFit` was structurally always null and EVERY
  // gap question rendered "nothing bookable there". Runtime: 5 gap pairs on
  // 2026-07-20/23/24, each preceded by 4× `getFreeBusy — zero or inverted
  // window, returning empty` (one per allowed duration) and followed by
  // `verdicts injected bookable:0`. A probe that cannot tell "I found nothing"
  // from "I never looked" must not assert a negative — so a gap verdict now
  // exists only once checkSlot has actually answered, and its null means every
  // allowed duration was tested and each failed.
  const allowedDurations = params.profile.meetings.allowed_durations ?? [25];
  const eventsByWeek = new Map<string, import('../connectors/graph/calendar').CalendarEvent[]>();

  /** The slot's own week of events, fetched once per PRE-CHECK CALL (this map is
   *  local to this function invocation — it never survives past this one turn's
   *  precheckAvailability call). v4.3.x (row "remaining-cached-decision-reads") —
   *  now reads via `getOwnerEventsForDecision`, ALWAYS 'live': never the
   *  cross-turn warm copy (up to CALENDAR_CACHE_TTL_SECONDS stale), with its own
   *  one-retry-then-typed-offline contract. Pre-fix this called plain
   *  `getCalendarEvents` (default freshness 'cached'), so "can you check again?"
   *  could be answered from a copy up to 5 minutes old with no way to force past
   *  it — the exact symptom `getOwnerEventsForDecision`'s own doc cites
   *  (logs/maelle-2026-07-27.log:512 vs :559) and the exact one a colleague hit
   *  again asking about Michal's slot. THROWS on an unreadable calendar —
   *  `getOwnerEventsForDecision` can now throw a typed `CalendarOfflineError`,
   *  which the catch below still treats like any other per-pair failure (log +
   *  skip, no verdict for this pair) — unchanged and correct: a blind owner
   *  calendar already has its own refusal elsewhere, and this pre-check's
   *  contract has always been "assert nothing when the data isn't there." */
  const eventsForWeek = async (startDt: DateTime) => {
    const weekKey = startDt.startOf('week').toFormat('yyyy-MM-dd');
    const cached = eventsByWeek.get(weekKey);
    if (cached) return cached;
    const events = await getOwnerEventsForDecision(
      params.profile.user.email,
      startDt.startOf('week').toFormat("yyyy-MM-dd'T'00:00:00"),
      startDt.endOf('week').toFormat("yyyy-MM-dd'T'23:59:59"),
      tz,
    );
    eventsByWeek.set(weekKey, events);
    return events;
  };

  /**
   * The rule-aware answer for ONE exact instant. Extracted (v4.2.2) so that the two
   * readings of an undecided frame are judged by the SAME code on the SAME meeting
   * length — a second, hand-written copy for the ambiguous branch is exactly how the
   * two surfaces drifted apart in the first place (M2).
   */
  const evaluateInstant = async (
    date: string, time: string, gapQuery: boolean, snappedMin: number,
  ): Promise<SlotOutcome | null> => {
    const startDt = DateTime.fromISO(`${date}T${time}`, { zone: tz });
    if (!startDt.isValid) return null;
    const events = await eventsForWeek(startDt);

    // v3.7.x (#143) — no WE short-circuit. An away day is a per-date override
    // carrying a timezone; checkSlot self-resolves that effective day and
    // validates the slot against the stated hours IN the away tz, so the
    // colleague pre-check reports bookable correctly (away, in-hours = bookable)
    // and the booking path agrees.
    const checkAt = (minutes: number) => checkSlot({
      profile: params.profile,
      slotStartIso: startDt.toISO()!,
      slotEndIso: startDt.plus({ minutes }).toISO()!,
      category: detectedCategory,   // enforce the SAME category cap the search does (was null → cap skipped)
      events,
      // v4.1.x (M2) — this pre-check runs on the COLLEAGUE path, so it must
      // hold the colleague booking lead time the search holds. Pre-fix it
      // didn't: "is Idan free at 3pm?" asked at 2pm answered BOOKABLE, the
      // colleague then booked it, and the 4-hour lead time was silently
      // defeated on a slot find_available_slots had never offered.
      leadTimeHours: bookingLeadTimeHours(params.profile, 'colleague'),
      // Colleague surface — a private meeting's subject never reaches the
      // verdict text (default masks; stated for the reader).
      viewer: 'other',
    });

    // v3.6.x — GAP query ("how much is free there?"). The question is how much
    // fits STARTING HERE, not what's free that day — so probe the allowed
    // durations at this exact start, descending; the first that passes IS the
    // largest bookable length. Injecting the real free length stops the "said
    // 10 min, it was 25" fabrication. Nothing fits → the SMALLEST duration's
    // violation is the honest reason (if even the shortest meeting can't sit
    // here, that's why), and it renders through the same soft/hard ladder as
    // any other verdict — a gap question landing outside his hours or over a
    // category cap is HIS to override, not the flat refusal the old branch
    // printed while planMeeting would have escalated it.
    // allowed_durations is schema-guaranteed non-empty (userProfile.ts:178,
    // `.min(1)`), so the loop always probes at least once: `maxFit === null`
    // is therefore always an ANSWER, never an unrun check.
    if (gapQuery) {
      let maxFit: number | null = null;
      let blockedBy: RuleViolationKind | undefined;
      let blockedByOoo = false;
      for (const d of [...allowedDurations].sort((a, b) => b - a)) {
        const probe = checkAt(d);
        if (probe.passes) { maxFit = d; break; }
        blockedBy = probe.violation_kind;
        blockedByOoo = probe.overCommitment?.allDayOutOfOffice === true;
      }
      return {
        date, time,
        bookable: maxFit !== null,
        maxFreeMinutes: maxFit,
        ...(maxFit === null && blockedBy ? { rejection_reason: blockedBy } : {}),
        ...(maxFit === null && blockedByOoo ? { outOfOfficeAllDay: true as const } : {}),
        // The "nothing fits" verdict was established by the LAST (smallest)
        // probe in the descending sweep — o#189, so the ledger/refuter re-probe
        // at that same length rather than a possibly-different smallest-allowed.
        ...(maxFit === null && blockedBy ? { durationMin: Math.min(...allowedDurations) } : {}),
      };
    }

    const check = checkAt(snappedMin);
    if (check.passes) return { date, time, bookable: true };
    return {
      date, time,
      bookable: false,
      rejection_reason: check.violation_kind ?? 'unknown',
      ...(check.overCommitment?.allDayOutOfOffice ? { outOfOfficeAllDay: true as const } : {}),
      durationMin: snappedMin,
    };
  };

  for (const pair of pairs.slice(0, 6)) {  // cap at 6 to bound cost
    // Duration: the asked length when the colleague named one, snapped to
    // allowed_durations exactly like create_meeting snaps (nearest). An
    // "11:00-11:15" ask checks 11:00+10min — the same meeting booking
    // would create — instead of a phantom default-25 window. Computed once per
    // PAIR so both readings of an undecided frame answer the same meeting.
    const askedMin = pair.durationMin ?? durationMinutes;
    const snappedMin = allowedDurations.reduce(
      (best, d) => (Math.abs(d - askedMin) < Math.abs(best - askedMin) ? d : best),
      allowedDurations[0],
    );
    try {
      const gapQuery = pair.gapQuery === true;
      const primary = await evaluateInstant(pair.date, pair.time, gapQuery, snappedMin);
      if (!primary) continue;
      // Both readings or neither. A throw on the SECOND one propagates to the catch
      // below and drops the whole pair, which is the honest outcome: half of an
      // undecided frame is not an answer, and shipping the primary alone would be
      // the silent single-frame assertion this change exists to remove.
      const other = pair.other
        ? await evaluateInstant(pair.other.date, pair.other.time, gapQuery, snappedMin)
        : null;
      if (!gapQuery) testedDurations.push(snappedMin);
      verdicts.push({
        ...primary,
        ...(gapQuery ? { gapQuery: true as const } : {}),
        ...(other && pair.other && pair.statedClock
          ? { statedClock: pair.statedClock, other: { ...other, zone: pair.other.zone } }
          : {}),
      });
    } catch (err) {
      // Single-slot failure shouldn't break the rest; log and skip. The SKIP is what
      // keeps this honest: no verdict is emitted for this pair, and if every pair
      // fails the caller injects no block at all (`verdicts.length === 0` below →
      // `ran: false` → buildTurnContext.ts:696 adds nothing), so a blind pre-check
      // can never assert "bookable" or "not bookable" with no data behind it. The
      // data source is built for that too: whether it's a typed `CalendarOfflineError`
      // (v4.3.x — `eventsForWeek` now reads via `getOwnerEventsForDecision`,
      // calendarReads.ts:435, the SAME decision-safe helper the slot walker uses) or
      // any other propagated throw, "no events" and "a completely free week" are never
      // the same value here, so both land in this same catch and skip this same
      // pair — a later reader must not come here looking for an offline verdict
      // that never arrives; that refusal lives at the meeting-lane call site, not here.
      //
      // v4.2.x — WARN, not debug. Debug is not persisted (zero `"level":"debug"`
      // rows in any log on disk), so the ONE path where this pre-check goes blind
      // was the one event a log review could not see, and "did she answer without
      // data?" was unanswerable from the tape. Behaviour is unchanged on purpose:
      // an unreadable owner calendar already has an owner — the refusal in the
      // meeting lane — and a second "I couldn't check" narration from here would be
      // a competing voice for the same fact (G1/G2). Make it visible; leave the
      // remedy where it lives.
      logger.warn('availabilityPreCheck — slot check threw; NO verdict emitted for this time', {
        date: pair.date, time: pair.time,
        errName: err instanceof Error ? err.name : typeof err,
        err: String(err).slice(0, 200),
      });
    }
  }

  if (verdicts.length === 0) return empty;

  // v4.2.x — hand the ESTABLISHED hard blocks to the output-time floor. This is
  // the only place in the system where "this exact instant is not available for
  // the owner" is a settled, rule-aware fact rather than a narration, so it is the
  // right place to record it: the floor then reads a verdict `checkSlot` produced
  // and never re-derives one (G3).
  //
  // Recorded per OWNER rather than per thread on purpose: in the 2026-07-27
  // incident the fact was established on the owner's turn and the false statement
  // went out on the NEXT turn, to the colleague.
  // And the SAME loop invalidates. A verdict here is the newest possible
  // knowledge about that instant: the same validator, on the same calendar,
  // milliseconds ago. If a stale entry from an earlier turn disagrees, the entry is
  // simply WRONG and must go — otherwise the floor rewrites a truthful "11:30 is open
  // now" (after the clash was moved) or "25 minutes at 11:30 fits" (a shorter ask
  // than the one that was refused) into a confident false refusal with a fabricated
  // reason, sent to a colleague who cannot challenge it. That is worse than the
  // over-optimistic claim this guard exists to stop, and it needs no external actor
  // at all. Newer knowledge wins, in the one place that produces it.
  //
  // v4.2.2 — an UNDECIDED frame arms nothing unless BOTH readings are HARD-blocked.
  // "17:00 is taken" is a true fact about the calendar, but if we cannot tell
  // whether the asker meant 17:00 or 16:00 it is not a fact about the slot he
  // ASKED about — and the floor's whole action is to contradict a draft that names
  // one clock. That is precisely the 2026-07-27 Dirk sequence: 16:00 Israel was
  // genuinely busy, 17:00 (= his 16:00) was genuinely free, one reading was
  // recorded as settled, and the floor rewrote a correct "ich halte mir 16:00 CET
  // frei" into a false collision claim (:743). When both readings are HARD-blocked
  // the ambiguity stops mattering — "that time does not work" is true either way —
  // so both instants are recorded, each with its own display, and whichever clock
  // the draft names has a matching entry. Otherwise this turn has established
  // nothing the floor may fire on for either instant, and both are forgotten.
  //
  // THE TIER IS THE FLOOR'S, AND IT IS ASKED HERE BY THE FLOOR'S OWN PREDICATE.
  // Both halves of this loop tested `!bookable` until v4.2.2, and `!bookable` is
  // equally true of the owner-overridable tier — so both halves read a tier the
  // ledger does not use:
  //   • a MIXED hard/soft pair passed the "both readings blocked" exemption and armed
  //     the hard reading of a frame nobody had decided. A Brussels colleague's bare
  //     "16:00" is 16:00 owner-local (a real collision) and 17:00 owner-local (merely
  //     outside his hours, HIS to override): the exemption held, the collision armed,
  //     and an honest "16:00 your time is past his usual hours — want me to raise it?"
  //     was in line to be flattened into a refusal about a different instant. :743
  //     again, with the #128 escalation the soft reading was owed destroyed too. The
  //     exemption's own justification only ever held for one tier at a time.
  //   • a fresh SOFT verdict over a stale hard entry did NEITHER thing: `record`
  //     no-ops on a kind outside the floor's list, and `forget` was skipped because
  //     the reading still counted as "blocked". So a hard entry armed at 07:35
  //     survived an 08:00 re-check that had downgraded it to a soft one — which is
  //     how a truthful "could work if he's OK with the tight turnaround" comes back
  //     as a refusal citing a clash the owner had already dragged away in Outlook (no
  //     Maelle mutation, so no other invalidation rule fires either).
  // `armsHardFloor` is the ledger's own arming test, imported rather than restated,
  // so the producer and the store cannot drift about where the tier line is. It
  // SUBSUMES `!bookable`: a bookable outcome carries no `rejection_reason` at all
  // (evaluateInstant above), so it can never arm — invalidation rule 1 survives as
  // the special case of "a fresh verdict that is not a hard block forgets".
  const ownerFirstName = params.profile.user.name.split(' ')[0];
  for (const v of verdicts) {
    const readings: SlotOutcome[] = [v, ...(v.other ? [v.other] : [])];
    const everyReadingArmsTheFloor = readings.every(r => armsHardFloor(r.rejection_reason));
    for (const r of readings) {
      const startDt = DateTime.fromISO(`${r.date}T${r.time}`, { zone: tz });
      if (!startDt.isValid) continue;
      const instantIso = startDt.toISO()!;
      if (!everyReadingArmsTheFloor) {
        forgetHardBlockedSlot(params.profile.user.email, instantIso);
        continue;
      }
      // Still hard-blocked → re-record, which also refreshes the TTL. A slot that
      // stays legitimately blocked across turns therefore stays armed.
      recordHardBlockedSlot({
        ownerEmail: params.profile.user.email,
        ownerFirst: ownerFirstName,
        instantIso,
        // Owner-local ONLY. This ledger is owner-keyed and is read in later
        // threads with other askers, so "(= … where they are)" baked in here is one
        // colleague's clock presented to the next one as a fact to preserve. The
        // floor adds the current reader's clock itself, per turn, from `instantIso`
        // (availabilityGate.displayForAsker).
        display: formatSlotDisplay(r.date, r.time, tz),
        kind: r.rejection_reason,
        allDayOutOfOffice: r.outOfOfficeAllDay === true,
        // Always set alongside rejection_reason (evaluateInstant, above) — the
        // fallback only guards the type, it is not expected to fire.
        durationMin: r.durationMin ?? durationMinutes,
      });
    }
  }

  // v4.2.x — when EVERY slot we tested came back not-bookable, the honest next
  // move is options, not a question. The predicate, the search, the stash write and
  // the rendering all live in `meeting`'s nearbyAlternatives so the trigger and the
  // computation cannot drift from the booking and search paths that answer the same
  // question; this call site only supplies what it alone knows — the validated
  // durations and the category the verdicts were computed under (without the
  // category an alternative can break the very cap the original request broke,
  // planMeeting.ts:625). It returns '' before any I/O when any tested slot was
  // bookable, so the common path costs nothing.
  //
  // Appended AFTER the verdict lines because the block's own text refers to them.
  // That is the only ordering constraint here — the alternatives block never reads
  // the floor's ledger, so its position relative to the loop above is free.
  const alternativesBlock = await blockedSlotAlternativesBlock({
    profile: params.profile,
    // v4.2.2 — an undecided frame contributes BOTH of its readings, because both of
    // that block's questions are per-instant: its trigger is "did anything come back
    // bookable this turn" (one free reading means the drafter already has something
    // to offer for the time they asked about, so a second list would compete with
    // it), and its anchor days come from the same list — which a cross-midnight
    // shift genuinely moves (23:00 CET is the NEXT day owner-local).
    verdicts: verdicts.flatMap(v => [
      { date: v.date, time: v.time, bookable: v.bookable },
      ...(v.other ? [{ date: v.other.date, time: v.other.time, bookable: v.other.bookable }] : []),
    ]),
    durationMinutes: testedDurations.length > 0 ? Math.max(...testedDurations) : durationMinutes,
    category: detectedCategory,
    initiator: 'colleague',
    channelId: params.channelId,
    threadTs: params.threadTs,
  });
  const promptBlock = renderPromptBlock(verdicts, params.profile, requesterTz)
    + (alternativesBlock ? `\n\n${alternativesBlock}` : '');
  // v4.2.2 — log the TIER split, not just the count. `notBookable` sums the HARD
  // tier and the owner-overridable NOT CLEAN tier, and that ambiguity cost a day of
  // diagnosis: `bookable:0, notBookable:3` on 2026-07-27 (:187) was read as three
  // hard blocks, so the reply's "tighter than your usual, workable if you want to
  // push through" looked like an invented reason — when it is verbatim the NOT CLEAN
  // line's own vocabulary and the verdicts were soft. Two candidate roots were
  // opened off that misreading. One field closes it.
  const notBookable = verdicts.filter(v => !v.bookable);
  const hardBlocked = notBookable.filter(
    v => !(v.rejection_reason && ESCALATABLE.has(v.rejection_reason)),
  ).length;
  logger.info('availabilityPreCheck — verdicts injected', {
    count: verdicts.length,
    bookable: verdicts.filter(v => v.bookable).length,
    notBookable: notBookable.length,
    hardBlocked,
    notClean: notBookable.length - hardBlocked,
    undecidedFrame: verdicts.filter(v => !!v.other).length,
  });
  return { ran: true, verdicts, promptBlock };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractTimes(text: string): Array<{ hour: number; minute: number; index: number }> {
  const out: Array<{ hour: number; minute: number; index: number }> = [];
  for (const m of text.matchAll(TIME_PATTERN)) {
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h < 0 || h > 23 || min < 0 || min > 59) continue;
    out.push({ hour: h, minute: min, index: m.index ?? 0 });
  }
  return out;
}

interface DateMatch { date: string; index: number }

function extractDates(text: string, tz: string, monthFirst: boolean): DateMatch[] {
  const out: DateMatch[] = [];
  for (const m of text.matchAll(DATE_PATTERN)) {
    // v3.2.x de-tenant — don't hardcode DD/MM (Israeli/EU). Disambiguate by
    // value first (a component >12 can't be a month), then fall back to the
    // owner's locale order for the genuinely ambiguous case (e.g. "6/2" =
    // June 2 for a month-first owner, 6 Feb for a day-first owner).
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    let d: number, mo: number;
    if (a > 12 && b <= 12) { d = a; mo = b; }
    else if (b > 12 && a <= 12) { d = b; mo = a; }
    else if (monthFirst) { mo = a; d = b; }
    else { d = a; mo = b; }
    if (d < 1 || d > 31 || mo < 1 || mo > 12) continue;
    let year: number;
    if (m[3]) {
      const y = parseInt(m[3], 10);
      year = y < 100 ? 2000 + y : y;
    } else {
      // No year — assume current year, but if the date is more than ~2 weeks
      // in the past relative to today, roll to next year (e.g. December
      // referencing January).
      const now = DateTime.now().setZone(tz);
      const candidate = DateTime.fromObject({ year: now.year, month: mo, day: d }, { zone: tz });
      year = candidate.isValid && candidate.diff(now.minus({ days: 14 })).milliseconds < 0
        ? now.year + 1
        : now.year;
    }
    const dt = DateTime.fromObject({ year, month: mo, day: d }, { zone: tz });
    if (!dt.isValid) continue;
    out.push({ date: dt.toFormat('yyyy-MM-dd'), index: m.index ?? 0 });
  }
  return out;
}

interface Pair {
  date: string;
  time: string;
  durationMin?: number;
  gapQuery?: boolean;
  /** v4.2.2 — the second reading of an undecided frame (see resolveFrame), already
   *  expressed owner-local, plus the zone it was read in for the narration. */
  other?: { date: string; time: string; zone: string };
  /** The clock as the asker wrote it (`HH:MM`); set with `other` only. */
  statedClock?: string;
}

function pairTimesWithDates(
  _text: string,
  times: Array<{ hour: number; minute: number; index: number }>,
  dates: DateMatch[],
  fallbackDate: string,
): Pair[] {
  const out: Pair[] = [];
  for (const t of times) {
    // Find the nearest preceding date in the message; fall back to fallbackDate.
    let matchedDate = fallbackDate;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const d of dates) {
      if (d.index <= t.index) {
        const dist = t.index - d.index;
        if (dist < bestDistance) {
          bestDistance = dist;
          matchedDate = d.date;
        }
      }
    }
    out.push({
      date: matchedDate,
      time: `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`,
    });
  }
  // Dedupe identical pairs.
  const seen = new Set<string>();
  return out.filter(p => {
    const key = `${p.date}T${p.time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Cost-free (no LLM) extraction of the (date, time) pairs the bare clock digits
 * in a message name, paired with the nearest preceding date mention (or
 * `today`). Exactly the regex-fallback extraction `precheckAvailability` itself
 * runs when Haiku errors/returns nothing — factored out so it has exactly ONE
 * definition, shared with `forgetNamedInstantsFromHardBlockLedger` below (they
 * must not drift about what a bare clock in this message names).
 */
function extractRawPairs(message: string, tz: string, today: string): Pair[] {
  const times = extractTimes(message);
  if (times.length === 0) return [];
  // Owner locale order for ambiguous DD/MM vs MM/DD: Americas → month-first,
  // everywhere else → day-first.
  const monthFirst = /^America\//.test(tz);
  const dates = extractDates(message, tz, monthFirst);
  return pairTimesWithDates(message, times, dates, today);
}

/**
 * v4.3.x (gh#158) — forgets any hard-block ledger entry (availabilityGate.ts)
 * whose instant this message ALSO names, using the same cost-free regex
 * extraction as the fallback path above — never the Haiku normalizer, and never
 * a `checkSlot` call. Called ONLY from the named-attendee bail in
 * `precheckAvailability`; see that call site for why.
 *
 * A bare clock's frame is undecided exactly as `resolveFrame` describes (a
 * requester outside the owner's zone could mean either clock), so BOTH readings
 * are forgotten — forgetting an instant that was never armed is a harmless
 * no-op, and this function only ever DELETES ledger entries
 * (`forgetHardBlockedSlot`); it never records one.
 *
 * This is invalidation rule 5 in availabilityGate.ts's own ledger doc (o#190) —
 * the one rule not grounded in a fresh `checkSlot` read; formalized there as its
 * own numbered rule rather than left to drift as an uncounted mechanism.
 */
function forgetNamedInstantsFromHardBlockLedger(
  message: string,
  profile: UserProfile,
  requesterTimezone?: string,
): void {
  const tz = profile.user.timezone;
  const today = DateTime.now().setZone(tz).toFormat('yyyy-MM-dd');
  const pairs = extractRawPairs(message, tz, today);
  if (pairs.length === 0) return;
  const requesterTz = requesterTimezone && IANAZone.isValidZone(requesterTimezone.trim())
    ? requesterTimezone.trim()
    : tz;
  const frame = resolveFrame(undefined, requesterTz, tz);
  for (const p of pairs) {
    const primary = readClockIn(`${p.date}T${p.time}`, frame.zone, tz);
    if (primary) {
      const iso = DateTime.fromISO(`${primary.date}T${primary.time}`, { zone: tz }).toISO();
      if (iso) forgetHardBlockedSlot(profile.user.email, iso);
    }
    if (frame.otherZone) {
      const other = readClockIn(`${p.date}T${p.time}`, frame.otherZone, tz);
      if (other) {
        const iso = DateTime.fromISO(`${other.date}T${other.time}`, { zone: tz }).toISO();
        if (iso) forgetHardBlockedSlot(profile.user.email, iso);
      }
    }
  }
}

/** One rendering of a slot, shared by the prompt block and the hard-block ledger so
 *  a corrected reply names a slot exactly as the drafting context named it — and so
 *  a floor rewrite never answers a question about 16:00 by naming 17:00, which reads
 *  as yet another different time (the 2026-07-27 thread's whole complaint).
 *
 *  The cross-zone second clock is OPTIONAL, and the two callers differ on purpose
 *  (v4.2.2). The prompt block passes `requesterTz`: it is built for ONE turn and one
 *  asker. The ledger does not: it is owner-keyed and read in later threads with other
 *  askers, so it stores the owner's clock and the floor re-adds the current reader's
 *  own from the stored instant (availabilityGate.displayForAsker). Either way the
 *  reply never converts by hand, which is what produced three different "16:00"s. */
function formatSlotDisplay(date: string, time: string, tz: string, requesterTz?: string): string {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: tz });
  if (!dt.isValid) return `${date} ${time}`;
  const theirs = requesterTz ? requesterClock(date, time, tz, requesterTz) : '';
  return dt.toFormat("EEEE d MMM 'at' HH:mm") + (theirs ? ` (= ${theirs} where they are)` : '');
}

/**
 * The SAME instant in the asker's own zone, computed here (M14) so the reply can
 * quote it instead of the model converting owner-local back by hand — the exact
 * arithmetic that produced three different "16:00"s in one 2026-07-27 thread.
 * '' when the asker is in the owner's zone or the render fails, and callers then
 * emit no parenthetical at all rather than an empty one.
 */
function requesterClock(date: string, time: string, ownerTz: string, requesterTz: string): string {
  if (!requesterTz || requesterTz === ownerTz) return '';
  const iso = DateTime.fromISO(`${date}T${time}`, { zone: ownerTz }).toISO();
  return iso ? renderClockInZone(iso, ownerTz, requesterTz) : '';
}

// v3.3.x — precheckAvailability runs ONLY on the colleague path
// (orchestrator/index.ts gate). Never surface the rule name to a colleague —
// "focus_time_office" / "lunch" etc. leaks the owner's schedule mechanics.
// v3.3.7 (#125a) — but DO distinguish soft (owner-relaxable day-load
// protections) from hard (real meetings / work hours): a soft block is
// "his day is loaded" + escalatable, not a flat refusal. Kinds are
// checkSlot's RuleViolationKind values (verdicts run checkSlot now).
// v3.7.x — OWNER-OVERRIDABLE violations are escalatable, never a flat
// refuse. A colleague-proposed time that breaks one of these is the owner's
// call — route it to him via policy_exception, matching planMeeting (which
// offers alternatives then escalates). This is what makes the pre-check
// AGREE with the booking path: before, work-hours + category caps rendered
// as flat "NOT BOOKABLE" here while planMeeting escalated them — so a
// US-evening or over-cap proposal got refused upfront and never reached the
// owner's approval. Truly-hard states (owner genuinely busy, in the past)
// still fall through to NOT BOOKABLE.
// v4.1.x (M2/M11) — `within_lead_time` and `travel_buffer_collision` join
// the set. Both are soft, owner-overridable protections that the SEARCH has
// always treated that way (SOFT_REJECT_PREFIXES) and that planMeeting
// escalates on the colleague path; without them here a "3pm today" ask at
// 2pm renders as a bare "NOT BOOKABLE" with no reason at all — a mechanical
// no, which is precisely what M11 forbids.
//
// v4.2.2 — hoisted to module scope. It was rebuilt inside the per-verdict map, and
// the tier split is now read in two places (the renderer and the injected-verdicts
// log), so one definition is the only way they cannot disagree about which tier a
// kind is — which is exactly the question a log review of this file needs answered.
const ESCALATABLE = new Set<string>([
  'focus_time_floor', 'floating_block_overlap', 'within_lead_time', 'travel_buffer_collision',
  'outside_working_hours', 'category_per_day', 'category_per_week', 'category_day_type',
]);

function renderPromptBlock(verdicts: SlotVerdict[], profile: UserProfile, requesterTz: string): string {
  const tz = profile.user.timezone;
  const ownerFirst = profile.user.name.split(' ')[0];
  const anyRequesterClock = verdicts.some(v => requesterClock(v.date, v.time, tz, requesterTz) !== '');
  const anyUndecidedFrame = verdicts.some(v => !!v.other);

  /**
   * What this ONE instant is, per the rules. Extracted (v4.2.2) so the two readings
   * of an undecided frame are described by the same ladder — a hand-written second
   * copy for the ambiguous branch would drift, and the tier vocabulary is the thing
   * the drafter acts on.
   */
  const outcomeClause = (o: SlotOutcome, gapQuery?: boolean): string => {
    // v3.6.x — gap query ("how much is free there?"): report the REAL largest
    // bookable length so the reply states it instead of estimating a smaller one.
    // v4.2.x — only the POSITIVE case is special-cased. A gap query that
    // fits nothing falls through to the ladder below and carries checkSlot's
    // real reason. The old flat "nothing bookable there" did two dishonest
    // things: it claimed a NEIGHBOURHOOD ("there") when the probe only ever
    // tests one exact start, and it collapsed owner-overridable rules into a
    // refusal the booking path would have escalated. "FROM this start" for the
    // same reason — the length is measured from it, not around it.
    if (gapQuery && o.maxFreeMinutes && o.maxFreeMinutes > 0) {
      return `up to ${o.maxFreeMinutes} min is free FROM this start per ${ownerFirst}'s rules — state THIS length, do not estimate a shorter one.`;
    }
    if (o.bookable) return `BOOKABLE per ${ownerFirst}'s rules`;
    if (o.rejection_reason && ESCALATABLE.has(o.rejection_reason)) {
      // High-level phrasing hint by kind — NEVER leak the rule name or the cap
      // to a colleague (rule 7). All route to owner approval on insist.
      const why = o.rejection_reason === 'outside_working_hours'
        ? `that's outside ${ownerFirst}'s usual hours`
        : o.rejection_reason === 'within_lead_time'
          ? `that's sooner than ${ownerFirst} normally takes a new booking at`
        : o.rejection_reason === 'travel_buffer_collision'
          ? `there isn't enough room around it for ${ownerFirst} to get there and back`
        : o.rejection_reason.startsWith('category_')
          ? `${ownerFirst} is already at his limit for that kind of meeting that day`
          : `${ownerFirst}'s day is loaded around then`;
      return `NOT CLEAN — ${why}; NOT a hard conflict and it's ${ownerFirst}'s to override. Phrase it high-level to the colleague (never name the rule or the limit). If they INSIST on this exact time, raise create_approval(kind=policy_exception) so ${ownerFirst} decides — don't refuse outright, don't book.`;
    }
    // ── HARD block ──────────────────────────────────────────────────────────
    // v4.2.x — carry the class `checkSlot` ESTABLISHED (G3). This line used to be
    // the bare string "NOT BOOKABLE" for every hard kind except the all-day OOO:
    // checkSlot had returned violation_kind, violation_label, level:'unfiltered'
    // and overCommitment, and the renderer dropped all of it. So the ONE tier that
    // is non-negotiable was the ONE tier that arrived with no reason and no
    // instruction, sitting under a header that hands the drafter the whole
    // OVERRIDABLE vocabulary ("outside his usual hours", "day-load protection",
    // "HIS to override, do NOT flatly refuse") — a reason-shaped hole next to a
    // ready-made wrong reason. The all-day-OOO fix had already found this for the vacation
    // sub-case; the general case had the same hole. Reason visibility = owner
    // decision 2026-07-27: the CLASS of the blocker, in-thread, and nothing that
    // identifies the event. The class comes off the verdict via
    // hardBlockClassPhrase — never re-derived here — and when it is unknown the
    // line carries NO reason and says so, because an invented hard reason would be
    // the same failure as an invented soft one.
    //
    // This fix was first written on the belief that the 2026-07-27 MPIM reply
    // ("tighter than your usual, workable if you want to push through") was a HARD
    // verdict softened through that hole. The thread record refutes that: the same
    // reply renders the all-day line verbatim for the third slot ("you're away that
    // whole day") and uses this block's own NOT CLEAN label for the other two ("not
    // clean as-is"), so those two verdicts were the SOFT tier and the drafter was
    // faithful to all three lines. The hole is real and this closes it; that
    // incident is not its evidence, and `notBookable:3` summing both tiers is what
    // made it look like one (hence the tier split in the injected-verdicts log).
    const phrase = hardBlockClassPhrase(o.rejection_reason, {
      ownerFirst,
      allDayOutOfOffice: o.outOfOfficeAllDay,
    });
    // The all-day case also rules out the obvious follow-up: a different hour on
    // the same day has the same answer.
    const sameDayNote = o.outOfOfficeAllDay
      ? ` Offer another DAY — do NOT offer a different time on the same day, and do NOT say he's booked.`
      : '';
    const reasonRule = phrase
      ? `never give a reason other than the one on this line (and never name the meeting, who is on it, or whose it is)`
      : `NO reason for it is available — say plainly that it doesn't work and give none, never a guessed one`;
    return `NOT BOOKABLE${phrase ? ` — ${phrase}` : ''}. This is a FACT about ${ownerFirst}'s calendar, not a preference and not something to push through: do NOT call it workable / tight / possible / fine-if-he-pushes, do NOT offer to book it, and ${reasonRule}.${sameDayNote}`;
  };

  const lines = verdicts.map(v => {
    const when = formatSlotDisplay(v.date, v.time, tz, requesterTz);
    if (!v.other) return `  - ${when}: ${outcomeClause(v, v.gapQuery)}`;
    // v4.2.2 — UNDECIDED FRAME. They wrote a clock and named no timezone, and they
    // are not in ${ownerFirst}'s zone, so the words they typed name two different
    // moments and nothing in the message says which (see resolveFrame — the tape has
    // one colleague of each convention). Both are checked and both are printed; the
    // one thing the reply may not do is answer as though there were one.
    const otherWhen = formatSlotDisplay(v.other.date, v.other.time, tz, requesterTz);
    return `  - They wrote "${v.statedClock}" and named NO timezone, and they are not in ${ownerFirst}'s zone — so that is one of TWO moments and I cannot tell which they meant. Answer ONE of them and SAY WHICH CLOCK you used, in the reply itself:\n`
      + `      • as ${ownerFirst}'s clock → ${when}: ${outcomeClause(v, v.gapQuery)}\n`
      + `      • as THEIR clock (${v.other.zone}) → ${otherWhen}: ${outcomeClause(v.other, v.gapQuery)}`;
  });
  // v4.3.x (G164-a) — removed the duplicated reversal-honesty instruction
  // (now lives only in meetings.ts's MEETINGS HONESTY block); kept below is
  // just the clock-mechanism fact, which meetings.ts:1377 also states.
  return `## AVAILABILITY CHECK (rule-aware, deterministic)

I pre-checked the times in this colleague's question against ${profile.user.name.split(' ')[0]}'s real scheduling rules (work hours, buffer, focus blocks, category limits). Use these verdicts in your reply — do NOT eyeball get_calendar and disagree:

${lines.join('\n')}
${anyRequesterClock ? `
Each line carries TWO clocks for one moment: ${ownerFirst}'s local time first, then "(= … where they are)" — the SAME instant in the asker's own timezone, computed by code. On a line with ONE reading: when you name that time to them, quote the "where they are" clock VERBATIM and never re-derive it; when you name it to ${ownerFirst} or pass it to a tool, use his. Both refer to one instant, so never present them as two options. This rule does NOT apply to a two-reading line — that line has its own rule below, and it wins.
` : ''}${anyUndecidedFrame ? `
One of the times above has TWO readings because they gave a clock with no timezone and they do not share ${ownerFirst}'s. I do not know which they meant, so you must not answer as if I did. Pick the reading you are answering, use ITS verdict, and NAME THE CLOCK in your own words to them — "16:00 your time" / "16:00 ${ownerFirst}'s time" — so that if you picked wrong they can correct it in one message instead of a wrong meeting appearing. To them, the NUMBER you give is the clock THEY WROTE, labelled with whose clock you read it as; do NOT also quote the "(= … where they are)" parenthetical off those two lines. Either reading IS that same stated clock seen from one of two zones, so that parenthetical adds a THIRD number to a thread that already has two, and for the reading you did not pick it is a time nobody has mentioned. Never state a time from one of those lines without saying whose clock it is, and never offer the two readings as two options to choose between: only one of them is the time they asked about.
` : ''}
NOT BOOKABLE and NOT CLEAN are two DIFFERENT tiers and each line tells you which one you have — never treat one as the other. NOT BOOKABLE is a FACT about his calendar: say plainly that it doesn't work, use ONLY the reason that line gives (none at all when it gives none), and NEVER soften it into "tight but workable" / "he could push through" / "works on his end" — to him or to anyone else. If it's NOT CLEAN, it breaks one of ${profile.user.name.split(' ')[0]}'s OWN rules (outside his usual hours, a per-day category limit, or his day-load protection) — it is HIS to override, so do NOT flatly refuse and do NOT book: use the high-level reason on that line, and if the colleague wants that exact time, escalate via create_approval(kind=policy_exception) so he decides. If it's BOOKABLE, you can confirm — for right now. These verdicts run the SAME checkSlot the booking flow uses (work hours, buffer, focus blocks, category limits), so never eyeball get_calendar and disagree with them. That is not a standing promise, though: within_lead_time and in_the_past are checked against the CURRENT clock, so a slot clear of the lead-time floor here can fall inside it if real time passes before an actual booking call runs — waiting on the colleague's reply, or on ${ownerFirst}'s approval, is enough on its own. The category above is also only a guess from this message — there is no real subject/body yet — so a category cap (per-day / per-week / office-only) can land differently once the actual meeting is classified at booking time.`;
}
