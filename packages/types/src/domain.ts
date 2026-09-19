/**
 * Domain types shared by every layer (web UI, API routes, worker, future
 * mobile/cloud clients). This package is intentionally dependency-free apart
 * from zod so that it can be consumed by browser and native clients.
 */

/**
 * A platform identifier. Providers register themselves under a stable,
 * lowercase id (e.g. "youtube", "instagram", "facebook"). It is a plain string
 * rather than an enum so new providers can be added without a schema migration.
 */
export type PlatformId = string;

export const DESTINATION_STATUSES = [
  'queued',
  'uploading',
  'processing',
  'published',
  'failed',
  'canceled',
] as const;

export type DestinationStatus = (typeof DESTINATION_STATUSES)[number];

/** Statuses in which no further automatic work will happen. */
export const TERMINAL_DESTINATION_STATUSES: readonly DestinationStatus[] = [
  'published',
  'failed',
  'canceled',
];

export function isTerminalStatus(status: DestinationStatus): boolean {
  return TERMINAL_DESTINATION_STATUSES.includes(status);
}

export interface UserDto {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
}

/**
 * A connected social account as exposed to clients.
 * Credentials are never included: only the server sees tokens.
 */
export interface SocialAccountDto {
  id: string;
  platform: PlatformId;
  platformAccountId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  enabled: boolean;
  /** Non-sensitive, provider-specific details (e.g. Facebook page category). */
  metadata: Record<string, unknown>;
  tokenExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MediaKind = 'video' | 'image';

/** Most items a single post may carry (Instagram's carousel limit). */
export const MAX_POST_MEDIA_ITEMS = 10;

export function mediaKindOf(mimeType: string): MediaKind | null {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('image/')) return 'image';
  return null;
}

export interface MediaDto {
  id: string;
  kind: MediaKind;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  createdAt: string;
}

export interface PostDestinationDto {
  id: string;
  postId: string;
  socialAccountId: string | null;
  platform: PlatformId;
  /** Snapshot of the account name at publish time (survives disconnects). */
  accountDisplayName: string;
  accountAvatarUrl: string | null;
  status: DestinationStatus;
  /** 0-100 while uploading, otherwise null. */
  progress: number | null;
  settings: Record<string, unknown>;
  platformPostId: string | null;
  platformPostUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorRetryable: boolean | null;
  attempts: number;
  startedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PostDto {
  id: string;
  title: string | null;
  caption: string | null;
  description: string | null;
  /** First item, used as the cover in lists. */
  media: MediaDto;
  /** Every item in publishing order (one for single posts, several for a carousel). */
  mediaItems: MediaDto[];
  destinations: PostDestinationDto[];
  createdAt: string;
  updatedAt: string;
}

export interface DestinationStatusSummary {
  total: number;
  queued: number;
  uploading: number;
  processing: number;
  published: number;
  failed: number;
  canceled: number;
}

export interface PostSummaryDto {
  id: string;
  title: string | null;
  caption: string | null;
  /** First item, used as the cover. */
  media: MediaDto;
  mediaCount: number;
  summary: DestinationStatusSummary;
  createdAt: string;
}

/**
 * Declarative description of a provider-specific setting so clients can render
 * the right control without knowing anything about the provider.
 */
export type SettingsField =
  | {
      key: string;
      label: string;
      type: 'text' | 'textarea';
      description?: string;
      required?: boolean;
      maxLength?: number;
      placeholder?: string;
      /** When true the field falls back to the common post field of this name. */
      inheritsFrom?: 'title' | 'caption' | 'description';
    }
  | {
      key: string;
      label: string;
      type: 'select';
      description?: string;
      required?: boolean;
      options: { value: string; label: string }[];
      default?: string;
    }
  | {
      key: string;
      label: string;
      type: 'boolean';
      description?: string;
      default?: boolean;
    };

export interface ProviderCapabilities {
  /** Accepted media kinds. */
  media: { video: boolean; image: boolean };
  /** Items one post may contain; more than 1 means carousels are supported. Defaults to 1. */
  maxMediaItems?: number;
  maxFileSizeBytes?: number;
  maxDurationSeconds?: number;
  minDurationSeconds?: number;
  acceptedMimeTypes?: string[];
  /** The provider fetches media from a public URL (e.g. Instagram) rather than accepting an upload stream. */
  requiresPublicMediaUrl: boolean;
}

export interface ProviderInfoDto {
  platform: PlatformId;
  displayName: string;
  /** True when the administrator configured credentials for this provider. */
  configured: boolean;
  /** How accounts are connected: an OAuth connector id, or "mock" for the dev provider. */
  connector: { id: string; label: string; kind: 'oauth' | 'mock' } | null;
  settingsFields: SettingsField[];
  capabilities: ProviderCapabilities;
  /** Human-readable notes about platform restrictions, shown in the UI. */
  notes: string[];
}

/** An account discovered during an OAuth flow that the user may choose to connect. */
export interface ConnectableAccountDto {
  platform: PlatformId;
  platformAccountId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  alreadyConnected: boolean;
  metadata: Record<string, unknown>;
}

/**
 * Whether a provider can publish a post made of these media items, judged
 * from its declared capabilities only. Returns a human-readable reason when it
 * cannot, or null. Shared by the Publish page (to disable accounts up front)
 * and the server (which also runs the provider's own validateMedia).
 */
export function checkMediaCompatibility(
  provider: { displayName: string; capabilities: ProviderCapabilities },
  items: { mimeType: string }[],
): string | null {
  const { displayName, capabilities } = provider;
  if (items.length === 0) return null;
  const maxItems = capabilities.maxMediaItems ?? 1;
  const kinds = new Set(items.map((item) => mediaKindOf(item.mimeType)));

  for (const kind of kinds) {
    if (kind === null) return `${displayName} cannot publish this file type`;
    if (!capabilities.media[kind]) {
      return kind === 'image'
        ? `${displayName} does not support image posts in Repeat`
        : `${displayName} does not support video posts in Repeat`;
    }
  }
  if (items.length > maxItems) {
    if (maxItems === 1) {
      const only =
        capabilities.media.image && !capabilities.media.video
          ? 'image'
          : capabilities.media.video && !capabilities.media.image
            ? 'video'
            : 'item';
      return `${displayName} publishes a single ${only} per post, not a carousel`;
    }
    return `${displayName} accepts up to ${maxItems} items per post`;
  }
  if (capabilities.acceptedMimeTypes) {
    const rejected = items.find((item) => !capabilities.acceptedMimeTypes!.includes(item.mimeType));
    if (rejected) {
      return `${displayName} does not accept ${rejected.mimeType} files (accepted: ${capabilities.acceptedMimeTypes.join(', ')})`;
    }
  }
  return null;
}
