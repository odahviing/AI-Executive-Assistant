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
 * `composeSocialCoda` inside the 10s beat it already waits before posting. The
 * work answer never waits on a social line (L10).
 *
 * v2.2.4 — language hint passed through so the coda matches the conversation's
 * actual language; discovery-mode for raise_new with no existing topics (ask
 * something concrete-and-discoverable rather than fabricating an "offsite next
 * month" topic that doesn't exist).
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
import type { LegacySocialDirectiveShape as SocialDirective } from './stateMachine';
import logger from '../../utils/logger';
import {
  getRecentTopicBeats,
  pickLeastRecentlyUsedTopicBeat,
  markTopicBeatUsed,
} from '../../db/socialSubjects';

/**
 * Everything the coda needs, decided during the turn but COMPOSED later.
 *
 * The orchestrator settles eligibility (work resolved / parked, 1:1 DM, the
 * once-a-day cadence gate) while the turn is still in hand, and hands this over
 * on `OrchestratorOutput.socialCoda`. No text: composing it there put a Sonnet
 * call plus a claim-check between "answer ready" and "answer posted", so the
 * person waited two extra round-trips for their WORK answer to produce a line
 * the transport then deliberately posts 10 seconds later (L10 — social never
 * delays real work). Composition now runs inside that 10s beat, which is dead
 * time, so it costs no user-visible latency anywhere.
 */
export interface PendingSocialCoda {
  directive: SocialDirective;
  /** Person-of-the-turn: owner id on owner turns, colleague id on colleague turns. */
  personSlackId: string;
  /** Absent on `raise_new` codas — there is no subject row yet. */
  subjectId?: string;
  senderRole: 'owner' | 'colleague';
  senderFirstName: string;
  language: 'he' | 'en';
}

async function generateSocialCoda(params: {
  profile: UserProfile;
  directive: SocialDirective;
  senderRole: 'owner' | 'colleague';
  senderFirstName: string;
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
  const { profile, directive, senderRole, senderFirstName, language } = params;
  if (directive.mode === 'none') return null;

  const isOwner = senderRole === 'owner';
  const ownerFirst = profile.user.name.split(' ')[0];

  // v2.6.7 — for continue mode on an existing subject, pull a least-recently-
  // used topic-beat as a concrete hook (avoids spamming the same beat). Mark
  // it used so next time a different beat is preferred. Variety baked in.
  let topicBeatHook: string | null = null;
  if (directive.mode === 'continue' && directive.subjectId) {
    try {
      const lru = pickLeastRecentlyUsedTopicBeat(directive.subjectId);
      if (lru) {
        topicBeatHook = lru.label;
        markTopicBeatUsed(lru.id);
      } else {
        // No beats yet — fall back to a recent-beats list (likely also empty
        // but safe). Coda generator handles missing hook gracefully.
        const recent = getRecentTopicBeats(directive.subjectId, 3);
        if (recent.length > 0) topicBeatHook = recent[0].label;
      }
    } catch (err) {
      logger.warn('coda topic-beat picker threw — proceeding without hook', {
        err: String(err).slice(0, 200),
      });
    }
  }

  let intent: string;
  if (directive.mode === 'continue' && directive.topicLabel) {
    const hookLine = topicBeatHook
      ? ` Recent beat to lean on: "${topicBeatHook}" — same caveat, and only use it if it actually fits the moment, otherwise just ask in your own way.`
      : '';
    // Subject labels and topic beats are free text a Haiku pass derived from the
    // DM transcript, and they're written as MEMORY labels — filed from the
    // outside, about a person ("Idan's Boston trip" is a real row). Echoed
    // verbatim into a coda sent to that same person, that becomes the
    // third-person audience slip humanGate drops. Say the label is filing, not
    // phrasing.
    intent = `Follow up briefly on "${directive.topicLabel}" — that's a memory label, not wording to echo; if it names the person you're writing to, ask about the thing itself, never about them by name. One short natural line — don't interrogate, don't recap what was said before.${hookLine}`;
  } else if (directive.mode === 'raise_new') {
    // v2.2.4 (bug 1B) — discovery mode. Without an existing topic to continue,
    // a "raise_new" coda was free to fabricate ("Are you joining the offsite
    // next month?"). Re-frame: ask a concrete, *discoverable* question whose
    // answer is a real fact we'd save to memory.
    // v3.2.6 — anchor to a CONCRETE category the picker chose (music / weekend
    // / travel …) instead of a generic "how's your week". Owner liked the
    // category-anchored ping ("any good music lately?"). Still must NOT invent
    // specifics — ask an open question ABOUT that category, discovering what
    // they're into, not assuming a particular item/event exists.
    const cat = directive.categoryLabel;
    intent = cat
      ? `Ask ONE plain, open question about their interest in "${cat}" — discover what they're into in that area (e.g. ${cat} = music → what they've been listening to; travel → any trips coming up; weekend → plans this weekend; pets → whether they have any). NEVER assume a specific item/event exists ("that concert", "the marathon you mentioned") — ask open.`
      : `Ask ONE plain, open human question — something whose answer is a real fact about them you don't already know (what they do outside work, whether they're traveling). NEVER invent a specific event or shared context that doesn't exist.`;
  } else if (directive.mode === 'celebrate') {
    intent = `Briefly celebrate the ${directive.topicLabel ?? 'news'} they shared earlier.`;
  } else {
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
  // where second person inflects by gender, and langLine owns that (L12 — never
  // guess a gendered form).
  const audienceLine = isOwner
    ? `You're writing TO ${ownerFirst} — the person you work for is the one reading this. Address them directly; never name them or describe them from the outside, the way you would when speaking to someone else ("any trips coming up?", never "does ${ownerFirst} have any trips coming up?").`
    : `You're writing TO ${senderFirstName}, not to ${ownerFirst} — ${ownerFirst} isn't in this conversation. Address ${senderFirstName} directly; never name them or describe them from the outside.`;

  const prompt = `You're ${profile.assistant.name}, ${ownerFirst}'s executive assistant. ${audienceLine}

The task you just handled is either closed, or handed off and you're waiting on someone else. Either way it's off your plate for now and there's a quiet moment.

Compose one small human line to send into that quiet moment. It is NOT part of the task reply — it goes out as its own message in the same thread, landing a beat after it. It should:
- Be ONE short sentence, not two — warm and complete, not a clipped fragment
- Stand entirely alone. It arrives as a separate message, so the break itself is the transition: a connective ("Also" / "By the way" / "PS" / "speaking of") explains what the reader can already see and reads like padding — drop it. Equally, nothing that leans back on the task reply ("that too?", "as I said") — someone reading this line by itself has to understand it.
- ${intent}
- Feel like something a real human EA would send unprompted — never "let me know if you need anything!", never tool-leak
- Match the register of a DM in the middle of a workday
${langLine ? `- ${langLine}` : ''}

${directive.toneCue ? `Tone: ${directive.toneCue}` : ''}

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
 * (L9). Splitting generate and validate would have made the transport assemble
 * that snapshot, putting a person's private notes in the pipes for no reason
 * the pipes have. It stays here, where it is already at home, and nothing but
 * the finished sentence ever leaves.
 *
 * Called from the transport INSIDE the 10s beat, after the lull checks and
 * before the coda gates — so a coda the lull already killed costs nothing, and
 * `markTopicBeatUsed` (inside the generator, for `continue` mode) no longer
 * burns a topic beat on a line that never ships. Same reasoning that moved
 * `recordCodaDelivered` to delivery: social bookkeeping is charged on the thing
 * actually happening, not on intending it.
 *
 * Returns null on anything short of a usable, vetted sentence. Never throws.
 */
export async function composeSocialCoda(
  pending: PendingSocialCoda,
  profile: UserProfile,
): Promise<string | null> {
  try {
    const coda = await generateSocialCoda({
      profile,
      directive: pending.directive,
      senderRole: pending.senderRole,
      senderFirstName: pending.senderFirstName,
      language: pending.language,
    });
    if (!coda || coda.trim().length === 0) return null;

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
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getPersonMemory } = require('../../db') as typeof import('../../db');
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
      // The person store is the naming authority (L2) — prefer its canonical
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
        },
      });
      if (verdict.claimed_action === true) {
        logger.info('Coda dropped by validator', {
          reason: verdict.action_type, summary: verdict.action_summary,
          codaPreview: coda.slice(0, 120),
        });
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
