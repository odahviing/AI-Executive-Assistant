import { config } from './config';
import { App } from '@slack/bolt';
import { createSlackAppForProfile } from './connectors/slack/app';
import { loadAllProfiles } from './config/userProfile';
import { getDb, getPreferences, savePreference } from './db';
import { startBackgroundTimer, initProfile } from './core/background';
import { seedAssistantSelf } from './core/assistantSelf';
import logger from './utils/logger';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json') as { version: string };

async function main(): Promise<void> {
  logger.info('Assistant platform starting up...', { env: config.NODE_ENV });

  getDb();
  logger.info('Database ready');

  const profiles = loadAllProfiles();

  // v1.6.2 — ensure each profile has a people_memory row for its assistant so
  // notes Idan teaches her about herself land somewhere real. Idempotent.
  for (const [, profile] of profiles) {
    try { seedAssistantSelf(profile); } catch (err) {
      logger.warn('Failed to seed assistant self-memory row', { err: String(err) });
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

  console.log(`\n${runningApps.length} assistant(s) running in Socket Mode — no open ports\n`);

  // Startup notification — delayed 180s so rapid dev restarts don't spam the owner.
  // ONLY fires when package.json version differs from the last-announced version
  // stored per-profile. Regular restarts (same version) stay silent.
  const VERSION_PREF_KEY = 'last_announced_version';
  setTimeout(() => {
    for (const [profileName, profile] of profiles) {
      const ownerApp = runningApps.find(a => a.name === profile.assistant.name);
      if (!ownerApp) continue;

      // Check the last-announced version for this profile
      const prefs = getPreferences(profileName);
      const lastVersionPref = prefs.find(p => p.key === VERSION_PREF_KEY);
      const lastVersion = lastVersionPref?.value;

      if (lastVersion === version) {
        logger.info('Startup notification skipped — version unchanged', {
          user: profile.user.name,
          version,
        });
        continue;
      }

      logger.info('Startup notification firing — version changed', {
        user: profile.user.name,
        previousVersion: lastVersion ?? '(none)',
        newVersion: version,
      });

      ownerApp.app.client.conversations.open({
        token: profile.assistant.slack.bot_token,
        users: profile.user.slack_user_id,
      }).then((dmResult: any) => {
        const dmChannel = dmResult.channel?.id;
        if (!dmChannel) return;
        return ownerApp.app.client.chat.postMessage({
          token: profile.assistant.slack.bot_token,
          channel: dmChannel,
          text: `Hi ${profile.user.name.split(' ')[0]}, ${profile.assistant.name} v${version} back online.`,
        });
      }).then(() => {
        // Persist the announced version so the next restart stays quiet
        savePreference({
          userId: profileName,
          category: 'system',
          key: VERSION_PREF_KEY,
          value: version,
          source: 'inferred',
        });
        logger.info('Startup notification sent', { user: profile.user.name, version });
      }).catch((err: unknown) => {
        logger.warn('Could not send startup notification', { err: String(err) });
      });
    }
  }, 180_000);

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
