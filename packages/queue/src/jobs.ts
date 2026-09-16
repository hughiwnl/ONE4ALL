export const PUBLISH_QUEUE_NAME = 'repeat-publish';

export const JOB_NAMES = {
  publish: 'publish-destination',
  checkStatus: 'check-destination-status',
} as const;

export type PublishJobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export interface PublishJobData {
  destinationId: string;
}
