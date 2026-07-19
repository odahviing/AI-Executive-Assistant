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

  // In DMs (1:1 or group), say() must NOT receive thread_ts — Bolt rejects it
export function isDirectContext(channelId: string, isMpim?: boolean): boolean {
    return is1on1DM(channelId) || isMpim === true;
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

  // Helper: detect Anthropic API "overloaded" errors (529) so we can surface
  // a human "coffee break" message instead of generic "something broke".
export function isOverloadError(err: unknown): boolean {
    const s = String((err as any)?.error?.error?.type ?? '');
    const msg = String(err ?? '');
    if (s === 'overloaded_error') return true;
    if ((err as any)?.status === 529) return true;
    return /overloaded|rate[_ ]?limit/i.test(msg);
  }

  // Helper: narrate a KB ingest result to the owner in-thread.
export async function postIngestResult(
    result: Awaited<ReturnType<typeof import('../../../skills/knowledge').ingestKnowledgeDoc>>,
    say: (text: string) => Promise<void>,
  ): Promise<void> {
    if (result.kind === 'created' && result.sectionId) {
      await say(`Filed under \`${result.sectionId}.md\`, ${result.summary || result.title || 'saved'}. Want it renamed or moved? Just tell me.`);
    } else if (result.kind === 'merged' && result.sectionId) {
      await say(`Added to your existing \`${result.sectionId}.md\`, ${result.summary || 'merged under a new update section'}.`);
    } else if (result.kind === 'sibling' && result.sectionId) {
      await say(`Filed as \`${result.sectionId}.md\` (sibling of a related section), ${result.summary || result.title || 'saved'}.`);
    } else if (result.kind === 'ambiguous') {
      await say(result.question || `Not sure where to file this. Want to give me a hint?`);
    } else if (result.kind === 'rejected') {
      if (result.reason === 'too_short' || result.reason === 'empty_condensed') {
        await say(`That file's too thin to keep as a standalone reference, was it clipped?`);
      } else if (result.reason === 'classifier_error') {
        await say(`I hit an issue classifying that, give me a moment and try again?`);
      } else {
        await say(`I don't think this is worth keeping in the knowledge base (${result.reason || 'not a clear knowledge doc'}). Let me know if I got that wrong.`);
      }
    }
  }
