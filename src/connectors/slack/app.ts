import { App, LogLevel } from '@slack/bolt';
import { config } from '../../config';
import type { UserProfile } from '../../config/userProfile';
import { auditLog } from '../../db';
import logger from '../../utils/logger';
import type { SenderRole, SlackAppContext } from './app/context';
import { resolveSlackMentions } from './app/helpers';
import { processMessage } from './app/processMessage';
import { processImageFileShare, scanAndPrepareImage } from './app/fileIngestion';
import {
  registerInboundReplayHandler,
  registerDmHandler,
  registerMpimHandler,
  registerReactionHandler,
  registerMentionHandler,
} from './app/handlers';

/**
 * RESPONSE RULES — Maelle only speaks when spoken to. v3.3.0 routing matrix:
 *
 *   1:1 DM      (D...)              → responds to every message from authorised user
 *   Group DM / MPIM (G...)          → responds when @mentioned, when she was the
 *                                     most-recent active speaker, OR when the
 *                                     addressee-gate votes RESPOND (v3.3.0 — the
 *                                     separate relevance classifier was removed)
 *   Channel — top-of-thread @mention → owner-presence gate applies (CH-2 caveat
 *                                     known); when owner participates, runs the
 *                                     thread-action engine (book / follow_up / other)
 *   Channel — mid-thread @mention   → thread-action engine if the owner is a thread
 *                                     participant (see `core/threadActions/`); otherwise
 *                                     silent. Reading the thread is EPHEMERAL —
 *                                     no people-memory upserts from a real-channel read
 *   Channel — no @mention            → silent
 *
 * She never reads or processes messages she wasn't addressed in.
 */
export function createSlackAppForProfile(profile: UserProfile): App {
  const { assistant, user } = profile;

  // v3.6.x — custom Bolt logger. @slack/socket-mode logs the finity
  // reconnect-race throw ("Unhandled event '…' in state '…'" / "server explicit
  // disconnect") at ERROR with a full stack on EVERY transient — spamming the
  // console with a multi-line stack per blip even though index.ts already
  // survives these and logs one clean warn. Without a custom logger Bolt uses a
  // default ConsoleLogger; here we route Bolt through winston and downgrade the
  // known socket transients to debug, so real Bolt errors still surface but the
  // handled reconnect noise doesn't. Same signature as index.ts isTransientSocketError.
  const boltLevel = config.NODE_ENV === 'development' ? LogLevel.WARN : LogLevel.ERROR;
  const SOCKET_TRANSIENT = /server explicit disconnect|Unhandled event '.*?' in state '.*?'|SocketModeClient|@slack\/socket-mode|finity/i;
  const boltLogger = {
    debug: (...m: unknown[]) => logger.debug(`bolt: ${m.map(String).join(' ')}`),
    info: (...m: unknown[]) => logger.info(`bolt: ${m.map(String).join(' ')}`),
    warn: (...m: unknown[]) => logger.warn(`bolt: ${m.map(String).join(' ')}`),
    error: (...m: unknown[]) => {
      const text = m.map(x => (x instanceof Error ? `${x.message}\n${x.stack ?? ''}` : String(x))).join(' ');
      if (SOCKET_TRANSIENT.test(text)) {
        logger.debug(`bolt socket transient (downgraded): ${text.slice(0, 180)}`);
        return;
      }
      logger.error(`bolt: ${text}`);
    },
    setLevel: () => {},
    getLevel: () => boltLevel,
    setName: () => {},
  };

  const app = new App({
    token: assistant.slack.bot_token,
    appToken: assistant.slack.app_token,
    signingSecret: assistant.slack.signing_secret,
    socketMode: true,
    logLevel: boltLevel,
    logger: boltLogger,
  });

  // v1.9.0 — register SlackConnection for this profile so skills (via the
  // router) can resolve it for outgoing messages. Nothing consumes this yet
  // in v1.9.0 sub-phase A; SummarySkill will be the first consumer in B,
  // then outreach + coord in C/D.
  //
  // Profile id comes from user.slack_user_id (stable per-owner identifier).
  {
    // Lazy import to avoid circular deps with connections/slack/index.ts
    // which imports from this module via messaging.ts.
    const { createSlackConnection } = require('../../connections/slack') as typeof import('../../connections/slack');
    const { registerConnection } = require('../../connections/registry') as typeof import('../../connections/registry');
    registerConnection(user.slack_user_id, createSlackConnection(app, assistant.slack.bot_token, profile));
  }

  // ── Colleague-mode testing ────────────────────────────────────────────────
  // Owner can say "test as colleague" to simulate the colleague experience.
  // Persists per-thread so follow-up messages in the same thread stay in colleague mode.
  // Owner says "stop testing" or "back to normal" to exit.
  const colleagueTestThreads = new Set<string>();

  function getSenderRole(senderId: string): SenderRole {
    return senderId === user.slack_user_id ? 'owner' : 'colleague';
  }

  // Bot user ID — fetched once at startup, used to detect self-mentions
  let botUserId: string | null = null;
  app.client.auth.test({ token: assistant.slack.bot_token })
    .then(r => { botUserId = r.user_id as string; logger.debug('Bot user ID', { botUserId }); })
    .catch(() => { logger.warn('Could not fetch bot user ID — mention dedup disabled'); });

  // ── Shared context ──────────────────────────────────────
  // ONE object threads the factory-owned state (profile, app, the live
  // botUserId, the colleague-test Set) + the cross-referencing helper fns to
  // the extracted modules. botUserId is a LIVE getter — never snapshot it.
  const ctx: SlackAppContext = {
    profile,
    app,
    colleagueTestThreads,
    getSenderRole,
    get botUserId() { return botUserId; },
    resolveSlackMentions: (text) => resolveSlackMentions(ctx, text),
    processMessage: (params) => processMessage(ctx, params),
    processImageFileShare: (params) => processImageFileShare(ctx, params),
    scanAndPrepareImage: (params) => scanAndPrepareImage(ctx, params),
  };

  // Register the inbound-replay closure + the four Bolt handlers in the
  // ORIGINAL order — Bolt dispatches app.message / app.event in registration
  // order, so this ordering is load-bearing.
  registerInboundReplayHandler(ctx);
  registerDmHandler(ctx);
  registerMpimHandler(ctx);
  registerReactionHandler(ctx);
  registerMentionHandler(ctx);

  return app;
}

