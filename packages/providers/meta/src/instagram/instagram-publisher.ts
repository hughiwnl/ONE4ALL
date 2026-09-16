import { z } from 'zod';
import type { ProviderCapabilities, SettingsField } from '@repeat/types';
import {
  ProviderError,
  ProviderErrorCode,
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
import { normalizeMetaError } from '../errors.js';
import type { GraphClient } from '../graph-client.js';

export const INSTAGRAM_PLATFORM = 'instagram';

export const instagramSettingsSchema = z.object({
  /** Falls back to the post caption, then description. Max 2,200 characters. */
  caption: z.string().max(2200).optional(),
  /** Reels can also appear in the main feed. */
  shareToFeed: z.boolean().default(true),
});
export type InstagramSettings = z.infer<typeof instagramSettingsSchema>;

interface ContainerStatus {
  id: string;
  status_code?: string; // 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED'
  status?: string;
}

/**
 * Instagram Content Publishing API (via a Facebook Page-linked professional account).
 * https://developers.facebook.com/docs/instagram-platform/content-publishing
 *
 * Flow: create a REELS media container from a public video URL → Instagram
 * downloads and processes it asynchronously → publish the container → read
 * the permalink. Because Instagram fetches the file itself, this provider
 * needs `APP_URL` to be publicly reachable (see `requiresPublicMediaUrl`).
 */
export class InstagramPublisher implements PublisherProvider<InstagramSettings> {
  readonly platform = INSTAGRAM_PLATFORM;
  readonly displayName = 'Instagram';
  readonly settingsSchema = instagramSettingsSchema;
  readonly capabilities: ProviderCapabilities = {
    media: { video: true, image: false },
    maxFileSizeBytes: 1024 * 1024 * 1024,
    minDurationSeconds: 3,
    maxDurationSeconds: 15 * 60,
    acceptedMimeTypes: ['video/mp4', 'video/quicktime'],
    requiresPublicMediaUrl: true,
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
    { key: 'shareToFeed', label: 'Also share to feed', type: 'boolean', default: true },
  ];
  readonly notes = [
    'Only Instagram Business or Creator accounts linked to a Facebook Page can be connected; personal accounts are not supported by the API.',
    'Videos are published as Reels (MP4/MOV, H.264 + AAC, 3 s to 15 min, up to 1 GB). Instagram downloads the file from this server, so APP_URL must be publicly reachable over HTTPS.',
    'Instagram allows 100 API-published posts per account per rolling 24 hours.',
    'Requires instagram_basic and instagram_content_publish, which need Meta App Review outside development mode.',
  ];

  constructor(private readonly graph: GraphClient) {}

  async validateAccount(account: ProviderAccount): Promise<ValidationResult> {
    if (!account.credentials.accessToken) {
      return {
        ok: false,
        code: ProviderErrorCode.TOKEN_REVOKED,
        message: 'No access token stored. Reconnect this Instagram account.',
      };
    }
    if (account.credentials.expiresAt && account.credentials.expiresAt.getTime() < Date.now()) {
      return {
        ok: false,
        code: ProviderErrorCode.TOKEN_EXPIRED,
        message: 'The access token expired. Reconnect this Instagram account.',
      };
    }
    return { ok: true };
  }

  async refreshCredentialsIfNeeded(): Promise<ProviderCredentials | null> {
    return null;
  }

  validateMedia(media: MediaDescriptor): ValidationResult {
    const caps = this.capabilities;
    if (!caps.acceptedMimeTypes!.includes(media.mimeType)) {
      return {
        ok: false,
        code: ProviderErrorCode.INVALID_MEDIA,
        message: 'Instagram accepts MP4 or MOV videos only',
      };
    }
    if (media.sizeBytes > caps.maxFileSizeBytes!) {
      return {
        ok: false,
        code: ProviderErrorCode.INVALID_MEDIA,
        message: 'Video exceeds the 1 GB Instagram limit',
      };
    }
    if (media.durationSeconds != null) {
      if (media.durationSeconds < caps.minDurationSeconds!) {
        return {
          ok: false,
          code: ProviderErrorCode.INVALID_MEDIA,
          message: 'Instagram Reels must be at least 3 seconds long',
        };
      }
      if (media.durationSeconds > caps.maxDurationSeconds!) {
        return {
          ok: false,
          code: ProviderErrorCode.INVALID_MEDIA,
          message: 'Instagram Reels can be at most 15 minutes long',
        };
      }
    }
    if (media.width && media.width > 1920) {
      return {
        ok: false,
        code: ProviderErrorCode.INVALID_MEDIA,
        message: 'Instagram Reels must be at most 1920 pixels wide',
      };
    }
    return { ok: true };
  }

  async publish(
    input: PublishInput<InstagramSettings>,
    ctx: PublishContext,
  ): Promise<PublishResult> {
    const { account, media, settings, content } = input;
    const token = account.credentials.accessToken;
    const videoUrl = await media.getPublicUrl();
    if (!videoUrl) {
      throw ProviderError.permanent(
        ProviderErrorCode.NOT_CONFIGURED,
        'Instagram needs a public URL for the video. Set APP_URL to a publicly reachable HTTPS address.',
      );
    }
    const caption = (settings.caption ?? content.caption ?? content.description ?? '').slice(
      0,
      2200,
    );

    const container = await this.graph.post<{ id: string }>(
      `${account.platformAccountId}/media`,
      {
        media_type: 'REELS',
        video_url: videoUrl,
        caption,
        share_to_feed: String(settings.shareToFeed),
      },
      token,
      ctx,
      'create media container',
    );
    ctx.logger.info({ container_id: container.id }, 'instagram media container created');
    ctx.onProgress(100);

    return {
      state: 'processing',
      platformPostId: null,
      platformPostUrl: null,
      providerState: { containerId: container.id, phase: 'container' },
      pollAfterMs: 15_000,
    };
  }

  async getStatus(input: StatusInput, ctx: ProviderContext): Promise<StatusResult> {
    const token = input.account.credentials.accessToken;
    const containerId =
      typeof input.providerState.containerId === 'string' ? input.providerState.containerId : '';
    const phase =
      typeof input.providerState.phase === 'string' ? input.providerState.phase : 'container';

    if (phase === 'container') {
      if (!containerId) {
        return {
          state: 'failed',
          error: ProviderError.permanent(
            ProviderErrorCode.UNKNOWN,
            'No Instagram container id recorded',
          ),
        };
      }
      const status = await this.graph.get<ContainerStatus>(
        containerId,
        { fields: 'status_code,status' },
        token,
        ctx,
        'container status',
      );
      switch (status.status_code) {
        case 'FINISHED':
          break;
        case 'IN_PROGRESS':
          return {
            state: 'processing',
            platformPostId: null,
            platformPostUrl: null,
            providerState: input.providerState,
            pollAfterMs: 15_000,
          };
        case 'ERROR':
        case 'EXPIRED':
        default:
          return {
            state: 'failed',
            error: ProviderError.permanent(
              ProviderErrorCode.MEDIA_REJECTED,
              `Instagram could not process the video (${status.status_code ?? 'unknown'}): ${status.status ?? 'no details'}`,
            ),
          };
      }
      const published = await this.graph.post<{ id: string }>(
        `${input.account.platformAccountId}/media_publish`,
        { creation_id: containerId },
        token,
        ctx,
        'publish media container',
      );
      ctx.logger.info({ media_id: published.id }, 'instagram media published');
      const permalink = await this.fetchPermalink(published.id, token, ctx);
      return { state: 'published', platformPostId: published.id, platformPostUrl: permalink };
    }

    // Defensive: an unknown phase means state we do not understand; do not loop forever.
    return {
      state: 'failed',
      error: ProviderError.permanent(
        ProviderErrorCode.UNKNOWN,
        `Unknown Instagram publish phase "${phase}"`,
      ),
    };
  }

  normalizeError(error: unknown): ProviderError {
    return normalizeMetaError(error);
  }

  private async fetchPermalink(
    mediaId: string,
    token: string,
    ctx: ProviderContext,
  ): Promise<string | null> {
    try {
      const media = await this.graph.get<{ permalink?: string }>(
        mediaId,
        { fields: 'permalink' },
        token,
        ctx,
        'media permalink',
      );
      return media.permalink ?? null;
    } catch (error) {
      ctx.logger.warn({ err: error }, 'could not fetch instagram permalink');
      return null;
    }
  }
}
