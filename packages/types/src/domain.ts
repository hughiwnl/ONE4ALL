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

export interface MediaDto {
  id: string;
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
  media: MediaDto;
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
  media: MediaDto;
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
  /** Accepted media kinds. V1 only publishes video. */
  media: { video: boolean; image: boolean };
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
