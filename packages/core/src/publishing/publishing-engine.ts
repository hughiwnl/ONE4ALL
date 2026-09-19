import { Prisma, type Db, type PostDestination } from '@repeat/database';
import {
  ProviderError,
  ProviderErrorCode,
  normalizeUnknownError,
  type MediaAccess,
  type ProviderAccount,
  type ProviderRegistry,
  type PublishResult,
  type PublisherProvider,
} from '@repeat/provider-sdk';
import type { AccountService } from '../accounts/account-service.js';
import type { Logger } from '../logger.js';
import { asProviderLogger } from '../logger.js';
import type { MediaUrlSigner } from '../media/signed-url.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { DEFAULT_MAX_JOB_ATTEMPTS } from './backoff.js';
import type { PublishDispatcher } from './dispatcher.js';
import { createMediaAccess } from './media-access.js';
import { toMediaDescriptor, validatePostMedia } from './media-support.js';
import { POST_MEDIA_INCLUDE } from '../posts/mappers.js';

export interface PublishingEngineOptions {
  db: Db;
  providers: ProviderRegistry;
  accounts: AccountService;
  storage: StorageProvider;
  dispatcher: PublishDispatcher;
  logger: Logger;
  /** Null when the deployment cannot serve public media URLs. */
  urlSigner: MediaUrlSigner | null;
  /** Give up on a "processing" destination after this long. */
  processingTimeoutMs?: number;
}

export interface PublishJobInfo {
  jobId: string;
  /** 1-based attempt number of the current queue job. */
  attempt: number;
  maxAttempts?: number;
}

export type PublishJobOutcome =
  | { outcome: 'published' }
  | { outcome: 'processing'; pollAfterMs: number }
  | { outcome: 'skipped'; reason: string }
  /** Permanent failure (or retries exhausted): the job must not be retried. */
  | { outcome: 'failed'; error: ProviderError }
  /** Transient failure: the queue should retry with backoff. */
  | { outcome: 'retry'; error: ProviderError };

const DEFAULT_PROCESSING_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * Executes publish jobs. One invocation handles exactly one destination, so a
 * failure here never affects sibling destinations of the same post.
 *
 * The engine knows nothing about any platform: it loads the destination,
 * resolves the provider, runs the provider lifecycle (validate → refresh →
 * validate media → publish → poll) and records the outcome.
 */
export class PublishingEngine {
  private readonly processingTimeoutMs: number;

  constructor(private readonly options: PublishingEngineOptions) {
    this.processingTimeoutMs = options.processingTimeoutMs ?? DEFAULT_PROCESSING_TIMEOUT_MS;
  }

