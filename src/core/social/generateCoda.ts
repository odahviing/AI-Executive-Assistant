/**
 * Social coda composer (v2.2.1 Pattern 1).
 *
 * A coda rides a task turn that came to REST — the work either resolved this
 * turn (booking done, question answered, note saved) or was handed off and
 * Maelle is now waiting on someone else. Either way there is a genuine lull, so
 * she may offer ONE short social line.
 *
 * WHO DECIDES vs WHO WRITES. Eligibility is the orchestrator's
 * (`codaEligible` / `turnLeftWorkPending`, orchestrator/index.ts) together with
 * the 24h-per-person cadence gate in the picker — it is a property of the turn
 * and only the turn can judge it. WRITING is this file's, and it happens LATER:
 * the orchestrator hands over a `PendingSocialCoda` and the transport calls
 * `composeSocialCoda` inside the beat it already waits before posting. The
 * work answer never waits on a social line (L7).
 *
 * v2.2.4 — language hint passed through so the coda matches the conversation's
 * actual language; discovery-mode for raise_new with no existing topics (ask
 * something concrete-and-discoverable rather than fabricating an "offsite next
 * month" topic that doesn't exist).
 *
 * gh#198 (answer 2/3/10/13) — GROUNDING. Nothing this composer raises is ever
 * guessed: before writing a line it grounds the candidate via `groundCoda`
 * below — ONE live Tavily search per coda (not one per category, not one per
 * subject), asking what's new in the person's territory, plus a re-read of
 * the person's ACTUAL past messages (not a topic-beat label) for a subject
 * being continued. Either source alone is sufficient — a search result is
 * enough to open with someone Maelle has no history for (answer 10); past
 * chat alone is enough even when the search contributes nothing (answer 3).
 * No grounding found → the coda does not fire; silence is the correct
 * outcome, not a fallback to a generic line. This supersedes the old
 * least-recently-used topic-beat hook, which grounded nothing — it only
 * picked a label to avoid repeating itself.
 *
 * The output is ONE short sentence, delivered by the transport as its OWN
 * in-thread message a beat after the task reply — never concatenated onto it,
 * which read as a topic swerve in the reply's last line ("…17:30 Sydney. Any
 * trips coming up?"). Two consequences for the prompt below: the sentence must
 * make sense read entirely ALONE, and it needs no connective, because the
 * message break is the transition. Task content always comes first, and the
 * transport drops the coda if the person speaks again inside that beat.
 */

import { getAnthropicClient } from '../../llm/client';
import { SONNET } from '../../llm/models';
import type { UserProfile } from '../../config/userProfile';
import type { SocialDirective } from './stateMachine';
import logger from '../../utils/logger';
import { tavilySearch } from '../../skills/general';
import { getPersonMemory, getRecentChannelMessages } from '../../db';
import {
  getActiveSubjectsForPersonCategory,
  getCategoryByLabel,
  recordCategoryRaiseAttempt,
  recordSubjectUnanswered,
} from '../../db/socialSubjects';

/**
 * Everything the coda needs, decided during the turn but COMPOSED later.
 *
 * The orchestrator settles eligibility (work resolved / parked, 1:1 DM, the
 * once-a-day cadence gate) while the turn is still in hand, and hands this over
 * on `OrchestratorOutput.socialCoda`. No text: composing it there put a Sonnet
 * call plus a claim-check between "answer ready" and "answer posted", so the
 * person waited two extra round-trips for their WORK answer to produce a line
 * the transport then deliberately posts a beat later (L7 — social never
 * delays real work). Composition now runs inside that beat, which is dead
 * time, so it costs no user-visible latency anywhere — including the
 * grounding search and message re-read added by gh#198 (answer 12: the beat
 * is a range precisely so a slower compose never has to race a fixed window).
 */
