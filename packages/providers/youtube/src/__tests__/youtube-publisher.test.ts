import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  noopLogger,
  type MediaAccess,
  type ProviderAccount,
  type PublishInput,
} from '@repeat/provider-sdk';
import { GoogleConnector } from '../google-connector.js';
import {
  YouTubePublisher,
  youtubeSettingsSchema,
  type YouTubeSettings,
} from '../youtube-publisher.js';

const fileBytes = Buffer.alloc(20 * 1024 * 1024, 7); // 20 MiB → 3 chunks of 8 MiB

const media: MediaAccess = {
  id: 'm1',
  filename: 'video.mp4',
  mimeType: 'video/mp4',
  sizeBytes: fileBytes.length,
  durationSeconds: 30,
  width: 1920,
  height: 1080,
  openStream: async (range) =>
    Readable.from([
      fileBytes.subarray(range?.start ?? 0, (range?.end ?? fileBytes.length - 1) + 1),
    ]),
  getPublicUrl: async () => null,
};

const account: ProviderAccount = {
  id: 'acc',
  platform: 'youtube',
  platformAccountId: 'UC123',
  displayName: 'Main Channel',
  username: null,
  metadata: {},
  credentials: {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: new Date(Date.now() + 3600_000),
    scopes: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly',
    ],
  },
};

function input(settings: Partial<YouTubeSettings> = {}): PublishInput<YouTubeSettings> {
  return {
    destinationId: 'd1',
    postId: 'p1',
    attempt: 1,
    account,
    media,
    content: { title: 'My video', caption: 'cap', description: 'desc' },
    settings: youtubeSettingsSchema.parse(settings),
  };
}

/** A fake YouTube resumable upload server. */
function fakeYouTube(options: { failChunkOnce?: number; finalStatus?: string } = {}) {
  let received = 0;
  let failed = false;
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ method: init?.method ?? 'GET', url: href, headers });

    if (
      href.startsWith('https://www.googleapis.com/upload/youtube/v3/videos') &&
      init?.method === 'POST'
    ) {
      expect(headers['x-upload-content-length']).toBe(String(fileBytes.length));
      const body = JSON.parse(String(init.body)) as {
        snippet: { title: string };
        status: { privacyStatus: string };
      };
      expect(body.snippet.title).toBe('My video');
      return new Response(null, {
        status: 200,
        headers: { location: 'https://upload.example/session-1' },
      });
    }
    if (href === 'https://upload.example/session-1') {
      const range = headers['content-range']!;
      const total = fileBytes.length;
      if (range.startsWith('bytes */')) {
        return new Response(null, {
          status: 308,
          headers: received > 0 ? { range: `bytes=0-${received - 1}` } : {},
        });
      }
      const [, startStr, endStr] = range.match(/bytes (\d+)-(\d+)\//)!;
      const start = Number(startStr);
      const end = Number(endStr);
      expect(start).toBe(received);
      if (options.failChunkOnce !== undefined && start === options.failChunkOnce && !failed) {
        failed = true;
        return new Response('oops', { status: 503 });
      }
      received = end + 1;
      if (received < total) {
        return new Response(null, { status: 308, headers: { range: `bytes=0-${received - 1}` } });
      }
      return Response.json({
        id: 'vid123',
        status: { uploadStatus: options.finalStatus ?? 'uploaded' },
      });
    }
    if (href.startsWith('https://www.googleapis.com/youtube/v3/videos')) {
      return Response.json({ items: [{ id: 'vid123', status: { uploadStatus: 'processed' } }] });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, bytesReceived: () => received };
}

const connector = new GoogleConnector({ clientId: 'id', clientSecret: 'secret' });
const publisher = new YouTubePublisher(connector);

