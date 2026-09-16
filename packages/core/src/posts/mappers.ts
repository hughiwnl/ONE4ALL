import type { Media, Post, PostDestination } from '@repeat/database';
import type {
  DestinationStatus,
  DestinationStatusSummary,
  PostDestinationDto,
  PostDto,
  PostSummaryDto,
} from '@repeat/types';
import { asRecord } from '../accounts/mappers.js';
import { toMediaDto } from '../media/mappers.js';

export function toPostDestinationDto(destination: PostDestination): PostDestinationDto {
  return {
    id: destination.id,
    postId: destination.postId,
    socialAccountId: destination.socialAccountId,
    platform: destination.platform,
    accountDisplayName: destination.accountDisplayName,
    accountAvatarUrl: destination.accountAvatarUrl,
    status: destination.status,
    progress: destination.progress,
    settings: asRecord(destination.settings),
    platformPostId: destination.platformPostId,
    platformPostUrl: destination.platformPostUrl,
    errorCode: destination.errorCode,
    errorMessage: destination.errorMessage,
    errorRetryable: destination.errorRetryable,
    attempts: destination.attempts,
    startedAt: destination.startedAt?.toISOString() ?? null,
    publishedAt: destination.publishedAt?.toISOString() ?? null,
    createdAt: destination.createdAt.toISOString(),
    updatedAt: destination.updatedAt.toISOString(),
  };
}

export function toPostDto(post: Post & { media: Media; destinations: PostDestination[] }): PostDto {
  return {
    id: post.id,
    title: post.title,
    caption: post.caption,
    description: post.description,
    media: toMediaDto(post.media),
    destinations: post.destinations.map(toPostDestinationDto),
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}

export function summarizeDestinations(
  destinations: { status: DestinationStatus }[],
): DestinationStatusSummary {
  const summary: DestinationStatusSummary = {
    total: destinations.length,
    queued: 0,
    uploading: 0,
    processing: 0,
    published: 0,
    failed: 0,
    canceled: 0,
  };
  for (const destination of destinations) summary[destination.status] += 1;
  return summary;
}

export function toPostSummaryDto(
  post: Post & { media: Media; destinations: { status: DestinationStatus }[] },
): PostSummaryDto {
  return {
    id: post.id,
    title: post.title,
    caption: post.caption,
    media: toMediaDto(post.media),
    summary: summarizeDestinations(post.destinations),
    createdAt: post.createdAt.toISOString(),
  };
}
