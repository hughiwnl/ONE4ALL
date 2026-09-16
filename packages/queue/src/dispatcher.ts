import { randomUUID } from 'node:crypto';
import { Queue, type ConnectionOptions } from 'bullmq';
import type {
  EnqueuePublishInput,
  EnqueueResult,
  EnqueueStatusCheckInput,
  PublishDispatcher,
} from '@repeat/core';
import { DEFAULT_MAX_JOB_ATTEMPTS } from '@repeat/core';
import { JOB_NAMES, PUBLISH_QUEUE_NAME, type PublishJobData, type PublishJobName } from './jobs.js';

export type PublishQueue = Queue<PublishJobData, void, PublishJobName>;

export function createPublishQueue(
  connection: ConnectionOptions,
  options: { maxAttempts?: number } = {},
): PublishQueue {
  return new Queue<PublishJobData, void, PublishJobName>(PUBLISH_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: options.maxAttempts ?? DEFAULT_MAX_JOB_ATTEMPTS,
      // Delay is computed by the worker's backoffStrategy from the ProviderError.
      backoff: { type: 'custom' },
      removeOnComplete: { age: 24 * 3600, count: 5_000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
}

/** BullMQ implementation of the core `PublishDispatcher` port. */
export class BullMqPublishDispatcher implements PublishDispatcher {
  constructor(private readonly queue: PublishQueue) {}

  async enqueuePublish(input: EnqueuePublishInput): Promise<EnqueueResult> {
    const job = await this.queue.add(
      JOB_NAMES.publish,
      { destinationId: input.destinationId },
      { jobId: jobId('publish', input.destinationId), delay: input.delayMs },
    );
    return { jobId: String(job.id) };
  }

  async enqueueStatusCheck(input: EnqueueStatusCheckInput): Promise<EnqueueResult> {
    const job = await this.queue.add(
      JOB_NAMES.checkStatus,
      { destinationId: input.destinationId },
      { jobId: jobId('status', input.destinationId), delay: input.delayMs },
    );
    return { jobId: String(job.id) };
  }

  async cancel(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    if (!job) return;
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
      await job.remove();
    }
  }
}

/** BullMQ custom job ids must not contain ":"; keep them readable for log correlation. */
function jobId(kind: string, destinationId: string): string {
  return `${kind}-${destinationId}-${randomUUID().slice(0, 8)}`;
}
