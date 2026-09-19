import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { noopLogger, type MediaAccess, type ProviderAccount } from '@repeat/provider-sdk';
import { errorFromGraphResponse } from '../errors.js';
import { FacebookPublisher, facebookSettingsSchema } from '../facebook/facebook-publisher.js';
import { GraphClient } from '../graph-client.js';
import { InstagramPublisher, instagramSettingsSchema } from '../instagram/instagram-publisher.js';
import { MetaConnector } from '../meta-connector.js';

const graph = new GraphClient({ appSecret: 'secret', apiVersion: 'v21.0' });
const bytes = Buffer.alloc(3000, 1);

const media: MediaAccess = {
  id: 'm1',
  filename: 'clip.mp4',
  mimeType: 'video/mp4',
  sizeBytes: bytes.length,
  durationSeconds: 12,
  width: 1080,
  height: 1920,
  openStream: async (range) =>
    Readable.from([bytes.subarray(range?.start ?? 0, (range?.end ?? bytes.length - 1) + 1)]),
  getPublicUrl: async () => 'https://repeat.example.com/api/media/m1/file?expires=1&signature=x',
};

function account(platform: string, id: string): ProviderAccount {
  return {
    id: 'acc',
    platform,
    platformAccountId: id,
    displayName: 'Page',
    username: null,
    metadata: {},
    credentials: { accessToken: 'page-token', refreshToken: null, expiresAt: null, scopes: [] },
  };
}

function graphResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

describe('errorFromGraphResponse', () => {
  const make = (error: Record<string, unknown>, status = 400) =>
    errorFromGraphResponse(
      { status, ok: false, headers: new Headers(), body: { error }, text: '' },
      'test',
    );
  it('maps expired tokens to permanent errors', () => {
    expect(make({ code: 190, error_subcode: 463, message: 'expired' }, 401)).toMatchObject({
      code: 'token_expired',
      retryable: false,
    });
    expect(make({ code: 190, error_subcode: 460 })).toMatchObject({ code: 'token_revoked' });
  });
  it('maps rate limits and transient errors to retryable errors', () => {
    expect(make({ code: 4, message: 'limit' })).toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
    expect(make({ code: 2, message: 'temp' }, 500)).toMatchObject({ retryable: true });
    expect(make({ code: 12345, is_transient: true }, 500)).toMatchObject({ retryable: true });
  });
  it('maps permission errors to permanent insufficient_permissions', () => {
    expect(make({ code: 200, message: 'needs review' }, 403)).toMatchObject({
      code: 'insufficient_permissions',
      retryable: false,
    });
    expect(make({ code: 10 })).toMatchObject({ code: 'insufficient_permissions' });
  });
  it('maps media download failures to invalid_media with a helpful message', () => {
    expect(make({ code: 9004 }).message).toMatch(/publicly reachable/);
  });
});

describe('FacebookPublisher', () => {
  const publisher = new FacebookPublisher(graph);

  it('uploads with the start/transfer/finish resumable protocol', async () => {
    const calls: { url: string; body: FormData | string }[] = [];
    let received = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, body: init?.body as FormData | string });
      if (href.includes('/videos') && typeof init?.body === 'string') {
        const params = new URLSearchParams(init.body);
        expect(params.get('appsecret_proof')).toBeTruthy();
        if (params.get('upload_phase') === 'start') {
          expect(params.get('file_size')).toBe('3000');
          return graphResponse({
            upload_session_id: 's1',
            video_id: 'v1',
            start_offset: '0',
            end_offset: '1000',
          });
        }
        if (params.get('upload_phase') === 'finish') {
          expect(params.get('description')).toBe('my caption');
          expect(params.get('title')).toBe('My title');
          return graphResponse({ success: true });
        }
      }
      if (href.startsWith('https://graph-video.facebook.com') && init?.body instanceof FormData) {
        const form = init.body;
        expect(form.get('upload_phase')).toBe('transfer');
        const chunk = form.get('video_file_chunk') as Blob;
        expect(Number(form.get('start_offset'))).toBe(received);
        received += chunk.size;
        return graphResponse({
          start_offset: String(received),
          end_offset: String(Math.min(3000, received + 1000)),
        });
      }
      return new Response('unexpected', { status: 500 });
    }) as unknown as typeof fetch;

    const progress: number[] = [];
    const result = await publisher.publish(
      {
        destinationId: 'd',
        postId: 'p',
        attempt: 1,
        account: account('facebook', 'page1'),
        media,
        mediaItems: [media],
        content: { title: 'My title', caption: 'my caption', description: null },
        settings: facebookSettingsSchema.parse({}),
      },
      { logger: noopLogger, fetch: fetchImpl, onProgress: (p) => progress.push(p) },
    );
    expect(received).toBe(3000);
    expect(result).toMatchObject({ state: 'processing', platformPostId: 'v1' });
    expect(progress.at(-1)).toBe(100);
  });

  it('reports published when the video is ready', async () => {
    const fetchImpl = vi.fn(async () =>
      graphResponse({
        id: 'v1',
        permalink_url: '/page1/videos/v1',
        status: { video_status: 'ready' },
      }),
    ) as unknown as typeof fetch;
    const status = await publisher.getStatus(
      {
        destinationId: 'd',
        account: account('facebook', 'page1'),
        platformPostId: 'v1',
        providerState: {},
        processingSince: new Date(),
      },
      { logger: noopLogger, fetch: fetchImpl },
    );
    expect(status).toMatchObject({
      state: 'published',
      platformPostUrl: 'https://www.facebook.com/page1/videos/v1',
    });
  });

  it('surfaces processing errors as permanent failures', async () => {
    const fetchImpl = vi.fn(async () =>
      graphResponse({
        id: 'v1',
        status: { video_status: 'error', processing_phase: { errors: [{ message: 'bad codec' }] } },
      }),
    ) as unknown as typeof fetch;
    const status = await publisher.getStatus(
      {
        destinationId: 'd',
        account: account('facebook', 'page1'),
        platformPostId: 'v1',
        providerState: {},
        processingSince: new Date(),
      },
      { logger: noopLogger, fetch: fetchImpl },
    );
    expect(status).toMatchObject({
      state: 'failed',
      error: { code: 'media_rejected', retryable: false },
    });
  });
});