  async publishDestination(
    destinationId: string,
    job: PublishJobInfo,
    signal?: AbortSignal,
  ): Promise<PublishJobOutcome> {
    const { db, providers, accounts, dispatcher } = this.options;
    const maxAttempts = job.maxAttempts ?? DEFAULT_MAX_JOB_ATTEMPTS;

    const destination = await db.postDestination.findUnique({
      where: { id: destinationId },
      include: { post: { include: POST_MEDIA_INCLUDE }, socialAccount: true },
    });
    if (!destination) {
      this.options.logger.warn(
        { destination_id: destinationId, job_id: job.jobId },
        'destination no longer exists; skipping',
      );
      return { outcome: 'skipped', reason: 'destination not found' };
    }

    const logger = this.options.logger.child({
      post_id: destination.postId,
      destination_id: destination.id,
      social_account_id: destination.socialAccountId,
      platform: destination.platform,
      job_id: job.jobId,
      attempt: job.attempt,
    });

    if (destination.status === 'published' || destination.status === 'canceled') {
      logger.info({ status: destination.status }, 'destination already terminal; skipping');
      return { outcome: 'skipped', reason: `already ${destination.status}` };
    }
    if (destination.status === 'processing' && destination.platformPostId) {
      // A retried job after a crash mid-processing: resume polling instead of re-uploading.
      logger.info('destination is processing; scheduling status check instead of re-publishing');
      await dispatcher.enqueueStatusCheck({ destinationId, delayMs: 5_000 });
      return { outcome: 'processing', pollAfterMs: 5_000 };
    }

    const fail = async (error: ProviderError): Promise<PublishJobOutcome> => {
      const retry = error.retryable && job.attempt < maxAttempts;
      await db.postDestination.update({
        where: { id: destinationId },
        data: {
          status: retry ? 'queued' : 'failed',
          progress: null,
          errorCode: error.code,
          errorMessage: retry
            ? `${error.message} (retrying, attempt ${job.attempt} of ${maxAttempts})`
            : error.message,
          errorRetryable: error.retryable,
        },
      });
      logger[retry ? 'warn' : 'error'](
        {
          error_code: error.code,
          retryable: error.retryable,
          details: error.details,
          err: error.cause ?? error,
        },
        retry ? 'destination publish failed; will retry' : 'destination publish failed permanently',
      );
      return retry ? { outcome: 'retry', error } : { outcome: 'failed', error };
    };

    if (!destination.socialAccount) {
      return fail(
        ProviderError.permanent(
          ProviderErrorCode.ACCOUNT_DISCONNECTED,
          'The account was disconnected before publishing',
        ),
      );
    }

    let provider: PublisherProvider<Record<string, unknown>>;
    try {
      provider = providers.get(destination.platform);
    } catch (error) {
      return fail(normalizeUnknownError(error));
    }

    await db.postDestination.update({
      where: { id: destinationId },
      data: {
        status: 'uploading',
        progress: 0,
        startedAt: destination.startedAt ?? new Date(),
        attempts: { increment: 1 },
        jobId: job.jobId,
        errorCode: null,
        errorMessage: null,
        errorRetryable: null,
      },
    });
    logger.info('destination publish starting');

    const ctxBase = { logger: asProviderLogger(logger), signal };

    try {
      let account: ProviderAccount = await this.decryptAccount(
        destination.socialAccount.id,
        accounts,
      );

      const accountCheck = await provider.validateAccount(account, ctxBase);
      if (!accountCheck.ok) {
        throw ProviderError.permanent(accountCheck.code, accountCheck.message);
      }

      const refreshed = await provider.refreshCredentialsIfNeeded(account, ctxBase);
      if (refreshed) {
        await accounts.updateCredentials(account.id, refreshed);
        account = { ...account, credentials: refreshed };
        logger.info('credentials refreshed');
      }

      const settingsResult = provider.settingsSchema.safeParse(destination.settings ?? {});
      if (!settingsResult.success) {
        throw ProviderError.permanent(
          ProviderErrorCode.INVALID_SETTINGS,
          `Invalid settings: ${settingsResult.error.issues.map((issue) => issue.message).join('; ')}`,
        );
      }
      const settings = settingsResult.data;

      const mediaRows = [...destination.post.mediaItems]
        .sort((a, b) => a.position - b.position)
        .map((item) => item.media);
      const mediaItems: MediaAccess[] = mediaRows.map((row) =>
        createMediaAccess(row, {
          storage: this.options.storage,
          urlSigner: this.options.urlSigner,
        }),
      );
      const media = mediaItems[0];
      if (!media) {
        throw ProviderError.permanent(ProviderErrorCode.INVALID_MEDIA, 'This post has no media');
      }
      const mediaCheck = await validatePostMedia(
        provider,
        mediaRows.map(toMediaDescriptor),
        settings,
      );
      if (!mediaCheck.ok) {
        throw ProviderError.permanent(mediaCheck.code, mediaCheck.message);
      }
      if (provider.capabilities.requiresPublicMediaUrl && !(await media.getPublicUrl())) {
        throw ProviderError.permanent(
          ProviderErrorCode.NOT_CONFIGURED,
          `${provider.displayName} downloads media from a public URL, but this server cannot expose one. Set APP_URL to a publicly reachable HTTPS address.`,
        );
      }

      const onProgress = this.createProgressReporter(destinationId);
      const result: PublishResult = await provider.publish(
        {
          destinationId,
          postId: destination.postId,
          attempt: job.attempt,
          account,
          media,
          mediaItems,
          content: {
            title: destination.post.title,
            caption: destination.post.caption,
            description: destination.post.description,
          },
          settings,
        },
        { ...ctxBase, onProgress },
      );
      await onProgress.flush();

      return this.recordResult(destination, result, logger);
    } catch (error) {
      return fail(safeNormalize(provider, error));
    }
  }

