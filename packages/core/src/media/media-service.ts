import { randomUUID } from 'node:crypto';
import { pipeline, Transform, type Readable } from 'node:stream';
import type { Db, Media } from '@repeat/database';
import type { MediaDto } from '@repeat/types';
import { NotFoundError, PayloadTooLargeError, ValidationError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { probeMedia } from './ffprobe.js';
import { toMediaDto } from './mappers.js';
import { formatBytes, sniffMediaHeader, validateUpload } from './media-validation.js';

export interface CreateMediaInput {
  userId: string;
  filename: string;
  mimeType: string;
  /** Content-Length when known; the stream is still hard-limited regardless. */
  declaredSizeBytes?: number | null;
  stream: Readable;
  signal?: AbortSignal;
}

export interface MediaServiceOptions {
  db: Db;
  storage: StorageProvider;
  logger: Logger;
  maxUploadSizeBytes: number;
  ffprobePath?: string;
}

/**
 * Handles uploads: validation, streaming into storage with a hard size cap,
 * metadata extraction, and ownership-scoped reads.
 */
export class MediaService {
  constructor(private readonly options: MediaServiceOptions) {}

  async createFromStream(input: CreateMediaInput): Promise<MediaDto> {
    const { db, storage, logger, maxUploadSizeBytes } = this.options;
    const validation = validateUpload({
      filename: input.filename,
      mimeType: input.mimeType,
      declaredSizeBytes: input.declaredSizeBytes,
      maxSizeBytes: maxUploadSizeBytes,
    });
    if (!validation.ok) {
      if (validation.code === 'too_large') throw new PayloadTooLargeError(validation.message);
      throw new ValidationError(validation.message, { code: validation.code });
    }

    const storageKey = `${input.userId}/${randomUUID()}.${validation.extension}`;
    const guard = createUploadGuard({
      maxBytes: maxUploadSizeBytes,
      mimeType: validation.mimeType,
    });

    // Wire the guard with pipeline() so its errors always have a listener,
    // even before the storage provider starts consuming the stream.
    const guarded = pipeline(input.stream, guard, () => undefined);

    let sizeBytes: number;
    try {
      const result = await storage.put(storageKey, guarded, {
        contentType: validation.mimeType,
        signal: input.signal,
      });
      sizeBytes = result.sizeBytes;
    } catch (error) {
      await storage.delete(storageKey).catch(() => undefined);
      if (error instanceof UploadGuardError) {
        if (error.kind === 'too_large') throw new PayloadTooLargeError(error.message);
        throw new ValidationError(error.message, { code: 'invalid_content' });
      }
      throw error;
    }

    if (sizeBytes === 0) {
      await storage.delete(storageKey).catch(() => undefined);
      throw new ValidationError('File is empty', { code: 'invalid_content' });
    }

    const localPath = await storage.getLocalPath(storageKey);
    const probe = localPath
      ? await probeMedia(localPath, { ffprobePath: this.options.ffprobePath, logger })
      : { durationSeconds: null, width: null, height: null };

    const media = await db.media.create({
      data: {
        userId: input.userId,
        storageKey,
        filename: validation.safeFilename,
        mimeType: validation.mimeType,
        sizeBytes: BigInt(sizeBytes),
        // Still images have no duration (ffprobe may report a one-frame length).
        durationSeconds: validation.mimeType.startsWith('image/') ? null : probe.durationSeconds,
        width: probe.width,
        height: probe.height,
      },
    });
    logger.info(
      { media_id: media.id, user_id: input.userId, size_bytes: sizeBytes },
      'media stored',
    );
    return toMediaDto(media);
  }

  /** Fetch media owned by the user. Throws NotFound for other users' media (no existence leak). */
  async getOwned(userId: string, mediaId: string): Promise<Media> {
    const media = await this.options.db.media.findFirst({ where: { id: mediaId, userId } });
    if (!media) throw new NotFoundError('Media');
    return media;
  }

  async get(userId: string, mediaId: string): Promise<MediaDto> {
    return toMediaDto(await this.getOwned(userId, mediaId));
  }

  /** Unscoped fetch for internal callers (workers, signed public URLs) that already verified access. */
  async getById(mediaId: string): Promise<Media | null> {
    return this.options.db.media.findUnique({ where: { id: mediaId } });
  }

  async openStream(media: Media, range?: { start: number; end?: number }): Promise<Readable> {
    return this.options.storage.get(media.storageKey, range);
  }

  async delete(userId: string, mediaId: string): Promise<void> {
    const media = await this.getOwned(userId, mediaId);
    const inUse = await this.options.db.postMediaItem.count({ where: { mediaId } });
    if (inUse > 0)
      throw new ValidationError('Media is used by an existing post and cannot be deleted');
    await this.options.db.media.delete({ where: { id: mediaId } });
    await this.options.storage.delete(media.storageKey);
  }
}

class UploadGuardError extends Error {
  constructor(
    public readonly kind: 'too_large' | 'invalid_content',
    message: string,
  ) {
    super(message);
    this.name = 'UploadGuardError';
  }
}

/**
 * Transform that enforces the byte limit while streaming and sniffs the file
 * header, so a lying Content-Length or a mislabeled file is rejected before it
 * is fully written.
 */
function createUploadGuard(options: { maxBytes: number; mimeType: string }): Transform {
  let total = 0;
  let header: Buffer | null = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > options.maxBytes) {
        callback(
          new UploadGuardError(
            'too_large',
            `Upload exceeds the maximum size of ${formatBytes(options.maxBytes)}`,
          ),
        );
        return;
      }
      if (header) {
        header = Buffer.concat([header, chunk.subarray(0, 32)]);
        if (header.length >= 12) {
          const problem = sniffMediaHeader(header, options.mimeType);
          header = null;
          if (problem) {
            callback(new UploadGuardError('invalid_content', problem));
            return;
          }
        }
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (header && header.length > 0) {
        callback(
          new UploadGuardError('invalid_content', 'File is too small to be a valid video or image'),
        );
        return;
      }
      callback();
    },
  });
}
