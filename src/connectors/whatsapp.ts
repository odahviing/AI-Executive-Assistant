import { Client, LocalAuth, Message, MessageMedia } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import path from 'path';
import fs from 'fs';
import type { UserProfile } from '../config/userProfile';
import { config } from '../config';
import {
  getConversationHistory,
  appendToConversation,
} from '../db';
import { runOrchestrator } from '../core/orchestrator';
import { transcribeSlackAudio, textToSpeech, shouldRespondWithAudio } from '../voice';
import logger from '../utils/logger';

// Session stored in data dir so it persists across restarts
const SESSION_DIR = path.join(process.cwd(), 'data', 'whatsapp-session');

let waClient: Client | null = null;

function getChromePath(): string | undefined {
  // Try common Chrome locations on Windows, then Linux/Mac
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
    } catch (_) {}
  }
  return undefined; // fall back to bundled Chromium
}

export function getWhatsAppClient(): Client | null {
  return waClient;
}

/**
 * Start the WhatsApp client for a given profile.
 * Shows QR code in terminal on first run, then reconnects automatically.
 */
export async function startWhatsApp(profile: UserProfile): Promise<void> {
  if (!config.WHATSAPP_OWNER_PHONE) {
    logger.info('WHATSAPP_OWNER_PHONE not set — WhatsApp disabled');
    return;
  }

  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  const client = new Client({
    authStrategy: new LocalAuth({
      dataPath: SESSION_DIR,
      clientId: profile.user.slack_user_id,
    }),
    puppeteer: {
      headless: true,
      // Use system Chrome instead of bundled Chromium — more reliable on Windows
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

  client.on('qr', (qr) => {
    console.log('\n📱 Scan this QR code with WhatsApp to connect Maelle:\n');
    qrcode.generate(qr, { small: true });
    console.log('\nOpen WhatsApp → Settings → Linked Devices → Link a Device\n');
  });

  client.on('ready', () => {
    logger.info('WhatsApp connected', { assistant: profile.assistant.name, user: profile.user.name });
    console.log(`✅ WhatsApp connected for ${profile.assistant.name}`);
  });

  client.on('disconnected', (reason) => {
    logger.warn('WhatsApp disconnected', { reason });
    console.log('⚠️  WhatsApp disconnected:', reason);
    // Auto-reconnect after 10 seconds
    setTimeout(() => client.initialize(), 10000);
  });

  client.on('message', async (message: Message) => {
    try {
      await handleWhatsAppMessage(message, profile, client);
    } catch (err) {
      logger.error('WhatsApp message handler error', { err: String(err) });
    }
  });

  waClient = client;
  await client.initialize();
}

// ── Message handler ───────────────────────────────────────────────────────────

async function handleWhatsAppMessage(
  message: Message,
  profile: UserProfile,
  client: Client
): Promise<void> {
  // Only handle messages from the owner's phone number
  const ownerPhone = config.WHATSAPP_OWNER_PHONE;
  const senderPhone = message.from.replace('@c.us', '').replace('@s.whatsapp.net', '');

  if (senderPhone !== ownerPhone) {
    logger.debug('WhatsApp message from non-owner — ignored', { from: senderPhone });
    return;
  }

  // Skip group messages, status updates, etc.
  if (message.from.includes('@g.us') || message.from.includes('@broadcast')) return;

  logger.info('WhatsApp message received', {
    type: message.type,
    preview: message.body?.slice(0, 60),
  });

  // Use phone number as the "channel" for conversation history
  const channelId = `wa_${ownerPhone}`;
  const threadTs = channelId; // WhatsApp DMs are one continuous conversation

  let inputText: string;
  let voiceInput = false;

  // Handle voice messages
  if (message.type === 'ptt' || message.type === 'audio') {
    if (!config.OPENAI_API_KEY) {
      await message.reply("I received your voice message but I can't transcribe it without an OpenAI API key configured.");
      return;
    }

    try {
      await message.react('⏳');
      const media = await message.downloadMedia();
      if (!media?.data) {
        await message.reply("Couldn't download the voice message. Try again?");
        return;
      }

      // Save to temp file and transcribe
      const tmpPath = `/tmp/wa_audio_${Date.now()}.ogg`;
      fs.writeFileSync(tmpPath, Buffer.from(media.data, 'base64'));

      const { transcribeAudioFile } = await import('../voice/fileTranscribe');
      inputText = await transcribeAudioFile(tmpPath);
      fs.unlinkSync(tmpPath);

      voiceInput = true;
      logger.info('WhatsApp voice transcribed', { preview: inputText.slice(0, 80) });
    } catch (err) {
      logger.error('WhatsApp voice transcription failed', { err: String(err) });
      await message.reply("Couldn't transcribe that — try sending as text?");
      return;
    }
  } else if (message.body) {
    inputText = message.body.trim();
  } else {
    return; // Unknown message type
  }

  if (!inputText || inputText.length < 1) return;

  // Build conversation history
  const history = getConversationHistory(threadTs);
  appendToConversation(threadTs, channelId, {
    role: 'user',
    content: voiceInput ? `[Voice message]: ${inputText}` : inputText,
    ts: String(Date.now()),
  });

  // Show typing indicator
  await client.sendPresenceAvailable();

  try {
    const result = await runOrchestrator({
      userMessage: inputText,
      conversationHistory: history,
      threadTs,
      channelId,
      userId: profile.user.slack_user_id,
      senderRole: 'owner',
      channel: 'slack', // reuses slack channel type for now
      profile,
    });

    appendToConversation(threadTs, channelId, { role: 'assistant', content: result.reply });

    // Clean markdown just like Slack
    const cleanReply = result.reply
      .replace(/\*\*/g, '')
      .replace(/##+ /g, '')
      .replace(/^- /gm, '');

    // Decide audio vs text — same logic as Slack
    const useAudio = shouldRespondWithAudio({
      inputWasVoice: voiceInput,
      responseText: cleanReply,
    });

    if (useAudio && config.OPENAI_API_KEY) {
      try {
        const audioBuffer = await textToSpeech(cleanReply);
        const tmpAudio = `/tmp/wa_reply_${Date.now()}.mp3`;
        fs.writeFileSync(tmpAudio, audioBuffer);
        const media = MessageMedia.fromFilePath(tmpAudio);
        await client.sendMessage(message.from, media, { sendAudioAsVoice: true });
        fs.unlinkSync(tmpAudio);
      } catch (audioErr) {
        logger.warn('WhatsApp audio reply failed — sending text', { err: String(audioErr) });
        await message.reply(cleanReply);
      }
    } else {
      await message.reply(cleanReply);
    }

    // Handle any Slack actions (coordination DMs go to Slack, not WhatsApp)
    // WhatsApp is input-only for now — outbound to colleagues is always Slack

  } catch (err) {
    logger.error('WhatsApp orchestrator error', { err: String(err) });
    await message.reply("Something went wrong on my end. Try again in a moment.");
  }
}

/**
 * Send a proactive message to the owner via WhatsApp.
 * Used for briefings, task completions, etc.
 */
export async function sendWhatsAppMessage(text: string): Promise<void> {
  if (!waClient || !config.WHATSAPP_OWNER_PHONE) return;
  const chatId = `${config.WHATSAPP_OWNER_PHONE}@c.us`;
  const clean = text.replace(/\*\*/g, '').replace(/##+ /g, '');
  try {
    await waClient.sendMessage(chatId, clean);
  } catch (err) {
    logger.error('Failed to send WhatsApp message', { err: String(err) });
  }
}
