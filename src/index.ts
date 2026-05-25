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

  const runningApps: Array<{ app: App; name: string }> = [];

  for (const [profileName, profile] of profiles) {
    try {
      const app = createSlackAppForProfile(profile);
      await app.start();
      runningApps.push({ app, name: profile.assistant.name });

      console.log(`  ✅ ${profile.assistant.name} → online (for ${profile.user.name})`);
      logger.info('Assistant online', {
        assistant: profile.assistant.name,
        user: profile.user.name,
        profile: profileName,
      });
    } catch (err) {
      logger.error('Failed to start assistant', { profileName, err });
      console.error(`  ❌ ${profileName} → failed to start (check tokens and YAML)`);
    }
  }

  if (runningApps.length === 0) {
    console.error('\n❌ No assistants started. Check your YAML files and Slack tokens.\n');
    process.exit(1);
  }

  logger.info('All assistants running in Socket Mode — no open ports', { count: runningApps.length });

  // v3.0.5 — startup-version DM removed. The Slack agent-panel surface treats
  // every DM as a chat row in the sidebar, so even a one-line "back online"
  // ping creates a phantom unread / empty-chat artifact every restart. Version
  // bumps are visible via CHANGELOG.md + git log; the owner doesn't need a
  // boot ping.

  // Initialise each profile: briefing cron, missed briefing check, catch-up messages
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
      initProfile(ownerApp.app, profile, dmChannel).catch(err =>
        logger.warn('Profile init failed', { user: profile.user.name, err: String(err) })
      );
    } catch (err) {
      logger.warn('Could not initialise profile', { user: profile.user.name, err: String(err) });
    }
  }

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
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { err });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);

    if (message.includes('server explicit disconnect') || message.includes('SocketModeClient')) {
      logger.warn('Slack WebSocket disconnected — reconnecting automatically', { message });
      return;
    }

    const detail = reason instanceof Error
      ? { message: reason.message, stack: reason.stack, name: reason.name }
      : { reason: message };
    logger.error('Unhandled rejection', detail);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
