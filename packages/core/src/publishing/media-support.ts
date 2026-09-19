import type { Media } from '@repeat/database';
import {
  ProviderErrorCode,
  type MediaDescriptor,
  type PublisherProvider,
  type ValidationResult,
} from '@repeat/provider-sdk';
import { checkMediaCompatibility } from '@repeat/types';

export function toMediaDescriptor(media: Media): MediaDescriptor {
  return {
    id: media.id,
    filename: media.filename,
    mimeType: media.mimeType,
    sizeBytes: Number(media.sizeBytes),
    durationSeconds: media.durationSeconds,
    width: media.width,
    height: media.height,
  };
}

/**
 * Can this provider publish a post made of these items?
 *
 * First the generic, capability-based check shared with the UI (kinds, item
 * count, MIME types), then the provider's own per-item `validateMedia`.
 * Used when a post is created and again right before publishing.
 */
export async function validatePostMedia(
  provider: PublisherProvider<Record<string, unknown>>,
  items: MediaDescriptor[],
  settings: Record<string, unknown>,
): Promise<ValidationResult> {
  const reason = checkMediaCompatibility(provider, items);
  if (reason) return { ok: false, code: ProviderErrorCode.INVALID_MEDIA, message: reason };

  for (const [index, item] of items.entries()) {
    const result = await provider.validateMedia(item, settings);
    if (!result.ok) {
      return items.length > 1
        ? { ...result, message: `Item ${index + 1} (${item.filename}): ${result.message}` }
        : result;
    }
  }
  return { ok: true };
}
