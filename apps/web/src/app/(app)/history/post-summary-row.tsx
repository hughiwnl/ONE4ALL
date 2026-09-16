import Link from 'next/link';
import { Film } from 'lucide-react';
import type { PostSummaryDto } from '@repeat/types';
import { Badge } from '@/components/ui/badge';

export function PostSummaryRow({ post, subtitle }: { post: PostSummaryDto; subtitle: string }) {
  const { summary } = post;
  const inFlight = summary.queued + summary.uploading + summary.processing;
  return (
    <li>
      <Link
        href={`/posts/${post.id}`}
        className="flex items-center gap-4 px-5 py-3 hover:bg-neutral-50"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-neutral-100 text-neutral-500">
          <Film className="size-5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-neutral-900">
            {post.title || post.media.filename}
          </span>
          <span className="block truncate text-xs text-neutral-500">
            {post.media.filename} · {summary.total} destination{summary.total === 1 ? '' : 's'} ·{' '}
            {subtitle}
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
