import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  noopLogger,
  type MediaAccess,
  type ProviderAccount,
  type PublishInput,
} from '@repeat/provider-sdk';
import { errorFromTikTokFailReason, errorFromTikTokResponse } from '../errors.js';
import { TikTokConnector } from '../tiktok-connector.js';
import {
  extractPublicPostIds,
  planChunks,
  TikTokPublisher,
  tiktokSettingsSchema,
  type TikTokSettings,
} from '../tiktok-publisher.js';

const API = 'https://open.tiktokapis.com';
const bytes = Buffer.alloc(2500, 3);

const media: MediaAccess = {
  id: 'm1',
  filename: 'clip.mp4',
  mimeType: 'video/mp4',
  sizeBytes: bytes.length,
  durationSeconds: 42,
  width: 1080,
  height: 1920,
  openStream: async (range) =>
    Readable.from([bytes.subarray(range?.start ?? 0, (range?.end ?? bytes.length - 1) + 1)]),
  getPublicUrl: async () => null,
};

const account: ProviderAccount = {
  id: 'acc',
  platform: 'tiktok',
  platformAccountId: 'open-123',
  displayName: 'Creator',
  username: '@creator',
  metadata: { tiktokUsername: 'creator' },
  credentials: {
    accessToken: 'act.token',
    refreshToken: 'rft.token',
    expiresAt: new Date(Date.now() + 3600_000),
    scopes: ['user.info.basic', 'video.publish'],
  },
};

const connector = new TikTokConnector({ clientKey: 'key', clientSecret: 'secret' });
// Tiny chunks so a 2,500-byte file exercises the multi-chunk path: 1000-byte chunks → 2 chunks (1000 + 1500).
const publisher = new TikTokPublisher(connector, {
  chunkSizeBytes: 1000,
  maxSingleChunkBytes: 1000,
  publicIdPolls: 2,
  sleep: async () => {},
});

function input(
  settings: Partial<TikTokSettings> & Record<string, unknown> = {},
): PublishInput<TikTokSettings> {
  return {
    destinationId: 'd1',
    postId: 'p1',
    attempt: 1,
    account,
    media,
    mediaItems: [media],
    content: { title: 'Title', caption: 'hello tiktok', description: null },
    settings: tiktokSettingsSchema.parse({ privacyLevel: 'SELF_ONLY', ...settings }),
  };
}

const creatorInfo = {
  creator_username: 'creator',
  creator_nickname: 'Creator',
  privacy_level_options: ['PUBLIC_TO_EVERYONE', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'],
  comment_disabled: false,
  duet_disabled: true,
  stitch_disabled: false,
  max_video_post_duration_sec: 600,
};

function ok(data: unknown, status = 200) {
  return Response.json({ data, error: { code: 'ok', message: '', log_id: 'l' } }, { status });
}

/** Fake Content Posting API. */
function fakeTikTok(
  overrides: { creator?: Record<string, unknown>; failChunkOnce?: boolean } = {},
) {
  let received = 0;
  let failed = false;
  let initBody: {
    post_info: Record<string, unknown>;
    source_info: Record<string, unknown>;
  } | null = null;
  const puts: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const headers = new Headers(init?.headers);
    if (href === `${API}/v2/post/publish/creator_info/query/`) {
      expect(headers.get('authorization')).toBe('Bearer act.token');
      return ok({ ...creatorInfo, ...overrides.creator });
    }
    if (href === `${API}/v2/post/publish/video/init/`) {
      initBody = JSON.parse(String(init?.body)) as NonNullable<typeof initBody>;
      return ok({ publish_id: 'v_pub_1', upload_url: 'https://upload.tiktokapis.com/upload/abc' });
    }
    if (href === 'https://upload.tiktokapis.com/upload/abc') {
      const range = headers.get('content-range')!;
      puts.push(range);
      if (overrides.failChunkOnce && !failed) {
        failed = true;
        return new Response('busy', { status: 503 });
      }
      const [, start, end] = range.match(/bytes (\d+)-(\d+)\//)!;
      expect(Number(start)).toBe(received);
      received = Number(end) + 1;
      return new Response(null, { status: received === bytes.length ? 201 : 206 });
    }
    return new Response('unexpected', { status: 500 });
  }) as unknown as typeof fetch;
  return { fetchImpl, puts, init: () => initBody, received: () => received };
}