export interface PendingSocialCoda {
  directive: SocialDirective;
  /** Person-of-the-turn: owner id on owner turns, colleague id on colleague turns. */
  personSlackId: string;
  /** Absent on `raise_new` codas — there is no subject row yet. */
  subjectId?: string;
  /**
   * gh#198 — the DM channel this coda posts into, threaded through so
   * `groundCoda` can re-read this person's ACTUAL past messages via
   * SlackMaster's channel-scoped reader (`getRecentChannelMessages`) rather
   * than a topic-beat label. Absent only if the orchestrator ever fails to
   * populate it; grounding degrades to search-only in that case.
   */
  channelId?: string;
  senderRole: 'owner' | 'colleague';
  senderFirstName: string;
  language: 'he' | 'en';
}

/** What grounded this coda — at least one of the two must be present, or the
 *  coda does not fire (see `groundCoda`). */
export interface CodaGrounding {
  /** A snippet from the ONE live Tavily search run for this coda. */
  searchSnippet: string | null;
  /** A real excerpt from this person's own past messages (never the beat label). */
  pastChatSnippet: string | null;
}

// gh#198 (answer 16) — most specific location ON FILE, never inferred: a
// city/place in `people_memory.state` if present, else a coarse country
// derived from the IANA timezone. Only covers the zones actually seen in the
// person store; an unmapped zone returns null rather than guessing — this
// feeds a search QUERY, not a stored fact, but "never infer a city from a
// timezone" (people.ts:1506) still holds, so the fallback stays country-level
// and conservative (unmapped → omit location from the query entirely).
const TZ_COUNTRY: Record<string, string> = {
  'Asia/Jerusalem': 'Israel',
  'America/New_York': 'the US',
  'America/Los_Angeles': 'the US',
  'America/Chicago': 'the US',
  'America/Denver': 'the US',
  'Australia/Sydney': 'Australia',
  'Australia/Melbourne': 'Australia',
  'Australia/Canberra': 'Australia',
  'Europe/London': 'the UK',
  'Europe/Brussels': 'Belgium',
  'Europe/Paris': 'France',
  'Europe/Berlin': 'Germany',
  'Europe/Amsterdam': 'the Netherlands',
  'Europe/Madrid': 'Spain',
  'Europe/Rome': 'Italy',
};

function resolvePersonLocationForSearch(personSlackId: string): string | null {
  try {
    const person = getPersonMemory(personSlackId);
    if (!person) return null;
    if (person.state) return person.state;
    if (person.timezone) return TZ_COUNTRY[person.timezone] ?? null;
    return null;
  } catch (err) {
    logger.warn('Coda geo lookup threw — proceeding without location', { err: String(err).slice(0, 200) });
    return null;
  }
}

/**
 * Ground the candidate BEFORE composing. ONE live search (answer 3), plus a
 * re-read of this person's actual past messages when a subject/category
 * hint is available to search for (answer 13). Fails open per-source (a
 * thrown search or a thrown DB read just drops that one source) but fails
 * CLOSED overall: if neither source produced anything, returns null and the
 * coda does not fire — silence, per answer 3/10, is the correct outcome, not
 * a fallback to an ungrounded generic line.
 */
