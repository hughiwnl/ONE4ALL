import { describe, expect, it } from 'vitest';
import { checkMediaCompatibility, type ProviderCapabilities } from '@repeat/types';
import type { PublisherProvider } from '@repeat/provider-sdk';
import { validatePostMedia } from './media-support.js';

const video = { mimeType: 'video/mp4' };
const jpeg = { mimeType: 'image/jpeg' };
const png = { mimeType: 'image/png' };

const youtubeLike = {
  displayName: 'YouTube',
  capabilities: {
    media: { video: true, image: false },
    requiresPublicMediaUrl: false,
  } satisfies ProviderCapabilities,
};
const instagramLike = {
  displayName: 'Instagram',
  capabilities: {
    media: { video: true, image: true },
    maxMediaItems: 10,
    acceptedMimeTypes: ['video/mp4', 'video/quicktime', 'image/jpeg'],
    requiresPublicMediaUrl: true,
  } satisfies ProviderCapabilities,
};

describe('checkMediaCompatibility', () => {
  it('accepts what a provider declares', () => {
    expect(checkMediaCompatibility(youtubeLike, [video])).toBeNull();
    expect(checkMediaCompatibility(instagramLike, [jpeg])).toBeNull();
    expect(checkMediaCompatibility(instagramLike, [jpeg, video, jpeg])).toBeNull();
  });
  it('explains unsupported kinds, carousels and file types', () => {
    expect(checkMediaCompatibility(youtubeLike, [jpeg])).toBe(
      'YouTube does not support image posts in Repeat',
    );
    expect(checkMediaCompatibility(youtubeLike, [video, video])).toBe(
      'YouTube publishes a single video per post, not a carousel',
    );
    expect(checkMediaCompatibility(instagramLike, [png])).toMatch(/does not accept image\/png/);
    expect(
      checkMediaCompatibility(
        instagramLike,
        Array.from({ length: 11 }, () => jpeg),
      ),
    ).toBe('Instagram accepts up to 10 items per post');
  });
});

describe('validatePostMedia', () => {
  const provider = {
    ...instagramLike,
    validateMedia: (item: { filename: string; sizeBytes: number }) =>
      item.sizeBytes > 100
        ? { ok: false as const, code: 'invalid_media', message: 'too big' }
        : { ok: true as const },
  } as unknown as PublisherProvider<Record<string, unknown>>;
  const descriptor = (filename: string, mimeType: string, sizeBytes = 10) => ({
    id: filename,
    filename,
    mimeType,
    sizeBytes,
    durationSeconds: null,
    width: null,
    height: null,
  });

  it('runs the capability check before per-item validation', async () => {
    expect(await validatePostMedia(provider, [descriptor('a.png', 'image/png')], {})).toMatchObject(
      { ok: false },
    );
  });
  it('names the failing item in a carousel', async () => {
    const result = await validatePostMedia(
      provider,
      [descriptor('a.jpg', 'image/jpeg'), descriptor('b.jpg', 'image/jpeg', 500)],
      {},
    );
    expect(result).toEqual({
      ok: false,
      code: 'invalid_media',
      message: 'Item 2 (b.jpg): too big',
    });
  });
  it('passes valid posts', async () => {
    expect(await validatePostMedia(provider, [descriptor('a.jpg', 'image/jpeg')], {})).toEqual({
      ok: true,
    });
  });
});
