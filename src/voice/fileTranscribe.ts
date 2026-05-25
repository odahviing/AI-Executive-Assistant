import OpenAI from 'openai';
import fs from 'fs';
import { config } from '../config';

/**
 * Transcribe an audio file on disk using Whisper.
 * Used for WhatsApp voice notes (ogg/opus format).
 */
export async function transcribeAudioFile(filePath: string): Promise<string> {
  if (!config.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');

  const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  const fileStream = fs.createReadStream(filePath);

  // `response_format: 'text'` makes the SDK return a bare string (per the SDK
  // overload). Keep the literal narrow so TypeScript types `transcription` as
  // string directly — no cast needed.
  const transcription: string = await openai.audio.transcriptions.create({
    file: fileStream,
    model: 'whisper-1',
    response_format: 'text' as const,
  });

  return transcription.trim();
}
