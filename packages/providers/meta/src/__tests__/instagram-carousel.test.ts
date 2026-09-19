import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  noopLogger,
  type MediaAccess,
  type ProviderAccount,
  type StatusInput,
} from '@repeat/provider-sdk';
import { GraphClient } from '../graph-client.js';
import { InstagramPublisher, instagramSettingsSchema } from '../instagram/instagram-publisher.js';

const graph = new GraphClient({ appSecret: 'secret', apiVersion: 'v21.0' });
const publisher = new InstagramPublisher(graph);

function item(id: string, mimeType: string, extra: Partial<MediaAccess> = {}): MediaAccess {
  return {
    id,
    filename: `${id}.${mimeType === 'image/jpeg' ? 'jpg' : 'mp4'}`,
    mimeType,
    sizeBytes: 1000,
    durationSeconds: mimeType.startsWith('video/') ? 10 : null,
    width: 1080,
    height: 1080,
    openStream: async () => Readable.from([Buffer.alloc(1000)]),
    getPublicUrl: async () => `https://repeat.example.com/api/media/${id}/file?sig=x`,
    ...extra,
  };
}

const account: ProviderAccount = {
  id: 'acc',
  platform: 'instagram',
  platformAccountId: 'ig1',
  displayName: 'Brand',
  username: 'brand',
  metadata: {},
  credentials: { accessToken: 'page-token', refreshToken: null, expiresAt: null, scopes: [] },
};

function publishInput(items: MediaAccess[], settings: Record<string, unknown> = {}) {
  return {
    destinationId: 'd',
    postId: 'p',
    attempt: 1,
    account,
    media: items[0]!,
    mediaItems: items,
    content: { title: null, caption: 'summer drop', description: null },
    settings: instagramSettingsSchema.parse(settings),
  };
}

function statusInput(providerState: Record<string, unknown>): StatusInput {
  return {
    destinationId: 'd',
    account,
    platformPostId: null,
    providerState,
    processingSince: new Date(),
  };
}

/** Fake Graph API that records every container it creates. */
function fakeGraph(childStatuses: Record<string, string[]> = {}) {
  const created: Record<string, string>[] = [];
  let published: string | null = null;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith('/ig1/media') && init?.method === 'POST') {
      const params = Object.fromEntries(new URLSearchParams(String(init.body)));
      created.push(params);
      return Response.json({ id: `c${created.length}` });
    }
    if (href.endsWith('/ig1/media_publish')) {
      published = new URLSearchParams(String(init?.body)).get('creation_id');
      return Response.json({ id: 'media77' });
    }
    const statusMatch = href.match(/\/(c\d+)\?/);
    if (statusMatch) {
      const queue = childStatuses[statusMatch[1]!];
      const code = queue && queue.length > 1 ? queue.shift()! : (queue?.[0] ?? 'FINISHED');
      return Response.json({
        id: statusMatch[1],
        status_code: code,
        status: code === 'ERROR' ? 'bad file' : '',
      });
    }
    if (href.includes('/media77?'))
      return Response.json({ permalink: 'https://www.instagram.com/p/abc/' });
    return new Response('unexpected', { status: 500 });
  }) as unknown as typeof fetch;
  return { fetchImpl, created, published: () => published };
}

describe('Instagram image posts', () => {
  it('publishes a single JPEG as an image container with caption and alt text', async () => {
    const api = fakeGraph();
    const ctx = { logger: noopLogger, fetch: api.fetchImpl, onProgress: () => {} };
    const result = await publisher.publish(
      publishInput([item('img1', 'image/jpeg')], { altText: 'a red shoe' }),
      ctx,
    );
    expect(api.created[0]).toMatchObject({
      image_url: 'https://repeat.example.com/api/media/img1/file?sig=x',
      caption: 'summer drop',
      alt_text: 'a red shoe',
    });
    expect(api.created[0]).not.toHaveProperty('media_type');
    expect(result).toMatchObject({
      state: 'processing',
      providerState: { phase: 'container', kind: 'image', containerId: 'c1' },
    });

    const status = await publisher.getStatus(
      statusInput((result as { providerState: Record<string, unknown> }).providerState),
      ctx,
    );
    expect(status).toEqual({
      state: 'published',
      platformPostId: 'media77',
      platformPostUrl: 'https://www.instagram.com/p/abc/',
    });
    expect(api.published()).toBe('c1');
  });
});