// v2.0.7 — handleApprovalResponse retired with the legacy approval_queue
// table. Approvals today are resolved via the `approvals` table + Sonnet's
// free-text interpretation (resolve_approval tool); no command grammar needed.

// ── Socket watchdog (v3.3.x — recovery rewrite) ────────────────────────────────
//
// The v3.2.4 "never crash on a socket transient" handlers (index.ts) keep the
// process alive when the Slack socket dies — which, with recovery being
// startup-only, turned socket-death into a SILENT ZOMBIE: process up, socket
// dead, no inbound, no restart, no catch-up (2026-06-12/13). This watchdog
// closes that: it POLLS the documented public `client.connected` boolean (no
// API calls, no fragile finity event names — not a catch-up heartbeat) and:
//   • reconnect after a gap → fire ONE gap-scoped catch-up (recover what
//     arrived while the socket was down, without waiting for a restart).
//   • disconnected > threshold AND Slack API still reachable → exit(1) so the
//     supervisor (PM2 fork, autorestart) restarts clean → startup catch-up.
//     The auth.test gate prevents a restart-storm during a real Slack outage
//     (if the API is ALSO down, restarting won't help — ride it out).
const WATCHDOG_POLL_MS = 30 * 1000;
const DISCONNECT_EXIT_MS = 3 * 60 * 1000;

