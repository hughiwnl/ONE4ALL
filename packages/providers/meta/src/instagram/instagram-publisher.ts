import { z } from 'zod';
import type { ProviderCapabilities, SettingsField } from '@repeat/types';
import {
  ProviderError,
  ProviderErrorCode,
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
import { normalizeMetaError } from '../errors.js';
import type { GraphClient } from '../graph-client.js';

export const INSTAGRAM_PLATFORM = 'instagram';

const MB = 1024 * 1024;
const MAX_VIDEO_BYTES = 1024 * MB;
const MAX_IMAGE_BYTES = 8 * MB;
const MAX_CAROUSEL_ITEMS = 10;
const VIDEO_TYPES = ['video/mp4', 'video/quicktime'];
const IMAGE_TYPES = ['image/jpeg'];

export const instagramSettingsSchema = z.object({
  /** Falls back to the post caption, then description. Max 2,200 characters. */
  caption: z.string().max(2200).optional(),
  /** Reels only: also show the Reel in the main feed. */
  shareToFeed: z.boolean().default(true),
  /** Single image posts only: accessibility description. */
  altText: z.string().max(1000).optional(),
});
export type InstagramSettings = z.infer<typeof instagramSettingsSchema>;

interface ContainerStatus {
  id: string;
  status_code?: string; // 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED'
  status?: string;
}

type PostKind = 'reel' | 'image' | 'carousel';

/**
 * Instagram Content Publishing API (via a Facebook Page-linked professional account).
 * https://developers.facebook.com/docs/instagram-platform/content-publishing
 *
 * Three shapes, all built from media containers that Instagram downloads from
 * a public URL (so `APP_URL` must be publicly reachable over HTTPS):
 *
 * - one video  → a REELS container → publish
 * - one image  → an image container (JPEG only) → publish
 * - 2–10 items → one child container per item (is_carousel_item), wait until
 *   every child is FINISHED, then a CAROUSEL container listing the children →
 *   publish. A carousel counts as one post towards the 100-per-day limit.
 */
export class InstagramPublisher implements PublisherProvider<InstagramSettings> {
  readonly platform = INSTAGRAM_PLATFORM;
  readonly displayName = 'Instagram';
  readonly settingsSchema = instagramSettingsSchema;
  readonly capabilities: ProviderCapabilities = {
    media: { video: true, image: true },
    maxMediaItems: MAX_CAROUSEL_ITEMS,
    maxFileSizeBytes: MAX_VIDEO_BYTES,
    minDurationSeconds: 3,
    maxDurationSeconds: 15 * 60,
    acceptedMimeTypes: [...VIDEO_TYPES, ...IMAGE_TYPES],
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
    {
      key: 'shareToFeed',
      label: 'Also share Reels to feed',
      type: 'boolean',
      default: true,
      description: 'Applies to single-video posts (Reels).',
    },
    {
      key: 'altText',
      label: 'Alt text',
      type: 'text',
      maxLength: 1000,
      placeholder: 'Describe the image for people using screen readers',
      description: 'Applies to single-image posts.',
    },
  ];
  readonly notes = [
    'Only Instagram Business or Creator accounts linked to a Facebook Page can be connected; personal accounts are not supported by the API.',
    'A single video is published as a Reel (MP4/MOV, H.264 + AAC, 3 s to 15 min, up to 1 GB). A single image is published as a photo post. 2–10 items are published as a carousel.',
    'Images must be JPEG (Instagram does not accept PNG through its API), up to 8 MB, with an aspect ratio between 4:5 and 1.91:1.',
    'Instagram downloads files from this server, so APP_URL must be publicly reachable over HTTPS.',
    'Instagram allows 100 API-published posts per account per rolling 24 hours; a carousel counts as one.',
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
    const invalid = (message: string): ValidationResult => ({
      ok: false,
      code: ProviderErrorCode.INVALID_MEDIA,
      message,
    });

    if (media.mimeType.startsWith('image/')) {
      if (!IMAGE_TYPES.includes(media.mimeType)) {
        return invalid('Instagram accepts JPEG images only. Convert the image to JPEG first.');
      }
      if (media.sizeBytes > MAX_IMAGE_BYTES)
        return invalid('Images must be at most 8 MB for Instagram');
      if (media.width != null && media.width < 320) {
        return invalid('Images must be at least 320 pixels wide for Instagram');
      }
      if (media.width && media.height) {
        const ratio = media.width / media.height;
        if (ratio < 0.8 - 0.005 || ratio > 1.91 + 0.005) {
          return invalid(
            `Instagram images must have an aspect ratio between 4:5 and 1.91:1 (this one is ${media.width}×${media.height})`,
          );
        }
      }
      return { ok: true };
    }

    if (!VIDEO_TYPES.includes(media.mimeType)) {
      return invalid('Instagram accepts MP4 or MOV videos only');
    }
    if (media.sizeBytes > MAX_VIDEO_BYTES) return invalid('Video exceeds the 1 GB Instagram limit');
    if (media.durationSeconds != null) {
      if (media.durationSeconds < 3)
        return invalid('Instagram videos must be at least 3 seconds long');
      if (media.durationSeconds > 15 * 60)
        return invalid('Instagram videos can be at most 15 minutes long');
    }
    if (media.width && media.width > 1920) {
      return invalid('Instagram videos must be at most 1920 pixels wide');
    }
    return { ok: true };
  }

  async publish(
    input: PublishInput<InstagramSettings>,
    ctx: PublishContext,
  ): Promise<PublishResult> {
    const { account, settings, content } = input;
    const token = account.credentials.accessToken;
    const items = input.mediaItems.length > 0 ? input.mediaItems : [input.media];
    const caption = (settings.caption ?? content.caption ?? content.description ?? '').slice(
      0,
      2200,
    );
    const mediaPath = `${account.platformAccountId}/media`;

    if (items.length > MAX_CAROUSEL_ITEMS) {
      throw ProviderError.permanent(
        ProviderErrorCode.INVALID_MEDIA,
        `Instagram carousels can contain at most ${MAX_CAROUSEL_ITEMS} items`,
      );
    }

    if (items.length === 1) {
      const item = items[0]!;
      const url = await publicUrl(item);
      const kind: PostKind = isImage(item) ? 'image' : 'reel';
      const params: Record<string, string> =
        kind === 'image'
          ? { image_url: url, caption, ...(settings.altText ? { alt_text: settings.altText } : {}) }
          : {
              media_type: 'REELS',
              video_url: url,
              caption,
              share_to_feed: String(settings.shareToFeed),
            };
      const container = await this.graph.post<{ id: string }>(
        mediaPath,
        params,
        token,
        ctx,
        'create media container',
      );
      ctx.logger.info({ container_id: container.id, kind }, 'instagram media container created');
      ctx.onProgress(100);
      return {
        state: 'processing',
        platformPostId: null,
        platformPostUrl: null,
        providerState: { phase: 'container', kind, containerId: container.id },
        pollAfterMs: kind === 'image' ? 3_000 : 15_000,
      };
    }

    // Carousel: one child container per item, in order.
    const childIds: string[] = [];
    for (const [index, item] of items.entries()) {
      const url = await publicUrl(item);
      const child = await this.graph.post<{ id: string }>(
        mediaPath,
        isImage(item)
          ? { image_url: url, is_carousel_item: 'true' }
          : { media_type: 'VIDEO', video_url: url, is_carousel_item: 'true' },
        token,
        ctx,
        `create carousel item ${index + 1}`,
      );
      childIds.push(child.id);
      ctx.onProgress(((index + 1) / items.length) * 100);
    }
    ctx.logger.info({ children: childIds.length }, 'instagram carousel item containers created');
    return {
      state: 'processing',
      platformPostId: null,
      platformPostUrl: null,
      providerState: { phase: 'children', kind: 'carousel', childIds, caption },
      pollAfterMs: items.some((item) => !isImage(item)) ? 15_000 : 3_000,
    };
  }

  async getStatus(input: StatusInput, ctx: ProviderContext): Promise<StatusResult> {
    const token = input.account.credentials.accessToken;
    const state = input.providerState;
    const phase = typeof state.phase === 'string' ? state.phase : 'container';
    const kind: PostKind =
      state.kind === 'image' || state.kind === 'carousel' ? state.kind : 'reel';
    const waiting = (
      providerState: Record<string, unknown>,
      pollAfterMs: number,
    ): StatusResult => ({
      state: 'processing',
      platformPostId: null,
      platformPostUrl: null,
      providerState,
      pollAfterMs,
    });

    if (phase === 'children') {
      const childIds = Array.isArray(state.childIds)
        ? state.childIds.filter((id): id is string => typeof id === 'string')
        : [];
      if (childIds.length < 2) {
        return {
          state: 'failed',
          error: ProviderError.permanent(
            ProviderErrorCode.UNKNOWN,
            'Carousel items were not recorded',
          ),
        };
      }
      let pending = false;
      for (const [index, childId] of childIds.entries()) {
        const status = await this.containerStatus(childId, token, ctx);
        if (status.status_code === 'FINISHED') continue;
        if (status.status_code === 'IN_PROGRESS') {
          pending = true;
          continue;
        }
        return {
          state: 'failed',
          error: ProviderError.permanent(
            ProviderErrorCode.MEDIA_REJECTED,
            `Instagram could not process carousel item ${index + 1} (${status.status_code ?? 'unknown'}): ${status.status ?? 'no details'}`,
          ),
        };
      }
      if (pending) return waiting(state, 10_000);

      const caption = typeof state.caption === 'string' ? state.caption : '';
      const carousel = await this.graph.post<{ id: string }>(
        `${input.account.platformAccountId}/media`,
        { media_type: 'CAROUSEL', children: childIds.join(','), caption },
        token,
        ctx,
        'create carousel container',
      );
      ctx.logger.info({ container_id: carousel.id }, 'instagram carousel container created');
      return waiting({ phase: 'container', kind: 'carousel', containerId: carousel.id }, 3_000);
    }

    if (phase === 'container') {
      const containerId = typeof state.containerId === 'string' ? state.containerId : '';
      if (!containerId) {
        return {
          state: 'failed',
          error: ProviderError.permanent(
            ProviderErrorCode.UNKNOWN,
            'No Instagram container id recorded',
          ),
        };
      }
      const status = await this.containerStatus(containerId, token, ctx);
      switch (status.status_code) {
        case 'FINISHED':
          break;
        case 'IN_PROGRESS':
          return waiting(state, kind === 'reel' ? 15_000 : 5_000);
        case 'ERROR':
        case 'EXPIRED':
        default:
          return {
            state: 'failed',
            error: ProviderError.permanent(
              ProviderErrorCode.MEDIA_REJECTED,
              `Instagram could not process the ${kind === 'reel' ? 'video' : kind} (${status.status_code ?? 'unknown'}): ${status.status ?? 'no details'}`,
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
      ctx.logger.info({ media_id: published.id, kind }, 'instagram media published');
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

  private containerStatus(
    id: string,
    token: string,
    ctx: ProviderContext,
  ): Promise<ContainerStatus> {
    return this.graph.get<ContainerStatus>(
      id,
      { fields: 'status_code,status' },
      token,
      ctx,
      'container status',
    );
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

function isImage(item: MediaDescriptor): boolean {
  return item.mimeType.startsWith('image/');
}

async function publicUrl(item: MediaAccess): Promise<string> {
  const url = await item.getPublicUrl();
  if (!url) {
    throw ProviderError.permanent(
      ProviderErrorCode.NOT_CONFIGURED,
      'Instagram needs a public URL for each file. Set APP_URL to a publicly reachable HTTPS address.',
    );
  }
  return url;
}