describe('YouTubePublisher', () => {
  it('uploads in chunks via the resumable protocol and reports progress', async () => {
    const server = fakeYouTube();
    const progress: number[] = [];
    const result = await publisher.publish(input(), {
      logger: noopLogger,
      fetch: server.fetchImpl,
      onProgress: (p) => progress.push(p),
    });
    expect(result).toMatchObject({
      state: 'processing',
      platformPostId: 'vid123',
      platformPostUrl: 'https://www.youtube.com/watch?v=vid123',
    });
    expect(server.bytesReceived()).toBe(fileBytes.length);
    expect(server.calls.filter((c) => c.url === 'https://upload.example/session-1').length).toBe(3);
    expect(progress.at(-1)).toBe(100);
    expect(progress.some((p) => p > 30 && p < 70)).toBe(true);
  }, 20_000);

  it('resumes from the server-reported offset after a transient chunk failure', async () => {
    const server = fakeYouTube({ failChunkOnce: 8 * 1024 * 1024 });
    const result = await publisher.publish(input(), {
      logger: noopLogger,
      fetch: server.fetchImpl,
      onProgress: () => {},
    });
    expect(result.state).toBe('processing');
    expect(server.bytesReceived()).toBe(fileBytes.length);
    expect(server.calls.some((c) => c.headers['content-range']?.startsWith('bytes */'))).toBe(true);
  }, 20_000);

  it('reports published once YouTube finished processing', async () => {
    const server = fakeYouTube();
    const status = await publisher.getStatus(
      {
        destinationId: 'd1',
        account,
        platformPostId: 'vid123',
        providerState: {},
        processingSince: new Date(),
      },
      { logger: noopLogger, fetch: server.fetchImpl },
    );
    expect(status).toMatchObject({ state: 'published', platformPostId: 'vid123' });
  });

  it('requires a title', async () => {
    const server = fakeYouTube();
    const noTitle = { ...input(), content: { title: null, caption: null, description: null } };
    await expect(
      publisher.publish(noTitle, {
        logger: noopLogger,
        fetch: server.fetchImpl,
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({
      code: 'invalid_settings',
      retryable: false,
    });
  });

  it('maps a quota error to a permanent quota_exceeded failure', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } },
        { status: 403 },
      ),
    ) as unknown as typeof fetch;
    await expect(
      publisher.publish(input(), { logger: noopLogger, fetch: fetchImpl, onProgress: () => {} }),
    ).rejects.toMatchObject({
      code: 'quota_exceeded',
      retryable: false,
    });
  });

  it('maps a 503 on session start to a retryable error', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('backend', { status: 503 }),
    ) as unknown as typeof fetch;
    await expect(
      publisher.publish(input(), { logger: noopLogger, fetch: fetchImpl, onProgress: () => {} }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it('refreshes credentials only when they are close to expiry', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ access_token: 'new', expires_in: 3600, scope: 'a b' }),
    ) as unknown as typeof fetch;
    expect(
      await publisher.refreshCredentialsIfNeeded(account, { logger: noopLogger, fetch: fetchImpl }),
    ).toBeNull();
    const expiring = {
      ...account,
      credentials: { ...account.credentials, expiresAt: new Date(Date.now() + 60_000) },
    };
    const refreshed = await publisher.refreshCredentialsIfNeeded(expiring, {
      logger: noopLogger,
      fetch: fetchImpl,
    });
    expect(refreshed).toMatchObject({ accessToken: 'new', refreshToken: 'refresh' });
  });

  it('flags accounts that lack the upload scope', async () => {
    const limited = {
      ...account,
      credentials: {
        ...account.credentials,
        scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
      },
    };
    expect(await publisher.validateAccount(limited)).toMatchObject({
      ok: false,
      code: 'insufficient_permissions',
    });
  });
});

describe('GoogleConnector', () => {
  it('builds an authorization URL with PKCE and offline access', () => {
    const url = new URL(
      connector.getAuthorizationUrl({
        state: 'st',
        redirectUri: 'https://app/cb',
        codeChallenge: 'ch',
      }),
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge')).toBe('ch');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('scope')).toContain('youtube.upload');
  });

  it('discovers the channel behind a token', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/channels')) {
        return Response.json({
          items: [
            {
              id: 'UC1',
              snippet: {
                title: 'Clips',
                customUrl: '@clips',
                thumbnails: { default: { url: 'https://img' } },
              },
            },
          ],
        });
      }
      return Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'x' });
    }) as unknown as typeof fetch;
    const tokens = await connector.exchangeCode(
      { code: 'c', redirectUri: 'https://app/cb', codeVerifier: 'v' },
      { logger: noopLogger, fetch: fetchImpl },
    );
    const accounts = await connector.discoverAccounts(tokens, {
      logger: noopLogger,
      fetch: fetchImpl,
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      platform: 'youtube',
      platformAccountId: 'UC1',
      displayName: 'Clips',
      username: '@clips',
    });
  });

  it('refuses logins without a refresh token', async () => {
    await expect(
      connector.discoverAccounts(
        { accessToken: 'a', refreshToken: null, expiresAt: null, scopes: [] },
        { logger: noopLogger },
      ),
    ).rejects.toMatchObject({ code: 'insufficient_permissions' });
  });
});
