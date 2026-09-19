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

/** Shape of a post loaded with its ordered media items. */
export type PostWithMedia = Post & { mediaItems: { position: number; media: Media }[] };

/** Prisma include for a post's media in publishing order. */
export const POST_MEDIA_INCLUDE = {
  mediaItems: { include: { media: true }, orderBy: { position: 'asc' as const } },
};

function orderedMedia(post: PostWithMedia): Media[] {
  const items = [...post.mediaItems]
    .sort((a, b) => a.position - b.position)
    .map((item) => item.media);
  if (items.length === 0) throw new Error(`Post ${post.id} has no media items`);
  return items;
}

export function toPostDto(post: PostWithMedia & { destinations: PostDestination[] }): PostDto {
  const media = orderedMedia(post).map(toMediaDto);
  return {
    id: post.id,
    title: post.title,
    caption: post.caption,
    description: post.description,
    media: media[0]!,
    mediaItems: media,
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
  post: PostWithMedia & { destinations: { status: DestinationStatus }[] },
): PostSummaryDto {
  const media = orderedMedia(post);
  return {
    id: post.id,
    title: post.title,
    caption: post.caption,
    media: toMediaDto(media[0]!),
    mediaCount: media.length,
    summary: summarizeDestinations(post.destinations),
    createdAt: post.createdAt.toISOString(),
  };
}
