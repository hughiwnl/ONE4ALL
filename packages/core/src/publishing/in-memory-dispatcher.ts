import type {
  EnqueuePublishInput,
  EnqueueResult,
  EnqueueStatusCheckInput,
  PublishDispatcher,
} from './dispatcher.js';

/**
 * Records enqueued jobs instead of sending them anywhere. Used by tests and
 * handy for scripts that want to create posts without running a queue.
 */
export class InMemoryDispatcher implements PublishDispatcher {
  readonly publishJobs: (EnqueuePublishInput & { jobId: string })[] = [];
  readonly statusJobs: (EnqueueStatusCheckInput & { jobId: string })[] = [];
  readonly canceled: string[] = [];
  private counter = 0;

  async enqueuePublish(input: EnqueuePublishInput): Promise<EnqueueResult> {
    const jobId = `publish-${++this.counter}`;
    this.publishJobs.push({ ...input, jobId });
    return { jobId };
  }

  async enqueueStatusCheck(input: EnqueueStatusCheckInput): Promise<EnqueueResult> {
    const jobId = `status-${++this.counter}`;
    this.statusJobs.push({ ...input, jobId });
    return { jobId };
  }

  async cancel(jobId: string): Promise<void> {
    this.canceled.push(jobId);
  }

  reset(): void {
    this.publishJobs.length = 0;
    this.statusJobs.length = 0;
    this.canceled.length = 0;
  }
}
