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

export const FACEBOOK_PLATFORM = 'facebook';

export const facebookSettingsSchema = z.object({
  /** Falls back to the post title. */
  title: z.string().trim().max(255).optional(),
  /** Falls back to caption, then description. */
  description: z.string().max(10_000).optional(),
});
export type FacebookSettings = z.infer<typeof facebookSettingsSchema>;

interface StartResponse {
  upload_session_id: string;
  video_id: string;
  start_offset: string;
  end_offset: string;
}
interface TransferResponse {
  start_offset: string;
  end_offset: string;
}
interface VideoStatusResponse {
  id: string;
  permalink_url?: string;
  status?: {
    /** 'ready' | 'processing' | 'error' | 'expired' */
    video_status?: string;
    processing_phase?: { status?: string; errors?: { message?: string }[] };
    publishing_phase?: { status?: string; errors?: { message?: string }[] };
  };
}

/**
 * Publishes videos to a Facebook Page using the Graph API resumable upload
 * (upload_phase=start/transfer/finish), which supports files up to 10 GB.
 * https://developers.facebook.com/docs/video-api/guides/publishing
 *
 * Only Pages are supported: Meta does not allow API publishing to personal
 * profiles. The account's access token is a long-lived Page token.
 */
export class FacebookPublisher implements PublisherProvider<FacebookSettings> {
  readonly platform = FACEBOOK_PLATFORM;
  readonly displayName = 'Facebook Page';
  readonly settingsSchema = facebookSettingsSchema;
  readonly capabilities: ProviderCapabilities = {
    media: { video: true, image: false },
    maxFileSizeBytes: 10 * 1024 * 1024 * 1024,
    maxDurationSeconds: 4 * 60 * 60,
    requiresPublicMediaUrl: false,
  };
  readonly settingsFields: SettingsField[] = [
    {
      key: 'title',
      label: 'Title',
      type: 'text',
      maxLength: 255,
      inheritsFrom: 'title',
      placeholder: 'Defaults to the post title',
    },
    {
      key: 'description',
      label: 'Description',
      type: 'textarea',
      maxLength: 10_000,
      inheritsFrom: 'caption',
      placeholder: 'Defaults to the post caption',
    },
  ];
  readonly notes = [
    'Publishes to Facebook Pages only; personal profiles cannot be published to through the API.',
    'Requires the pages_manage_posts permission, which needs Meta App Review for users outside your app roles.',
  ];

  constructor(private readonly graph: GraphClient) {}

  async validateAccount(account: ProviderAccount): Promise<ValidationResult> {
    if (!account.credentials.accessToken) {
      return {
        ok: false,
        code: ProviderErrorCode.TOKEN_REVOKED,
        message: 'No Page access token stored. Reconnect this Page.',
      };
    }
    if (account.credentials.expiresAt && account.credentials.expiresAt.getTime() < Date.now()) {
      return {
        ok: false,
        code: ProviderErrorCode.TOKEN_EXPIRED,
        message: 'The Page access token expired. Reconnect this Page.',
      };
    }
    return { ok: true };
  }

  /** Meta issues no refresh tokens; long-lived Page tokens are used until they are invalidated. */
  async refreshCredentialsIfNeeded(): Promise<ProviderCredentials | null> {
    return null;
  }

  validateMedia(media: MediaDescriptor): ValidationResult {
    if (!media.mimeType.startsWith('video/')) {
      return {
        ok: false,
        code: ProviderErrorCode.INVALID_MEDIA,
        message: 'Facebook Pages accept video files only in Repeat',
      };
    }
    if (media.sizeBytes > this.capabilities.maxFileSizeBytes!) {
      return {
        ok: false,
        code: ProviderErrorCode.INVALID_MEDIA,
        message: 'Video exceeds the 10 GB Facebook limit',
      };
    }
    if (media.durationSeconds && media.durationSeconds > this.capabilities.maxDurationSeconds!) {
      return {
        ok: false,
        code: ProviderErrorCode.INVALID_MEDIA,
        message: 'Video exceeds the 4 hour Facebook limit',
      };
    }
    return { ok: true };
  }

