import { UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';
import {
  computeBackoffMs,
  DEFAULT_MAX_JOB_ATTEMPTS,
  type Logger,
  type PublishJobOutcome,
  type PublishingEngine,
} from '@repeat/core';
import { isProviderError } from '@repeat/provider-sdk';
import { JOB_NAMES, PUBLISH_QUEUE_NAME, type PublishJobData, type PublishJobName } from './jobs.js';

export interface CreatePublishWorkerOptions {
  connection: ConnectionOptions;
  engine: PublishingEngine;
  logger: Logger;
  concurrency?: number;
}

/**
 * Delay before the next attempt, derived from the failed attempt count and the
 * provider's Retry-After hint (carried on the ProviderError).
 */
export function backoffStrategy(
  attemptsMade: number,
  _type: string | undefined,
  error: Error | undefined,
): number {
  const retryAfterMs = error && isProviderError(error) ? error.retryAfterMs : undefined;
  return computeBackoffMs(attemptsMade, retryAfterMs);
}

/**
 * Runs publish and status-check jobs through the core PublishingEngine.
 *
 * The engine returns an outcome instead of throwing; this adapter translates
 * it into BullMQ semantics: `retry` re-throws (BullMQ retries with backoff),
 * `failed` throws UnrecoverableError (no more attempts), everything else completes.
 */
export function createPublishWorker(
  options: CreatePublishWorkerOptions,
): Worker<PublishJobData, void, PublishJobName> {
  const { engine, logger } = options;

  const processor = async (job: Job<PublishJobData, void, PublishJobName>): Promise<void> => {
    const info = {
      jobId: String(job.id),
      attempt: job.attemptsMade + 1,
      maxAttempts: job.opts.attempts ?? DEFAULT_MAX_JOB_ATTEMPTS,
    };
    const controller = new AbortController();
    let outcome: PublishJobOutcome;
    switch (job.name) {
      case JOB_NAMES.publish:
        outcome = await engine.publishDestination(job.data.destinationId, info, controller.signal);
        break;
      case JOB_NAMES.checkStatus:
        outcome = await engine.checkDestinationStatus(
          job.data.destinationId,
          info,
          controller.signal,
        );
        break;
      default: {
        const unknown: never = job.name;
        throw new UnrecoverableError(`Unknown job name ${String(unknown)}`);
      }
    }

    switch (outcome.outcome) {
      case 'retry':
        throw outcome.error;
      case 'failed':
        throw new UnrecoverableError(`${outcome.error.code}: ${outcome.error.message}`);
      default:
        return;
    }
  };

  const worker = new Worker<PublishJobData, void, PublishJobName>(PUBLISH_QUEUE_NAME, processor, {
    connection: options.connection,
    concurrency: options.concurrency ?? 2,
    settings: { backoffStrategy },
    // Publishing a large video can take a while; extend the lock so the job is not re-queued mid-upload.
    lockDuration: 5 * 60_000,
    stalledInterval: 60_000,
    maxStalledCount: 2,
  });

  worker.on('failed', (job, error) => {
    logger.warn(
      {
        job_id: job?.id,
        job_name: job?.name,
        destination_id: job?.data.destinationId,
        attempts_made: job?.attemptsMade,
        err: error,
      },
      'job failed',
    );
  });
  worker.on('error', (error) => {
    logger.error({ err: error }, 'worker error');
  });

  return worker;
}
