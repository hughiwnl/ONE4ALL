import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type BadgeTone = 'neutral' | 'blue' | 'green' | 'red' | 'amber' | 'purple';

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-100 text-neutral-700 ring-neutral-200',
  blue: 'bg-blue-50 text-blue-700 ring-blue-200',
  green: 'bg-green-50 text-green-700 ring-green-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  purple: 'bg-purple-50 text-purple-700 ring-purple-200',
};

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
