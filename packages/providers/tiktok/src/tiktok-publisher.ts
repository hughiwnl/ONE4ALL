import { z } from 'zod';
import type { ProviderCapabilities, SettingsField } from '@repeat/types';
import {
  isProviderError,
  normalizeUnknownError,
  ProviderError,
  ProviderErrorCode,
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
import {
  errorFromTikTokFailReason,
  errorFromTikTokResponse,
  type TikTokApiErrorBody,
} from './errors.js';
import { queryCreatorInfo, type CreatorInfo, type TikTokConnector } from './tiktok-connector.js';

export const TIKTOK_PLATFORM = 'tiktok';

export const TIKTOK_PRIVACY_LEVELS = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
] as const;

const PRIVACY_LABELS: Record<(typeof TIKTOK_PRIVACY_LEVELS)[number], string> = {
  PUBLIC_TO_EVERYONE: 'Everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Friends',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me',
};

/**
 * Settings follow TikTok's Content Sharing Guidelines for Direct Post:
 * privacy has no default and must be chosen, and Comment/Duet/Stitch are off
 * unless the user turns them on.
 */
export const tiktokSettingsSchema = z
  .object({
    /** Falls back to the post caption, then description, then title. */
    caption: z.string().max(2200).optional(),
    privacyLevel: z.enum(TIKTOK_PRIVACY_LEVELS, {
      required_error: 'Choose who can view the video on TikTok',
      invalid_type_error: 'Choose who can view the video on TikTok',
    }),
    allowComments: z.boolean().default(false),
    allowDuet: z.boolean().default(false),
    allowStitch: z.boolean().default(false),
    /** "Your brand": promotional content for your own business. */
    promotesOwnBrand: z.boolean().default(false),
    /** "Branded content": paid partnership promoting a third party. */
    brandedContent: z.boolean().default(false),
    aiGenerated: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.brandedContent && value.privacyLevel === 'SELF_ONLY') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['privacyLevel'],
        message: 'Branded content cannot be posted with "Only me" visibility',
      });
    }
  });
export type TikTokSettings = z.infer<typeof tiktokSettingsSchema>;

export interface TikTokPublisherOptions {
  /** Chunk size for files larger than `maxSingleChunkBytes`. TikTok allows 5–64 MB. */
  chunkSizeBytes?: number;
  /** Files up to this size are sent as one chunk. Must stay within TikTok's 64 MB chunk limit. */
  maxSingleChunkBytes?: number;
  /** Polls after PUBLISH_COMPLETE to wait for the public post id (moderation). */
  publicIdPolls?: number;
  sleep?: (ms: number) => Promise<void>;
}

const MB = 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * MB;
const MAX_API_DURATION_SECONDS = 10 * 60;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MAX_CHUNK_RETRIES = 3;
const POLL_INTERVAL_MS = 10_000;
const ACCEPTED_MIME_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];

interface InitResponse extends TikTokApiErrorBody {
  data?: { publish_id?: string; upload_url?: string };
}

interface StatusResponse extends TikTokApiErrorBody {
  data?: { status?: string; fail_reason?: string; uploaded_bytes?: number };
}

/**
 * TikTok Content Posting API, Direct Post with FILE_UPLOAD.
 * https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 *
 * Flow: creator_info/query (required every time) → video/init → PUT the file
 * in chunks to the returned upload_url → poll status/fetch until
 * PUBLISH_COMPLETE or FAILED.
 */