describe('TikTokPublisher.publish', () => {
  it('queries creator info, initializes a Direct Post, and uploads the file in ordered chunks', async () => {
    const server = fakeTikTok();
    const progress: number[] = [];
    const result = await publisher.publish(input({ allowComments: true, allowDuet: true }), {
      logger: noopLogger,
      fetch: server.fetchImpl,
      onProgress: (p) => progress.push(p),
    });

    expect(result).toMatchObject({
      state: 'processing',
      platformPostId: 'v_pub_1',
      providerState: { publishId: 'v_pub_1', username: 'creator', privacyLevel: 'SELF_ONLY' },
    });
    expect(server.received()).toBe(bytes.length);
    expect(server.puts).toEqual(['bytes 0-999/2500', 'bytes 1000-2499/2500']);
    expect(progress.at(-1)).toBe(100);

    const body = server.init()!;
    expect(body.source_info).toEqual({
      source: 'FILE_UPLOAD',
      video_size: 2500,
      chunk_size: 1000,
      total_chunk_count: 2,
    });
    expect(body.post_info).toMatchObject({
      title: 'hello tiktok',
      privacy_level: 'SELF_ONLY',
      disable_comment: false,
      // the creator disabled Duet in TikTok, so it stays disabled even though it was allowed here
      disable_duet: true,
      disable_stitch: true,
      brand_organic_toggle: false,
      brand_content_toggle: false,
      is_aigc: false,
    });
  });

  it('retries a chunk after a transient upload error', async () => {
    const server = fakeTikTok({ failChunkOnce: true });
    const result = await publisher.publish(input(), {
      logger: noopLogger,
      fetch: server.fetchImpl,
      onProgress: () => {},
    });
    expect(result.state).toBe('processing');
    expect(server.received()).toBe(bytes.length);
    expect(server.puts[0]).toBe(server.puts[1]);
  });

  it('rejects a privacy level the creator does not offer, before uploading anything', async () => {
    const server = fakeTikTok();
    await expect(
      publisher.publish(input({ privacyLevel: 'MUTUAL_FOLLOW_FRIENDS' }), {
        logger: noopLogger,
        fetch: server.fetchImpl,
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({
      code: 'invalid_settings',
      retryable: false,
      message: expect.stringContaining('Friends'),
    });
    expect(server.init()).toBeNull();
  });

  it("enforces the account's own maximum duration", async () => {
    const server = fakeTikTok({ creator: { max_video_post_duration_sec: 30 } });
    await expect(
      publisher.publish(input(), {
        logger: noopLogger,
        fetch: server.fetchImpl,
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({
      code: 'invalid_media',
      message: expect.stringContaining('30 seconds'),
    });
  });

  it('maps the unaudited-app error from init', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('creator_info')) return ok(creatorInfo);
      return Response.json(
        {
          data: {},
          error: {
            code: 'unaudited_client_can_only_post_to_private_accounts',
            message: 'x',
            log_id: 'l',
          },
        },
        { status: 400 },
      );
    }) as unknown as typeof fetch;
    await expect(
      publisher.publish(input({ privacyLevel: 'PUBLIC_TO_EVERYONE' }), {
        logger: noopLogger,
        fetch: fetchImpl,
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({ code: 'insufficient_permissions', retryable: false });
  });
});

describe('TikTokPublisher.getStatus', () => {
  function statusFetch(text: string) {
    return vi.fn(
      async () =>
        new Response(text, { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch;
  }
  const base = {
    destinationId: 'd1',
    account,
    platformPostId: 'v_pub_1',
    processingSince: new Date(),
  };

  it('keeps processing while TikTok is working', async () => {
    const result = await publisher.getStatus(
      { ...base, providerState: { publishId: 'v_pub_1', username: 'creator' } },
      {
        logger: noopLogger,
        fetch: statusFetch('{"data":{"status":"PROCESSING_UPLOAD"},"error":{"code":"ok"}}'),
      },
    );
    expect(result.state).toBe('processing');
  });

  it('publishes with a video link and keeps int64 post ids exact', async () => {
    const result = await publisher.getStatus(
      {
        ...base,
        providerState: {
          publishId: 'v_pub_1',
          username: 'creator',
          privacyLevel: 'PUBLIC_TO_EVERYONE',
        },
      },
      {
        logger: noopLogger,
        fetch: statusFetch(
          '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7412345678901234567]},"error":{"code":"ok"}}',
        ),
      },
    );
    expect(result).toEqual({
      state: 'published',
      platformPostId: '7412345678901234567',
      platformPostUrl: 'https://www.tiktok.com/@creator/video/7412345678901234567',
    });
  });

  it('waits for moderation on public posts, then settles on the profile link', async () => {
    const fetchImpl = statusFetch(
      '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[]},"error":{"code":"ok"}}',
    );
    const state = {
      publishId: 'v_pub_1',
      username: 'creator',
      privacyLevel: 'PUBLIC_TO_EVERYONE',
      completePolls: 0,
    };
    const first = await publisher.getStatus(
      { ...base, providerState: state },
      { logger: noopLogger, fetch: fetchImpl },
    );
    expect(first).toMatchObject({ state: 'processing', providerState: { completePolls: 1 } });
    const last = await publisher.getStatus(
      { ...base, providerState: { ...state, completePolls: 2 } },
      { logger: noopLogger, fetch: fetchImpl },
    );
    expect(last).toEqual({
      state: 'published',
      platformPostId: 'v_pub_1',
      platformPostUrl: 'https://www.tiktok.com/@creator',
    });
  });

  it('settles private posts immediately', async () => {
    const result = await publisher.getStatus(
      {
        ...base,
        providerState: { publishId: 'v_pub_1', username: 'creator', privacyLevel: 'SELF_ONLY' },
      },
      {
        logger: noopLogger,
        fetch: statusFetch('{"data":{"status":"PUBLISH_COMPLETE"},"error":{"code":"ok"}}'),
      },
    );
    expect(result.state).toBe('published');
  });

  it('maps FAILED fail_reason values', async () => {
    const result = await publisher.getStatus(
      { ...base, providerState: { publishId: 'v_pub_1' } },
      {
        logger: noopLogger,
        fetch: statusFetch(
          '{"data":{"status":"FAILED","fail_reason":"frame_rate_check_failed"},"error":{"code":"ok"}}',
        ),
      },
    );
    expect(result).toMatchObject({
      state: 'failed',
      error: { code: 'invalid_media', retryable: false },
    });
  });
});

describe('TikTok settings and media rules', () => {
  it('requires privacy to be chosen and defaults interactions to off', () => {
    expect(tiktokSettingsSchema.safeParse({}).success).toBe(false);
    const parsed = tiktokSettingsSchema.parse({ privacyLevel: 'PUBLIC_TO_EVERYONE' });
    expect(parsed).toMatchObject({ allowComments: false, allowDuet: false, allowStitch: false });
  });
  it('refuses branded content with "Only me"', () => {
    const result = tiktokSettingsSchema.safeParse({
      privacyLevel: 'SELF_ONLY',
      brandedContent: true,
    });
    expect(result.success).toBe(false);
  });
  it('validates format, size, duration and resolution', () => {
    expect(publisher.validateMedia(media)).toEqual({ ok: true });
    expect(publisher.validateMedia({ ...media, mimeType: 'video/x-matroska' })).toMatchObject({
      ok: false,
    });
    expect(publisher.validateMedia({ ...media, durationSeconds: 601 })).toMatchObject({
      ok: false,
    });
    expect(publisher.validateMedia({ ...media, width: 200 })).toMatchObject({ ok: false });
    expect(publisher.validateMedia({ ...media, sizeBytes: 5 * 1024 ** 3 })).toMatchObject({
      ok: false,
    });
  });
  it('plans chunks according to TikTok rules', () => {
    const MB = 1024 * 1024;
    expect(planChunks(3 * MB, 16 * MB, 32 * MB)).toEqual({ chunkSize: 3 * MB, chunkCount: 1 });
    expect(planChunks(30 * MB, 16 * MB, 32 * MB)).toEqual({ chunkSize: 30 * MB, chunkCount: 1 });
    // 100 MB → 6 chunks of 16 MB, the last absorbing the remaining 20 MB
    expect(planChunks(100 * MB, 16 * MB, 32 * MB)).toEqual({ chunkSize: 16 * MB, chunkCount: 6 });
  });
  it('extracts post ids from raw JSON without precision loss', () => {
    expect(
      extractPublicPostIds('{"publicaly_available_post_id":[7412345678901234567, "123"]}'),
    ).toEqual(['7412345678901234567', '123']);
    expect(extractPublicPostIds('{"data":{}}')).toEqual([]);
  });
});

describe('TikTok credentials', () => {
  it('refreshes near expiry and keeps a rotated refresh token', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('refresh_token')).toBe('rft.token');
      return Response.json({
        access_token: 'act.new',
        refresh_token: 'rft.new',
        expires_in: 86400,
        scope: 'user.info.basic,video.publish',
      });
    }) as unknown as typeof fetch;
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
    expect(refreshed).toMatchObject({
      accessToken: 'act.new',
      refreshToken: 'rft.new',
      scopes: ['user.info.basic', 'video.publish'],
    });
  });

  it('flags accounts without video.publish', async () => {
    const limited = {
      ...account,
      credentials: { ...account.credentials, scopes: ['user.info.basic'] },
    };
    expect(await publisher.validateAccount(limited)).toMatchObject({
      ok: false,
      code: 'insufficient_permissions',
    });
  });
});

describe('TikTokConnector', () => {
  it('builds the Login Kit authorization URL', () => {
    const url = new URL(
      connector.getAuthorizationUrl({
        state: 'st',
        redirectUri: 'https://repeat.example.com/api/connect/tiktok/callback',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(url.searchParams.get('client_key')).toBe('key');
    expect(url.searchParams.get('scope')).toBe('user.info.basic,video.publish');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('st');
  });

  it('exchanges the code and discovers the account with its username', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === `${API}/v2/oauth/token/`) {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get('grant_type')).toBe('authorization_code');
        expect(form.get('client_secret')).toBe('secret');
        return Response.json({
          access_token: 'act.1',
          refresh_token: 'rft.1',
          expires_in: 86400,
          refresh_expires_in: 31536000,
          open_id: 'open-123',
          scope: 'user.info.basic,video.publish',
          token_type: 'Bearer',
        });
      }
      if (href.startsWith(`${API}/v2/user/info/`)) {
        return ok({
          user: {
            open_id: 'open-123',
            display_name: 'Creator Name',
            avatar_url: 'https://p16.tiktokcdn.com/a.jpg',
          },
        });
      }
      if (href === `${API}/v2/post/publish/creator_info/query/`) return ok(creatorInfo);
      return new Response('unexpected', { status: 500 });
    }) as unknown as typeof fetch;

    const tokens = await connector.exchangeCode(
      { code: 'c', redirectUri: 'https://x/cb' },
      { logger: noopLogger, fetch: fetchImpl },
    );
    expect(tokens.scopes).toEqual(['user.info.basic', 'video.publish']);
    const [discovered] = await connector.discoverAccounts(tokens, {
      logger: noopLogger,
      fetch: fetchImpl,
    });
    expect(discovered).toMatchObject({
      platform: 'tiktok',
      platformAccountId: 'open-123',
      displayName: 'Creator Name',
      username: '@creator',
      metadata: { tiktokUsername: 'creator', profileUrl: 'https://www.tiktok.com/@creator' },
      credentials: { accessToken: 'act.1', refreshToken: 'rft.1' },
    });
  });

  it('reports a token endpoint error returned with HTTP 200', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: 'invalid_grant', error_description: 'expired', log_id: 'l' }),
    ) as unknown as typeof fetch;
    await expect(
      connector.refreshAccessToken('old', { logger: noopLogger, fetch: fetchImpl }),
    ).rejects.toMatchObject({
      code: 'token_revoked',
      retryable: false,
    });
  });

  it('refuses logins that did not grant video.publish', async () => {
    await expect(
      connector.discoverAccounts(
        { accessToken: 'a', refreshToken: 'r', expiresAt: null, scopes: ['user.info.basic'] },
        { logger: noopLogger },
      ),
    ).rejects.toMatchObject({ code: 'insufficient_permissions' });
  });
});

