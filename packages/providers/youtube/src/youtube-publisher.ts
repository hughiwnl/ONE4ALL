import { z } from 'zod';
import type { ProviderCapabilities, SettingsField } from '@repeat/types';
import {
  ProviderError,
  ProviderErrorCode,
  parseRetryAfter,
  requestJson,
  type MediaAccess,
  type MediaDescriptor,
  type ProviderAccount,
  type ProviderContext,
  type ProviderCredentials,
  type PublishContext,
  type PublishInput,
  type PublishResult,
  type PublisherProvider,
  type StatusInput,
  type StatusResult,
  type ValidationResult,
} from '@repeat/provider-sdk';
import { errorFromGoogleResponse, normalizeGoogleError } from './errors.js';
import type { GoogleConnector } from './google-connector.js';

export const YOUTUBE_PLATFORM = 'youtube';

const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';
/** Resumable upload chunks must be multiples of 256 KiB. 8 MiB keeps memory bounded. */
const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK_RETRIES = 5;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export const YOUTUBE_CATEGORIES: { value: string; label: string }[] = [
  { value: '22', label: 'People & Blogs' },
  { value: '1', label: 'Film & Animation' },
  { value: '2', label: 'Autos & Vehicles' },
  { value: '10', label: 'Music' },
  { value: '15', label: 'Pets & Animals' },
  { value: '17', label: 'Sports' },
  { value: '19', label: 'Travel & Events' },
  { value: '20', label: 'Gaming' },
  { value: '23', label: 'Comedy' },
  { value: '24', label: 'Entertainment' },
  { value: '25', label: 'News & Politics' },
  { value: '26', label: 'Howto & Style' },
  { value: '27', label: 'Education' },
  { value: '28', label: 'Science & Technology' },
];

export const youtubeSettingsSchema = z.object({
  /** Falls back to the post title. */
  title: z.string().trim().max(100).optional(),
  /** Falls back to the post description, then caption. */
  description: z.string().max(5000).optional(),
  privacyStatus: z.enum(['public', 'unlisted', 'private']).default('public'),
  categoryId: z.string().regex(/^\d+$/).default('22'),
  /** Comma-separated tags. */
  tags: z.string().max(500).optional(),
  madeForKids: z.boolean().default(false),
  notifySubscribers: z.boolean().default(true),
});
export type YouTubeSettings = z.infer<typeof youtubeSettingsSchema>;

interface VideoResource {
  id: string;
  status?: {
    uploadStatus?: 'uploaded' | 'processed' | 'failed' | 'rejected' | 'deleted';
    failureReason?: string;
    rejectionReason?: string;
    privacyStatus?: string;
  };
  processingDetails?: { processingStatus?: string; processingProgress?: { timeLeftMs?: string } };
}

/**
 * YouTube Data API v3 publisher using the resumable upload protocol.
 * https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
 *
 * Videos are uploaded in 8 MiB chunks read straight from storage, with resume
 * on transient failures, then polled until YouTube finishes processing.
 */
export class YouTubePublisher implements PublisherProvider<YouTubeSettings> {
  readonly platform = YOUTUBE_PLATFORM;
  readonly displayName = 'YouTube';
  readonly settingsSchema = youtubeSettingsSchema;
  readonly capabilities: ProviderCapabilities = {
    media: { video: true, image: false },
    maxFileSizeBytes: 256 * 1024 * 1024 * 1024,
    maxDurationSeconds: 12 * 60 * 60,
    requiresPublicMediaUrl: false,
  };
  readonly settingsFields: SettingsField[] = [
    {
      key: 'title',
      label: 'Title',
      type: 'text',
      maxLength: 100,
      inheritsFrom: 'title',
      placeholder: 'Defaults to the post title',
    },
    {
      key: 'description',
      label: 'Description',
      type: 'textarea',
      maxLength: 5000,
      inheritsFrom: 'description',
      placeholder: 'Defaults to the post description',
    },
    {
      key: 'privacyStatus',
      label: 'Privacy',
      type: 'select',
      default: 'public',
      options: [
        { value: 'public', label: 'Public' },
        { value: 'unlisted', label: 'Unlisted' },
        { value: 'private', label: 'Private' },
      ],
    },
    {
      key: 'categoryId',
      label: 'Category',
      type: 'select',
      default: '22',
      options: YOUTUBE_CATEGORIES,
    },
    {
      key: 'tags',
      label: 'Tags',
      type: 'text',
      maxLength: 500,
      placeholder: 'comma, separated, tags',
    },
    {
      key: 'madeForKids',
      label: 'Made for kids',
      type: 'boolean',
      default: false,
      description: 'Required self-declaration under COPPA.',
    },
    { key: 'notifySubscribers', label: 'Notify subscribers', type: 'boolean', default: true },
  ];
  readonly notes = [
    'Uploads from Google Cloud projects that have not completed the YouTube API audit are locked to private.',
    'Each upload costs about 1,600 units of the default 10,000 units/day YouTube Data API quota.',
    'Videos longer than 15 minutes require a verified YouTube channel.',
  ];