async function groundCoda(params: {
  directive: SocialDirective;
  personSlackId: string;
  channelId?: string;
}): Promise<CodaGrounding | null> {
  const { directive, personSlackId, channelId } = params;

  // Bug 2.2 — in `continue` mode a real subject IS being followed up on, so
  // the grounding search should target it specifically (e.g. the actual game
  // title), not the whole category — otherwise every "continue" coda in a
  // category re-runs the identical generic category search regardless of
  // which subject is nominally being continued, and a title that genuinely
  // holds the top spot for a while gets served back nearly verbatim each
  // time. `raise_new` has no subject yet, so category-first stays correct
  // and unchanged there.
  const topicHint = directive.mode === 'continue'
    ? (directive.subjectLabel ?? directive.categoryLabel ?? null)
    : (directive.categoryLabel ?? directive.subjectLabel ?? null);
  const location = resolvePersonLocationForSearch(personSlackId);
  const query = topicHint
    ? `${topicHint} — what's new or trending right now${location ? `, ${location}` : ''}`
    : location
      ? `What's new or trending in ${location} this week`
      : null;

  let searchSnippet: string | null = null;
  if (query) {
    try {
      const result = await tavilySearch(query, 'basic', 14) as { results?: Array<{ title?: string; content?: string }> };
      const first = (result.results ?? [])[0];
      const text = (first?.content || first?.title || '').trim();
      if (text) searchSnippet = text.slice(0, 300);
    } catch (err) {
      logger.warn('Coda grounding search threw — proceeding without it', { err: String(err).slice(0, 200) });
    }
  }

  // Cross-reference with the past chat WITH this person (answer 13) — the raw
  // thread text is already durable in conversation_threads; this is a plain
  // channel-scoped read over it, never a new index or backfill. A hit here can
  // ground the coda entirely on its own even when the search above contributed
  // nothing (answer 3).
  //
  // gh#198 (198-LIB-8) — role === 'user' ONLY. getRecentChannelMessages returns
  // BOTH roles, and every posted coda is itself appended to conversation_threads
  // as role:'assistant' (postReply.ts) — without this filter the snippet handed
  // to Sonnet under "Something they actually said before" could be Maelle's OWN
  // prior coda quoted back at the person as if they had said it.
  let pastChatSnippet: string | null = null;
  const needle = (directive.subjectLabel ?? directive.categoryLabel ?? '').trim().toLowerCase();
  if (channelId && needle) {
    try {
      const msgs = getRecentChannelMessages(channelId, 60, 20);
      const hit = msgs.filter(m => m.role === 'user' && m.content.toLowerCase().includes(needle)).slice(-1)[0];
      if (hit) pastChatSnippet = hit.content.slice(0, 300);
    } catch (err) {
      logger.warn('Coda past-message re-read threw — proceeding without it', { err: String(err).slice(0, 200) });
    }
  }

  if (!searchSnippet && !pastChatSnippet) return null;
  return { searchSnippet, pastChatSnippet };
}