describe('errorFromTikTokResponse', () => {
  const make = (code: string, status: number) =>
    errorFromTikTokResponse(
      {
        status,
        ok: false,
        headers: new Headers(),
        body: { error: { code, message: 'm' } },
        text: '',
      },
      'test',
    );
  it('classifies documented error codes', () => {
    expect(make('access_token_invalid', 401)).toMatchObject({
      code: 'token_expired',
      retryable: false,
    });
    expect(make('scope_not_authorized', 401)).toMatchObject({
      code: 'insufficient_permissions',
      retryable: false,
    });
    expect(make('rate_limit_exceeded', 429)).toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
    expect(make('spam_risk_too_many_posts', 400)).toMatchObject({
      code: 'quota_exceeded',
      retryable: false,
    });
    expect(make('reached_active_user_cap', 400)).toMatchObject({ code: 'quota_exceeded' });
    expect(make('privacy_level_option_mismatch', 400)).toMatchObject({ code: 'invalid_settings' });
    expect(make('something_new', 503)).toMatchObject({ retryable: true });
  });
  it('classifies fail reasons', () => {
    expect(errorFromTikTokFailReason('auth_removed')).toMatchObject({
      code: 'token_revoked',
      retryable: false,
    });
    expect(errorFromTikTokFailReason('internal')).toMatchObject({ retryable: true });
    expect(errorFromTikTokFailReason('spam_risk_text')).toMatchObject({ code: 'media_rejected' });
  });
});
