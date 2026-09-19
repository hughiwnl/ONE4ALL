import { z } from 'zod';
import type { ProviderCapabilities, SettingsField } from '@repeat/types';
import {
  ProviderError,
  ProviderErrorCode,
  normalizeUnknownError,
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

/**
 * MockPublisher: a development/test-only provider that simulates the full
 * publishing lifecycle without touching any real social platform.
 *
 * Behavior is chosen per account (metadata.behavior, set when the mock account
 * is "connected") and can be overridden per destination via settings. It is
 * registered only when MOCK_PROVIDER_ENABLED=true and is refused in production.
 */

export const MOCK_PLATFORM = 'mock';

export const MOCK_BEHAVIORS = [
  'succeed',
  'succeed_after_processing',
  'fail_retryable',
  'fail_permanent',
  'flaky',
] as const;
export type MockBehavior = (typeof MOCK_BEHAVIORS)[number];

export const mockSettingsSchema = z.object({
  /** Override the account's default behavior for this destination. */
  behavior: z.enum(MOCK_BEHAVIORS).optional(),
  /** Simulated upload duration. */
  uploadMs: z.number().int().min(0).max(60_000).optional(),
  /** Number of status polls before a "processing" publish completes. */
  processingPolls: z.number().int().min(1).max(20).optional(),
});
export type MockSettings = z.infer<typeof mockSettingsSchema>;

export interface MockPublisherOptions {
  /** Default simulated upload duration in ms. Tests set 0. */
  defaultUploadMs?: number;
  /** Delay suggested between status polls. */
  pollIntervalMs?: number;
  /** Optional clock/sleep override for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MockPublisher implements PublisherProvider<MockSettings> {
  readonly platform = MOCK_PLATFORM;
  readonly displayName = 'Mock (development)';
  readonly settingsSchema = mockSettingsSchema;
  readonly capabilities: ProviderCapabilities = {
    media: { video: true, image: true },
    // Lets developers exercise carousels without a real Instagram account.
    maxMediaItems: 10,
    requiresPublicMediaUrl: false,
  };
  readonly settingsFields: SettingsField[] = [
    {
      key: 'behavior',
      label: 'Simulated outcome',
      type: 'select',
      description: 'Overrides the behaviour chosen when this mock account was connected.',
      options: [
        { value: '', label: 'Account default' },
        { value: 'succeed', label: 'Succeed' },
        { value: 'succeed_after_processing', label: 'Succeed after processing' },
        { value: 'fail_retryable', label: 'Fail (retryable)' },
        { value: 'fail_permanent', label: 'Fail (permanent)' },
        { value: 'flaky', label: 'Fail once, then succeed' },
      ],
    },
  ];
  readonly notes = [
    'Development-only provider. Nothing is published anywhere.',
    'Use it to exercise the publishing pipeline, retries and the status UI without real credentials.',
  ];

  private readonly defaultUploadMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: MockPublisherOptions = {}) {
    this.defaultUploadMs = options.defaultUploadMs ?? 3000;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async validateAccount(account: ProviderAccount): Promise<ValidationResult> {
    if (!account.credentials.accessToken) {
      return {
        ok: false,
        code: ProviderErrorCode.TOKEN_REVOKED,
        message: 'Mock account has no token',
      };
    }
    return { ok: true };
  }

  async refreshCredentialsIfNeeded(account: ProviderAccount): Promise<ProviderCredentials | null> {
    const { expiresAt } = account.credentials;
    if (expiresAt && expiresAt.getTime() < Date.now()) {
      return {
        ...account.credentials,
        accessToken: `mock-refreshed-${Date.now()}`,
        expiresAt: new Date(Date.now() + 3600_000),
      };
    }
    return null;
  }

  validateMedia(media: MediaDescriptor): ValidationResult {
    if (!media.mimeType.startsWith('video/') && !media.mimeType.startsWith('image/')) {
      return {
        ok: false,
        code: ProviderErrorCode.INVALID_MEDIA,
        message: `Unsupported media type ${media.mimeType}`,
      };
    }
    return { ok: true };
  }

  async publish(input: PublishInput<MockSettings>, ctx: PublishContext): Promise<PublishResult> {
    const behavior = this.resolveBehavior(input);
    const uploadMs = input.settings.uploadMs ?? this.defaultUploadMs;
    ctx.logger.info({ behavior, attempt: input.attempt }, 'mock publish starting');

    if (behavior === 'fail_permanent') {
      throw ProviderError.permanent(
        ProviderErrorCode.TOKEN_EXPIRED,
        'Simulated permanent failure: token expired',
      );
    }
    if (behavior === 'fail_retryable') {
      throw ProviderError.retryable(
        ProviderErrorCode.PROVIDER_UNAVAILABLE,
        'Simulated transient failure (HTTP 503)',
        {
          details: { status: 503 },
        },
      );
    }
    if (behavior === 'flaky' && input.attempt < 2) {
      throw ProviderError.retryable(
        ProviderErrorCode.NETWORK,
        'Simulated network failure on first attempt',
      );
    }

    // Simulate a streamed upload with progress. We really read the stream so
    // storage access is exercised end to end.
    const items = input.mediaItems.length > 0 ? input.mediaItems : [input.media];
    const totalBytes = Math.max(
      1,
      items.reduce((sum, item) => sum + item.sizeBytes, 0),
    );
    let read = 0;
    for (const item of items) {
      const stream = await item.openStream();
      for await (const chunk of stream) {
        read += (chunk as Buffer).length;
        ctx.onProgress(Math.min(99, Math.round((read / totalBytes) * 100)));
        if (ctx.signal?.aborted)
          throw ProviderError.retryable(ProviderErrorCode.TIMEOUT, 'Aborted');
      }
    }
    const steps = 4;
    for (let i = 1; i <= steps; i += 1) {
      await this.sleep(uploadMs / steps);
      ctx.onProgress(Math.min(100, Math.round((i / steps) * 100)));
    }

    const platformPostId = `mock_${input.destinationId.slice(0, 8)}_${Date.now().toString(36)}`;
    const platformPostUrl = `https://mock.invalid/posts/${platformPostId}`;

    if (behavior === 'succeed_after_processing') {
      return {
        state: 'processing',
        platformPostId,
        platformPostUrl,
        providerState: { pollsRemaining: input.settings.processingPolls ?? 2 },
        pollAfterMs: this.pollIntervalMs,
      };
    }

    return { state: 'published', platformPostId, platformPostUrl };
  }

  async getStatus(input: StatusInput, ctx: ProviderContext): Promise<StatusResult> {
    const pollsRemaining = Number(input.providerState.pollsRemaining ?? 0) - 1;
    ctx.logger.debug({ pollsRemaining }, 'mock status poll');
    if (pollsRemaining > 0) {
      return {
        state: 'processing',
        platformPostId: input.platformPostId,
        platformPostUrl: input.platformPostId
          ? `https://mock.invalid/posts/${input.platformPostId}`
          : null,
        providerState: { pollsRemaining },
        pollAfterMs: this.pollIntervalMs,
      };
    }
    return {
      state: 'published',
      platformPostId: input.platformPostId ?? 'mock_unknown',
      platformPostUrl: input.platformPostId
        ? `https://mock.invalid/posts/${input.platformPostId}`
        : null,
    };
  }

  normalizeError(error: unknown): ProviderError {
    return normalizeUnknownError(error);
  }

  private resolveBehavior(input: PublishInput<MockSettings>): MockBehavior {
    const fromSettings = input.settings.behavior;
    if (fromSettings) return fromSettings;
    const fromAccount = input.account.metadata.behavior;
    if (
      typeof fromAccount === 'string' &&
      (MOCK_BEHAVIORS as readonly string[]).includes(fromAccount)
    ) {
      return fromAccount as MockBehavior;
    }
    return 'succeed';
  }
}
