/**
 * v2.8.6 — deterministic detection of "owner-in-MPIM proposed this exact slot
 * in recent chat". Used by the colleague-path create_meeting handler so that
 * when the owner is sitting in an MPIM and explicitly suggests a time
 * (typically outside his normal work hours), Maelle treats his presence as
 * the approval — books with relaxed=true and skips the policy_exception
 * escalation that today produces the leaked "Idan said yes on policy
 * exception needs your input" MPIM message (bug 103D/F + 103E on the
 * 2026-05-18 wave).
 *
 * Detection is conservative: only fires when (a) we're in an MPIM with the
 * owner in the group, (b) the slot's wall-clock hour:minute appears in a
 * recent owner-typed message, (c) the matched message was within the last 8
 * turns. Anything fuzzier (Sonnet's interpretation, free-text amendments)
 * still falls through to the existing rule check.
 *
 * The check is regex on the message text. No LLM call, no extra latency.
 */

import { DateTime } from 'luxon';

interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Returns true when the OWNER's MOST RECENT message in this MPIM proposed
 * the specific slot Sonnet is about to book. "Proposed" means the message
 * contains both (a) the slot's wall-clock time in any common format AND
 * (b) a proposal-cue — a question mark, or one of "what about", "what wrong
 * with", "isn't", "how about", "let's do", "let's try", "try X", "X work",
 * "what's wrong with". Without a cue, a casual mention of the same time
 * earlier in chat (e.g. "we already met at 22:30") would falsely auto-relax
 * a rule-breaking slot — that's the false-positive guard.
 *
 * Scope: only the LATEST owner-typed message in MPIM is consulted. Older
 * owner messages don't count — once Maelle has had subsequent turns, an
 * earlier proposal is stale and a fresh user message overrides.
 *
 * @param history Recent conversation history (last ~8 turns).
 * @param slotStartIso ISO datetime of the slot Sonnet is about to book.
 * @param ownerName The owner's full real_name (matches the MPIM "Sender: X" prefix).
 * @param timezone Owner's timezone, used to parse the slot ISO to wall clock.
 */
export function ownerProposedSlot(
  history: HistoryMessage[] | undefined,
  slotStartIso: string,
  ownerName: string,
  timezone: string,
): boolean {
  if (!history || history.length === 0) return false;
  if (!slotStartIso || !ownerName) return false;

  const dt = DateTime.fromISO(slotStartIso, { zone: timezone });
  if (!dt.isValid) return false;

  const hour24 = dt.hour;
  const min = dt.minute;
  const minPad = String(min).padStart(2, '0');
  const form24 = `${hour24}:${minPad}`;
  const hour12 = ((hour24 + 11) % 12) + 1;
  const ampm = hour24 >= 12 ? 'pm' : 'am';
  const form12tight = `${hour12}:${minPad}${ampm}`;
  const form12loose = `${hour12}:${minPad} ${ampm}`;
  const timePatterns = [
    new RegExp(`\\b${escapeRegex(form24)}\\b`, 'i'),
    new RegExp(`\\b${escapeRegex(form12tight)}\\b`, 'i'),
    new RegExp(`\\b${escapeRegex(form12loose)}\\b`, 'i'),
  ];

  // Proposal cues. Mix of English and Hebrew. The "?" cue covers most natural
  // proposals like "what about 22:30?" or "isn't 10pm free?". Phrase cues
  // catch the cases without question marks ("let's do 10:30pm").
  const PROPOSAL_PHRASES = [
    'what about', 'what wrong with', "what's wrong with",
    'how about', "let's do", "let's try", 'try at',
    "isn't", 'is it', 'is that', 'sounds good', 'works for me',
    'מה לגבי', 'מה עם', 'בוא ננסה', 'יש לי הצעה',
  ];
  const hasProposalCue = (text: string): boolean => {
    if (text.includes('?')) return true;
    const lower = text.toLowerCase();
    return PROPOSAL_PHRASES.some(p => lower.includes(p));
  };

  const senderFull = `sender: ${ownerName.toLowerCase()}`;
  const senderFirst = `sender: ${ownerName.split(' ')[0].toLowerCase()}`;

  // Find the LATEST owner-typed message and check it only.
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'user') continue;
    const lower = m.content.toLowerCase();
    if (!lower.includes(senderFull) && !lower.includes(senderFirst)) continue;
    // Found owner's latest message. Test it AND stop — older owner messages
    // don't count.
    const hasTime = timePatterns.some(p => p.test(m.content));
    if (!hasTime) return false;
    return hasProposalCue(m.content);
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
