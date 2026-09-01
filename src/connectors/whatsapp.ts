/**
 * WhatsApp inbound connector (whatsapp-web.js, unofficial linked-device).
 *
 * STEP 1 of the WhatsApp transport build (.claude/WHATSAPP_PROJECT.md):
 * owner front-door only, multi-tenant, crash-safe. WIRED AND RUNNING:
 * src/index.ts imports `startWhatsApp` and calls it at boot (Phase 4) for
 * every profile, with a watchdog around it for transient errors. It is
 * inert per-profile unless that profile's YAML sets `whatsapp_phone`
 * (no-op otherwise, byte-identical to Slack-only — see startWhatsApp
 * below), and inbound is owner-phone-only — every other sender is
 * silently dropped before any content work (the trust gate below).
 *
 * What this half does (inbound):
 *   - Owner (phone === profile.user.whatsapp_phone) → full owner orchestrator
 *     turn on channel:'whatsapp', text + voice both directions.
 *   - Anyone else (1:1) → SILENT DROP. No reply, before any content work.
 *     The colleague path + trust gate land in Step 5.
 *   - Groups / status / broadcast → dropped in Step 1 (groups land in Step 6).
 *
 * Multi-tenant: owner phone comes from the per-profile YAML (env is a dev-only
 * fallback). Clients keyed by profile id. Temp files via os.tmpdir(). No
 * hardcoded phone / path.
 *
 * Resilience: disconnect / auth_failure / QR all alert the owner ON SLACK (the
 * one transport we know is still up when WhatsApp drops) and reconnect is
 * bounded + backed-off, never an infinite blind loop.
 */

import { Client, LocalAuth, Message, MessageMedia } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import path from 'path';
import fs from 'fs';
import os from 'os';
import type { UserProfile } from '../config/userProfile';
import { config } from '../config';
import { getConversationHistory, appendToConversation } from '../db';
import { runOrchestrator } from '../core/orchestrator';
import { textToSpeech, shouldRespondWithAudio } from '../voice';
import { getConnection } from '../connections/registry';
import logger from '../utils/logger';

// Session stored in data dir so it persists across restarts. LocalAuth
// namespaces by clientId (= profile id) under here, so this is multi-tenant
// safe even though the parent dir is shared.
const SESSION_DIR = path.join(process.cwd(), 'data', 'whatsapp-session');

// profileId -> Client. Multi-tenant: each profile links its own phone.
const waClients = new Map<string, Client>();

/** The live WhatsApp client for a profile, or null if not started/connected. */
export function getWhatsAppClient(profileId: string): Client | null {
  return waClients.get(profileId) ?? null;
}

// ── Phone normalization ─────────────────────────────────────────────────────
// Step 1 keeps this minimal: strip the WhatsApp JID suffix and any non-digits
// so "+972 50-123 4567", "972501234567@c.us" and "972501234567" all collapse
// to one canonical digits-only form. The fuller E.164 helper + person-store
// matching lands in Step 3 (identity); this is enough to compare against the
// owner's configured number.
function normalizePhone(raw: string): string {
  return (raw || '').replace(/@c\.us|@s\.whatsapp\.net|@g\.us/g, '').replace(/\D/g, '');
}

/** Owner phone from profile (preferred) or env (dev fallback). Undefined → off. */
function getOwnerPhone(profile: UserProfile): string | undefined {
  const fromProfile = normalizePhone(profile.user.whatsapp_phone ?? '');
  if (fromProfile) return fromProfile;
  const fromEnv = normalizePhone(config.WHATSAPP_OWNER_PHONE ?? '');
  return fromEnv || undefined;
}

// ── Inbound dedup ───────────────────────────────────────────────────────────
// whatsapp-web.js delivers each message once while connected, but can replay
// on reconnect. Keyed by the message's stable serialized id. Process-global +
// TTL, modeled on connectors/slack/processedDedup.ts.
const processedMsgIds = new Set<string>();
const MSG_TTL_MS = 10 * 60 * 1000;
function markProcessed(id: string): boolean {
  if (!id) return true; // no id → can't dedup; let it through
  if (processedMsgIds.has(id)) return false;
  processedMsgIds.add(id);
  setTimeout(() => processedMsgIds.delete(id), MSG_TTL_MS);
  return true;
}

function msgId(message: Message): string {
  const id = message.id as unknown as { _serialized?: string } | string | undefined;
  if (!id) return '';
  return typeof id === 'string' ? id : (id._serialized ?? '');
}

// ── Slack alert (resilience surface) ────────────────────────────────────────
// When WhatsApp drops, we cannot reach the owner on WhatsApp — alert on Slack
// via the connection registry (Slack is registered during its own startup).
// No direct connectors/slack import → invariant 6 preserved.
async function alertOwnerOnSlack(profile: UserProfile, text: string): Promise<void> {
  try {
    const slack = getConnection(profile.user.slack_user_id, 'slack');
    if (!slack) {
      logger.warn('WhatsApp alert: no Slack connection registered — cannot notify owner', {
        profileId: profile.user.slack_user_id,
      });
      return;
    }
    await slack.sendDirect(profile.user.slack_user_id, text);
  } catch (err) {
    logger.error('WhatsApp → Slack alert failed', { err: String(err) });
  }
}

