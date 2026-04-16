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

  const transcription = await openai.audio.transcriptions.create({
    file: fileStream,
    model: 'whisper-1',
    response_format: 'text',
  });

  return (transcription as unknown as string).trim();
}
