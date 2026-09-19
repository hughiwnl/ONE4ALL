'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RotateCcw } from 'lucide-react';
import { isTerminalStatus, type PostDestinationDto, type PostDto } from '@repeat/types';
import { AccountAvatar, PlatformBadge } from '@/components/platform-badge';
import { MediaThumb } from '@/components/media-thumb';
import { StatusBadge } from '@/components/status-badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api-client';
import { formatBytes, formatDate } from '@/lib/format';

const POLL_INTERVAL_MS = 2500;

/**
 * Live destination statuses. Polls while any destination is still in flight;
 * the API shape is designed so this can become an SSE/WebSocket subscription later.
 */
export function PostStatusView({ initialPost }: { initialPost: PostDto }) {
  const [post, setPost] = useState(initialPost);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = post.destinations.some((d) => !isTerminalStatus(d.status));

  const refresh = useCallback(async () => {
    try {
      const { post: fresh } = await api.posts.get(post.id);
      setPost(fresh);
    } catch {
      /* transient; the next poll will retry */
    }
  }, [post.id]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, refresh]);

  async function retry(destination: PostDestinationDto) {
    setBusy(destination.id);
    setError(null);
    try {
      await api.posts.retry(post.id, destination.id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Retry failed');
    } finally {
      setBusy(null);
    }
  }

  async function cancel(destination: PostDestinationDto) {
    setBusy(destination.id);
    setError(null);
    try {
      await api.posts.cancel(post.id, destination.id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cancel failed');
    } finally {
      setBusy(null);
    }
  }

  const published = post.destinations.filter((d) => d.status === 'published').length;
  const failed = post.destinations.filter((d) => d.status === 'failed').length;

  return (
    <div className="space-y-6">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Destinations</CardTitle>
            <p className="mt-0.5 text-sm text-neutral-500" aria-live="polite">
              {published} published · {failed} failed ·{' '}
              {post.destinations.length - published - failed} other
              {active ? ' · updating live' : ''}
            </p>
          </div>
        </CardHeader>
        <ul className="divide-y divide-neutral-200">
          {post.destinations.map((destination) => (
            <li key={destination.id} className="px-5 py-4">
              <div className="flex flex-wrap items-center gap-4">
                <AccountAvatar
                  name={destination.accountDisplayName}
                  url={destination.accountAvatarUrl}
                />
                <div className="min-w-0 flex-1">
                  <PlatformBadge
                    platform={destination.platform}
                    className="text-xs text-neutral-500"
                  />
                  <p className="truncate text-sm font-medium text-neutral-900">
                    {destination.accountDisplayName}
                  </p>
                </div>
                <StatusBadge status={destination.status} progress={destination.progress} />
                <div className="flex items-center gap-2">
                  {destination.platformPostUrl && destination.status === 'published' ? (
                    <a
                      href={destination.platformPostUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline"
                    >
                      View post <ExternalLink className="size-3.5" aria-hidden="true" />
                    </a>
                  ) : null}
                  {destination.status === 'failed' || destination.status === 'canceled' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => retry(destination)}
                      loading={busy === destination.id}
                      disabled={!destination.socialAccountId}
                    >
                      <RotateCcw className="size-3.5" aria-hidden="true" /> Retry
                    </Button>
                  ) : null}
                  {destination.status === 'queued' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => cancel(destination)}
                      loading={busy === destination.id}
                    >
                      Cancel
                    </Button>
                  ) : null}
                </div>
              </div>
              {destination.status === 'uploading' ? (
                <div
                  className="mt-3 h-1.5 overflow-hidden rounded-full bg-neutral-200"
                  role="progressbar"
                  aria-valuenow={destination.progress ?? 0}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="h-full bg-brand-600 transition-[width]"
                    style={{ width: `${destination.progress ?? 0}%` }}
                  />
                </div>
              ) : null}
              {destination.errorMessage ? (
                <p
                  className={
                    destination.status === 'failed'
                      ? 'mt-2 text-sm text-red-700'
                      : 'mt-2 text-sm text-amber-700'
                  }
                >
                  {destination.errorMessage}
                  {destination.errorCode ? (
                    <span className="ml-1 text-xs text-neutral-500">({destination.errorCode})</span>
                  ) : null}
                </p>
              ) : null}
              {!destination.socialAccountId ? (
                <p className="mt-2 text-xs text-neutral-500">This account has been disconnected.</p>
              ) : null}
              <p className="mt-1 text-xs text-neutral-500">
                {destination.attempts} attempt{destination.attempts === 1 ? '' : 's'}
                {destination.publishedAt
                  ? ` · published ${formatDate(destination.publishedAt)}`
                  : ''}
                {destination.platformPostId ? ` · id ${destination.platformPostId}` : ''}
              </p>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Post</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-4 text-sm md:grid-cols-2">
          <div>
            <p className="text-neutral-500">
              {post.mediaItems.length > 1 ? `Carousel · ${post.mediaItems.length} items` : 'Media'}
            </p>
            <ol className="mt-1 space-y-1.5">
              {post.mediaItems.map((media, index) => (
                <li key={media.id} className="flex items-center gap-2">
                  {post.mediaItems.length > 1 ? (
                    <span className="w-4 text-xs text-neutral-500">{index + 1}</span>
                  ) : null}
                  <MediaThumb media={media} className="size-8" />
                  <span className="truncate">
                    {media.filename} · {formatBytes(media.sizeBytes)}
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <p className="text-neutral-500">Created</p>
            <p>{formatDate(post.createdAt)}</p>
          </div>
          {post.caption ? (
            <div className="md:col-span-2">
              <p className="text-neutral-500">Caption</p>
              <p className="whitespace-pre-wrap">{post.caption}</p>
            </div>
          ) : null}
          {post.description ? (
            <div className="md:col-span-2">
              <p className="text-neutral-500">Description</p>
              <p className="whitespace-pre-wrap">{post.description}</p>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <p className="text-sm">
        <Link href="/history" className="text-brand-600 hover:underline">
          ← Back to history
        </Link>
      </p>
    </div>
  );
}