function getChromePath(): string | undefined {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) { /* ignore */ }
  }
  return undefined; // fall back to bundled Chromium
}

/**
 * Start the WhatsApp client for a given profile. No-op (disabled) when the
 * profile has no whatsapp_phone. Shows a QR on first link, then reconnects.
 *
 * Called from src/index.ts at boot for every profile (fire-and-forget).
 */
export async function startWhatsApp(profile: UserProfile): Promise<void> {
  const ownerPhone = getOwnerPhone(profile);
  if (!ownerPhone) {
    logger.info('WhatsApp disabled — no whatsapp_phone in profile (or env)', {
      profileId: profile.user.slack_user_id,
    });
    return;
  }

  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  const client = new Client({
    authStrategy: new LocalAuth({
      dataPath: SESSION_DIR,
      clientId: profile.user.slack_user_id, // per-profile session namespace
    }),
    puppeteer: {
      headless: true,
      executablePath: getChromePath(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-timer-throttling',
      ],
    },
  });

  // ── Bounded, backed-off reconnect (replaces the old infinite blind loop) ──
  let reconnectAttempts = 0;
  const MAX_RECONNECT = 5;
  const scheduleReconnect = (): void => {
    if (reconnectAttempts >= MAX_RECONNECT) {
      logger.error('WhatsApp reconnect gave up after max attempts', {
        profileId: profile.user.slack_user_id,
        attempts: reconnectAttempts,
      });
      void alertOwnerOnSlack(
        profile,
        "WhatsApp didn't come back after several reconnect attempts. Please open WhatsApp → Settings → Linked Devices and re-scan the QR shown in the server terminal.",
      );
      return;
    }
    const delay = Math.min(10_000 * 2 ** reconnectAttempts, 5 * 60 * 1000);
    reconnectAttempts++;
    logger.info('WhatsApp scheduling reconnect', {
      profileId: profile.user.slack_user_id,
      attempt: reconnectAttempts,
      delayMs: delay,
    });
    setTimeout(() => {
      client.initialize().catch((err) =>
        logger.error('WhatsApp reconnect initialize failed', { err: String(err) }),
      );
    }, delay);
  };

  client.on('qr', (qr) => {
    console.log('\n📱 Scan this QR code with WhatsApp to connect Maelle:\n');
    qrcode.generate(qr, { small: true });
    console.log('\nOpen WhatsApp → Settings → Linked Devices → Link a Device\n');
    void alertOwnerOnSlack(
      profile,
      'WhatsApp needs to be linked. A QR code is waiting in the server terminal — scan it from WhatsApp → Settings → Linked Devices.',
    );
  });

  client.on('ready', () => {
    reconnectAttempts = 0; // healthy again — reset backoff
    logger.info('WhatsApp connected', {
      assistant: profile.assistant.name,
      user: profile.user.name,
    });
    console.log(`✅ WhatsApp connected for ${profile.assistant.name}`);
  });

  client.on('auth_failure', (msg) => {
    logger.error('WhatsApp auth failure', { msg: String(msg) });
    void alertOwnerOnSlack(
      profile,
      'WhatsApp authentication failed — the linked device was likely removed. Please re-scan the QR shown in the server terminal.',
    );
  });

  client.on('disconnected', (reason) => {
    logger.warn('WhatsApp disconnected', { reason: String(reason) });
    void alertOwnerOnSlack(
      profile,
      `WhatsApp link dropped (${String(reason)}). I'm trying to reconnect — if it doesn't come back shortly, re-scan the QR in the terminal.`,
    );
    scheduleReconnect();
  });

  client.on('message', async (message: Message) => {
    try {
      await handleWhatsAppMessage(message, profile, client, ownerPhone);
    } catch (err) {
      // Never let a handler throw escape to the process — invariant 5.
      logger.error('WhatsApp message handler error', { err: String(err) });
    }
  });

  waClients.set(profile.user.slack_user_id, client);

  try {
    await client.initialize();
  } catch (err) {
    // A failed init must not crash startup — log loud, alert, let reconnect try.
    logger.error('WhatsApp initialize failed', {
      profileId: profile.user.slack_user_id,
      err: String(err),
    });
    void alertOwnerOnSlack(
      profile,
      "WhatsApp couldn't start up. I'll keep running on Slack — check the server terminal for a QR or error.",
    );
  }
}

// ── Message handler (owner-only in Step 1) ──────────────────────────────────

