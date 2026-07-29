/**
 * Forwarded-header participant + stated-timezone extraction (v4.3.0, #24 E4,
 * hardened #24 rows 129/132/133/137).
 *
 * A forward is addressed to Maelle, so the Graph message's own `toRecipients`
 * is just her — the ORIGINAL participants exist only inside the body, in the
 * header block a mail client inserts right after the forward marker
 * ("---------- Forwarded message ---------", "מאת:", …). The exact marker
 * and labels vary by language and mail client, which is why this is an LLM
 * pass and not a regex (rule 4 — no regex on natural language, Maelle is
 * multilingual).
 *
 * Binds NARROW on purpose: only the TOP forwarded header, never the deeper
 * quoted history further down the chain (which may carry stale participants
 * from an unrelated older sub-thread). The full chain still reaches the
 * model as conversation context separately (read wide) — this is only the
 * deterministic attendee hint layered on top.
 *
 * Correctness here is guaranteed SOCIALLY, not syntactically (owner
 * decision): the reply names the attendees extracted, the owner reads it
 * before forwarding it on, so a miss is visible rather than silent. The RFC
 * check below is a structural sanity filter on the LLM's own output, not a
 * claim that extraction itself is exact.
 *
 * FORWARD vs REPLY (row 133 fix — proven in production, not theoretical):
 * Outlook inserts the identical "From: / Sent: / To: / Subject:" block above
 * BOTH a genuine forward AND a plain reply-quote. Run 3 of the #24 live test
 * ("Re: Fw: Kevel / Reflectiz") proved this: with no genuine forward marker
 * anywhere in that email (the prior Maelle reply it quotes had no chain to
 * forward — see row 130), the classifier still returned 2 "participants" —
 * `maelle@<mailbox>` and the owner's own address — lifted straight out of
 * Outlook's own reply-quote header (confirmed by reading the persisted turn
 * text: `From: Maelle <…>\nSent: …\nTo: Idan Cohen <…>\nSubject: Re: Fw: …`).
 * Those two are never meeting participants. The prompt below now says so
 * explicitly, and treats "can't tell forward from reply" as "return nothing"
 * rather than a guess.
 *
 * STATED TIMEZONE (row 129/136 fix; tier-authority corrected report row 144)
 * — same call, same bounded body, extended rather than duplicated (one Haiku
 * round trip, not two). The owner's precedence ruling, verbatim: "don't ask.
 * if I tell you in email the timezone, you know it. if I didn't tell you and
 * the email told you because the email wrote its ET-> you know it. if you
 * didn't get anything, you assume my time. no asking in email routes." So
 * this also extracts, when actually WRITTEN anywhere in the email (the
 * forwarding person's own new note, or deeper in the original chain): the
 * participant it applies to and the zone/location exactly as written — never
 * inferred from a phone number, company, or general knowledge, and never a
 * live lookup (the caller resolves the returned free text to IANA statically
 * — see connectors/email/inbound.ts). No stated zone anywhere → an empty
 * list; the owner explicitly blessed the existing owner-zone fallback for
 * that case, so the caller does nothing further.
 *
 * WHERE this module deliberately stops (report row 144): it used to also
 * report WHICH part of the email a hint came from ('forwarding_note' vs
 * 'chain'), and the caller wrote that classification straight through as the
 * PERSISTENCE AUTHORITY (owner-tier vs auto-tier). One Haiku misjudgment
 * about POSITION in the body then minted a wrong timezone at owner
 * authority — sticky, because no later auto-tier correction can ever outrank
 * it. Per the shared charter, a model classification may choose a VALUE,
 * never the TIER that value is written at. This module now returns only the
 * value; the caller derives the tier itself from Graph's own `uniqueBody` —
 * a structural fact about which text is provably the current sender's own,
 * never a classifier's guess about where in the body it sat.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from '../../llm/client';
import { MODEL_HAIKU } from '../../llm/models';
import { logLlmUsage } from '../../utils/usageLog';
import logger from '../../utils/logger';

const anthropic = getAnthropicClient();

// Structural (language-independent) validation of the LLM's OWN output —
// not a parse of natural language, same class as the codebase's existing
// req_id / ISO-datetime regexes.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Bounds the classifier call; the forwarded header block is always near the
// top, so truncating far into a long chain never loses it.
const MAX_BODY_CHARS = 12000;

export interface EmailTimezoneHint {
  /** The participant email this stated zone/location applies to. */
  email: string;
  /** Exactly as written — "EST", "Eastern", "New York", "GMT+2", etc. The
   *  caller maps this to IANA (inferTimezoneFromStateStatic); this module
   *  never invents a zone name itself. Report row 144: this module does NOT
   *  say where in the email it found this — the caller derives persistence
   *  authority structurally (Graph's uniqueBody), never from a classification
   *  this module would otherwise have to guess. */
  statedTimezone: string;
}

export interface ExtractedParticipants {
  /** Email addresses on the ORIGINAL forwarded message's top header block.
   *  Empty when this isn't a genuine forward, or none were found. */
  participants: string[];
  /** Stated timezone/location hints, keyed by email. Empty when nothing was
   *  actually written anywhere in this email. */
  timezoneHints: EmailTimezoneHint[];
}