async function generateSocialCoda(params: {
  profile: UserProfile;
  directive: SocialDirective;
  senderRole: 'owner' | 'colleague';
  senderFirstName: string;
  /** What grounded this coda (search result / actual past message). Required
   *  whenever mode is 'continue' or 'raise_new' — see `groundCoda`. */
  grounding: CodaGrounding;
  /**
   * Bug 2.2 — this person's OTHER live subjects in the same category as the
   * one being continued (real DB labels, excluding the subject itself), for
   * `continue` mode only. Additional real grounding the model MAY draw on
   * for personalization/variety — never a substitute for the subject-
   * specific search grounding above, and never invented content.
   */
  otherCategorySubjectLabels?: string[];
  /**
   * v2.2.4 — language hint for the coda. The orchestrator passes the
   * dominant language of the current conversation. Sonnet's prompt is
   * always English here; without an explicit instruction Sonnet will
   * default to English regardless of what the surrounding conversation
   * looks like. Pass 'he' for Hebrew, 'en' for English. Falls back to
   * English when omitted.
   */
  language?: 'he' | 'en';
}): Promise<string | null> {
  const { profile, directive, senderRole, senderFirstName, grounding, otherCategorySubjectLabels, language } = params;
  if (directive.mode === 'none') return null;

  const isOwner = senderRole === 'owner';
  const ownerFirst = profile.user.name.split(' ')[0];

  // gh#198 — the grounding line. Never both empty when mode is continue/
  // raise_new (composeSocialCoda already returned null upstream if so).
  const groundingLine = [
    grounding.pastChatSnippet
      ? `Something they actually said before, to ground this on — memory, not wording to echo verbatim: "${grounding.pastChatSnippet}"`
      : null,
    grounding.searchSnippet
      ? `Something real and current you found: ${grounding.searchSnippet}`
      : null,
  ].filter(Boolean).join(' ');

  // Bug 2.2 — real, on-file context only: this person's other live subjects
  // in the same category as the one being continued. The model MAY draw on
  // these for personalization/variety (e.g. noticing a pattern across their
  // interests in this category) but never MUST — never a substitute for the
  // subject-specific grounding above, and these are stored labels, not
  // invented content, so this doesn't touch the anti-fabrication guard.
  const otherSubjectsLine = otherCategorySubjectLabels && otherCategorySubjectLabels.length > 0
    ? `This person's other subjects in this same category, for context only, mention only if it fits naturally: ${otherCategorySubjectLabels.join(', ')}.`
    : '';

  // gh#198 (answer 11) — the shape is the model's and the topic's call: a
  // question, an observation, or a plain share are all legal for `continue`
  // and `raise_new`. Lifting the old "must be a question" mandate is the
  // change here — the anti-fabrication guards (NEVER assume/invent beyond
  // the grounding) and the audience framing below are untouched, because a
  // statement asserts facts a question doesn't and stays just as exposed to
  // the claim-check downstream.
  let intent: string;
  if (directive.mode === 'continue' && directive.subjectLabel) {
    // Subject labels are free text a Haiku pass derived from the DM
    // transcript, and they're written as MEMORY labels — filed from the
    // outside, about a person ("Idan's Boston trip" is a real row). Echoed
    // verbatim into a coda sent to that same person, that becomes the
    // third-person audience slip humanGate drops. Say the label is filing, not
    // phrasing.
    intent = `Follow up briefly on "${directive.subjectLabel}" — that's a memory label, not wording to echo; if it names the person you're writing to, engage with the thing itself, never with them by name. One short natural line — a question, an observation, or a plain share are all fair game; don't interrogate, don't recap what was said before. ${groundingLine}`;
  } else if (directive.mode === 'raise_new') {
    // v2.2.4 (bug 1B) — discovery mode. Without an existing topic to continue,
    // a "raise_new" coda was free to fabricate ("Are you joining the offsite
    // next month?"). Re-frame: ground it in something concrete and real,
    // whatever shape — question, observation or share — that takes.
    // v3.2.6 — anchor to a CONCRETE category the picker chose (music / weekend
    // / travel …) instead of a generic "how's your week". Owner liked the
    // category-anchored ping ("any good music lately?"). Still must NOT invent
    // specifics beyond the grounding.
    const cat = directive.categoryLabel;
    intent = cat
      ? `Bring up "${cat}" — a question, an observation, or a plain share are all fair game; the goal is genuine curiosity about what they're into in that area, your call how. Ground it in what's below; NEVER assume a specific item/event beyond it. ${groundingLine}`
      : `Open with something plainly human — a question, an observation, or a share, whichever fits; aimed at a real fact about them you don't already know. Ground it in what's below; NEVER invent beyond it. ${groundingLine}`;
  } else {
    // Only 'continue' and 'raise_new' ever reach this composer (composeSocialCoda's
    // only caller is the coda-eligible orchestrator path, which never produces a
    // PendingSocialCoda for any other mode — orchestrator/index.ts:1411). 'celebrate'
    // and 'engage' belong to the separate in-prompt directive (directiveForPersonSocial,
    // rendered by formatDirectiveForPromptBlock into the system prompt, never routed
    // through this file) — deleted here as unreachable (gh#198 answer 0). This branch
    // is a defensive fallback for 'continue' with no subjectLabel, not a live mode.
    intent = 'One short warm human follow-up.';
  }

  // v2.2.4 (bug 1A) — language hint. Coda matches the conversation language,
  // not the prompt language.
  const langLine = language === 'he'
    ? 'Write the coda in Hebrew. The conversation has been in Hebrew; an English coda would jar. Match the gendered forms to the person.'
    : language === 'en'
    ? 'Write the coda in English.'
    : '';

  // WHO is reading this. On BOTH paths the person the coda asks about IS the
  // person it is sent to (owner DM → the owner; colleague DM → that colleague),
  // but only the colleague path ever said so. On the owner path the prompt named
  // him as the subject of the ask and left the audience unstated, so nothing told
  // Sonnet the subject and the reader were the same person — the setup for "any
  // good music Idan's been into?" sent TO Idan. humanGate's owner branch calls
  // that "bizarre robot-speak" (utils/humanGate.ts:96), and it used to REWRITE it
  // because the coda rode inside the reply; now the coda runs the drop-only
  // runCodaGates, so the same slip discards the coda outright and an owner-path
  // coda silently stops arriving. Stating the frame on both paths is the root fix.
  //
  // No gendered pronoun for the reader anywhere below: the output may be Hebrew,
  // where second person inflects by gender, and langLine owns that (L2 — never
  // guess a gendered form).
  const audienceLine = isOwner
    ? `You're writing TO ${ownerFirst} — the person you work for is the one reading this. Address them directly; never name them or describe them from the outside, the way you would when speaking to someone else ("any trips coming up?", never "does ${ownerFirst} have any trips coming up?").`
    : `You're writing TO ${senderFirstName}, not to ${ownerFirst} — ${ownerFirst} isn't in this conversation. Address ${senderFirstName} directly; never name them or describe them from the outside.`;

  // 2026-08-18 (I10 / ledger:coda-ai-disclosure-non-english-gap) — this call
  // is a wholly separate prompt from systemPrompt.ts, so the main reply
  // path's "never volunteer that you're AI" line never reached it: nothing
  // below stopped an unprompted coda from volunteering an AI/bot claim, in
  // any language. runCodaGates' humanGate pass is the enforcement backstop
  // for that and is separately documented as unreliable on non-English
  // casual-aside claims (runOutputGates.ts:737-747) — that gap is
  // Gatekeeper's to close. This is the prevention half: don't generate the
  // claim to begin with, regardless of what language the coda lands in.
  // Folded into the existing "real human EA" bullet below rather than a new
  // one (same category — sounding like a colleague, not software).
  const prompt = `You're ${profile.assistant.name}, ${ownerFirst}'s executive assistant. ${audienceLine}

The task you just handled is either closed, or handed off and you're waiting on someone else. Either way it's off your plate for now and there's a quiet moment.

Compose one small human line to send into that quiet moment. It is NOT part of the task reply — it goes out as its own message in the same thread, landing a beat after it. It should:
- Be ONE short sentence, not two — warm and complete, not a clipped fragment
- Stand entirely alone. It arrives as a separate message, so the break itself is the transition: a connective ("Also" / "By the way" / "PS" / "speaking of") explains what the reader can already see and reads like padding — drop it. Equally, nothing that leans back on the task reply ("that too?", "as I said") — someone reading this line by itself has to understand it.
- ${intent}
- Feel like something a real human EA would send unprompted — never "let me know if you need anything!", never tool-leak, never a hint that you're AI, a bot, or software, in whatever language this lands in
- Match the register of a DM in the middle of a workday
${langLine ? `- ${langLine}` : ''}

${directive.toneCue ? `Tone: ${directive.toneCue}` : ''}
${otherSubjectsLine ? `\n${otherSubjectsLine}` : ''}

Output the coda sentence only. No quotes, no label.`;

  try {
    const anthropic = getAnthropicClient();
    const resp = await anthropic.messages.create({
      ...SONNET,
      max_tokens: 100,
      tools: [{
        name: 'compose_coda',
        description: 'Compose the coda sentence.',
        input_schema: {
          type: 'object' as const,
          properties: { sentence: { type: 'string' } },
          required: ['sentence'],
        },
      }],
      tool_choice: { type: 'tool', name: 'compose_coda' },
      messages: [{ role: 'user', content: prompt }],
    });
    const toolUse = resp.content.find((b: any) => b.type === 'tool_use') as any;
    const sentence = toolUse?.input?.sentence as string | undefined;
    if (!sentence) return null;
    return sentence.trim();
  } catch (err) {
    logger.warn('generateSocialCoda threw', { err: String(err).slice(0, 200) });
    return null;
  }
}

