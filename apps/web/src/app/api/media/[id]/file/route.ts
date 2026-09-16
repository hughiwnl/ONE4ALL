import { Readable } from 'node:stream';
import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME } from '@repeat/auth';
import { getContainer } from '@/server/container';
import { parseRange } from '@/server/range';

export const dynamic = 'force-dynamic';

type Params = { id: string };

/**
 * Serve the raw media file. Access is granted either to the owner's session
 * or to a bearer of a valid time-limited signature (used by platforms that
 * download media from a URL, i.e. Instagram). Supports Range requests.
 */
async function handle(
  request: NextRequest,
  context: { params: Promise<Params> },
  headOnly: boolean,
): Promise<Response> {
  const { params } = context;
  const { id } = await params;
  const { services, sessions } = getContainer();
  const storage = services.storage;

  const search = request.nextUrl.searchParams;
  const signatureOk = services.urlSigner.verify(id, search.get('expires'), search.get('signature'));
  let ownerOk = false;
  if (!signatureOk) {
    const user = await sessions.validate(request.cookies.get(SESSION_COOKIE_NAME)?.value);
    ownerOk = Boolean(user) && (await services.media.getById(id))?.userId === user?.id;
  }
  if (!signatureOk && !ownerOk) return new NextResponse('Not found', { status: 404 });

  const media = await services.media.getById(id);
  if (!media) return new NextResponse('Not found', { status: 404 });
  const size = Number(media.sizeBytes);

  const headers = new Headers({
    'content-type': media.mimeType,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=0',
    'content-disposition': `inline; filename="${media.filename.replace(/[^\w.\-]/g, '_')}"`,
  });

  const range = parseRange(request.headers.get('range'), size);
  if (range === 'invalid') {
    headers.set('content-range', `bytes */${size}`);
    return new NextResponse(null, { status: 416, headers });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  headers.set('content-length', String(end - start + 1));
  if (range) headers.set('content-range', `bytes ${start}-${end}/${size}`);

  if (headOnly) return new NextResponse(null, { status: range ? 206 : 200, headers });

  const stream = await storage.get(media.storageKey, range ? { start, end } : undefined);
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
    status: range ? 206 : 200,
    headers,
  });
}

export function GET(request: NextRequest, context: { params: Promise<Params> }) {
  return handle(request, context, false);
}

export function HEAD(request: NextRequest, context: { params: Promise<Params> }) {
  return handle(request, context, true);
}
