import { config } from './config';
import { App } from '@slack/bolt';
import { createSlackAppForProfile, startSocketWatchdog } from './connectors/slack/app';
import { stampSocketAlive, flushSocketWatermark, getLastSocketAlive } from './connectors/slack/socketWatermark';
import { startWhatsApp } from './connectors/whatsapp';
import { loadAllProfiles, type UserProfile } from './config/userProfile';
import { getDb } from './db';
import { startBackgroundTimer, initProfile, catchUpMissedMessages } from './core/background';
import { seedAssistantSelf } from './core/assistantSelf';
import { seedOwnerSelf } from './core/ownerSelf';
import logger from './utils/logger';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Build stamp for startup logging. Under PM2 the bot runs the COMPILED
 * `dist/index.js`, which only changes after `npm run build` — so a stale
 * `dist/` can silently keep running old code (observed 2026-05-28: a forgotten
 * PM2 process ran old `dist` alongside `npm run dev`). Logging version + git
 * SHA on every boot lets `pm2 logs maelle` confirm at a glance WHICH build is
 * live. Fail-safe: any read error degrades to 'unknown', never blocks startup.
 * __dirname resolves to repo/dist (PM2) or repo/src (ts-node-dev) — `..` is
 * the repo root in both.
 *
 * Container path: an image has no `.git`, so `git rev-parse` would always fail
 * and log gitSha='unknown' — losing the deploy-verification signal. The image
 * build injects APP_VERSION + GIT_SHA as envs (see Dockerfile); read those
 * first. Local/PM2 runs leave them unset and fall back to reading package.json +
 * git directly (byte-identical to before).
 */
