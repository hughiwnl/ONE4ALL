import Link from 'next/link';
import type { PostSummaryDto } from '@repeat/types';
import { Badge } from '@/components/ui/badge';
import { describeMedia, MediaThumb } from '@/components/media-thumb';

export function PostSummaryRow({ post, subtitle }: { post: PostSummaryDto; subtitle: string }) {
  const { summary } = post;
  const inFlight = summary.queued + summary.uploading + summary.processing;
  return (
    <li>
      <Link
        href={`/posts/${post.id}`}
        className="flex items-center gap-4 px-5 py-3 hover:bg-neutral-50"
      >
        <MediaThumb media={post.media} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-neutral-900">
            {post.title || post.media.filename}
          </span>
          <span className="block truncate text-xs text-neutral-500">
            {describeMedia({ count: post.mediaCount, first: post.media })} · {summary.total}{' '}
            destination{summary.total === 1 ? '' : 's'} · {subtitle}
          </span>
        </span>
        <span className="flex shrink-0 flex-wrap justify-end gap-1">
          {summary.published > 0 ? <Badge tone="green">{summary.published} published</Badge> : null}
          {summary.failed > 0 ? <Badge tone="red">{summary.failed} failed</Badge> : null}
          {inFlight > 0 ? <Badge tone="blue">{inFlight} in progress</Badge> : null}
          {summary.canceled > 0 ? <Badge>{summary.canceled} canceled</Badge> : null}
        </span>
      </Link>
    </li>
  );
}
