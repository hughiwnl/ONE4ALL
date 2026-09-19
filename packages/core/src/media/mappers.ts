import type { Media } from '@repeat/database';
import { mediaKindOf, type MediaDto } from '@repeat/types';

export function toMediaDto(media: Media): MediaDto {
  return {
    id: media.id,
    kind: mediaKindOf(media.mimeType) ?? 'video',
    filename: media.filename,
    mimeType: media.mimeType,
    sizeBytes: Number(media.sizeBytes),
    durationSeconds: media.durationSeconds,
    width: media.width,
    height: media.height,
    createdAt: media.createdAt.toISOString(),
  };
}
