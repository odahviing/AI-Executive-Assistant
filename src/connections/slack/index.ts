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
import type { Connection, ConnectionChannel, ConnectionUser, SendOptions, SendResult } from '../types';
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
import { upsertPersonMemory, searchPeopleMemory } from '../../db';
import { detectAndSaveGender } from '../../utils/genderDetect';
import logger from '../../utils/logger';

function toSendResult(outcome: SendOutcome): SendResult {
  if (outcome.ok) return { ok: true, ref: outcome.channel_id, ts: outcome.ts, attachments_failed: outcome.attachments_failed };
  return { ok: false, reason: outcome.reason, detail: outcome.detail };
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
    async collectCoreInfo(ref) {
      try {
        const info = await app.client.users.info({ token: botToken, user: ref });
        const u = info.user as any;
        if (!u) return null;
        return {
          timezone:    u?.tz || undefined,
          pronouns:    u?.profile?.pronouns || undefined,
          imageUrl:    u?.profile?.image_192 || u?.profile?.image_72 || undefined,
          email:       u?.profile?.email || undefined,
          displayName: u?.real_name || u?.name || undefined,
        };
      } catch {
        return null;
      }
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

    async executeToolCall(toolName, args) {
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

          // v2.6.6 — people_memory pull-through. Before hitting Slack
          // workspace, look in people_memory: if we know this person, return
          // them with the same cautionary "(timezone only, city unknown)"
          // suffix that formatPeopleMemoryForPrompt uses on owner-path. This
          // closes the duplication where colleague-path Sonnet got bare
          // `timezone: "Australia/Brisbane"` (and inferred Brisbane) while
          // owner-path Sonnet got the cautionary suffix. Single source of
          // truth: people_memory's renderer. Slack workspace lookup stays
          // as the fallback for net-new names.
          //
          // Privacy: same fields the caller would have learned via Slack
          // (slack_id, name, tz, email). No notes / preferences / topics —
          // those stay owner-only via formatPeopleMemoryForPrompt.
          try {
            const memoryHits = searchPeopleMemory(args.name as string);
            const cleanFromMemory = memoryHits
              .filter(p => p.slack_id && /^[UW][A-Z0-9]{6,}$/.test(p.slack_id))
              .map(p => ({
                slack_id: p.slack_id,
                name: p.name,
                tz_iana: p.timezone || 'UTC',
                tz_note: p.timezone && !p.state ? 'City not on file — TZ is reliable for time math; only ask for city when location/venue matters.' : undefined,
                state: p.state || undefined,
                email: p.email || undefined,
              }));
            if (cleanFromMemory.length > 0) {
              logger.info('find_slack_user — people_memory hit', {
                query: args.name, matches: cleanFromMemory.length,
              });
              return { matches: cleanFromMemory, count: cleanFromMemory.length, source: 'people_memory' };
            }
          } catch (err) {
            logger.warn('find_slack_user — people_memory lookup threw, falling through to Slack', {
              err: String(err).slice(0, 200),
            });
          }

          // Store full raw member alongside match so we can read pronouns/image later
          const matches: Array<{ slack_id: string; name: string; timezone: string; email?: string; _raw: any }> = [];
          let cursor: string | undefined;

          // Paginate through all workspace members — avoids missing people in large workspaces
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
                matches.push({
                  slack_id: m.id,
                  name:     m.real_name || m.profile?.display_name || m.name,
                  timezone: m.tz || 'UTC',
                  email:    m.profile?.email,
                  _raw:     m,
                });
              }
            }

            cursor = (result.response_metadata as any)?.next_cursor || undefined;
          } while (cursor && matches.length < 20);

          // Persist all matches into people_memory and kick off gender detection.
          // Side-effect of finding someone on this transport: cache directory data.
          for (const match of matches) {
            upsertPersonMemory({
              slackId:  match.slack_id,
              name:     match.name,
              email:    match.email,
              timezone: match.timezone,
            });
            detectAndSaveGender({
              slackId:  match.slack_id,
              name:     match.name,
              pronouns: match._raw?.profile?.pronouns || undefined,
              imageUrl: match._raw?.profile?.image_192 || match._raw?.profile?.image_72 || undefined,
              botToken,
            }).catch(() => {});
          }

          // Fallback for guest users: users.list() may not return single/multi-channel guests.
          // If no matches found, check people_memory for a known slack_id and validate via users.info().
          if (matches.length === 0) {
            const memoryMatches = searchPeopleMemory(args.name as string);
            for (const pm of memoryMatches) {
              if (!pm.slack_id || !/^U[A-Z0-9]{7,11}$/.test(pm.slack_id)) continue;
              try {
                const info = await app.client.users.info({ token: botToken, user: pm.slack_id });
                const u = info.user as any;
                if (u && !u.deleted) {
                  matches.push({
                    slack_id: u.id,
                    name: u.real_name || u.profile?.display_name || u.name,
                    timezone: u.tz || 'UTC',
                    email: u.profile?.email,
                    _raw: u,
                  });
                  upsertPersonMemory({
                    slackId: u.id,
                    name: u.real_name || u.profile?.display_name || u.name,
                    email: u.profile?.email,
                    timezone: u.tz || 'UTC',
                  });
                  logger.info('Found guest user via users.info fallback', { slackId: u.id, name: u.real_name });
                }
              } catch {
                // users.info failed — ID might be invalid, skip
              }
            }
          }

          // v2.6.6 — rename `timezone` → `tz_iana` + add `tz_note` so Sonnet
          // doesn't read the IANA tz string as a city. Same shape as the
          // people_memory pull-through above; one source of truth for the
          // cautionary framing. Pre-fix, `timezone: "Australia/Brisbane"`
          // had Sonnet writing "Since you're in Brisbane..." (Shayan, May 10).
          const cleanMatches = matches.map(({ _raw: _raw, timezone, ...m }) => {
            void _raw;
            return {
              ...m,
              tz_iana: timezone || 'UTC',
              tz_note: timezone ? 'City not on file — TZ is reliable for time math; only ask for city when location/venue matters.' : undefined,
              state: undefined,
            };
          });

          // External-email signal — when query was an email AND no Slack match
          // AND email is outside owner's company domain, return external:true
          // so Sonnet doesn't read the empty result as "blocked, can't book".
          const queryRaw = (args.name as string).trim();
          const isEmail = /@/.test(queryRaw);
          const ownerEmail = (profile.user.email ?? '').toLowerCase();
          const ownerDomain = ownerEmail.includes('@') ? ownerEmail.split('@')[1] : '';
          const isExternalEmail = isEmail && ownerDomain &&
            !queryRaw.toLowerCase().endsWith('@' + ownerDomain);
          if (cleanMatches.length === 0 && isExternalEmail) {
            return {
              matches: [],
              count: 0,
              external: true,
              email: queryRaw.toLowerCase(),
              message: `${queryRaw} is an external email (outside ${ownerDomain}) — they don't need a Slack ID. Proceed with create_meeting using the email; Outlook will deliver the calendar invite. Don't ask anyone to "forward the invite" — that's automatic.`,
            };
          }

          logger.info('find_slack_user', { query: args.name, matches: cleanMatches.length });
          return { matches: cleanMatches, count: cleanMatches.length };
        } catch (err) {
          logger.error('find_slack_user failed', { err: String(err) });
          return { error: String(err) };
        }
      }

      return null;
    },
  };
}