  constructor(private readonly connector: GoogleConnector) {}

  async validateAccount(account: ProviderAccount): Promise<ValidationResult> {
    if (!account.credentials.refreshToken) {
      return {
        ok: false,
        code: ProviderErrorCode.TOKEN_REVOKED,
        message: 'No refresh token stored. Reconnect this YouTube channel.',
      };
    }
    if (!account.credentials.scopes.some((scope) => scope.endsWith('youtube.upload'))) {
      return {
        ok: false,
        code: ProviderErrorCode.INSUFFICIENT_PERMISSIONS,
        message:
          'The youtube.upload permission was not granted. Reconnect and accept all permissions.',
      };
    }
    return { ok: true };
  }

  async refreshCredentialsIfNeeded(
    account: ProviderAccount,
    ctx: ProviderContext,
  ): Promise<ProviderCredentials | null> {
    const { expiresAt, refreshToken } = account.credentials;
    if (!refreshToken) return null;
    if (expiresAt && expiresAt.getTime() - Date.now() > TOKEN_REFRESH_MARGIN_MS) return null;
    const tokens = await this.connector.refreshAccessToken(refreshToken, ctx);
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes.length > 0 ? tokens.scopes : account.credentials.scopes,
    };
  }

  validateMedia(media: MediaDescriptor): ValidationResult {
    if (!media.mimeType.startsWith('video/')) {
      return {
        ok: false,
        code: ProviderErrorCode.INVALID_MEDIA,
        message: 'YouTube only accepts video files',
      };
    }
    if (
      this.capabilities.maxFileSizeBytes &&
      media.sizeBytes > this.capabilities.maxFileSizeBytes
    ) {
      return {
        ok: false,
        code: ProviderErrorCode.INVALID_MEDIA,
        message: 'Video exceeds the 256 GB YouTube limit',
      };
    }
    if (
      media.durationSeconds &&
      this.capabilities.maxDurationSeconds &&
      media.durationSeconds > this.capabilities.maxDurationSeconds
    ) {
      return {
        ok: false,
        code: ProviderErrorCode.INVALID_MEDIA,
        message: 'Video exceeds the 12 hour YouTube limit',
      };
    }
    return { ok: true };
  }

  async publish(input: PublishInput<YouTubeSettings>, ctx: PublishContext): Promise<PublishResult> {
    const { settings, content, media, account } = input;
    const title = (settings.title || content.title || '').trim();
    if (!title) {
      throw ProviderError.permanent(
        ProviderErrorCode.INVALID_SETTINGS,
        'YouTube requires a title. Set a post title or a YouTube-specific title.',
      );
    }
    if (/[<>]/.test(title)) {
      throw ProviderError.permanent(
        ProviderErrorCode.INVALID_SETTINGS,
        'YouTube titles cannot contain "<" or ">".',
      );
    }
    const description = (
      settings.description ??
      content.description ??
      content.caption ??
      ''
    ).slice(0, 5000);
    const tags = settings.tags
      ? settings.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean)
          .slice(0, 100)
      : undefined;

    const fetchImpl = ctx.fetch ?? fetch;
    const headers = { authorization: `Bearer ${account.credentials.accessToken}` };

    // 1. Start a resumable session.
    const startUrl = new URL(UPLOAD_URL);
    startUrl.searchParams.set('uploadType', 'resumable');
    startUrl.searchParams.set('part', 'snippet,status');
    startUrl.searchParams.set('notifySubscribers', String(settings.notifySubscribers));
    const start = await requestJson(startUrl.toString(), {
      method: 'POST',
      headers: {
        ...headers,
        'x-upload-content-length': String(media.sizeBytes),
        'x-upload-content-type': media.mimeType,
      },
      body: {
        snippet: { title, description, categoryId: settings.categoryId, ...(tags ? { tags } : {}) },
        status: {
          privacyStatus: settings.privacyStatus,
          selfDeclaredMadeForKids: settings.madeForKids,
        },
      },
      fetch: fetchImpl,
      signal: ctx.signal,
    });
    if (!start.ok) throw errorFromGoogleResponse(start, 'start upload');
    const uploadUrl = start.headers.get('location');
    if (!uploadUrl)
      throw ProviderError.retryable(
        ProviderErrorCode.PROVIDER_UNAVAILABLE,
        'YouTube did not return an upload session URL',
      );
    ctx.logger.info({ size_bytes: media.sizeBytes }, 'youtube resumable upload session created');

    // 2. Upload chunks with resume support.
    const video = await this.uploadChunks(uploadUrl, media, headers.authorization, fetchImpl, ctx);
    ctx.onProgress(100);

    const platformPostUrl = `https://www.youtube.com/watch?v=${video.id}`;
    const uploadStatus = video.status?.uploadStatus;
    if (uploadStatus === 'processed') {
      return { state: 'published', platformPostId: video.id, platformPostUrl };
    }
    if (uploadStatus === 'failed' || uploadStatus === 'rejected') {
      throw rejectionError(video);
    }
    return {
      state: 'processing',
      platformPostId: video.id,
      platformPostUrl,
      providerState: {},
      pollAfterMs: 15_000,
    };
  }

  async getStatus(input: StatusInput, ctx: ProviderContext): Promise<StatusResult> {
    if (!input.platformPostId) {
      return {
        state: 'failed',
        error: ProviderError.permanent(ProviderErrorCode.UNKNOWN, 'No YouTube video id recorded'),
      };
    }
    const url = new URL(VIDEOS_URL);
    url.searchParams.set('part', 'status,processingDetails');
    url.searchParams.set('id', input.platformPostId);
    const response = await requestJson<{ items?: VideoResource[] }>(url.toString(), {
      headers: { authorization: `Bearer ${input.account.credentials.accessToken}` },
      fetch: ctx.fetch,
      signal: ctx.signal,
    });
    if (!response.ok) throw errorFromGoogleResponse(response, 'video status');
    const video = response.body?.items?.[0];
    const platformPostUrl = `https://www.youtube.com/watch?v=${input.platformPostId}`;
    if (!video) {
      return {
        state: 'failed',
        error: ProviderError.permanent(
          ProviderErrorCode.MEDIA_REJECTED,
          'The uploaded video no longer exists on YouTube',
        ),
      };
    }
    switch (video.status?.uploadStatus) {
      case 'processed':
        return { state: 'published', platformPostId: video.id, platformPostUrl };
      case 'failed':
      case 'rejected':
      case 'deleted':
        return { state: 'failed', error: rejectionError(video) };
      default: {
        const hint = Number(video.processingDetails?.processingProgress?.timeLeftMs);
        const pollAfterMs =
          Number.isFinite(hint) && hint > 0 ? Math.min(Math.max(hint, 10_000), 120_000) : 30_000;
        return {
          state: 'processing',
          platformPostId: video.id,
          platformPostUrl,
          providerState: {},
          pollAfterMs,
        };
      }
    }
  }

  normalizeError(error: unknown): ProviderError {
    return normalizeGoogleError(error);
  }

  private async uploadChunks(
    uploadUrl: string,
    media: MediaAccess,
    authorization: string,
    fetchImpl: typeof fetch,
    ctx: PublishContext,
  ): Promise<VideoResource> {
    const total = media.sizeBytes;
    let offset = 0;
    let consecutiveFailures = 0;

    while (offset < total) {
      const end = Math.min(offset + CHUNK_SIZE, total) - 1;
      const chunk = await readRange(media, offset, end);
      let response: Response;
      try {
        response = await fetchImpl(uploadUrl, {
          method: 'PUT',
          headers: {
            authorization,
            'content-length': String(chunk.length),
            'content-range': `bytes ${offset}-${end}/${total}`,
            'content-type': media.mimeType,
          },
          body: chunk,
          signal: ctx.signal,
        });
      } catch (error) {
        consecutiveFailures += 1;
        if (consecutiveFailures > MAX_CHUNK_RETRIES) {
          throw ProviderError.retryable(
            ProviderErrorCode.NETWORK,
            'Upload to YouTube kept failing; will retry the whole destination later',
            { cause: error },
          );
        }
        ctx.logger.warn(
          { offset, failures: consecutiveFailures },
          'chunk upload failed; querying resume offset',
        );
        offset = await this.queryResumeOffset(uploadUrl, total, authorization, fetchImpl, ctx);
        continue;
      }

      if (response.status === 308) {
        consecutiveFailures = 0;
        offset = nextOffsetFromRange(response.headers.get('range'), end + 1);
        ctx.onProgress((offset / total) * 100);
        continue;
      }
      if (response.ok) {
        const body = (await response.json()) as VideoResource;
        if (!body?.id)
          throw ProviderError.retryable(
            ProviderErrorCode.PROVIDER_UNAVAILABLE,
            'YouTube upload finished without a video id',
          );
        return body;
      }
      if (response.status === 404 || response.status === 410) {
        throw ProviderError.retryable(
          ProviderErrorCode.PROVIDER_UNAVAILABLE,
          'YouTube upload session expired; the destination will be retried from scratch',
        );
      }
      if (response.status >= 500 || response.status === 429) {
        consecutiveFailures += 1;
        if (consecutiveFailures > MAX_CHUNK_RETRIES) {
          throw ProviderError.retryable(
            ProviderErrorCode.PROVIDER_UNAVAILABLE,
            `YouTube upload kept failing (HTTP ${response.status})`,
            {
              retryAfterMs: parseRetryAfter(response.headers),
              details: { status: response.status },
            },
          );
        }
        await sleep(Math.min(30_000, 1000 * 2 ** consecutiveFailures), ctx.signal);
        offset = await this.queryResumeOffset(uploadUrl, total, authorization, fetchImpl, ctx);
        continue;
      }
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep text */
      }
      throw errorFromGoogleResponse(
        { status: response.status, ok: false, headers: response.headers, body: parsed, text },
        'upload chunk',
      );
    }
    throw ProviderError.retryable(
      ProviderErrorCode.PROVIDER_UNAVAILABLE,
      'YouTube upload ended unexpectedly',
    );
  }

  private async queryResumeOffset(
    uploadUrl: string,
    total: number,
    authorization: string,
    fetchImpl: typeof fetch,
    ctx: PublishContext,
  ): Promise<number> {
    const response = await fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: { authorization, 'content-length': '0', 'content-range': `bytes */${total}` },
      signal: ctx.signal,
    });
    if (response.status === 308) return nextOffsetFromRange(response.headers.get('range'), 0);
    if (response.ok) return total; // already complete; the loop will not run again but we need the body...
    throw ProviderError.retryable(
      ProviderErrorCode.PROVIDER_UNAVAILABLE,
      `Could not resume YouTube upload (HTTP ${response.status})`,
    );
  }
}

