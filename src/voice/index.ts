import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import FormDataNode from 'form-data';
import https from 'https';
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require('ffmpeg-static');
import { config } from '../config';
import logger from '../utils/logger';

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    if (!config.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
    openaiClient = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }
  return openaiClient;
}

// ── Transcription ─────────────────────────────────────────────────────────────

/**
 * Download a Slack audio file and transcribe it with Whisper.
 * Returns the transcribed text.
 */
export async function transcribeSlackAudio(
  fileUrl: string,
  botToken: string,
  language?: string,  // hint e.g. 'he' or 'en' — optional, Whisper auto-detects
  mimetype?: string,  // e.g. 'audio/webm', 'audio/mp4' — used to pick correct file extension
): Promise<string> {
  // Derive extension from mimetype so Whisper can detect the format correctly
  // (Whisper uses file extension — wrong extension = 400 error)
  const extMap: Record<string, string> = {
    'audio/webm':  'webm',
    'audio/mp4':   'mp4',
    'audio/mpeg':  'mp3',
    'audio/ogg':   'ogg',
    'audio/wav':   'wav',
    'audio/x-m4a': 'm4a',
    'audio/m4a':   'm4a',
    'audio/flac':  'flac',
  };
  const baseType = (mimetype ?? '').split(';')[0].trim().toLowerCase();
  const ext = extMap[baseType] ?? 'webm';  // default webm — Slack's native voice format
  const tmpPath = path.join(os.tmpdir(), `maelle_audio_${Date.now()}.${ext}`);

  await downloadFile(fileUrl, tmpPath, botToken);

  const fileSize = fs.statSync(tmpPath).size;
  logger.info('Transcribing audio', { ext, mimetype: baseType, size: fileSize });

  // Convert to WAV first — Slack records in AAC-ELD which Whisper rejects even
  // though the mp4/m4a container is listed as supported. WAV always works.
  const wavPath = tmpPath.replace(/\.[^.]+$/, '.wav');
  let converted = false;
  try {
    await execFileAsync(ffmpegPath, [
      '-i', tmpPath,
      '-ar', '16000',  // 16 kHz — optimal for Whisper
      '-ac', '1',       // mono
      '-f', 'wav', '-y',
      wavPath,
    ]);
    converted = true;
    logger.info('Audio converted to WAV', { wavSize: fs.statSync(wavPath).size });
  } catch (convErr) {
    logger.warn('ffmpeg conversion failed — sending original', { err: String(convErr) });
  }

  const sendPath = converted ? wavPath : tmpPath;
  const sendExt  = converted ? 'wav'  : ext;
  const sendType = converted ? 'audio/wav' : (baseType || 'audio/mp4');

  try {
    const fileBuffer = fs.readFileSync(sendPath);

    // Use form-data + https directly — Node's native FormData+Blob builds
    // multipart incorrectly for file uploads, causing Whisper 400 errors.
    const form = new FormDataNode();
    form.append('model', 'whisper-1');
    form.append('response_format', 'text');
    if (language) form.append('language', language);
    form.append('file', fileBuffer, {
      filename: `audio.${sendExt}`,
      contentType: sendType,
      knownLength: fileBuffer.length,
    });

    const formBuffer = form.getBuffer();
    const formHeaders = form.getHeaders();

    const transcription = await new Promise<string>((resolve, reject) => {
      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.OPENAI_API_KEY}`,
          'Content-Length': formBuffer.length,
          ...formHeaders,
        },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(body);
          } else {
            reject(new Error(`Whisper ${res.statusCode}: ${body}`));
          }
        });
      });
      req.on('error', reject);
      req.write(formBuffer);
      req.end();
    });

    logger.info('Audio transcribed', { length: transcription.length, preview: transcription.slice(0, 80) });
    return transcription.trim();
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    if (converted) try { fs.unlinkSync(wavPath); } catch (_) {}
  }
}

// ── Text-to-Speech ────────────────────────────────────────────────────────────

/**
 * Convert text to speech and return the audio buffer.
 * Uses OpenAI TTS with a consistent voice for Maelle.
 */
export async function textToSpeech(text: string): Promise<Buffer> {
  const openai = getOpenAI();

  const response = await (openai.audio.speech.create as any)({
    model: 'gpt-4o-mini-tts',
    voice: 'sage',
    input: text,
    response_format: 'mp3',
    speed: 1.15,
    instructions: "Voice Affect: Calm, composed, and reassuring — competent and in control, instilling trust. Tone: Sincere and empathetic, with genuine care. Pacing: Regular, but pick up speed when offering solutions or next steps to signal action and resolution. Emotion: Calm reassurance and warmth. Pronunciation: Clear and precise, especially on key details.",
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  logger.info('TTS generated', { chars: text.length, bytes: buffer.length });
  return buffer;
}

/**
 * Upload an audio buffer to Slack and send it as a voice message.
 */
export async function sendAudioMessage(params: {
  app: any;
  botToken: string;
  channelId: string;
  threadTs?: string;
  audioBuffer: Buffer;
  filename?: string;
}): Promise<void> {
  const filename = params.filename || 'maelle_response.mp3';
  const tmpPath = path.join(os.tmpdir(), filename);

  fs.writeFileSync(tmpPath, params.audioBuffer);

  try {
    await params.app.client.files.uploadV2({
      token: params.botToken,
      channel_id: params.channelId,
      thread_ts: params.threadTs,
      file: fs.createReadStream(tmpPath),
      filename,
      title: 'Voice message',
    });
    logger.info('Audio message sent', { channelId: params.channelId });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

// ── Response type detection ───────────────────────────────────────────────────

/**
 * Determine if a response should be sent as audio.
 *
 * Rule: voice input → audio response, but only if short enough to listen to (~30 sec).
 * Text input → always text. No persistent "car mode" state.
 */
// ~75 words ≈ 30 seconds of speech at 1.15x speed
const AUDIO_WORD_LIMIT = 75;

export function shouldRespondWithAudio(params: {
  inputWasVoice: boolean;
  responseText: string;
}): boolean {
  const { inputWasVoice, responseText } = params;

  if (!inputWasVoice) return false;

  // Voice input → audio only if short enough to be comfortable to listen to
  const wordCount = responseText.trim().split(/\s+/).length;
  return wordCount <= AUDIO_WORD_LIMIT;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Uses native fetch (Node 18+) which follows redirects automatically.
// https.get does NOT follow 302 redirects — Slack's url_private can redirect
// to a CDN signed URL, which would cause https.get to download an HTML page.
async function downloadFile(url: string, destPath: string, token: string): Promise<void> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to download Slack file: HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const arrayBuffer = await response.arrayBuffer();
  const buf = Buffer.from(arrayBuffer);
  // Log first 16 bytes as hex so we can verify it's actually audio (not HTML/JSON)
  const header = buf.slice(0, 16).toString('hex');
  logger.info('Slack file downloaded', { status: response.status, contentType, bytes: buf.length, header });

  if (!contentType.startsWith('audio/') && !contentType.startsWith('video/') && !contentType.includes('octet-stream')) {
    // Not audio — dump first 200 chars so we can see what Slack actually returned
    logger.error('Non-audio content downloaded', { contentType, body: buf.slice(0, 200).toString('utf8') });
    throw new Error(`Expected audio file but got: ${contentType}`);
  }

  fs.writeFileSync(destPath, buf);
}
