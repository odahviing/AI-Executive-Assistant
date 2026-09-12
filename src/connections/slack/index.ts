/**
 * SlackConnection — concrete Connection impl for Slack (v1.9.0).
 *
 * Wraps the existing messaging.ts primitives behind the Connection interface.
 * Zero behavior change vs. calling messaging.ts directly — this is the
 * adaptor layer.
 *
 * Skills import { Connection } from '../../connections/types' and receive
 * instances of this from the registry. They never import this file directly.
 */

import type { App } from '@slack/bolt';
import type { Connection, ConnectionChannel, ConnectionUser, SendResult } from '../types';
import type { UserProfile } from '../../config/userProfile';
import {
  sendDM,
  sendMpim,
  postToChannel as slackPostToChannel,
  findUserByName as slackFindUserByName,
  findChannelByName as slackFindChannelByName,
  resolveDmChannelId,
  resolveDmCounterpart,
  updateMessage as slackUpdateMessage,
  deleteMessage as slackDeleteMessage,
  type SendOutcome,
} from './messaging';
import { formatForSlack } from './formatting';
import { searchPeopleMemory } from '../../db';
import logger from '../../utils/logger';

function toSendResult(outcome: SendOutcome): SendResult {
  if (outcome.ok) return { ok: true, ref: outcome.channel_id, ts: outcome.ts, attachments_failed: outcome.attachments_failed };
  return { ok: false, reason: outcome.reason, detail: outcome.detail };
}

/** The turn's surface — `SkillContext.surface` (src/skills/types.ts), by value. */
type ToolSurface = 'owner_dm' | 'colleague_dm' | 'room';

/**
 * One find_slack_user hit BEFORE surface projection — what both sources (the
 * people_memory pull-through and Slack users.list) resolve to, so the payload
 * a caller receives is shaped in exactly one place: projectDirectoryMatch.
 */
interface DirectoryMatch {
  slack_id: string;
  name: string;
  timezone?: string;
  /** people_memory only: `timezone_set_by === 'auto'` — an inferred guess. */
  tzUnconfirmed: boolean;
  /** people_memory only — Slack's directory carries no city field. */
  state?: string;
  email?: string;
}

/**
 * W9 — the tool's payload is scoped HERE, by surface, before it reaches the
 * model; nothing downstream (prompt, guard) is asked to hold back what this
 * function already withheld.
 *
 *   room (MPIM / channel, whoever is typing — the owner is not owner in a
 *   shared space): IDENTITY ONLY, slack_id + name. Everything else on the row
 *   — timezone, city, email — is stored data the room prompt already strips
 *   from PEOPLE IN THIS THREAD; this tool used to hand it straight back
 *   ("who is Paul?" in a channel → Paul's city and email in the room).
 *
 *   owner_dm / colleague_dm: the full shape (tz + note, city, email). For a
 *   colleague asking about a third party this is wider than L6 tier 3 (name,
 *   timezone, language, availability) — whether city and email stay in a
 *   colleague DM is the owner's call and is deliberately left as it was.
 *
 *   undefined (an untyped caller omitted the required scope): treated as room.
 */
function projectDirectoryMatch(m: DirectoryMatch, surface: ToolSurface | undefined) {
  if (surface !== 'owner_dm' && surface !== 'colleague_dm') {
    return { slack_id: m.slack_id, name: m.name };
  }
  // `tz_iana` + `tz_note`, never a bare `timezone` (v2.6.6): Sonnet read the
  // IANA string as a city ("Since you're in Brisbane...", Shayan, May 10).
  return {
    slack_id: m.slack_id,
    name: m.name,
    tz_iana: m.timezone,
    tz_note: m.timezone
      ? `${!m.state ? 'City not on file — TZ is reliable for time math; only ask for city when location/venue matters.' : ''}${m.tzUnconfirmed ? ' Guessed, not confirmed — confirm before presenting their local time as fact.' : ''}`.trim() || undefined
      : 'No timezone on file for this person — Slack and people_memory have no signal. Do not assume UTC or any other zone; say you don\'t know their local time, or ask, rather than presenting a fabricated one.',
    state: m.state,
    email: m.email,
  };
}

/**
 * Build a SlackConnection bound to a specific Bolt app + token + profile.
 * Called once per profile on startup and registered in the Connection registry.
 *
 * v2.6.4 — profile threaded through so Slack-owned tools (find_slack_user)
 * can read owner-domain for external-email detection without needing context.
 */
