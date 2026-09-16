import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { ValidationError } from '@repeat/core';
import { json, route } from '@/server/api';
import { getContainer } from '@/server/container';
import { requireUser } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * Upload a video. The request body is the raw file (not multipart) so it can
 * be streamed straight into storage without buffering:
 *
 *   POST /api/media
 *   Content-Type: video/mp4
 *   X-Filename: <URI-encoded original filename>
 *   <bytes>
 */
export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { services } = getContainer();

  const filenameHeader = request.headers.get('x-filename');
  if (!filenameHeader) throw new ValidationError('Missing X-Filename header');
  let filename: string;
  try {
    filename = decodeURIComponent(filenameHeader);
  } catch {
    throw new ValidationError('X-Filename must be URI-encoded');
  }
  const mimeType = request.headers.get('content-type') ?? '';
  const contentLength = request.headers.get('content-length');
  if (!request.body) throw new ValidationError('Request body is empty');

  const media = await services.media.createFromStream({
    userId: user.id,
    filename,
    mimeType,
    declaredSizeBytes: contentLength ? Number(contentLength) : null,
    stream: Readable.fromWeb(request.body as unknown as NodeReadableStream),
    signal: request.signal,
  });
  return json({ media }, { status: 201 });
});
