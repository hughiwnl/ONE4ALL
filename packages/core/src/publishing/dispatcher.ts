/**
 * Port through which core hands work to the background queue.
 *
 * `@repeat/queue` implements it with BullMQ; tests use an in-memory fake. Core
 * never imports a queue library, which keeps the publishing engine reusable in
 * other runtimes (a cloud API, a CLI, a different queue).
 */
export interface EnqueuePublishInput {
  destinationId: string;
  /** Optional initial delay (e.g. scheduling in a future version). */
  delayMs?: number;
}

export interface EnqueueStatusCheckInput {
  destinationId: string;
  delayMs: number;
}

export interface EnqueueResult {
  jobId: string;
}

export interface PublishDispatcher {
  enqueuePublish(input: EnqueuePublishInput): Promise<EnqueueResult>;
  enqueueStatusCheck(input: EnqueueStatusCheckInput): Promise<EnqueueResult>;
  /** Best-effort removal of a job that has not started. */
  cancel(jobId: string): Promise<void>;
}