  async publish(
    input: PublishInput<FacebookSettings>,
    ctx: PublishContext,
  ): Promise<PublishResult> {
    const { account, media, settings, content } = input;
    const token = account.credentials.accessToken;
    const pageId = account.platformAccountId;
    const path = `${pageId}/videos`;
    const description = settings.description ?? content.caption ?? content.description ?? '';
    const title = settings.title ?? content.title ?? undefined;

    const start = await this.graph.post<StartResponse>(
      path,
      { upload_phase: 'start', file_size: String(media.sizeBytes) },
      token,
      ctx,
      'start video upload',
    );
    ctx.logger.info(
      { video_id: start.video_id, size_bytes: media.sizeBytes },
      'facebook upload session started',
    );

    let startOffset = Number(start.start_offset);
    let endOffset = Number(start.end_offset);
    while (startOffset < endOffset) {
      const chunk = await readRange(media, startOffset, endOffset - 1);
      const form = new FormData();
      form.set('upload_phase', 'transfer');
      form.set('upload_session_id', start.upload_session_id);
      form.set('start_offset', String(startOffset));
      form.set('video_file_chunk', new Blob([chunk], { type: media.mimeType }), media.filename);
      const transfer = await this.graph.postVideoMultipart<TransferResponse>(
        path,
        form,
        token,
        ctx,
        'transfer video chunk',
      );
      startOffset = Number(transfer.start_offset);
      endOffset = Number(transfer.end_offset);
      ctx.onProgress((startOffset / media.sizeBytes) * 100);
    }

    await this.graph.post<{ success: boolean }>(
      path,
      {
        upload_phase: 'finish',
        upload_session_id: start.upload_session_id,
        description,
        ...(title ? { title } : {}),
        published: 'true',
      },
      token,
      ctx,
      'finish video upload',
    );
    ctx.onProgress(100);

    return {
      state: 'processing',
      platformPostId: start.video_id,
      platformPostUrl: `https://www.facebook.com/${pageId}/videos/${start.video_id}`,
      providerState: {},
      pollAfterMs: 15_000,
    };
  }

  async getStatus(input: StatusInput, ctx: ProviderContext): Promise<StatusResult> {
    if (!input.platformPostId) {
      return {
        state: 'failed',
        error: ProviderError.permanent(ProviderErrorCode.UNKNOWN, 'No Facebook video id recorded'),
      };
    }
    const video = await this.graph.get<VideoStatusResponse>(
      input.platformPostId,
      { fields: 'id,permalink_url,status{video_status,processing_phase,publishing_phase}' },
      input.account.credentials.accessToken,
      ctx,
      'video status',
    );
    const url = video.permalink_url
      ? video.permalink_url.startsWith('http')
        ? video.permalink_url
        : `https://www.facebook.com${video.permalink_url}`
      : `https://www.facebook.com/${input.account.platformAccountId}/videos/${input.platformPostId}`;
    switch (video.status?.video_status) {
      case 'ready':
        return { state: 'published', platformPostId: video.id, platformPostUrl: url };
      case 'error':
      case 'expired': {
        const reason =
          video.status.processing_phase?.errors?.[0]?.message ??
          video.status.publishing_phase?.errors?.[0]?.message ??
          video.status.video_status;
        return {
          state: 'failed',
          error: ProviderError.permanent(
            ProviderErrorCode.MEDIA_REJECTED,
            `Facebook could not process the video: ${reason}`,
          ),
        };
      }
      default:
        return {
          state: 'processing',
          platformPostId: video.id,
          platformPostUrl: url,
          providerState: {},
          pollAfterMs: 20_000,
        };
    }
  }

  normalizeError(error: unknown): ProviderError {
    return normalizeMetaError(error);
  }
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