export class TikTokPublisher implements PublisherProvider<TikTokSettings> {
  readonly platform = TIKTOK_PLATFORM;
  readonly displayName = 'TikTok';
  readonly settingsSchema = tiktokSettingsSchema;
  readonly capabilities: ProviderCapabilities = {
    media: { video: true, image: false },
    maxFileSizeBytes: MAX_FILE_BYTES,
    maxDurationSeconds: MAX_API_DURATION_SECONDS,
    acceptedMimeTypes: ACCEPTED_MIME_TYPES,
    requiresPublicMediaUrl: false,
  };
  readonly settingsFields: SettingsField[] = [
    {
      key: 'caption',
      label: 'Caption',
      type: 'textarea',
      maxLength: 2200,
      inheritsFrom: 'caption',
      placeholder: 'Defaults to the post caption',
    },
    {
      key: 'privacyLevel',
      label: 'Who can view this video',
      type: 'select',
      required: true,
      description:
        'Required. Choices your TikTok account does not offer are rejected when publishing. Unaudited TikTok apps can only use "Only me".',
      options: [
        { value: '', label: 'Choose…' },
        ...TIKTOK_PRIVACY_LEVELS.map((value) => ({ value, label: PRIVACY_LABELS[value] })),
      ],
    },
    { key: 'allowComments', label: 'Allow comments', type: 'boolean', default: false },
    { key: 'allowDuet', label: 'Allow Duet', type: 'boolean', default: false },
    { key: 'allowStitch', label: 'Allow Stitch', type: 'boolean', default: false },
    {
      key: 'promotesOwnBrand',
      label: 'Promotes your own brand',
      type: 'boolean',
      default: false,
      description: 'Labelled "Promotional content" on TikTok.',
    },
    {
      key: 'brandedContent',
      label: 'Branded content (paid partnership)',
      type: 'boolean',
      default: false,
      description:
        'Labelled "Paid partnership". Cannot be "Only me". Subject to TikTok\'s Branded Content Policy.',
    },
    { key: 'aiGenerated', label: 'AI-generated content', type: 'boolean', default: false },
  ];
  readonly notes = [
    "By posting, you agree to TikTok's Music Usage Confirmation (https://www.tiktok.com/legal/page/global/music-usage-confirmation/en).",
    'Until TikTok audits your app, every post is private ("Only me"), at most 5 accounts can post per 24 hours, and those accounts must be set to private on TikTok.',
    'Interactions the creator disabled in the TikTok app stay disabled, whatever is selected here.',
    "MP4 (H.264 recommended), MOV or WebM; up to 4 GB and 10 minutes (or the account's own limit); 23–60 fps; 360–4096 px per side.",
  ];

