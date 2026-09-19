'use client';

import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { ArrowDown, ArrowUp, FileVideo, Image as ImageIcon, UploadCloud, X } from 'lucide-react';
import { MAX_POST_MEDIA_ITEMS, type MediaDto } from '@repeat/types';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { formatBytes, formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';

export type PickedItem =
  | {
      key: string;
      file: File;
      previewUrl: string | null;
      state: 'uploading';
      percent: number;
      controller: AbortController;
    }
  | { key: string; file: File; previewUrl: string | null; state: 'done'; media: MediaDto }
  | { key: string; file: File; previewUrl: string | null; state: 'error'; message: string };

const ACCEPT =
  'video/*,image/jpeg,image/png,.mp4,.mov,.m4v,.webm,.mkv,.avi,.mpeg,.mpg,.3gp,.jpg,.jpeg,.png';

/**
 * Step 1 of the Publish page: one video, one image, or several items for a
 * carousel. Files upload as soon as they are added; order is the carousel order.
 */
export function MediaPicker({
  items,
  maxUploadSizeMb,
  onAdd,
  onRemove,
  onMove,
}: {
  items: PickedItem[];
  maxUploadSizeMb: number;
  onAdd: (files: File[]) => void;
  onRemove: (key: string) => void;
  onMove: (key: string, direction: -1 | 1) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const full = items.length >= MAX_POST_MEDIA_ITEMS;

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    onAdd([...event.dataTransfer.files]);
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    onAdd([...(event.target.files ?? [])]);
    event.target.value = '';
  }

  return (
    <div className="space-y-4">
      {items.length > 0 ? (
        <ol className="space-y-2" aria-label="Media in publishing order">
          {items.map((item, index) => (
            <li
              key={item.key}
              className="flex items-center gap-3 rounded-md border border-neutral-200 p-2"
            >
              <span className="w-5 text-center text-xs font-medium text-neutral-500">
                {index + 1}
              </span>
              <Thumbnail item={item} />
              <div className="min-w-0 flex-1 text-sm">
                <p className="truncate font-medium">{item.file.name}</p>
                <ItemDetails item={item} />
              </div>
              {items.length > 1 ? (
                <div className="flex flex-col">
                  <button
                    type="button"
                    className="rounded p-0.5 text-neutral-500 hover:bg-neutral-100 disabled:opacity-30"
                    onClick={() => onMove(item.key, -1)}
                    disabled={index === 0}
                    aria-label={`Move ${item.file.name} earlier`}
                  >
                    <ArrowUp className="size-4" />
                  </button>
                  <button
                    type="button"
                    className="rounded p-0.5 text-neutral-500 hover:bg-neutral-100 disabled:opacity-30"
                    onClick={() => onMove(item.key, 1)}
                    disabled={index === items.length - 1}
                    aria-label={`Move ${item.file.name} later`}
                  >
                    <ArrowDown className="size-4" />
                  </button>
                </div>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRemove(item.key)}
                aria-label={`Remove ${item.file.name}`}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ol>
      ) : null}

      {!full ? (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'flex flex-col items-center justify-center rounded-md border-2 border-dashed px-6 text-center',
            items.length > 0 ? 'py-5' : 'py-10',
            dragging ? 'border-brand-500 bg-brand-50' : 'border-neutral-300',
          )}
        >
          {items.length === 0 ? (
            <UploadCloud className="size-8 text-neutral-400" aria-hidden="true" />
          ) : null}
          <p className="mt-2 text-sm text-neutral-700">
            {items.length === 0
              ? 'Drag and drop a video or images here, or'
              : 'Add more items to make a carousel (Instagram), or'}
          </p>
          <Button variant="secondary" className="mt-3" onClick={() => fileInput.current?.click()}>
            {items.length === 0 ? 'Choose files' : 'Add files'}
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ACCEPT}
            className="sr-only"
            onChange={onPick}
            aria-label="Choose media files"
          />
          <p className="mt-3 text-xs text-neutral-500">
            Videos (MP4, MOV, WebM, MKV, AVI, MPEG, 3GP) or images (JPEG, PNG) · up to{' '}
            {maxUploadSizeMb} MB each · up to {MAX_POST_MEDIA_ITEMS} items
          </p>
        </div>
      ) : (
        <p className="text-xs text-neutral-500">
          A post can contain at most {MAX_POST_MEDIA_ITEMS} items.
        </p>
      )}
    </div>
  );
}

function Thumbnail({ item }: { item: PickedItem }) {
  if (item.previewUrl) {
    return <img src={item.previewUrl} alt="" className="size-12 shrink-0 rounded object-cover" />;
  }
  const isImage = item.file.type.startsWith('image/');
  const Icon = isImage ? ImageIcon : FileVideo;
  return (
    <span className="flex size-12 shrink-0 items-center justify-center rounded bg-neutral-100 text-neutral-600">
      <Icon className="size-6" aria-hidden="true" />
    </span>
  );
}

function ItemDetails({ item }: { item: PickedItem }) {
  if (item.state === 'uploading') {
    return (
      <div className="mt-1">
        <div
          className="h-1.5 overflow-hidden rounded-full bg-neutral-200"
          role="progressbar"
          aria-valuenow={item.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Uploading ${item.file.name}`}
        >
          <div
            className="h-full bg-brand-600 transition-[width]"
            style={{ width: `${item.percent}%` }}
          />
        </div>
        <p className="mt-0.5 text-xs text-neutral-500">Uploading {item.percent}%…</p>
      </div>
    );
  }
  if (item.state === 'error') {
    return (
      <Alert tone="error" className="mt-1 py-1.5">
        {item.message}
      </Alert>
    );
  }
  const media = item.media;
  return (
    <p className="text-xs text-neutral-500">
      {formatBytes(media.sizeBytes)} · {media.mimeType}
      {media.durationSeconds != null ? ` · ${formatDuration(media.durationSeconds)}` : ''}
      {media.width && media.height ? ` · ${media.width}×${media.height}` : ''}
    </p>
  );
}
