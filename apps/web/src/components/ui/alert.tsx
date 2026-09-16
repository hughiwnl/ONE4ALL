import type { HTMLAttributes } from 'react';
import { AlertCircle, CheckCircle2, Info, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tone = 'info' | 'success' | 'warning' | 'error';

const styles: Record<Tone, { box: string; Icon: typeof Info }> = {
  info: { box: 'border-blue-200 bg-blue-50 text-blue-900', Icon: Info },
  success: { box: 'border-green-200 bg-green-50 text-green-900', Icon: CheckCircle2 },
  warning: { box: 'border-amber-200 bg-amber-50 text-amber-900', Icon: TriangleAlert },
  error: { box: 'border-red-200 bg-red-50 text-red-900', Icon: AlertCircle },
};

export function Alert({
  tone = 'info',
  title,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: Tone; title?: string }) {
  const { box, Icon } = styles[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-md border px-4 py-3 text-sm', box, className)}
      {...props}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={cn(title && 'mt-1')}>{children}</div> : null}
      </div>
    </div>
  );
}