  /** Poll a destination the platform is still processing. */
  async checkDestinationStatus(
    destinationId: string,
    job: PublishJobInfo,
    signal?: AbortSignal,
  ): Promise<PublishJobOutcome> {
    const { db, providers, accounts } = this.options;
    const destination = await db.postDestination.findUnique({
      where: { id: destinationId },
      include: { socialAccount: true },
    });
    if (!destination) return { outcome: 'skipped', reason: 'destination not found' };

    const logger = this.options.logger.child({
      post_id: destination.postId,
      destination_id: destination.id,
      social_account_id: destination.socialAccountId,
      platform: destination.platform,
      job_id: job.jobId,
    });

    if (destination.status !== 'processing') {
      return { outcome: 'skipped', reason: `status is ${destination.status}` };
    }
    if (!destination.socialAccount) {
      return this.markFailed(
        destination,
        ProviderError.permanent(
          ProviderErrorCode.ACCOUNT_DISCONNECTED,
          'The account was disconnected',
        ),
        logger,
      );
    }

    const processingSince = destination.startedAt ?? destination.updatedAt;
    if (Date.now() - processingSince.getTime() > this.processingTimeoutMs) {
      return this.markFailed(
        destination,
        ProviderError.permanent(
          ProviderErrorCode.PROCESSING_TIMEOUT,
          'The platform did not finish processing the media in time',
        ),
        logger,
      );
    }

    let provider: PublisherProvider<Record<string, unknown>>;
    try {
      provider = providers.get(destination.platform);
    } catch (error) {
      return this.markFailed(destination, normalizeUnknownError(error), logger);
    }

    try {
      let account = await this.decryptAccount(destination.socialAccount.id, accounts);
      const refreshed = await provider.refreshCredentialsIfNeeded(account, {
        logger: asProviderLogger(logger),
        signal,
      });
      if (refreshed) {
        await accounts.updateCredentials(account.id, refreshed);
        account = { ...account, credentials: refreshed };
      }
      const result = await provider.getStatus(
        {
          destinationId,
          account,
          platformPostId: destination.platformPostId,
          providerState: (destination.providerState as Record<string, unknown> | null) ?? {},
          processingSince,
        },
        { logger: asProviderLogger(logger), signal },
      );
      if (result.state === 'failed') {
        return this.markFailed(destination, result.error, logger);
      }
      return this.recordResult(destination, result, logger);
    } catch (error) {
      const normalized = safeNormalize(provider, error);
      if (normalized.retryable && job.attempt < (job.maxAttempts ?? DEFAULT_MAX_JOB_ATTEMPTS)) {
        logger.warn(
          { error_code: normalized.code, err: normalized.cause ?? normalized },
          'status check failed transiently; will retry',
        );
        return { outcome: 'retry', error: normalized };
      }
      return this.markFailed(destination, normalized, logger);
    }
  }

  private async recordResult(
    destination: PostDestination,
    result: PublishResult,
    logger: Logger,
  ): Promise<PublishJobOutcome> {
    const { db, dispatcher } = this.options;
    if (result.state === 'published') {
      await db.postDestination.update({
        where: { id: destination.id },
        data: {
          status: 'published',
          progress: null,
          platformPostId: result.platformPostId,
          platformPostUrl: result.platformPostUrl,
          providerState: Prisma.DbNull,
          publishedAt: new Date(),
          errorCode: null,
          errorMessage: null,
          errorRetryable: null,
        },
      });
      logger.info({ platform_post_id: result.platformPostId }, 'destination published');
      return { outcome: 'published' };
    }

    await db.postDestination.update({
      where: { id: destination.id },
      data: {
        status: 'processing',
        progress: null,
        platformPostId: result.platformPostId,
        platformPostUrl: result.platformPostUrl,
        providerState: result.providerState as Prisma.InputJsonValue,
      },
    });
    const pollAfterMs = Math.max(1_000, result.pollAfterMs);
    await dispatcher.enqueueStatusCheck({ destinationId: destination.id, delayMs: pollAfterMs });
    logger.info(
      { poll_after_ms: pollAfterMs },
      'destination processing on platform; status check scheduled',
    );
    return { outcome: 'processing', pollAfterMs };
  }

  private async markFailed(
    destination: PostDestination,
    error: ProviderError,
    logger: Logger,
  ): Promise<PublishJobOutcome> {
    await this.options.db.postDestination.update({
      where: { id: destination.id },
      data: {
        status: 'failed',
        progress: null,
        errorCode: error.code,
        errorMessage: error.message,
        errorRetryable: error.retryable,
      },
    });
    logger.error(
      { error_code: error.code, retryable: error.retryable, err: error.cause ?? error },
      'destination failed',
    );
    return { outcome: 'failed', error };
  }

  private async decryptAccount(
    accountId: string,
    accounts: AccountService,
  ): Promise<ProviderAccount> {
    const account = await accounts.getProviderAccount(accountId);
    if (!account) {
      throw ProviderError.permanent(
        ProviderErrorCode.ACCOUNT_DISCONNECTED,
        'The account was disconnected before publishing',
      );
    }
    return account;
  }

  /** Persist progress at most every second (or on completion) to avoid hammering the database. */
  private createProgressReporter(
    destinationId: string,
  ): ((percent: number) => void) & { flush: () => Promise<void> } {
    let last = -1;
    let lastWrite = 0;
    let pending: Promise<unknown> = Promise.resolve();
    const write = (percent: number) => {
      lastWrite = Date.now();
      last = percent;
      pending = pending.then(() =>
        this.options.db.postDestination
          .updateMany({
            where: { id: destinationId, status: 'uploading' },
            data: { progress: percent },
          })
          .catch(() => undefined),
      );
    };
    const report = (raw: number) => {
      const percent = Math.max(0, Math.min(100, Math.round(raw)));
      if (percent === last) return;
      if (percent === 100 || Date.now() - lastWrite >= 1000) write(percent);
    };
    return Object.assign(report, { flush: async () => pending.then(() => undefined) });
  }
}

function safeNormalize(
  provider: PublisherProvider<Record<string, unknown>>,
  error: unknown,
): ProviderError {
  try {
    return provider.normalizeError(error);
  } catch {
    return normalizeUnknownError(error);
  }
}