const EMPTY_RESULT: ExtractedParticipants = { participants: [], timezoneHints: [] };

export async function extractForwardedParticipants(plainTextBody: string): Promise<ExtractedParticipants> {
  const bounded = plainTextBody.slice(0, MAX_BODY_CHARS);
  try {
    const resp = await anthropic.messages.create({
      model: MODEL_HAIKU,
      max_tokens: 400,
      tools: [{
        name: 'extract_participants',
        description:
          'Extract (1) the email addresses of the people on the ORIGINAL forwarded message — the From/To/Cc-style ' +
          'header block that sits immediately under a GENUINE forward marker, in whatever language it is written — ' +
          'and (2) any timezone/location actually stated for those people, either in the sender\'s own new note or ' +
          'within the original chain. Do NOT extract participants from a plain REPLY-quote block (see below).',
        input_schema: {
          type: 'object' as const,
          properties: {
            participants: {
              type: 'array',
              items: { type: 'string' },
              description: 'Email addresses found in the top forwarded header block only. Empty array if none found, or this is not a genuine forward (e.g. it is a plain reply).',
            },
            attendee_timezones: {
              type: 'array',
              description:
                'For any participant whose timezone or location is ACTUALLY WRITTEN somewhere in this email — ' +
                'either in the sender\'s own new note (above any quoted/forwarded content) or within the original ' +
                'chain itself (e.g. "He needs EST time", "let\'s do 2pm ET", a signature naming a city) — the email ' +
                'it applies to and the zone/location exactly as written. Omit anyone with nothing stated anywhere ' +
                '— never infer from an area code, a company, or general knowledge.',
              items: {
                type: 'object',
                properties: {
                  email: { type: 'string', description: 'The participant email this stated zone applies to.' },
                  stated_timezone: { type: 'string', description: 'The zone/location exactly as written, e.g. "EST", "Eastern", "New York", "GMT+2".' },
                },
                required: ['email', 'stated_timezone'],
              },
            },
          },
          required: ['participants'],
        },
      }],
      tool_choice: { type: 'tool', name: 'extract_participants' },
      messages: [{
        role: 'user',
        content:
          `A person forwarded this email to their assistant. Find the header block of the ORIGINAL message they ` +
          `forwarded (the "From / To / Cc" style lines a mail client inserts right after a forward marker, in ANY ` +
          `language — English "From:", Hebrew "מאת:", etc). Extract ONLY the email addresses from THAT block — the ` +
          `participants of the original conversation. Do NOT pull addresses from any older quoted message further ` +
          `down the chain.\n\n` +
          `IMPORTANT — a forward is NOT a reply. Many mail clients (Outlook in particular) insert the exact same ` +
          `"From: / Sent: / To: / Subject:" block above a plain REPLY-quote as they do above a genuine forward. If ` +
          `this email is itself a REPLY (its subject/content shows it is replying to a previous message, not ` +
          `relaying someone else's conversation), that block just names who is being replied to — it is NOT a ` +
          `forwarded conversation and its address(es) are NOT meeting participants. When you cannot tell whether a ` +
          `From/Sent/To/Subject-shaped block is a genuine forward or just a reply-quote, return an EMPTY ` +
          `participants array rather than guessing.\n\n` +
          `Separately, note any timezone or location actually written for a participant — the sender's own new ` +
          `words, or the original chain's own words. Never infer one from a phone number, company name, or general ` +
          `knowledge; omit anyone nothing is written for.\n\n` +
          `Email body:\n${bounded}`,
      }],
    });
    logLlmUsage('extract_participants', MODEL_HAIKU, resp);

    const toolUse = resp.content.find(b => b.type === 'tool_use') as Anthropic.ToolUseBlock | undefined;
    const input = toolUse?.input as { participants?: unknown; attendee_timezones?: unknown } | undefined;

    const rawParticipants = input?.participants;
    const participants = Array.isArray(rawParticipants)
      ? [...new Set(
          rawParticipants
            .filter((a): a is string => typeof a === 'string')
            .map(a => a.trim().toLowerCase())
            .filter(a => EMAIL_RE.test(a)),
        )]
      : [];

    const rawHints = input?.attendee_timezones;
    const timezoneHints: EmailTimezoneHint[] = Array.isArray(rawHints)
      ? rawHints
          .filter((h): h is Record<string, unknown> => typeof h === 'object' && h !== null)
          .map(h => ({
            email: typeof h.email === 'string' ? h.email.trim().toLowerCase() : '',
            statedTimezone: typeof h.stated_timezone === 'string' ? h.stated_timezone.trim() : '',
          }))
          .filter(h => EMAIL_RE.test(h.email) && h.statedTimezone.length > 0)
      : [];

    return { participants, timezoneHints };
  } catch (err) {
    logger.warn('extractForwardedParticipants — classifier threw, proceeding with no extracted participants', {
      err: String(err).slice(0, 200),
    });
    return EMPTY_RESULT;
  }
}
