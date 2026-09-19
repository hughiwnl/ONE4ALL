import { Film, Image as ImageIcon } from 'lucide-react';
import type { MediaDto } from '@repeat/types';
import { cn } from '@/lib/utils';

/** Small preview: the real image for photos (served to its owner), an icon for videos. */
export function MediaThumb({ media, className }: { media: MediaDto; className?: string }) {
  if (media.kind === 'image') {
    return (
      <img
        src={`/api/media/${media.id}/file`}
        alt=""
        loading="lazy"
        className={cn('size-10 shrink-0 rounded-md bg-neutral-100 object-cover', className)}
      />
    );
  }
  return (
    <span
      className={cn(
        'flex size-10 shrink-0 items-center justify-center rounded-md bg-neutral-100 text-neutral-500',
        className,
      )}
    >
      {media.kind === 'video' ? (
        <Film className="size-5" aria-hidden="true" />
      ) : (
        <ImageIcon className="size-5" aria-hidden="true" />
      )}
    </span>
  );
}

export function describeMedia(
  items: { filename: string; kind: string }[] | { count: number; first: { filename: string } },
): string {
  if ('count' in items) {
    return items.count > 1 ? `Carousel of ${items.count} items` : items.first.filename;
  }
  return items.length > 1 ? `Carousel of ${items.length} items` : (items[0]?.filename ?? '');
}
