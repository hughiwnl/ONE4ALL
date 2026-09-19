import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  noopLogger,
  ProviderError,
  type MediaAccess,
  type ProviderAccount,
  type PublishInput,
} from '@repeat/provider-sdk';
import { MockPublisher, type MockSettings } from '../mock-publisher.js';

function account(behavior: string): ProviderAccount {
  return {
    id: 'acc-1',
    platform: 'mock',
    platformAccountId: 'mock-1',
    displayName: 'Mock',
    username: null,
    metadata: { behavior },
    credentials: { accessToken: 'token', refreshToken: null, expiresAt: null, scopes: [] },
  };
}

const media: MediaAccess = {
  id: 'm1',
  filename: 'video.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 6,
  durationSeconds: null,
  width: null,
  height: null,
  openStream: async () => Readable.from([Buffer.from('abc'), Buffer.from('def')]),
  getPublicUrl: async () => null,
};

function input(
  behavior: string,
  attempt = 1,
  settings: MockSettings = {},
): PublishInput<MockSettings> {
  return {
    destinationId: 'dest-1234',
    postId: 'post-1',
    attempt,
    account: account(behavior),
    media,
    mediaItems: [media],
    content: { title: 't', caption: null, description: null },
    settings,
  };
}

const publisher = new MockPublisher({ defaultUploadMs: 0, sleep: async () => {} });
const ctx = { logger: noopLogger, onProgress: () => {} };

describe('MockPublisher', () => {
  it('publishes successfully and reports progress', async () => {
    const progress: number[] = [];
    const result = await publisher.publish(input('succeed'), {
      logger: noopLogger,
      onProgress: (p) => progress.push(p),
    });
    expect(result.state).toBe('published');
    expect(progress.at(-1)).toBe(100);
  });

  it('returns processing then published on subsequent polls', async () => {
    const result = await publisher.publish(
      input('succeed_after_processing', 1, { processingPolls: 2 }),
      ctx,
    );
    expect(result.state).toBe('processing');
    if (result.state !== 'processing') return;
    const first = await publisher.getStatus(
      {
        destinationId: 'd',
        account: account('x'),
        platformPostId: result.platformPostId,
        providerState: result.providerState,
        processingSince: new Date(),
      },
      ctx,
    );
    expect(first.state).toBe('processing');
    const second = await publisher.getStatus(
      {
        destinationId: 'd',
        account: account('x'),
        platformPostId: result.platformPostId,
        providerState: (first as { providerState: Record<string, unknown> }).providerState,
        processingSince: new Date(),
      },
      ctx,
    );
    expect(second.state).toBe('published');
  });

  it('throws a retryable error for fail_retryable', async () => {
    await expect(publisher.publish(input('fail_retryable'), ctx)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('throws a permanent error for fail_permanent', async () => {
    await expect(publisher.publish(input('fail_permanent'), ctx)).rejects.toMatchObject({
      retryable: false,
      code: 'token_expired',
    });
  });

  it('flaky fails on the first attempt and succeeds on the second', async () => {
    await expect(publisher.publish(input('flaky', 1), ctx)).rejects.toBeInstanceOf(ProviderError);
    const result = await publisher.publish(input('flaky', 2), ctx);
    expect(result.state).toBe('published');
  });

  it('lets destination settings override the account behavior', async () => {
    await expect(
      publisher.publish(input('succeed', 1, { behavior: 'fail_permanent' }), ctx),
    ).rejects.toMatchObject({ retryable: false });
  });

  it('rejects non-media mime types', () => {
    expect(publisher.validateMedia({ ...media, mimeType: 'application/pdf' })).toMatchObject({
      ok: false,
    });
  });
});
