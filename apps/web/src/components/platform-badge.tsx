import { FlaskConical, Globe } from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';
import { FacebookIcon, InstagramIcon, YouTubeIcon } from '@/components/brand-icons';
import type { PlatformId } from '@repeat/types';
import { platformLabel } from '@/lib/format';
import { cn } from '@/lib/utils';

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

const ICONS: Record<string, { Icon: IconComponent; className: string }> = {
  youtube: { Icon: YouTubeIcon, className: 'text-red-600' },
  instagram: { Icon: InstagramIcon, className: 'text-pink-600' },
  facebook: { Icon: FacebookIcon, className: 'text-blue-600' },
  mock: { Icon: FlaskConical, className: 'text-purple-600' },
};

export function PlatformIcon({
  platform,
  className,
}: {
  platform: PlatformId;
  className?: string;
}) {
  const entry = ICONS[platform] ?? { Icon: Globe, className: 'text-neutral-500' };
  return <entry.Icon className={cn('size-4', entry.className, className)} aria-hidden="true" />;
}

export function PlatformBadge({
  platform,
  className,
}: {
  platform: PlatformId;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-sm font-medium text-neutral-700',
        className,
      )}
    >
      <PlatformIcon platform={platform} />
      {platformLabel(platform)}
    </span>
  );
}

export function AccountAvatar({
  name,
  url,
  className,
}: {
  name: string;
  url: string | null;
  className?: string;
}) {
  if (url) {
    return (
      <img
        src={url}
        alt=""
        className={cn('size-10 rounded-full object-cover', className)}
        referrerPolicy="no-referrer"
      />
    );
  }
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
  return (
    <span
      className={cn(
        'flex size-10 items-center justify-center rounded-full bg-neutral-200 text-sm font-semibold text-neutral-700',
        className,
      )}
      aria-hidden="true"
    >
      {initials || '?'}
    </span>
  );
}
