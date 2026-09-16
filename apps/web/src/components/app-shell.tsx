'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Clock, LayoutDashboard, LogOut, Repeat2, Settings, Upload, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { UserDto } from '@repeat/types';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { href: '/accounts', label: 'Accounts', Icon: Users },
  { href: '/publish', label: 'Publish', Icon: Upload },
  { href: '/history', label: 'History', Icon: Clock },
  { href: '/settings', label: 'Settings', Icon: Settings },
];

export function AppShell({ user, children }: { user: UserDto; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function logout() {
    setLoggingOut(true);
    try {
      await api.auth.logout();
    } finally {
      router.push('/login');
      router.refresh();
    }
  }

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-neutral-200 bg-white md:flex">
        <div className="flex h-16 items-center gap-2 border-b border-neutral-200 px-5">
          <Repeat2 className="size-6 text-brand-600" aria-hidden="true" />
          <span className="text-lg font-semibold tracking-tight">Repeat</span>
        </div>
        <nav className="flex-1 space-y-1 p-3" aria-label="Main">
          {NAV.map(({ href, label, Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium',
                  active ? 'bg-brand-50 text-brand-700' : 'text-neutral-700 hover:bg-neutral-100',
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-neutral-200 p-3">
          <p className="truncate px-3 text-xs text-neutral-500" title={user.email}>
            {user.name ?? user.email}
          </p>
          <button
            type="button"
            onClick={logout}
            disabled={loggingOut}
            className="mt-1 flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-100"
          >
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-neutral-200 bg-white px-4 md:hidden">
          <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
            <Repeat2 className="size-5 text-brand-600" aria-hidden="true" /> Repeat
          </Link>
          <nav className="flex gap-1" aria-label="Main">
            {NAV.map(({ href, label, Icon }) => (
              <Link
                key={href}
                href={href}
                aria-label={label}
                className={cn(
                  'rounded-md p-2',
                  pathname.startsWith(href) ? 'bg-brand-50 text-brand-700' : 'text-neutral-600',
                )}
              >
                <Icon className="size-5" aria-hidden="true" />
              </Link>
            ))}
          </nav>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">{title}</h1>
        {description ? <p className="mt-1 text-sm text-neutral-500">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
