import { describe, expect, it } from 'vitest';
import { MediaUrlSigner } from './signed-url.js';

describe('MediaUrlSigner', () => {
  const signer = new MediaUrlSigner('s'.repeat(32), 'https://repeat.example.com');

  it('produces a verifiable URL', () => {
    const url = new URL(signer.sign('media-1', 600));
    expect(url.pathname).toBe('/api/media/media-1/file');
    expect(
      signer.verify('media-1', url.searchParams.get('expires'), url.searchParams.get('signature')),
    ).toBe(true);
  });
  it('rejects a signature for another media id, tampering, and expiry', () => {
    const url = new URL(signer.sign('media-1', 600));
    const expires = url.searchParams.get('expires');
    const signature = url.searchParams.get('signature');
    expect(signer.verify('media-2', expires, signature)).toBe(false);
    expect(signer.verify('media-1', String(Number(expires) + 1), signature)).toBe(false);
    expect(signer.verify('media-1', expires, `${signature}x`)).toBe(false);
    const expired = new URL(signer.sign('media-1', -10));
    expect(
      signer.verify(
        'media-1',
        expired.searchParams.get('expires'),
        expired.searchParams.get('signature'),
      ),
    ).toBe(false);
    expect(signer.verify('media-1', null, null)).toBe(false);
  });
});