export function createSlackConnection(app: App, botToken: string, profile: UserProfile): Connection {
  return {
    id: 'slack',

    // v2.0.2 — EVERY text-bearing method here runs its text through
    // formatForSlack before hitting the primitives (the four send verbs below
    // plus updateMessage). This scrubs internal leakage (sentinels, tool names)
    // and applies Slack's markdown dialect. formatForSlack is idempotent, so
    // callers that pre-format stay safe. Any remaining direct
    // `app.client.chat.postMessage` call sites will migrate through here.
    // If you add a verb that carries text, it goes through formatForSlack too —
    // that omission is exactly what made routine output render raw (see
    // updateMessage below).

    async sendDirect(recipientRef, text, opts) {
      const outcome = await sendDM(app, botToken, recipientRef, formatForSlack(text), {
        threadTs: opts?.threadTs,
        attachments: opts?.attachments,
        unfurl: opts?.unfurl,
      });
      return toSendResult(outcome);
    },

    async sendBroadcast(recipientRefs, text, opts) {
      if (recipientRefs.length === 0) return { ok: false, reason: 'no_recipients' };
      const formatted = formatForSlack(text);
      let lastErr: SendResult | null = null;
      let anyOk = false;
      for (const ref of recipientRefs) {
        const outcome = await sendDM(app, botToken, ref, formatted, { threadTs: opts?.threadTs });
        const result = toSendResult(outcome);
        if (result.ok) anyOk = true;
        else lastErr = result;
      }
      return anyOk ? { ok: true } : (lastErr ?? { ok: false, reason: 'all_failed' });
    },

    async sendGroupConversation(recipientRefs, text, opts) {
      const outcome = await sendMpim(app, botToken, recipientRefs, formatForSlack(text), { threadTs: opts?.threadTs });
      return toSendResult(outcome);
    },

    async postToChannel(channelRef, text, opts) {
      const outcome = await slackPostToChannel(app, botToken, channelRef, formatForSlack(text), {
        threadTs: opts?.threadTs,
        unfurl: opts?.unfurl,
        attachments: opts?.attachments,
      });
      return toSendResult(outcome);
    },

    async findUserByName(query): Promise<ConnectionUser[]> {
      const results = await slackFindUserByName(app, botToken, query);
      return results.map(u => ({ id: u.id, name: u.real_name || u.name, email: u.email }));
    },

    async findChannelByName(query): Promise<ConnectionChannel[]> {
      const results = await slackFindChannelByName(app, botToken, query);
      return results.map(c => ({ id: c.id, name: c.name }));
    },

    // v2.2.2 (#46) — pull core info from Slack's user directory. Maps
    // users.info → { timezone, pronouns, imageUrl, email, displayName }.
    // Slack doesn't expose a `state` (city/country) field directly, so we
    // skip that — owner-volunteered or state-from-state-via-locationTz fills.
    //
    // Contract (matches the interface doc): null means Slack CONFIRMED the
    // ref doesn't resolve (`user_not_found`) — the only case a caller may
    // read as "there is nothing there" and act accordingly (e.g. clear a
    // stale auto value). Any OTHER failure — rate limit, network blip,
    // `account_inactive`, a transient socket error — is "we don't know",
    // not "Slack says no", and must not collapse into the same null a
    // confirmed-absent read produces; that conflation is the exact failure
    // class the retired `m.tz || 'UTC'` fallback had (a missing READING
    // fabricated a permanent value). So those throw instead, and the caller
    // decides how to handle "couldn't read this one" (retry later, skip).
    async collectCoreInfo(ref) {
      let info;
      try {
        info = await app.client.users.info({ token: botToken, user: ref });
      } catch (err: any) {
        if (err?.data?.error === 'user_not_found') return null;
        throw err;
      }
      const u = info.user as any;
      if (!u) return null;
      return {
        timezone:    u?.tz || undefined,
        pronouns:    u?.profile?.pronouns || undefined,
        imageUrl:    u?.profile?.image_192 || u?.profile?.image_72 || undefined,
        email:       u?.profile?.email || undefined,
        displayName: u?.real_name || u?.name || undefined,
      };
    },

    // v2.6.4 — Slack-specific tools owned by the Connection itself, not by a
    // skill. Skills are activities (meetings, outreach, summary); Connections
    // are transports (Slack, email, future). Tools whose NAME or SEMANTICS
    // are transport-bound live here. Today: find_slack_channel + find_slack_user.
    // When EmailConnection lands, its getTools() will return find_email_thread,
    // list_unread, etc. — same pattern.
    getTools(_profile) {
      return [
        {
          name: 'find_slack_channel',
          description: 'Find a Slack channel ID by name. Use before message_colleague when the user specifies a channel (e.g. "post in #product") and you need the channel ID.',
          input_schema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Channel name to search for, with or without # (e.g. "product" or "#product")',
              },
            },
            required: ['name'],
          },
        },
        {
          name: 'find_slack_user',
          description: `Resolve a person to their Slack ID — used for sending Slack DMs.

CRITICAL — when to call this:
- You need to send a Slack DM (message_colleague, coord polling, heads-up).
- You don't already know their Slack ID from @mention or WORKSPACE CONTACTS.

DO NOT call this for booking meetings. Booking uses EMAIL, period.
- create_meeting takes attendees as { name, email }. No Slack ID required for any attendee.
- An external attendee (email outside the company domain) will NEVER have a Slack ID. That's normal. Outlook delivers calendar invites via email regardless.
- An internal attendee may not have a Slack ID either (guests, deactivated, fresh hires) — still book via email; the heads-up Slack DM step skips silently.

The result shape:
- { matches: [...] } — person(s) found, slack_id usable for DMs.
- { matches: [], external: true, email, message: ... } — query was an external email; proceed with that email for booking, no Slack DM possible.
- { matches: [] } — name didn't match anyone in the workspace; try a different spelling, or if the user gave you an email, just book directly without this tool.

If you already have an email for the person, you don't need this tool to book a meeting with them. Just call create_meeting with the email.`,
          input_schema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'The person\'s name, partial name, OR email address. When passed an email outside the owner\'s company domain, the tool returns { external: true } so you know to skip Slack and proceed directly with create_meeting.',
              },
            },
            required: ['name'],
          },
        },
      ];
    },

    // v3.3.7 (#125c) — person → DM channel, for verbatim conversation recall.
    async resolveDirectChannelId(userRef) {
      return resolveDmChannelId(app, botToken, userRef);
    },

    // v4.1.x (#51) — DM channel → person, the reverse direction. IM-only; the
    // primitive returns null for anything multi-party.
    async resolveChannelCounterpart(channelRef) {
      return resolveDmCounterpart(app, botToken, channelRef);
    },

    async reactToMessage(channelRef, messageTs, emojiName) {
      try {
        await app.client.reactions.add({
          token: botToken,
          channel: channelRef,
          timestamp: messageTs,
          name: emojiName,
        });
      } catch {
        // fire-and-forget; reactions failing is not a contract violation
      }
    },

    // v4.1.x (piece 2) — EDIT + RETRACT over chat.update / chat.delete, so the
    // placeholder-then-update pattern stops reaching into the Slack module.
    // formatForSlack on the update path is a BUG FIX, not symmetry: update is
    // the NORMAL path for routine output (the placeholder almost always posts),
    // so pre-fix the owner got raw `**bold**` / `## header` / `- ` markdown from
    // every routine, while the rare fresh-post fallback rendered clean.
    async updateMessage(channelRef, messageRef, text) {
      const res = await slackUpdateMessage(app, botToken, channelRef, messageRef, formatForSlack(text));
      return res.ok
        ? { ok: true, ref: channelRef, ts: messageRef }
        : { ok: false, reason: 'error', detail: res.detail };
    },

    async deleteMessage(channelRef, messageRef) {
      const res = await slackDeleteMessage(app, botToken, channelRef, messageRef);
      // No `ts` on success — the message it named is gone.
      return res.ok
        ? { ok: true, ref: channelRef }
        : { ok: false, reason: 'error', detail: res.detail };
    },

    // executeSkillTool (src/skills/registry.ts) forwards the required turn
    // surface from SkillContext through the Connection contract. Projection
    // still fails closed if an untyped caller omits or supplies an invalid scope.
    async executeToolCall(toolName, args, scope: { surface: ToolSurface }) {
      if (toolName === 'find_slack_channel') {
        const results = await slackFindChannelByName(app, botToken, args.name as string);
        return {
          channels: results.map(c => ({ id: c.id, name: c.name })),
          count: results.length,
        };
      }

      if (toolName === 'find_slack_user') {
        try {
          const query = (args.name as string).toLowerCase();
          const surface = scope?.surface;

          // v2.6.6 — people_memory pull-through. Before hitting the Slack
          // workspace, look in people_memory: a person we know comes back with
          // the same cautionary tz framing formatPeopleMemoryForPrompt uses on
          // owner-path (v4.8.x: including its unconfirmed-guess marker for an
          // auto-inferred zone — `tzUnconfirmed` in that function, src/db/
          // people.ts). This is also how a single-/multi-channel guest
          // resolves — users.list may omit guests, but one we have engaged
          // with has a row here. Slack workspace lookup stays as the fallback
          // for net-new names. Both sources resolve to DirectoryMatch; what the
          // caller receives is shaped once, by surface, in projectDirectoryMatch.
          let found: DirectoryMatch[] = [];
          let source: 'people_memory' | 'slack' = 'slack';
          try {
            found = searchPeopleMemory(args.name as string)
              .filter(p => p.slack_id && /^[UW][A-Z0-9]{6,}$/.test(p.slack_id))
              .map(p => ({
                slack_id: p.slack_id!,
                name: p.name,
                timezone: p.timezone || undefined,
                tzUnconfirmed: !!p.timezone && p.timezone_set_by === 'auto',
                state: p.state || undefined,
                email: p.email || undefined,
              }));
            if (found.length > 0) {
              source = 'people_memory';
              logger.info('find_slack_user — people_memory hit', { query: args.name, matches: found.length });
            }
          } catch (err) {
            logger.warn('find_slack_user — people_memory lookup threw, falling through to Slack', {
              err: String(err).slice(0, 200),
            });
          }

          // Paginate through all workspace members — avoids missing people in
          // large workspaces. A READ, nothing more: this used to upsert every
          // substring match (up to 20) into people_memory and fire gender
          // detection for each, so people merely searched for got a row and a
          // fresh `last_seen`, displacing real contacts from the last_seen-
          // ordered roster (formatPeopleMemoryForPrompt, src/db/people.ts).
          // Engagement earns the record, and every engagement path persists
          // on its own: an @mention (app/helpers.ts), a colleague's own
          // message (app/processMessage.ts), a room's members (app/
          // handlers.ts), an outreach send (skills/outreach.ts), a booking
          // (memory/recordBooking.ts). A search result the turn never acts on
          // is not one of them.
          if (found.length === 0) {
            let cursor: string | undefined;
            do {
              const result = await app.client.users.list({
                token: botToken,
                limit: 200,
                ...(cursor ? { cursor } : {}),
              });
              const members = (result.members as any[]) ?? [];
              for (const m of members) {
                if (
                  !m.deleted && !m.is_bot &&
                  (m.real_name?.toLowerCase().includes(query) ||
                   m.name?.toLowerCase().includes(query) ||
                   m.profile?.display_name?.toLowerCase().includes(query))
                ) {
                  found.push({
                    slack_id: m.id,
                    name:     m.real_name || m.profile?.display_name || m.name,
                    // `m.tz` absent means Slack reported NOTHING — no 'UTC'
                    // default, so the tz_note says "no signal" instead of
                    // presenting a fabricated zone as a reading.
                    timezone: m.tz || undefined,
                    tzUnconfirmed: false,
                    email:    m.profile?.email,
                  });
                }
              }
              cursor = (result.response_metadata as any)?.next_cursor || undefined;
            } while (cursor && found.length < 20);
          }

          // External-email signal — when query was an email AND no Slack match
          // AND email is outside owner's company domain, return external:true
          // so Sonnet doesn't read the empty result as "blocked, can't book".
          const queryRaw = (args.name as string).trim();
          const isEmail = /@/.test(queryRaw);
          const ownerEmail = (profile.user.email ?? '').toLowerCase();
          const ownerDomain = ownerEmail.includes('@') ? ownerEmail.split('@')[1] : '';
          const isExternalEmail = isEmail && ownerDomain &&
            !queryRaw.toLowerCase().endsWith('@' + ownerDomain);
          if (found.length === 0 && isExternalEmail) {
            return {
              matches: [],
              count: 0,
              external: true,
              email: queryRaw.toLowerCase(),
              message: `${queryRaw} is an external email (outside ${ownerDomain}) — they don't need a Slack ID. Proceed with create_meeting using the email; Outlook will deliver the calendar invite. Don't ask anyone to "forward the invite" — that's automatic.`,
            };
          }

          const matches = found.map(m => projectDirectoryMatch(m, surface));
          logger.info('find_slack_user', { query: args.name, matches: matches.length, source, surface: surface ?? 'unscoped' });
          return source === 'people_memory'
            ? { matches, count: matches.length, source }
            : { matches, count: matches.length };
        } catch (err) {
          logger.error('find_slack_user failed', { err: String(err) });
          return { error: String(err) };
        }
      }

      return null;
    },
  };
}