/**
 * Compose the coda for a pending directive: WRITE it, then VET it. One call, one
 * owner — the transport asks for a sentence and gets a sentence or nothing.
 *
 * Deliberately one function rather than two. The validator needs a snapshot of
 * what Maelle knows about the recipient — their state, timezone and free-text
 * personal notes — and that is people-lane data under a confidentiality rule
 * (L6). Splitting generate and validate would have made the transport assemble
 * that snapshot, putting a person's private notes in the pipes for no reason
 * the pipes have. It stays here, where it is already at home, and nothing but
 * the finished sentence ever leaves.
 *
 * Called from the transport INSIDE the beat, after the lull checks and before
 * the coda gates — so a coda the lull already killed costs nothing, including
 * the grounding search/message re-read below, which now run in the exact same
 * spot the topic-beat picker they replace used to. Same reasoning that moved
 * `recordCodaDelivered` to delivery: social bookkeeping is charged on the
 * thing actually happening, not on intending it.
 *
 * Returns null on anything short of a usable, vetted sentence. Never throws.
 */
export async function composeSocialCoda(
  pending: PendingSocialCoda,
  profile: UserProfile,
): Promise<string | null> {
  try {
    // gh#198 — ground the candidate BEFORE composing. Only 'continue' and
    // 'raise_new' ever reach this composer (the orchestrator's coda-eligible
    // path only produces those two modes), and both require grounding — no
    // grounding found means the beat silently does not fire (answer 3/10).
    let grounding: CodaGrounding = { searchSnippet: null, pastChatSnippet: null };
    if (pending.directive.mode === 'continue' || pending.directive.mode === 'raise_new') {
      const ground = await groundCoda({
        directive: pending.directive,
        personSlackId: pending.personSlackId,
        channelId: pending.channelId,
      });
      if (!ground) {
        logger.info('Coda not composed — no grounding found (silence is correct)', {
          personSlackId: pending.personSlackId, mode: pending.directive.mode,
        });
        return null;
      }
      grounding = ground;
    }

    // Bug 2.2 — for `continue`, hand the composer the person's OTHER live
    // subjects in this same category (real DB labels, subject being
    // continued excluded) so it can personalize/vary content by drawing on
    // real history, not just the one subject in isolation. Additional real
    // grounding on top of the subject-specific search above, never a
    // substitute for it.
    let otherCategorySubjectLabels: string[] | undefined;
    if (pending.directive.mode === 'continue' && pending.directive.subject) {
      try {
        otherCategorySubjectLabels = getActiveSubjectsForPersonCategory(
          pending.personSlackId, pending.directive.subject.category_id,
        )
          .filter(s => s.id !== pending.directive.subject!.id)
          .map(s => s.label);
      } catch (err) {
        logger.warn('Coda other-subjects lookup threw — proceeding without it', { err: String(err).slice(0, 200) });
      }
    }

    const coda = await generateSocialCoda({
      profile,
      directive: pending.directive,
      senderRole: pending.senderRole,
      senderFirstName: pending.senderFirstName,
      grounding,
      otherCategorySubjectLabels,
      language: pending.language,
    });
    if (!coda || coda.trim().length === 0) return null;

    // Bounce fix (gh#198) — mark this category "already suggested" the
    // moment there's an actual candidate sentence for it, so
    // pickDormantCategory (stateMachine.ts) never re-offers the same
    // untouched category tomorrow. Deliberately BEFORE the validator below:
    // even a candidate the validator later drops used up this category's one
    // free rotation slot, which is a harmless trade against the alternative
    // (re-asking the same thing on a loop). No-op for `continue` — only
    // `raise_new` ever names a category with nothing behind it yet.
    if (pending.directive.mode === 'raise_new' && pending.directive.categoryLabel) {
      try {
        const category = getCategoryByLabel(pending.directive.categoryLabel);
        if (category) {
          recordCategoryRaiseAttempt({
            ownerUserId: profile.user.slack_user_id,
            personSlackId: pending.personSlackId,
            categoryId: category.id,
          });
        }
      } catch (err) {
        logger.warn('Coda category-tried marker threw — proceeding', { err: String(err).slice(0, 200) });
      }
    }

    // v2.3.2 (2B) — validate against people_memory before it ships. Catches the
    // "shares my name" / "marathon training" hallucinations (invented facts) and
    // gossipy commentary about third parties. Reuses claimChecker with
    // mode='coda' so the same JSON contract / fail-open semantics apply. Fails
    // OPEN: if the validator can't reach a verdict the coda still ships — better
    // one weird coda than dropping every coda when the API blips. (The
    // guard-owned runCodaGates downstream is the fail-CLOSED half.)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { checkReplyClaims } = require('../../utils/claimChecker') as
        typeof import('../../utils/claimChecker');
      const personRow = getPersonMemory(pending.personSlackId);
      // A compact text snapshot of what we know about the recipient — the inputs
      // Sonnet should have been riffing on. Built and consumed inside this
      // function; it is never returned.
      const snapshot: string[] = [];
      if (personRow) {
        if (personRow.state) snapshot.push(`state: ${personRow.state}`);
        if (personRow.timezone) snapshot.push(`timezone: ${personRow.timezone}`);
        if (personRow.notes) {
          try {
            const notes = JSON.parse(personRow.notes) as Array<{ note?: string }>;
            for (const n of notes.slice(-10)) if (n.note) snapshot.push(`note: ${n.note}`);
          } catch { /* ignore */ }
        }
      }
      // The person store is the naming authority (L11) — prefer its canonical
      // name over the transport's display name, fall back to what we were given.
      const recipientName = personRow?.name || pending.senderFirstName || pending.personSlackId;
      const verdict = await checkReplyClaims({
        reply: coda,
        toolSummaries: [],
        bookingOccurred: false,
        ownerFirstName: profile.user.name.split(' ')[0],
        mode: 'coda',
        coda: {
          recipientName,
          recipientFactsSnapshot: snapshot.length > 0 ? snapshot.join('\n') : '(no notes / topics on record)',
          // coda-grounding-not-shown-to-validator (2026-08-16) — hand the
          // validator the same grounding the writer used (`grounding`, built
          // above by `groundCoda`), so a coda correctly grounded in a live
          // search result or the recipient's own past message is judged
          // against the evidence it was actually built from, not against
          // people_memory notes alone.
          groundingSearchSnippet: grounding.searchSnippet,
          groundingPastChatSnippet: grounding.pastChatSnippet,
        },
      });
      if (verdict.claimed_action === true) {
        logger.info('Coda dropped by validator', {
          reason: verdict.action_type, summary: verdict.action_summary,
          codaPreview: coda.slice(0, 120),
        });
        // coda-repeats-invented-personal-fact-no-negative-feedback (2026-08-19)
        // — a coda dropped here BEFORE send previously left no trace, so the
        // exact same fabricated claim about a real `continue`-mode subject
        // (e.g. presuming a finished game is still ongoing) was free to be
        // regenerated in a later session (observed twice, 2 days apart, on
        // Ghost of Tsushima — subj_U0F28CK6H_1784482213309_9vod, still `live`
        // with unanswered_raises=0 after both drops). Feed the SAME
        // negative-feedback counter a sent-then-ignored raise already uses
        // (recordSubjectUnanswered — dies at MAX_UNANSWERED_RAISES) so a
        // subject the model can't stop fabricating about eventually stops
        // being offered, instead of retrying forever. Scoped to `continue`
        // mode with a real subjectId and an actual invented-fact verdict
        // (not `gossipy`, which isn't about this subject's own staleness) —
        // `raise_new` has no subject row yet; its own pre-send cooldown is
        // `recordCategoryRaiseAttempt` above.
        if (pending.directive.mode === 'continue' && pending.subjectId && verdict.action_type === 'invented_fact') {
          try {
            recordSubjectUnanswered(pending.subjectId);
          } catch (err) {
            logger.warn('recordSubjectUnanswered (validator-dropped coda) threw — proceeding', {
              err: String(err).slice(0, 200),
            });
          }
        }
        return null;
      }
    } catch (err) {
      logger.warn('Coda validator threw — letting coda through (fail-open)', {
        err: String(err).slice(0, 200),
      });
    }

    return coda.trim();
  } catch (err) {
    logger.warn('composeSocialCoda threw — no coda this turn', { err: String(err).slice(0, 200) });
    return null;
  }
}
