import type { DestinationStatus } from '@repeat/types';
import { STATUS_LABELS } from '@/lib/format';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/button';

const TONES: Record<DestinationStatus, BadgeTone> = {
  queued: 'neutral',
  uploading: 'blue',
  processing: 'amber',
  published: 'green',
  failed: 'red',
  canceled: 'neutral',
};

export function StatusBadge({
  status,
  progress,
}: {
  status: DestinationStatus;
  progress?: number | null;
}) {
  const active = status === 'uploading' || status === 'processing' || status === 'queued';
  return (
    <Badge tone={TONES[status]}>
      {active ? <Spinner className="size-3" /> : null}
      {STATUS_LABELS[status]}
      {status === 'uploading' && progress != null ? ` ${progress}%` : ''}
    </Badge>
  );
}