function nextOffsetFromRange(range: string | null, fallback: number): number {
  // "bytes=0-524287" → 524288
  const match = range?.match(/bytes=\d+-(\d+)/);
  if (!match) return range ? fallback : 0;
  return Number(match[1]) + 1;
}

/** Read an inclusive byte range into a plain ArrayBuffer-backed view (what fetch/Blob accept). */
async function readRange(
  media: MediaAccess,
  start: number,
  end: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = await media.openStream({ start, end });
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
    length += (chunk as Buffer).length;
  }
  const out = new Uint8Array(new ArrayBuffer(length));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function rejectionError(video: VideoResource): ProviderError {
  const reason =
    video.status?.rejectionReason ??
    video.status?.failureReason ??
    video.status?.uploadStatus ??
    'unknown';
  const messages: Record<string, string> = {
    duplicate: 'YouTube rejected the video as a duplicate of an existing upload.',
    copyright: 'YouTube rejected the video for a copyright claim.',
    inappropriate: 'YouTube rejected the video as inappropriate.',
    termsOfUse: 'YouTube rejected the video for a Terms of Use violation.',
    length:
      'The video is too long for this channel (verify the channel to upload videos over 15 minutes).',
    trademark: 'YouTube rejected the video for a trademark issue.',
    uploaderAccountClosed: 'The uploading YouTube account is closed.',
    uploaderAccountSuspended: 'The uploading YouTube account is suspended.',
    codec: 'YouTube could not process the video codec. Re-encode as H.264/AAC MP4.',
    conversion: 'YouTube failed to convert the video. Re-encode and try again.',
    emptyFile: 'The uploaded file was empty.',
    invalidFile: 'YouTube considers the file invalid.',
    tooSmall: 'The uploaded file is too small.',
    uploadAborted: 'The upload was aborted.',
  };
  return ProviderError.permanent(
    ProviderErrorCode.MEDIA_REJECTED,
    messages[reason] ?? `YouTube did not accept the video (${reason}).`,
    {
      details: { reason },
    },
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
