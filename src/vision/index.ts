/**
 * Vision module (v1.7.1) — Slack image input.
 *
 * Parallel to src/voice/ for the audio path. Where voice transcribes-then-discards,
 * vision keeps the image bytes live for the current turn so Sonnet sees the
 * actual pixels (exact error text, UI layout, log lines). The image is NOT
 * persisted in conversation history — see app.ts for the placeholder write.
 *
 * Owner-only in v1.7.1. When colleague paths open (issue #1 Connection work),
 * the image guard policy in src/utils/imageGuard.ts flips from log-and-proceed
 * to refuse-and-notify; this module itself stays transport-agnostic.
 */

import type Anthropic from '@anthropic-ai/sdk';
import logger from '../utils/logger';

export const SUPPORTED_IMAGE_MIMETYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

// Anthropic vision limit per image. Anything bigger gets a friendly DM back.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface DownloadedImage {
  buffer: Buffer;
  mimetype: ImageMediaType;
  bytes: number;
}

export type ImageDownloadFailure = {
  error: 'unsupported_type' | 'too_large' | 'download_failed';
  detail: string;
};

export type AnthropicImageBlock = Anthropic.ImageBlockParam;

/**
 * Download a Slack image file and return the buffer + normalised mimetype.
 * Returns an error object instead of throwing — caller decides what to tell
 * the user (size limit hit → "could you try a smaller version", etc).
 */
export async function downloadSlackImage(
  fileUrl: string,
  botToken: string,
  mimetype: string,
): Promise<DownloadedImage | ImageDownloadFailure> {
  const baseType = (mimetype ?? '').split(';')[0].trim().toLowerCase();
  if (!SUPPORTED_IMAGE_MIMETYPES.includes(baseType as ImageMediaType)) {
    return {
      error: 'unsupported_type',
      detail: `${baseType || '(unknown)'} not supported (jpeg/png/gif/webp only)`,
    };
  }

  try {
    const response = await fetch(fileUrl, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    if (!response.ok) {
      return { error: 'download_failed', detail: `HTTP ${response.status} ${response.statusText}` };
    }

    const contentType = response.headers.get('content-type') ?? '';
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length > MAX_IMAGE_BYTES) {
      return {
        error: 'too_large',
        detail: `${(buffer.length / 1024 / 1024).toFixed(1)}MB exceeds 5MB limit`,
      };
    }

    if (!contentType.startsWith('image/')) {
      logger.warn('Slack returned non-image content for image download', {
        contentType,
        bytes: buffer.length,
      });
      return { error: 'download_failed', detail: `expected image, got ${contentType}` };
    }

    logger.info('Slack image downloaded', {
      mimetype: baseType,
      contentType,
      bytes: buffer.length,
    });
    return { buffer, mimetype: baseType as ImageMediaType, bytes: buffer.length };
  } catch (err) {
    return { error: 'download_failed', detail: String(err) };
  }
}

/**
 * Build an Anthropic image content block from a downloaded image buffer.
 * The block goes inside a user message's content array alongside the text part.
 */
export function buildImageBlock(image: DownloadedImage): AnthropicImageBlock {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: image.mimetype,
      data: image.buffer.toString('base64'),
    },
  };
}