describe('Instagram carousels', () => {
  it('creates ordered child containers, waits for them, then creates and publishes the carousel', async () => {
    const api = fakeGraph({ c2: ['IN_PROGRESS', 'FINISHED'] });
    const ctx = { logger: noopLogger, fetch: api.fetchImpl, onProgress: () => {} };
    const items = [item('a', 'image/jpeg'), item('b', 'video/mp4'), item('c', 'image/jpeg')];

    const started = await publisher.publish(publishInput(items), ctx);
    expect(api.created).toEqual([
      {
        image_url: 'https://repeat.example.com/api/media/a/file?sig=x',
        is_carousel_item: 'true',
        access_token: 'page-token',
        appsecret_proof: expect.any(String),
      },
      {
        media_type: 'VIDEO',
        video_url: 'https://repeat.example.com/api/media/b/file?sig=x',
        is_carousel_item: 'true',
        access_token: 'page-token',
        appsecret_proof: expect.any(String),
      },
      {
        image_url: 'https://repeat.example.com/api/media/c/file?sig=x',
        is_carousel_item: 'true',
        access_token: 'page-token',
        appsecret_proof: expect.any(String),
      },
    ]);
    // children carry no caption; the carousel container does
    expect(api.created.some((params) => 'caption' in params)).toBe(false);
    expect(started).toMatchObject({
      state: 'processing',
      providerState: { phase: 'children', childIds: ['c1', 'c2', 'c3'] },
    });

    // the video child is still processing: keep waiting, create nothing
    const first = await publisher.getStatus(
      statusInput((started as { providerState: Record<string, unknown> }).providerState),
      ctx,
    );
    expect(first.state).toBe('processing');
    expect(api.created).toHaveLength(3);

    // all children finished: the carousel container is created with the caption
    const second = await publisher.getStatus(
      statusInput((first as { providerState: Record<string, unknown> }).providerState),
      ctx,
    );
    expect(api.created[3]).toMatchObject({
      media_type: 'CAROUSEL',
      children: 'c1,c2,c3',
      caption: 'summer drop',
    });
    expect(second).toMatchObject({
      state: 'processing',
      providerState: { phase: 'container', kind: 'carousel', containerId: 'c4' },
    });

    const done = await publisher.getStatus(
      statusInput((second as { providerState: Record<string, unknown> }).providerState),
      ctx,
    );
    expect(done).toMatchObject({ state: 'published', platformPostId: 'media77' });
    expect(api.published()).toBe('c4');
  });

  it('fails with the item number when Instagram rejects a carousel item', async () => {
    const api = fakeGraph({ c2: ['ERROR'] });
    const ctx = { logger: noopLogger, fetch: api.fetchImpl, onProgress: () => {} };
    const status = await publisher.getStatus(
      statusInput({ phase: 'children', kind: 'carousel', childIds: ['c1', 'c2'], caption: '' }),
      ctx,
    );
    expect(status).toMatchObject({
      state: 'failed',
      error: {
        code: 'media_rejected',
        retryable: false,
        message: expect.stringContaining('carousel item 2'),
      },
    });
  });
});

describe('Instagram media rules', () => {
  it('accepts JPEG images within the size and aspect limits', () => {
    expect(publisher.validateMedia(item('i', 'image/jpeg'))).toEqual({ ok: true });
    expect(publisher.validateMedia(item('i', 'image/jpeg', { width: 1080, height: 1350 }))).toEqual(
      { ok: true },
    ); // 4:5
    expect(publisher.validateMedia(item('i', 'image/jpeg', { width: 1910, height: 1000 }))).toEqual(
      { ok: true },
    ); // 1.91:1
  });
  it('rejects PNG, oversize, too-tall/too-wide and too-narrow images', () => {
    expect(publisher.validateMedia(item('i', 'image/png'))).toMatchObject({
      ok: false,
      message: expect.stringContaining('JPEG'),
    });
    expect(
      publisher.validateMedia(item('i', 'image/jpeg', { sizeBytes: 9 * 1024 * 1024 })),
    ).toMatchObject({ ok: false });
    expect(
      publisher.validateMedia(item('i', 'image/jpeg', { width: 1080, height: 1920 })),
    ).toMatchObject({ ok: false, message: expect.stringContaining('aspect ratio') });
    expect(
      publisher.validateMedia(item('i', 'image/jpeg', { width: 2000, height: 1000 })),
    ).toMatchObject({ ok: false });
    expect(
      publisher.validateMedia(item('i', 'image/jpeg', { width: 300, height: 300 })),
    ).toMatchObject({ ok: false });
  });
  it('advertises carousel support to the core and UI', () => {
    expect(publisher.capabilities).toMatchObject({
      media: { video: true, image: true },
      maxMediaItems: 10,
    });
  });
});
