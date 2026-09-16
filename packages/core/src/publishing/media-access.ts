import type { Media } from '@repeat/database';
import type { MediaAccess } from '@repeat/provider-sdk';
import type { MediaUrlSigner } from '../media/signed-url.js';
import type { StorageProvider } from '../storage/storage-provider.js';

const PUBLIC_URL_TTL_SECONDS = 6 * 60 * 60;

/**
 * Build the provider-facing media handle from a database row. Providers never
 * see storage keys or filesystem paths.
 */
export function createMediaAccess(
  media: Media,
  deps: { storage: StorageProvider; urlSigner: MediaUrlSigner | null },
): MediaAccess {
  return {
    id: media.id,
    filename: media.filename,
    mimeType: media.mimeType,
    sizeBytes: Number(media.sizeBytes),
    durationSeconds: media.durationSeconds,
    width: media.width,
    height: media.height,
    openStream: (range) => deps.storage.get(media.storageKey, range),
    getPublicUrl: async () =>
      deps.urlSigner ? deps.urlSigner.sign(media.id, PUBLIC_URL_TTL_SECONDS) : null,
  };
}