function getBuildStamp(): { version: string; gitSha: string } {
  const repoRoot = join(__dirname, '..');
  let version = process.env.APP_VERSION || 'unknown';
  let gitSha = process.env.GIT_SHA || 'unknown';
  if (!process.env.APP_VERSION) {
    try {
      version = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version as string) ?? 'unknown';
    } catch { /* keep 'unknown' */ }
  }
  if (!process.env.GIT_SHA) {
    try {
      gitSha = execSync('git rev-parse --short HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch { /* keep 'unknown' — e.g. running outside a git checkout */ }
  }
  return { version, gitSha };
}

async function main(): Promise<void> {
  const build = getBuildStamp();
  logger.info('Assistant platform starting up...', { env: config.NODE_ENV, version: build.version, gitSha: build.gitSha });

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

  // ── Phase 2: fast per-profile setup (sockets still CLOSED) ───────────────
  // Idempotent LOCAL setup only — migrations, seeding, briefing cron. Fast, no
  // Slack API fan-out, so it doesn't delay the socket. The slow all-DMs catch-up
  // scan that used to run here (gating inbound for ~40s on every restart) now
  // runs in the BACKGROUND after the socket opens (Phase 4).
  //
  // We ALSO capture, per profile, the pre-boot socket watermark + owner DM
  // channel for Phase 4. Capturing the watermark HERE is essential: it must be
  // read before the socket is stamped alive (Phase 4 watchdog / any live
  // inbound), or the recovery gap collapses to zero and nothing is recovered.
  const catchUpQueue: Array<{ app: App; profile: UserProfile; dmChannel: string; sinceMs?: number }> = [];
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
      await initProfile(ownerApp.app, profile, dmChannel);
      catchUpQueue.push({
        app: ownerApp.app,
        profile,
        dmChannel,
        sinceMs: getLastSocketAlive(profile.user.slack_user_id) ?? undefined,
      });
    } catch (err) {
      logger.warn('Could not initialise profile (continuing)', {
        user: profile.user.name, err: String(err),
      });
    }
  }

  // ── Phase 3: open sockets ─────────────────────────────────────────────────
  // The socket opens as soon as the fast local setup (Phase 2) is done, so
  // Maelle is responsive within ~1s of boot instead of after the ~40s catch-up
  // scan. Slack flushes any queued (re-delivered) events to the live handler;
  // those dedup against the SAME atomic `markProcessed` claim the Phase 5
  // background catch-up uses, so a message re-delivered here and also seen by
  // catch-up is answered exactly once. Each app starts independently — a
  // failure on one doesn't block the others.
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

  // ── Phase 4: start WhatsApp transport (optional, per-profile, gated) ──────
  // Fire-and-forget. startWhatsApp returns immediately when the profile has no
  // whatsapp_phone configured (→ byte-identical to Slack-only). Even when
  // enabled, its puppeteer launch / QR-wait must NEVER block the rest of
  // startup, so we do NOT await it. Any failure is logged + alerted to the
  // owner on Slack from inside startWhatsApp; nothing here can crash boot.
  // (Runs after Phase 3 so the Slack connection — used for disconnect/QR
  // alerts — is fully up.)
  for (const [, profile] of profiles) {
    void startWhatsApp(profile).catch((err) =>
      logger.error('startWhatsApp failed (continuing — Slack unaffected)', {
        user: profile.user.name, err: String(err),
      }),
    );
  }

  // ── Socket watchdog — recovery on reconnect + restart-on-dead-socket ──────
  // v3.3.x. The socket just opened (Phase 3) → stamp the watermark, then start
  // the watchdog that polls connectivity, fires gap-scoped catch-up on a
  // reconnect, and exits (→ supervisor restart → startup catch-up) on a
  // persistent dead socket. Decouples recovery from "process just started",
  // closing the silent-zombie gap.
  for (const { app, name } of runningApps) {
    const profile = [...profiles.values()].find(p => p.assistant.name === name);
    if (!profile) continue;
    try {
      const dmRes = await app.client.conversations.open({
        token: profile.assistant.slack.bot_token,
        users: profile.user.slack_user_id,
      });
      const ownerChannel = (dmRes.channel as any)?.id as string | undefined;
      stampSocketAlive(profile.user.slack_user_id);
      if (ownerChannel) startSocketWatchdog(app, profile, ownerChannel);
    } catch (err) {
      logger.warn('Could not start socket watchdog (continuing)', { name, err: String(err).slice(0, 200) });
    }
  }

  // ── Phase 5: background catch-up (sockets are OPEN — she's already live) ──
  // Recover messages missed during downtime WITHOUT gating inbound: the socket
  // is up, so a fresh message is answered immediately by the live handler while
  // this scan runs behind it. Double-reply is impossible — markProcessed is a
  // shared atomic claim, so whichever of {live handler, this scan} reaches a
  // re-delivered message first wins and the other skips (replayMissedMessage's
  // mid-flight guard). Fire-and-forget per profile; one failure never blocks the
  // others or the process. Uses the pre-boot watermark captured in Phase 2.
  for (const ctx of catchUpQueue) {
    void catchUpMissedMessages(ctx.app, ctx.profile, ctx.dmChannel, ctx.sinceMs)
      .catch(err => logger.warn('Background catch-up failed (continuing)', {
        user: ctx.profile.user.name, err: String(err).slice(0, 200),
      }));
  }

  // Background timer — runs every 5 minutes
  startBackgroundTimer(runningApps, profiles);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Shutting down', { signal });
    // Persist the socket watermark so the next boot's catch-up scopes to the
    // real gap (this clean-stop moment), not a blind 24h window.
    try { flushSocketWatermark(); } catch { /* noop */ }
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

  // A WhatsApp (whatsapp-web.js / puppeteer) async error must not take the
  // whole process down — WhatsApp is an OPTIONAL transport, and its headless
  // Chrome can crash or the linked device can drop. startWhatsApp wraps its own
  // lifecycle, but a stray puppeteer rejection can still surface here. The
  // marker is deliberately NARROW (puppeteer / whatsapp-web / Chrome DevTools
  // protocol shapes) so unrelated bugs still exit as before.
  const isWhatsAppTransientError = (reason: unknown): boolean => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? (reason.stack ?? '') : '';
    return /puppeteer|whatsapp-web|Protocol error|Target closed|Session closed|Execution context was destroyed|Navigation failed/i
      .test(stack + ' ' + message);
  };

  process.on('uncaughtException', (err) => {
    if (isTransientSocketError(err)) {
      logger.warn('Slack socket-mode transient (uncaught) — staying up; socket reconnects', { message: err?.message });
      return;
    }
    if (isWhatsAppTransientError(err)) {
      logger.warn('WhatsApp transport error (uncaught) — staying up; Slack unaffected', { message: err?.message });
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

    if (isWhatsAppTransientError(reason)) {
      logger.warn('WhatsApp transport error — staying up; Slack unaffected', { message });
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
