import { Prisma, type Db } from '@repeat/database';
import type { ProviderRegistry } from '@repeat/provider-sdk';
import type {
  CreatePostInput,
  ListPostsQuery,
  PostDestinationDto,
  PostDto,
  PostSummaryDto,
} from '@repeat/types';
import { NotFoundError, ValidationError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { MediaService } from '../media/media-service.js';
import type { PublishDispatcher } from '../publishing/dispatcher.js';
import { toMediaDescriptor, validatePostMedia } from '../publishing/media-support.js';
import {
  POST_MEDIA_INCLUDE,
  toPostDestinationDto,
  toPostDto,
  toPostSummaryDto,
} from './mappers.js';

/** Stable, platform-grouped ordering for destination lists. */
const DESTINATION_ORDER: Prisma.PostDestinationOrderByWithRelationInput[] = [
  { platform: 'asc' },
  { accountDisplayName: 'asc' },
  { id: 'asc' },
];

export interface PostServiceOptions {
  db: Db;
  media: MediaService;
  providers: ProviderRegistry;
  dispatcher: PublishDispatcher;
  logger: Logger;
}

/**
 * Posts and their destinations.
 *
 * Creating a post creates one independent destination row per selected
 * account and enqueues one job per destination. Nothing here talks to a
 * social platform; that happens in the worker via the PublishingEngine.
 */
export class PostService {
  constructor(private readonly options: PostServiceOptions) {}

  async create(userId: string, input: CreatePostInput): Promise<PostDto> {
    const { db, media: mediaService, providers, logger } = this.options;

    if (input.mediaIds.length === 0) throw new ValidationError('Add at least one video or image');
    if (new Set(input.mediaIds).size !== input.mediaIds.length) {
      throw new ValidationError('The same file was added twice');
    }
    // Ownership check for every item; another user's media is reported as not found.
    const mediaItems = [];
    for (const mediaId of input.mediaIds)
      mediaItems.push(await mediaService.getOwned(userId, mediaId));
    const descriptors = mediaItems.map(toMediaDescriptor);

    // De-duplicate selections: one destination per account.
    const selections = new Map<string, Record<string, unknown>>();
    for (const destination of input.destinations) {
      if (!selections.has(destination.socialAccountId)) {
        selections.set(destination.socialAccountId, destination.settings ?? {});
      }
    }
    if (selections.size === 0) throw new ValidationError('Select at least one destination');

    const accountIds = [...selections.keys()];
    const accounts = await db.socialAccount.findMany({ where: { id: { in: accountIds }, userId } });
    const accountsById = new Map(accounts.map((account) => [account.id, account]));

    const problems: { socialAccountId: string; message: string }[] = [];
    const prepared: { accountId: string; settings: Record<string, unknown> }[] = [];

    for (const [accountId, rawSettings] of selections) {
      const account = accountsById.get(accountId);
      if (!account) {
        // Not found or owned by someone else: identical response either way.
        throw new NotFoundError('Account');
      }
      if (!account.enabled) {
        problems.push({
          socialAccountId: accountId,
          message: `${account.displayName} is disabled. Enable it on the Accounts page first.`,
        });
        continue;
      }
      if (!providers.has(account.platform)) {
        problems.push({
          socialAccountId: accountId,
          message: `The ${account.platform} provider is not configured on this server.`,
        });
        continue;
      }
      const provider = providers.get(account.platform);
      const parsed = provider.settingsSchema.safeParse(rawSettings);
      if (!parsed.success) {
        problems.push({
          socialAccountId: accountId,
          message: `Invalid settings for ${account.displayName}: ${parsed.error.issues.map((issue) => (issue.path.length ? `${issue.message} (${issue.path.join('.')})` : issue.message)).join('; ')}`,
        });
        continue;
      }
      const mediaCheck = await validatePostMedia(provider, descriptors, parsed.data);
      if (!mediaCheck.ok) {
        problems.push({
          socialAccountId: accountId,
          message: `${account.displayName}: ${mediaCheck.message}`,
        });
        continue;
      }
      prepared.push({ accountId, settings: parsed.data });
    }

    if (problems.length > 0) {
      throw new ValidationError('Some destinations cannot be published to', {
        destinations: problems,
      });
    }

    const post = await db.post.create({
      data: {
        userId,
        mediaItems: {
          create: mediaItems.map((media, position) => ({ mediaId: media.id, position })),
        },
        title: input.title || null,
        caption: input.caption || null,
        description: input.description || null,
        destinations: {
          create: prepared.map(({ accountId, settings }) => {
            const account = accountsById.get(accountId)!;
            return {
              socialAccountId: account.id,
              platform: account.platform,
              accountDisplayName: account.displayName,
              accountAvatarUrl: account.avatarUrl,
              settings: settings as Prisma.InputJsonValue,
              status: 'queued' as const,
            };
          }),
        },
      },
      include: { ...POST_MEDIA_INCLUDE, destinations: { orderBy: DESTINATION_ORDER } },
    });

    logger.info(
      { post_id: post.id, user_id: userId, destination_count: post.destinations.length },
      'post created',
    );

    // Enqueue after the transaction committed so a worker can never see a
    // destination before it exists. Each destination is its own job.
    for (const destination of post.destinations) {
      await this.enqueue(
        destination.id,
        destination.platform,
        post.id,
        destination.socialAccountId,
      );
    }

    return this.get(userId, post.id);
  }

  async get(userId: string, postId: string): Promise<PostDto> {
    const post = await this.options.db.post.findFirst({
      where: { id: postId, userId },
      include: { ...POST_MEDIA_INCLUDE, destinations: { orderBy: DESTINATION_ORDER } },
    });
    if (!post) throw new NotFoundError('Post');
    return toPostDto(post);
  }

  async list(
    userId: string,
    query: ListPostsQuery,
  ): Promise<{ items: PostSummaryDto[]; nextCursor: string | null }> {
    const rows = await this.options.db.post.findMany({
      where: { userId },
      include: { ...POST_MEDIA_INCLUDE, destinations: { select: { status: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
    return {
      items: items.map(toPostSummaryDto),
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * Re-queue one destination that failed or was canceled. Other destinations
   * of the same post are untouched, so successful publishes are never repeated.
   */
  async retryDestination(
    userId: string,
    postId: string,
    destinationId: string,
  ): Promise<PostDestinationDto> {
    const { db, logger } = this.options;
    const destination = await db.postDestination.findFirst({
      where: { id: destinationId, postId, post: { userId } },
      include: { socialAccount: true },
    });
    if (!destination) throw new NotFoundError('Destination');
    if (destination.status !== 'failed' && destination.status !== 'canceled') {
      throw new ValidationError(
        `Only failed or canceled destinations can be retried (current status: ${destination.status})`,
      );
    }
    if (!destination.socialAccount) {
      throw new ValidationError(
        'The account for this destination has been disconnected. Reconnect it and publish again.',
      );
    }
    if (!destination.socialAccount.enabled) {
      throw new ValidationError(
        `${destination.socialAccount.displayName} is disabled. Enable it to retry.`,
      );
    }

    const updated = await db.postDestination.update({
      where: { id: destination.id },
      data: {
        status: 'queued',
        progress: null,
        errorCode: null,
        errorMessage: null,
        errorRetryable: null,
        platformPostId: null,
        platformPostUrl: null,
        providerState: Prisma.DbNull,
        jobId: null,
      },
    });
    logger.info(
      { post_id: postId, destination_id: destinationId, user_id: userId },
      'destination retry requested',
    );
    await this.enqueue(updated.id, updated.platform, postId, updated.socialAccountId);
    const fresh = await db.postDestination.findUniqueOrThrow({ where: { id: destination.id } });
    return toPostDestinationDto(fresh);
  }

  /** Cancel a destination that has not started yet. */
  async cancelDestination(
    userId: string,
    postId: string,
    destinationId: string,
  ): Promise<PostDestinationDto> {
    const { db, dispatcher, logger } = this.options;
    const destination = await db.postDestination.findFirst({
      where: { id: destinationId, postId, post: { userId } },
    });
    if (!destination) throw new NotFoundError('Destination');
    if (destination.status !== 'queued') {
      throw new ValidationError(
        `Only queued destinations can be canceled (current status: ${destination.status})`,
      );
    }
    const updated = await db.postDestination.update({
      where: { id: destination.id },
      data: { status: 'canceled', errorCode: null, errorMessage: null, errorRetryable: null },
    });
    if (destination.jobId) await dispatcher.cancel(destination.jobId).catch(() => undefined);
    logger.info(
      { post_id: postId, destination_id: destinationId, user_id: userId },
      'destination canceled',
    );
    return toPostDestinationDto(updated);
  }

  private async enqueue(
    destinationId: string,
    platform: string,
    postId: string,
    socialAccountId: string | null,
  ): Promise<void> {
    const { db, dispatcher, logger } = this.options;
    try {
      const { jobId } = await dispatcher.enqueuePublish({ destinationId });
      await db.postDestination.update({ where: { id: destinationId }, data: { jobId } });
      logger.info(
        {
          post_id: postId,
          destination_id: destinationId,
          social_account_id: socialAccountId,
          platform,
          job_id: jobId,
        },
        'publish job enqueued',
      );
    } catch (error) {
      logger.error(
        { post_id: postId, destination_id: destinationId, platform, err: error },
        'failed to enqueue publish job',
      );
      await db.postDestination.update({
        where: { id: destinationId },
        data: {
          status: 'failed',
          errorCode: 'queue_unavailable',
          errorMessage:
            'Could not enqueue the publish job (is Redis running?). Retry the destination.',
          errorRetryable: true,
        },
      });
    }
  }
}