describe('InstagramPublisher', () => {
  const publisher = new InstagramPublisher(graph);

  it('creates a REELS container from the public URL, then publishes once finished', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      seen.push(href);
      if (href.endsWith('/ig1/media') && init?.method === 'POST') {
        const params = new URLSearchParams(String(init.body));
        expect(params.get('media_type')).toBe('REELS');
        expect(params.get('video_url')).toContain('/api/media/m1/file');
        expect(params.get('caption')).toBe('hello');
        return graphResponse({ id: 'container1' });
      }
      if (href.includes('/container1?'))
        return graphResponse({ id: 'container1', status_code: 'FINISHED' });
      if (href.endsWith('/ig1/media_publish')) return graphResponse({ id: 'media9' });
      if (href.includes('/media9?'))
        return graphResponse({ permalink: 'https://www.instagram.com/reel/abc/' });
      return new Response('unexpected', { status: 500 });
    }) as unknown as typeof fetch;

    const result = await publisher.publish(
      {
        destinationId: 'd',
        postId: 'p',
        attempt: 1,
        account: account('instagram', 'ig1'),
        media,
        mediaItems: [media],
        content: { title: null, caption: 'hello', description: null },
        settings: instagramSettingsSchema.parse({}),
      },
      { logger: noopLogger, fetch: fetchImpl, onProgress: () => {} },
    );
    expect(result).toMatchObject({
      state: 'processing',
      providerState: { containerId: 'container1' },
    });

    const status = await publisher.getStatus(
      {
        destinationId: 'd',
        account: account('instagram', 'ig1'),
        platformPostId: null,
        providerState: (result as { providerState: Record<string, unknown> }).providerState,
        processingSince: new Date(),
      },
      { logger: noopLogger, fetch: fetchImpl },
    );
    expect(status).toMatchObject({
      state: 'published',
      platformPostId: 'media9',
      platformPostUrl: 'https://www.instagram.com/reel/abc/',
    });
  });

  it('fails permanently when the server cannot expose a public URL', async () => {
    await expect(
      publisher.publish(
        {
          destinationId: 'd',
          postId: 'p',
          attempt: 1,
          account: account('instagram', 'ig1'),
          media: { ...media, getPublicUrl: async () => null },
          mediaItems: [{ ...media, getPublicUrl: async () => null }],
          content: { title: null, caption: null, description: null },
          settings: instagramSettingsSchema.parse({}),
        },
        { logger: noopLogger, onProgress: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'provider_not_configured', retryable: false });
  });

  it('validates Instagram media constraints', () => {
    expect(publisher.validateMedia({ ...media, mimeType: 'video/webm' })).toMatchObject({
      ok: false,
    });
    expect(publisher.validateMedia({ ...media, durationSeconds: 1 })).toMatchObject({ ok: false });
    expect(publisher.validateMedia({ ...media, durationSeconds: 2000 })).toMatchObject({
      ok: false,
    });
    expect(publisher.validateMedia({ ...media, width: 3840 })).toMatchObject({ ok: false });
    expect(publisher.validateMedia(media)).toEqual({ ok: true });
  });
});

describe('MetaConnector', () => {
  const connector = new MetaConnector({ appId: 'app', appSecret: 'secret', graph });

  it('exchanges the code for a long-lived token and discovers pages and linked instagram accounts', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('oauth/access_token') && href.includes('code=abc'))
        return graphResponse({ access_token: 'short', expires_in: 3600 });
      if (href.includes('fb_exchange_token=short'))
        return graphResponse({ access_token: 'long', expires_in: 5184000 });
      if (href.includes('me/accounts')) {
        return graphResponse({
          data: [
            {
              id: 'p1',
              name: 'Company Page',
              access_token: 'ptoken1',
              category: 'Business',
              instagram_business_account: { id: 'ig1', username: 'brand', name: 'Brand' },
            },
            { id: 'p2', name: 'Community Page', access_token: 'ptoken2' },
          ],
        });
      }
      return new Response('unexpected', { status: 500 });
    }) as unknown as typeof fetch;

    const tokens = await connector.exchangeCode(
      { code: 'abc', redirectUri: 'https://app/cb' },
      { logger: noopLogger, fetch: fetchImpl },
    );
    expect(tokens.accessToken).toBe('long');
    const accounts = await connector.discoverAccounts(tokens, {
      logger: noopLogger,
      fetch: fetchImpl,
    });
    expect(accounts.map((a) => `${a.platform}:${a.platformAccountId}`)).toEqual([
      'facebook:p1',
      'instagram:ig1',
      'facebook:p2',
    ]);
    expect(accounts[1]).toMatchObject({
      displayName: 'Brand',
      username: 'brand',
      credentials: { accessToken: 'ptoken1' },
      metadata: { facebookPageId: 'p1' },
    });
  });

  it('explains when a login has no pages', async () => {
    const fetchImpl = vi.fn(async () => graphResponse({ data: [] })) as unknown as typeof fetch;
    await expect(
      connector.discoverAccounts(
        { accessToken: 'long', refreshToken: null, expiresAt: null, scopes: [] },
        { logger: noopLogger, fetch: fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'unsupported_account' });
  });
});
