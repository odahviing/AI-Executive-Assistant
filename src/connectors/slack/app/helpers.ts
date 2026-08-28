/**
 * Small helpers extracted from app.ts: channel-type predicates, the overload
 * detector, the KB-ingest narrator, and the @mention resolver. Only
 * resolveSlackMentions needs the shared context (live botUserId + app client).
 */

import { upsertPersonMemory } from '../../../db';
import { detectAndSaveGender } from '../../../utils/genderDetect';
import type { SlackAppContext } from './context';

  // ── Channel type helpers ──────────────────────────────────────────────────
  // Slack channel ID prefixes:
  //   D = 1:1 direct message
  //   C = public channel
  //   G = private channel OR multi-person DM (MPIM)
  //
  // We treat pure group DMs (MPIM) the same as 1:1 DMs — respond freely.
  // Private channels look the same as group DMs at the ID level, so we use
  // the isMpim flag from the event to tell them apart.

export function is1on1DM(channelId: string): boolean {
    return channelId.startsWith('D');
  }

  // ── Mention resolver ─────────────────────────────────────────────────────
  // Replace <@USERID> with "Real Name (slack_id: USERID)" so Claude can use
  // the Slack ID directly without a separate find_slack_user call.
  // Also saves each resolved person to people_memory for cross-session context.
export async function resolveSlackMentions(ctx: SlackAppContext, text: string): Promise<string> {
  const { app } = ctx;
  const { assistant, user } = ctx.profile;
    // Clean mailto links: <mailto:email|email> → email
    let resolved = text.replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1');

    // Clean plain angle-bracket links — strip `<URL>` brackets only, no info
    // loss. The `<URL|text>` form is left INTACT (v3.0.5, issue #113): pre-fix
    // we stripped to just the URL and lost the link text, so when the owner
    // typed `@Leor` Slack delivered `<linkedin.com/feed/#|Leor Eliashiv>` and
    // Maelle saw only the URL — then asked "who's behind that LinkedIn link?"
    // Sonnet reads Slack's native `<URL|text>` syntax fine; no normalization
    // needed.
    resolved = resolved.replace(/<(https?:\/\/[^|>]+)>/g, '$1');

    // Resolve ALL @mentions
    const mentionPattern = /<@([A-Z0-9]+)>/g;
    const userIds = [...new Set([...resolved.matchAll(mentionPattern)].map(m => m[1]))];
    if (userIds.length === 0) return resolved;

    interface ResolvedUser { name: string; email?: string; timezone?: string; }
    const nameMap: Record<string, ResolvedUser> = {};

    await Promise.all(userIds.map(async (userId) => {
      try {
        const info = await app.client.users.info({ token: assistant.slack.bot_token, user: userId });
        const u = info.user as any;
        const name = u?.real_name || u?.name || userId;
        nameMap[userId] = {
          name,
          email:    u?.profile?.email   || undefined,
          timezone: u?.tz               || undefined,
        };
        // Save to people_memory — skip the bot itself and the owner
        if (userId !== ctx.botUserId && userId !== user.slack_user_id) {
          upsertPersonMemory({
            slackId:  userId,
            name,
            email:    u?.profile?.email   || undefined,
            timezone: u?.tz               || undefined,
          });
          // Fire-and-forget gender detection: pronouns first, then profile image
          const imageUrl = u?.profile?.image_192 || u?.profile?.image_72 || undefined;
          detectAndSaveGender({
            slackId:   userId,
            name,
            pronouns:  u?.profile?.pronouns || undefined,
            imageUrl,
            botToken:  assistant.slack.bot_token,
          }).catch(() => {});
        }
      } catch (_) {
        nameMap[userId] = { name: userId };
      }
    }));

    // Replace <@USERID> with "Name (slack_id: USERID)" so Claude knows the ID immediately
    resolved = resolved.replace(/<@([A-Z0-9]+)>/g, (_, userId) => {
      // v3.3.x — a mention of the BOT ITSELF renders as just the assistant's
      // name, never "Maelle (slack_id: U0ARK...)". The slack_id is only useful
      // for DMing a person; Maelle never DMs herself, so exposing her own ID
      // into the prompt is pointless AND is the exact token that could get
      // echoed back to a colleague (Ayala 2026-06-12: "@Maelle see above"
      // rendered "Maelle (slack_id: U0ARK5814PQ) see above" into the turn).
      if (userId === ctx.botUserId) return assistant.name;
      const info = nameMap[userId];
      if (!info) return userId;
      return `${info.name} (slack_id: ${userId})`;
    });

    return resolved;
}

/**
 * The `<<GROUP DM — participants: …>>` model-facing preamble, built in ONE
 * place for the three surfaces that declare it as framing (the live MPIM
 * handler, an MPIM-shaped app_mention, and the reconnect catch-up replay).
 * The wording is load-bearing model instruction, so three hand-copies were a
 * drift risk (WORKSHOP.md's own origin story). `senderName` is optional only
 * because the replay path doesn't fetch the sender's name — a parameter, not
 * a fork of the text.
 */
export function buildGroupDmPreamble(nameEntries: string[], senderName?: string): string {
  return (
    `<<GROUP DM — participants: ${nameEntries.join(', ')}. ` +
    (senderName ? `Sender: ${senderName}. ` : '') +
    `All participants can see everything you write. ` +
    `Respond to ALL relevant people in the DM — when addressing a specific person, START your reply with <@their_slack_id> so they get a push notification. ` +
    `Do NOT say "tell her" or "let him know" when they are right here in this conversation.>>\n\n`
  );
}

  // Helper: detect Anthropic API "overloaded" errors (529) so we can surface
  // a human "coffee break" message instead of generic "something broke".
export function isOverloadError(err: unknown): boolean {
    const s = String((err as any)?.error?.error?.type ?? '');
    const msg = String(err ?? '');
    if (s === 'overloaded_error') return true;
    if ((err as any)?.status === 529) return true;
    return /overloaded|rate[_ ]?limit/i.test(msg);
  }

/**
 * The one line for "the model itself is overloaded" — a real 529 /
 * `overloaded_error` off the wire. Shared rather than repeated because it is the
 * same condition in the same voice wherever it surfaces, and the two callers reach
 * it from different shapes: `failureReply` below judges an ERROR OBJECT via
 * isOverloadError, while the doc-ingestion path in handlers.ts already holds a
 * boolean (`res.overloaded` off extractSlackDocText) and so cannot call
 * failureReply at all. A string can be shared across that difference even though
 * the function cannot.
 */
export const OVERLOAD_REPLY = `Quick coffee break, ping me again in a couple of minutes?`;

/**
 * What Maelle says when a turn dies before she could answer.
 *
 * TWO lines, and only two, because two is all we can honestly tell apart from
 * an error object. `isOverloadError` reads a real 529 / `overloaded_error` off
 * the wire, so "I'm busy, come back in a minute" is a claim we can back. Every
 * other failure — a DB read that threw, a guard module that wouldn't import, a
 * Slack 5xx — we cannot name from here, so we don't name it: the second line
 * admits a fault on our side and asks for a retry without inventing a cause.
 * Deliberately NOT "I'm busy" (that would be a false claim) and NOT "I'm
 * broken, don't bother" (unknowable — most of these are transient, and either
 * way the person's only lever is to try again or go to Idan).
 *
 * Single source for both catches in processMessage (pre-queue and in-runner)
 * so the wording can never drift between the two halves of the same turn.
 */
export function failureReply(err: unknown): string {
  return isOverloadError(err)
    ? OVERLOAD_REPLY
    : `Something's off on my end, give me a minute and try again?`;
}