export function startSocketWatchdog(app: App, profile: UserProfile, ownerChannel: string): void {
  const profileId = profile.user.slack_user_id;
  const botToken = profile.assistant.slack.bot_token;
  let wasConnected = true;
  let disconnectedSinceMs: number | null = null;
  let watchdogDisabledLogged = false;

  setInterval(() => {
    void (async () => {
      const client = (app as any).receiver?.client;
      // CRITICAL fail-safe: `client.connected` is a runtime-internal of Bolt's
      // SocketModeReceiver. If that shape ever changes and the client object
      // isn't found, we CANNOT assess connectivity — and must NOT infer
      // "disconnected" (that would exit-loop a perfectly healthy bot). Skip the
      // poll entirely when the client/boolean is absent; recovery then falls
      // back to startup-only, never to a restart storm.
      if (!client || typeof client.connected !== 'boolean') {
        if (!watchdogDisabledLogged) {
          watchdogDisabledLogged = true;
          logger.warn('Socket watchdog: client.connected not reachable — watchdog disabled (startup catch-up still active)', { profileId });
        }
        return;
      }
      const connected: boolean = client.connected === true;

      if (connected) {
        if (!wasConnected) {
          // Reconnect after a gap → recover the downtime, scoped to the
          // watermark captured BEFORE we stamp the reconnect moment.
          const { getLastSocketAlive, stampSocketAlive } =
            require('./socketWatermark') as typeof import('./socketWatermark');
          const sinceMs = getLastSocketAlive(profileId) ?? undefined;
          logger.warn('Socket reconnected after a gap — running gap-scoped catch-up', {
            profileId, gapStartMs: sinceMs,
          });
          stampSocketAlive(profileId);
          try {
            const { catchUpMissedMessages } = require('../../core/background') as typeof import('../../core/background');
            await catchUpMissedMessages(app, profile, ownerChannel, sinceMs);
          } catch (err) {
            logger.error('Reconnect catch-up failed', { profileId, err: String(err).slice(0, 200) });
          }
        } else {
          // Healthy poll: stamp "alive" every tick while the socket is
          // genuinely connected. This keeps the watermark CURRENT during quiet
          // periods (no inbound for days) so a later crash recovers only the
          // real downtime, not the whole quiet stretch. Safe to stamp here —
          // unlike the bare process timer, this branch only runs when
          // client.connected === true, never in a dead-socket zombie state.
          try {
            (require('./socketWatermark') as typeof import('./socketWatermark')).stampSocketAlive(profileId);
          } catch { /* non-fatal */ }
        }
        wasConnected = true;
        disconnectedSinceMs = null;
        return;
      }

      // Disconnected.
      wasConnected = false;
      if (disconnectedSinceMs === null) {
        disconnectedSinceMs = Date.now();
        logger.warn('Socket reported disconnected — watching', { profileId });
        return;
      }
      if (Date.now() - disconnectedSinceMs < DISCONNECT_EXIT_MS) return;

      // Down past threshold. Only restart if Slack's API is reachable (socket-
      // specific problem a restart fixes) — not during a full Slack/network
      // outage (restarting won't help; avoid a PM2 max_restarts burn).
      let apiReachable = false;
      try { apiReachable = (await app.client.auth.test({ token: botToken }))?.ok === true; }
      catch { apiReachable = false; }
      if (!apiReachable) {
        logger.warn('Socket down but Slack API unreachable — likely an outage; NOT restarting', { profileId });
        return;
      }
      logger.error('Socket dead > threshold while API is reachable — exiting for a clean restart', {
        profileId, downMs: Date.now() - disconnectedSinceMs,
      });
      try { (require('./socketWatermark') as typeof import('./socketWatermark')).flushSocketWatermark(); } catch { /* noop */ }
      process.exit(1);
    })();
  }, WATCHDOG_POLL_MS).unref?.();
}

// ── Proactive messaging ───────────────────────────────────────────────────────
// Phase 3 — push messages to user without them initiating

export async function sendProactiveMessage(
  app: App,
  profile: UserProfile,
  text: string,
): Promise<void> {
  try {
    await app.client.chat.postMessage({
      token: profile.assistant.slack.bot_token,
      channel: profile.user.slack_user_id,
      text,
    });
    auditLog({
      action: 'proactive_message',
      source: 'system',
      actor: profile.assistant.name,
      target: profile.user.slack_user_id,
      details: { preview: text.slice(0, 100) },
      outcome: 'success',
    });
  } catch (err) {
    logger.error('Failed to send proactive message', { err, assistant: profile.assistant.name });
  }
}
