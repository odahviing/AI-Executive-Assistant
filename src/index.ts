import { config } from './config';
import { App } from '@slack/bolt';
import { createSlackAppForProfile } from './connectors/slack/app';
import { loadAllProfiles } from './config/userProfile';
import { getDb } from './db';
import { startBackgroundTimer, initProfile } from './core/background';
import { seedAssistantSelf } from './core/assistantSelf';
import { seedOwnerSelf } from './core/ownerSelf';
import logger from './utils/logger';

async function main(): Promise<void> {
  logger.info('Assistant platform starting up...', { env: config.NODE_ENV });

  getDb();
  logger.info('Database ready');

  const profiles = loadAllProfiles();

  // Ensure each profile has a people_memory row for its assistant so notes
  // the owner teaches her about herself land somewhere real, plus an owner
  // self-row so Maelle can track personal/social moments about the owner
  // via note_about_self (parallel to colleagues). Both idempotent.
  for (const [, profile] of profiles) {
    try { seedAssistantSelf(profile); } catch (err) {
      logger.warn('Failed to seed assistant self-memory row', { err: String(err) });
    }
    try { seedOwnerSelf(profile); } catch (err) {
      logger.warn('Failed to seed owner self-memory row', { err: String(err) });
    }
  }

  if (profiles.size === 0) {
    console.error(
      '\n❌ No user profiles found in config/users/\n' +
      '   Copy config/users.example/user.example.yaml to config/users/<name>.yaml and fill it in.\n'
    );
    process.exit(1);
  }

  const runningApps: Array<{ app: App; name: string; profileName: string }> = [];

  // ── Phase 1: construct apps (don't open sockets yet) ─────────────────────
  // Bolt's `app.client` (WebClient) works pre-`app.start()` because the WebClient
  // is plain HTTPS; only socket-mode event delivery waits on `app.start()`. We
  // exploit this to run catch-up BEFORE the socket flushes queued events — see
  // Phase 2 rationale below.
  for (const [profileName, profile] of profiles) {
    try {
      const app = createSlackAppForProfile(profile);
      runningApps.push({ app, name: profile.assistant.name, profileName });
    } catch (err) {
      logger.error('Failed to construct assistant', { profileName, err });
      console.error(`  ❌ ${profileName} → construction failed (check tokens and YAML)`);
    }
  }

  if (runningApps.length === 0) {
    console.error('\n❌ No assistants constructed. Check your YAML files and Slack tokens.\n');
    process.exit(1);
  }

  // v3.0.5 — startup-version DM removed. The Slack agent-panel surface treats
  // every DM as a chat row in the sidebar, so even a one-line "back online"
  // ping creates a phantom unread / empty-chat artifact every restart. Version
  // bumps are visible via CHANGELOG.md + git log; the owner doesn't need a
  // boot ping.

  // ── Phase 2: catch up missed messages (sockets still CLOSED) ─────────────
  // Running catch-up BEFORE `app.start()` closes the double-reply race on
  // restart: `processedDedup`'s in-memory Set is empty after a process restart.
  // If we opened the socket first, Slack's at-least-once queue would flush
  // events to the live handler before catch-up could mark them processed —
  // catch-up later sees the same user message (Slack's history endpoint
  // not yet indexed for our just-posted reply) and posts a second "↩ Catching
  // up…" reply. Catch-up-first populates the dedup Set; when Phase 3 opens
  // the socket, the live handler dedups against it and skips the queued copy.
  for (const [, profile] of profiles) {
    const ownerApp = runningApps.find(a => a.name === profile.assistant.name);
    if (!ownerApp) continue;
    try {
      const dmResult = await ownerApp.app.client.conversations.open({
        token: profile.assistant.slack.bot_token,
        users: profile.user.slack_user_id,
      });
      const dmChannel = (dmResult.channel as any)?.id;
      if (!dmChannel) continue;
      // Await — was fire-and-forget. We MUST finish catch-up before any
      // socket opens, otherwise the race the rest of this block describes
      // re-opens.
      await initProfile(ownerApp.app, profile, dmChannel);
    } catch (err) {
      logger.warn('Could not initialise profile (continuing)', {
        user: profile.user.name, err: String(err),
      });
    }
  }

  // ── Phase 3: open sockets ─────────────────────────────────────────────────
  // Catch-up has populated `processedDedup` for every message it replied to.
  // Slack now flushes queued events to the live handler; `hasProcessed(ts)`
  // returns true for catch-up's targets → live handler skips. Fresh messages
  // that arrived during catch-up (or before catch-up ran) flow through
  // normally. Each app starts independently — a failure on one doesn't block
  // the others.
  for (const { app, name, profileName } of runningApps) {
    try {
      await app.start();
      console.log(`  ✅ ${name} → online (for profile ${profileName})`);
      logger.info('Assistant online', { assistant: name, profile: profileName });
    } catch (err) {
      logger.error('Failed to start assistant socket', { profileName, name, err });
      console.error(`  ❌ ${profileName} → failed to start (check tokens and YAML)`);
    }
  }

  logger.info('All assistants running in Socket Mode — no open ports', { count: runningApps.length });

  // Background timer — runs every 5 minutes
  startBackgroundTimer(runningApps, profiles);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Shutting down', { signal });
    await Promise.all(runningApps.map(({ app, name }) =>
      app.stop().then(() => logger.info('Assistant stopped', { name }))
    ));
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  // v3.2.x — a transient Slack socket-mode / finity reconnect-race error must
  // NEVER take the bot down. The marker often lives in the STACK, not the
  // message: the finity "Unhandled event 'server hello' in state 'connected'"
  // crash (2026-06-04) had no 'SocketModeClient' in its message — only the
  // stack — so the old message-only allowlist missed it, hit process.exit(1),
  // and with PM2 off the bot stayed dark all day. Check stack + message.
  const isTransientSocketError = (reason: unknown): boolean => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? (reason.stack ?? '') : '';
    return /SocketModeClient|@slack\/socket-mode|finity/i.test(stack)
      || /server explicit disconnect|Unhandled event '.*' in state '.*'/i.test(message);
  };

  process.on('uncaughtException', (err) => {
    if (isTransientSocketError(err)) {
      logger.warn('Slack socket-mode transient (uncaught) — staying up; socket reconnects', { message: err?.message });
      return;
    }
    logger.error('Uncaught exception', { err });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);

    if (isTransientSocketError(reason)) {
      logger.warn('Slack socket-mode transient — staying up; socket reconnects', { message });
      return;
    }

    // v3.2.x — do NOT exit on a stray rejection. Previously this exited, and
    // with no supervisor (PM2 off) one unhandled rejection took the bot down
    // until a manual restart. A long-running assistant logs loudly and keeps
    // running. (uncaughtException still exits — a sync uncaught throw can mean
    // corrupt state — but socket-mode transients survive there too, above.)
    const detail = reason instanceof Error
      ? { message: reason.message, stack: reason.stack, name: reason.name }
      : { reason: message };
    logger.error('Unhandled rejection (kept alive — not exiting)', detail);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