async function handleWhatsAppMessage(
  message: Message,
  profile: UserProfile,
  client: Client,
  ownerPhone: string,
): Promise<void> {
  // Dedup first — cheap, and a reconnect replay must not double-process.
  if (!markProcessed(msgId(message))) return;

  // Step 1: drop groups / status / broadcast (groups land in Step 6).
  if (message.from.includes('@g.us') || message.from.includes('@broadcast')) return;

  // ── TRUST GATE ──────────────────────────────────────────────────────────
  // Resolve sender by PHONE ONLY. In Step 1 the only known phone is the owner;
  // everyone else is dropped SILENTLY before any content work — no body read,
  // no media download, no transcription, no history, no orchestrator. The
  // colleague path (known non-owner) arrives in Step 5.
  const senderPhone = normalizePhone(message.from);
  if (senderPhone !== ownerPhone) {
    // No reply, no body in the log — a stranger gets exactly zero signal.
    logger.debug('WhatsApp non-owner 1:1 — dropped (silent)', {
      profileId: profile.user.slack_user_id,
    });
    return;
  }

  // ── Owner path — full orchestrator turn ─────────────────────────────────
  // threadTs = channelId = the WhatsApp chat id (§5.5): one continuous
  // conversation per chat, return-address routing works unchanged.
  const channelId = message.from;
  const threadTs = message.from;

  let inputText: string;
  let voiceInput = false;

  if (message.type === 'ptt' || message.type === 'audio') {
    if (!config.OPENAI_API_KEY) {
      await message.reply("I got your voice message but can't transcribe it without an OpenAI API key configured.");
      return;
    }
    try {
      await message.react('⏳');
      const media = await message.downloadMedia();
      if (!media?.data) {
        await message.reply("Couldn't download that voice message — try again?");
        return;
      }
      const tmpPath = path.join(os.tmpdir(), `wa_audio_${profile.user.slack_user_id}_${Date.now()}.ogg`);
      fs.writeFileSync(tmpPath, Buffer.from(media.data, 'base64'));
      const { transcribeAudioFile } = await import('../voice/fileTranscribe');
      inputText = await transcribeAudioFile(tmpPath);
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      voiceInput = true;
      logger.info('WhatsApp voice transcribed', { preview: inputText.slice(0, 80) });
    } catch (err) {
      logger.error('WhatsApp voice transcription failed', { err: String(err) });
      await message.reply("Couldn't transcribe that — try sending it as text?");
      return;
    }
  } else if (message.body) {
    inputText = message.body.trim();
  } else {
    return; // unknown / unsupported message type
  }

  if (!inputText || inputText.length < 1) return;

  const history = getConversationHistory(threadTs);
  appendToConversation(threadTs, channelId, {
    role: 'user',
    content: voiceInput ? `[Voice message]: ${inputText}` : inputText,
    // Conversation history `ts` is unix SECONDS everywhere else (Slack's
    // format — see core/assistant.ts's `DateTime.fromSeconds(Number(m.ts))`
    // grounding read). Date.now() is milliseconds; keep the same unit here
    // so a later reader doesn't land ~50,000 years in the future.
    ts: String(Math.floor(Date.now() / 1000)),
  });

  // Best-effort presence/typing hint.
  try { await client.sendPresenceAvailable(); } catch { /* non-fatal */ }

  try {
    const result = await runOrchestrator({
      userMessage: inputText,
      conversationHistory: history,
      threadTs,
      channelId,
      userId: profile.user.slack_user_id,
      senderRole: 'owner',
      // v4.4.x (#154) — the trust gate above (senderPhone !== ownerPhone) is
      // the ONLY party that can reach this call today: owner-phone-only,
      // everyone else dropped silently before this point (no colleague path,
      // no room). `owner_dm` reproduces today's behaviour byte-for-byte and
      // matches the other owner-only synthetic callers (briefs.ts,
      // routine.ts, email inbound). Out of scope for redesign per this wave
      // — WhatsApp stays dormant and untouched otherwise.
      authority: 'owner',
      surface: 'owner_dm',
      channel: 'whatsapp',
      inboundConnectionId: 'whatsapp',
      profile,
    });

    appendToConversation(threadTs, channelId, { role: 'assistant', content: result.reply });

    const cleanReply = result.reply
      .replace(/\*\*/g, '')
      .replace(/##+ /g, '')
      .replace(/^- /gm, '');

    const useAudio = shouldRespondWithAudio({
      inputWasVoice: voiceInput,
      responseText: cleanReply,
    });

    if (useAudio && config.OPENAI_API_KEY) {
      try {
        const audioBuffer = await textToSpeech(cleanReply);
        const tmpAudio = path.join(os.tmpdir(), `wa_reply_${profile.user.slack_user_id}_${Date.now()}.mp3`);
        fs.writeFileSync(tmpAudio, audioBuffer);
        const media = MessageMedia.fromFilePath(tmpAudio);
        await client.sendMessage(message.from, media, { sendAudioAsVoice: true });
        try { fs.unlinkSync(tmpAudio); } catch { /* best effort */ }
      } catch (audioErr) {
        logger.warn('WhatsApp audio reply failed — sending text', { err: String(audioErr) });
        await message.reply(cleanReply);
      }
    } else {
      await message.reply(cleanReply);
    }
  } catch (err) {
    logger.error('WhatsApp orchestrator error', { err: String(err) });
    await message.reply('Something went wrong on my end. Try again in a moment.');
  }
}
