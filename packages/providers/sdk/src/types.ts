import type { Readable } from 'node:stream';
import type { ZodType, ZodTypeDef } from 'zod';
import type { PlatformId, ProviderCapabilities, SettingsField } from '@repeat/types';
import type { ProviderError } from './errors.js';
import type { ProviderLogger } from './logger.js';

/** Decrypted credentials for one connected account. Only ever lives in server memory. */
export interface ProviderCredentials {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

/** A connected account as seen by a provider (credentials already decrypted). */
export interface ProviderAccount {
  /** Repeat's own id for the social account. */
  id: string;
  platform: PlatformId;
  platformAccountId: string;
  displayName: string;
  username: string | null;
  metadata: Record<string, unknown>;
  credentials: ProviderCredentials;
}

export interface MediaDescriptor {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
}

/** Access to the media bytes, abstracted over the storage backend. */
export interface MediaAccess extends MediaDescriptor {
  /** Open a readable stream over the whole file or a byte range (inclusive end). */
  openStream(range?: { start: number; end?: number }): Promise<Readable>;
  /**
   * A time-limited URL the platform can download the media from, or null when
   * the deployment cannot expose one. Required by providers whose
   * `capabilities.requiresPublicMediaUrl` is true (Instagram).
   */
  getPublicUrl(): Promise<string | null>;
}

/** Common, platform-agnostic content entered by the user. */
export interface PostContent {
  title: string | null;
  caption: string | null;
  description: string | null;
}

export interface PublishInput<TSettings = Record<string, unknown>> {
  destinationId: string;
  postId: string;
  /** 1-based attempt number for this destination (useful for logging and idempotency). */
  attempt: number;
  account: ProviderAccount;
  /** The first (for most providers, the only) media item. */
  media: MediaAccess;
  /**
   * Every media item in publishing order. Length 1 unless the provider
   * declares `capabilities.maxMediaItems > 1` (carousels).
   */
  mediaItems: MediaAccess[];
  content: PostContent;
  settings: TSettings;
}

export interface ProviderContext {
  logger: ProviderLogger;
  signal?: AbortSignal;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface PublishContext extends ProviderContext {
  /** Report upload progress (0-100). Best effort; the engine throttles persistence. */
  onProgress(percent: number): void;
}

export type PublishResult =
  | {
      state: 'published';
      platformPostId: string;
      platformPostUrl: string | null;
    }
  | {
      /** The platform accepted the media but is still processing it; poll `getStatus`. */
      state: 'processing';
      platformPostId: string | null;
      platformPostUrl: string | null;
      /** Opaque state handed back to `getStatus` (must be JSON-serializable, never credentials). */
      providerState: Record<string, unknown>;
      pollAfterMs: number;
    };

export interface StatusInput {
  destinationId: string;
  account: ProviderAccount;
  platformPostId: string | null;
  providerState: Record<string, unknown>;
  /** Wall-clock time the destination entered "processing", so providers can time out. */
  processingSince: Date;
}

export type StatusResult =
  | PublishResult
  | {
      state: 'failed';
      error: ProviderError;
    };

export type ValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: string;
      message: string;
    };

/**
 * The contract every platform integration implements.
 *
 * The publishing engine only talks to this interface: it does not know how
 * YouTube resumable uploads or Instagram containers work. Adding a platform
 * means adding one package that implements this (plus an OAuthConnector) and
 * registering it; the engine, database and UI stay untouched.
 */
export interface PublisherProvider<TSettings = Record<string, unknown>> {
  readonly platform: PlatformId;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  /** Declarative UI description of the provider-specific settings. */
  readonly settingsFields: SettingsField[];
  /** Runtime validation for `PostDestination.settings`. */
  readonly settingsSchema: ZodType<TSettings, ZodTypeDef, unknown>;
  /** Restrictions worth surfacing to users (account types, review requirements...). */
  readonly notes: string[];

  /** Cheap check that the stored account is still usable (token present, right account type...). */
  validateAccount(account: ProviderAccount, ctx: ProviderContext): Promise<ValidationResult>;

  /**
   * Refresh credentials when they are expired or about to expire.
   * Returns the new credentials (which the engine persists encrypted) or null when nothing changed.
   */
  refreshCredentialsIfNeeded(
    account: ProviderAccount,
    ctx: ProviderContext,
  ): Promise<ProviderCredentials | null>;

  /** Validate media against platform rules before spending an upload. */
  validateMedia(
    media: MediaDescriptor,
    settings: TSettings,
  ): Promise<ValidationResult> | ValidationResult;

  /** Perform the upload/publish. May return `processing` for asynchronous platforms. */
  publish(input: PublishInput<TSettings>, ctx: PublishContext): Promise<PublishResult>;

  /** Poll an asynchronous publish. Only called after `publish` returned `processing`. */
  getStatus(input: StatusInput, ctx: ProviderContext): Promise<StatusResult>;

  /** Translate any thrown error into a ProviderError (retryable vs permanent). */
  normalizeError(error: unknown): ProviderError;
}
