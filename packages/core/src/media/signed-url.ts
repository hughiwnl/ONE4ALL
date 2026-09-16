import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Time-limited, HMAC-signed URLs for the raw media file.
 *
 * Some platforms (Instagram) only ingest media from a public URL. Rather than
 * making uploads public, we hand the platform a URL that is valid for a short
 * window and cannot be forged or reused for a different media id.
 */
export class MediaUrlSigner {
  constructor(
    private readonly secret: string,
    private readonly appUrl: string,
  ) {}

  sign(mediaId: string, ttlSeconds: number): string {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const signature = this.signature(mediaId, expires);
    const url = new URL(`/api/media/${encodeURIComponent(mediaId)}/file`, this.appUrl);
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('signature', signature);
    return url.toString();
  }

  verify(mediaId: string, expires: string | null, signature: string | null): boolean {
    if (!expires || !signature) return false;
    const expiresAt = Number(expires);
    if (!Number.isInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;
    const expected = Buffer.from(this.signature(mediaId, expiresAt));
    const provided = Buffer.from(signature);
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }

  private signature(mediaId: string, expires: number): string {
    return createHmac('sha256', this.secret)
      .update(`media-file:${mediaId}:${expires}`)
      .digest('base64url');
  }
}