  private readonly chunkSizeBytes: number;
  private readonly maxSingleChunkBytes: number;
  private readonly publicIdPolls: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly connector: TikTokConnector,
    options: TikTokPublisherOptions = {},
  ) {
    this.chunkSizeBytes = options.chunkSizeBytes ?? 16 * MB;
    this.maxSingleChunkBytes = options.maxSingleChunkBytes ?? 32 * MB;
    this.publicIdPolls = options.publicIdPolls ?? 6;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async validateAccount(account: ProviderAccount): Promise<ValidationResult> {
    if (!account.credentials.refreshToken) {
      return {
        ok: false,
        code: ProviderErrorCode.TOKEN_REVOKED,
        message: 'No refresh token stored. Reconnect this TikTok account.',
      };
    }
    if (!account.credentials.scopes.includes('video.publish')) {
      return {
        ok: false,
        code: ProviderErrorCode.INSUFFICIENT_PERMISSIONS,
        message:
          'The video.publish permission was not granted. Reconnect and accept all permissions.',
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
      // TikTok may rotate the refresh token; always keep the newest one.
      refreshToken: tokens.refreshToken ?? refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes.length > 0 ? tokens.scopes : account.credentials.scopes,
    };
  }

  validateMedia(media: MediaDescriptor): ValidationResult {
    if (!ACCEPTED_MIME_TYPES.includes(media.mimeType)) {
      return {
        ok: false,
        code: ProviderErrorCode.INVALID_MEDIA,
        message: 'TikTok accepts MP4, MOV or WebM videos only',
      };
    }
    if (media.sizeBytes > MAX_FILE_BYTES) {
      return {
        ok: false,
        code: ProviderErrorCode.INVALID_MEDIA,
        message: 'Video exceeds the 4 GB TikTok limit',
      };
    }
    if (media.durationSeconds != null && media.durationSeconds > MAX_API_DURATION_SECONDS) {
      return {
        ok: false,
        code: ProviderErrorCode.INVALID_MEDIA,
        message: 'TikTok accepts videos up to 10 minutes through the API',
      };
    }
    for (const side of [media.width, media.height]) {
      if (side != null && (side < 360 || side > 4096)) {
        return {
          ok: false,
          code: ProviderErrorCode.INVALID_MEDIA,
          message: 'TikTok requires a resolution between 360 and 4096 pixels on each side',
        };
      }
    }
    return { ok: true };
  }

  async publish(input: PublishInput<TikTokSettings>, ctx: PublishContext): Promise<PublishResult> {
    const { account, media, settings, content } = input;
    const token = account.credentials.accessToken;
    const apiBase = this.connector.apiBaseUrl;

    // 1. Creator info is mandatory before posting: privacy options, interaction
    //    settings and the account's maximum duration can differ per creator.
    const creator = await queryCreatorInfo(apiBase, token, ctx);
    this.checkAgainstCreator(creator, settings, media);

    const caption = (
      settings.caption ??
      content.caption ??
      content.description ??
      content.title ??
      ''
    ).slice(0, 2200);
    const plan = planChunks(media.sizeBytes, this.chunkSizeBytes, this.maxSingleChunkBytes);

    // 2. Initialize the Direct Post.
    const init = await requestJson<InitResponse>(
      new URL('/v2/post/publish/video/init/', apiBase).toString(),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=UTF-8',
        },
        body: {
          post_info: {
            title: caption,
            privacy_level: settings.privacyLevel,
            disable_comment: !settings.allowComments || Boolean(creator.comment_disabled),
            disable_duet: !settings.allowDuet || Boolean(creator.duet_disabled),
            disable_stitch: !settings.allowStitch || Boolean(creator.stitch_disabled),
            brand_organic_toggle: settings.promotesOwnBrand,
            brand_content_toggle: settings.brandedContent,
            is_aigc: settings.aiGenerated,
          },
          source_info: {
            source: 'FILE_UPLOAD',
            video_size: media.sizeBytes,
            chunk_size: plan.chunkSize,
            total_chunk_count: plan.chunkCount,
          },
        },
        fetch: ctx.fetch,
        signal: ctx.signal,
      },
    );
    if (!init.ok || (init.body?.error?.code && init.body.error.code !== 'ok')) {
      throw errorFromTikTokResponse(init, 'initialize post');
    }
    const publishId = init.body?.data?.publish_id;
    const uploadUrl = init.body?.data?.upload_url;
    if (!publishId || !uploadUrl) {
      throw ProviderError.retryable(
        ProviderErrorCode.PROVIDER_UNAVAILABLE,
        'TikTok did not return an upload URL',
      );
    }
    ctx.logger.info(
      { publish_id: publishId, chunks: plan.chunkCount },
      'tiktok upload initialized',
    );

    // 3. Upload every chunk in order.
    await this.uploadChunks(uploadUrl, media, plan, ctx);
    ctx.onProgress(100);

    const username = creator.creator_username ?? stringOrNull(account.metadata.tiktokUsername);
    return {
      state: 'processing',
      platformPostId: publishId,
      platformPostUrl: null,
      providerState: { publishId, username, privacyLevel: settings.privacyLevel, completePolls: 0 },
      pollAfterMs: POLL_INTERVAL_MS,
    };
  }

  async getStatus(input: StatusInput, ctx: ProviderContext): Promise<StatusResult> {
    const publishId = stringOrNull(input.providerState.publishId) ?? input.platformPostId;
    if (!publishId) {
      return {
        state: 'failed',
        error: ProviderError.permanent(ProviderErrorCode.UNKNOWN, 'No TikTok publish id recorded'),
      };
    }
    const response = await requestJson<StatusResponse>(
      new URL('/v2/post/publish/status/fetch/', this.connector.apiBaseUrl).toString(),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.account.credentials.accessToken}`,
          'content-type': 'application/json; charset=UTF-8',
        },
        body: { publish_id: publishId },
        fetch: ctx.fetch,
        signal: ctx.signal,
      },
    );
    if (!response.ok || (response.body?.error?.code && response.body.error.code !== 'ok')) {
      throw errorFromTikTokResponse(response, 'post status');
    }

    const status = response.body?.data?.status;
    const username = stringOrNull(input.providerState.username);
    const processing = (state: Record<string, unknown>): StatusResult => ({
      state: 'processing',
      platformPostId: publishId,
      platformPostUrl: null,
      providerState: state,
      pollAfterMs: POLL_INTERVAL_MS,
    });

    switch (status) {
      case 'PROCESSING_UPLOAD':
      case 'PROCESSING_DOWNLOAD':
        return processing(input.providerState);
      case 'PUBLISH_COMPLETE': {
        // Post ids are int64 and can exceed JavaScript's safe integer range, so read them from the raw text.
        const postId = extractPublicPostIds(response.text)[0] ?? null;
        if (postId) {
          return {
            state: 'published',
            platformPostId: postId,
            platformPostUrl: username
              ? `https://www.tiktok.com/@${username}/video/${postId}`
              : null,
          };
        }
        // Public posts get their id after moderation; wait briefly before settling without a link.
        const completePolls = Number(input.providerState.completePolls ?? 0) + 1;
        if (
          input.providerState.privacyLevel !== 'SELF_ONLY' &&
          completePolls <= this.publicIdPolls
        ) {
          return processing({ ...input.providerState, completePolls });
        }
        return {
          state: 'published',
          platformPostId: publishId,
          platformPostUrl: username ? `https://www.tiktok.com/@${username}` : null,
        };
      }
      case 'FAILED':
        return {
          state: 'failed',
          error: errorFromTikTokFailReason(response.body?.data?.fail_reason),
        };
      case 'SEND_TO_USER_INBOX':
        return {
          state: 'failed',
          error: ProviderError.permanent(
            ProviderErrorCode.UNKNOWN,
            "TikTok sent the video to the creator's inbox instead of posting it. Finish posting in the TikTok app.",
          ),
        };
      default:
        return processing(input.providerState);
    }
  }

  normalizeError(error: unknown): ProviderError {
    return isProviderError(error) ? error : normalizeUnknownError(error);
  }

  private checkAgainstCreator(
    creator: CreatorInfo,
    settings: TikTokSettings,
    media: MediaDescriptor,
  ): void {
    const options = creator.privacy_level_options;
    if (options && options.length > 0 && !options.includes(settings.privacyLevel)) {
      const allowed = options
        .map((option) => PRIVACY_LABELS[option as keyof typeof PRIVACY_LABELS] ?? option)
        .join(', ');
      throw ProviderError.permanent(
        ProviderErrorCode.INVALID_SETTINGS,
        `"${PRIVACY_LABELS[settings.privacyLevel]}" is not available for this TikTok account. Allowed: ${allowed}.`,
        { details: { allowed: options } },
      );
    }
    const maxDuration = creator.max_video_post_duration_sec;
    if (maxDuration && media.durationSeconds != null && media.durationSeconds > maxDuration) {
      throw ProviderError.permanent(
        ProviderErrorCode.INVALID_MEDIA,
        `This TikTok account can post videos up to ${maxDuration} seconds; this one is ${Math.round(media.durationSeconds)} seconds.`,
      );
    }
  }

  private async uploadChunks(
    uploadUrl: string,
    media: MediaAccess,
    plan: ChunkPlan,
    ctx: PublishContext,
  ): Promise<void> {
    const fetchImpl = ctx.fetch ?? fetch;
    for (let index = 0; index < plan.chunkCount; index += 1) {
      const start = index * plan.chunkSize;
      const end = index === plan.chunkCount - 1 ? media.sizeBytes - 1 : start + plan.chunkSize - 1;
      const chunk = await readRange(media, start, end);

      for (let attempt = 1; ; attempt += 1) {
        let response: Response;
        try {
          response = await fetchImpl(uploadUrl, {
            method: 'PUT',
            headers: {
              'content-type': media.mimeType,
              'content-length': String(chunk.length),
              'content-range': `bytes ${start}-${end}/${media.sizeBytes}`,
            },
            body: chunk,
            signal: ctx.signal,
          });
        } catch (error) {
          if (attempt >= MAX_CHUNK_RETRIES) {
            throw ProviderError.retryable(
              ProviderErrorCode.NETWORK,
              'Upload to TikTok kept failing; the destination will be retried',
              { cause: error },
            );
          }
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }

        if (response.status === 201 || response.status === 206 || response.ok) break;
        if (response.status === 403 || response.status === 416) {
          throw ProviderError.retryable(
            ProviderErrorCode.PROVIDER_UNAVAILABLE,
            response.status === 403
              ? 'The TikTok upload URL expired; the destination will be retried from the start'
              : 'TikTok lost track of the upload; the destination will be retried from the start',
            { details: { status: response.status } },
          );
        }
        if ((response.status >= 500 || response.status === 429) && attempt < MAX_CHUNK_RETRIES) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        const text = await response.text().catch(() => '');
        if (response.status >= 500 || response.status === 429) {
          throw ProviderError.retryable(
            ProviderErrorCode.PROVIDER_UNAVAILABLE,
            `TikTok upload kept failing (HTTP ${response.status})`,
            { details: { status: response.status } },
          );
        }
        throw ProviderError.permanent(
          ProviderErrorCode.INVALID_MEDIA,
          `TikTok rejected the upload (HTTP ${response.status})${text ? `: ${text.slice(0, 200)}` : ''}`,
          { details: { status: response.status } },
        );
      }
      ctx.onProgress(((end + 1) / media.sizeBytes) * 100);
    }
  }
}

export interface ChunkPlan {
  chunkSize: number;
  chunkCount: number;
}

/**
 * TikTok chunk rules: chunks of 5–64 MB, the last one absorbs the remainder
 * (up to 128 MB), total_chunk_count = floor(size / chunk_size), and files
 * under 5 MB go up whole. Small files are sent as a single chunk.
 */
export function planChunks(
  sizeBytes: number,
  chunkSize: number,
  maxSingleChunk: number,
): ChunkPlan {
  if (sizeBytes <= maxSingleChunk) return { chunkSize: sizeBytes, chunkCount: 1 };
  return { chunkSize, chunkCount: Math.floor(sizeBytes / chunkSize) };
}

/** Pull `publicaly_available_post_id` (TikTok's spelling) as strings, preserving int64 precision. */
export function extractPublicPostIds(rawJson: string): string[] {
  const match = rawJson.match(/"publicaly_available_post_id"\s*:\s*\[([^\]]*)\]/);
  if (!match?.[1]) return [];
  return match[1]
    .split(',')
    .map((part) => part.trim().replace(/^"|"$/g, ''))
    .filter((part) => /^\d+$/.test(part));
}

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

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
