import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plus } from 'lucide-react';
import { PageHeader } from '@/components/app-shell';
import { PlatformBadge } from '@/components/platform-badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { formatRelative, platformLabel } from '@/lib/format';
import { getContainer } from '@/server/container';
import { getCurrentUser } from '@/server/session';
import { PostSummaryRow } from '../history/post-summary-row';

export const metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const { services, providerSetup } = getContainer();
  const [accounts, recent] = await Promise.all([
    services.accounts.list(user.id),
    services.posts.list(user.id, { limit: 5 }),
  ]);
  const enabled = accounts.filter((account) => account.enabled);
  const byPlatform = new Map<string, number>();
  for (const account of enabled)
    byPlatform.set(account.platform, (byPlatform.get(account.platform) ?? 0) + 1);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Publish one video, image or carousel to every connected account at once."
        actions={
          <Link href="/publish">
            <Button>
              <Plus className="size-4" aria-hidden="true" /> New post
            </Button>
          </Link>
        }
      />

      {providerSetup.providers.list().length === 0 ? (
        <Alert tone="warning" title="No platforms are configured" className="mb-6">
          Set provider credentials in <code>.env</code> (see Settings) to connect real accounts, or
          enable the mock provider for development.
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardBody>
            <p className="text-sm text-neutral-500">Connected accounts</p>
            <p className="mt-1 text-3xl font-semibold">{accounts.length}</p>
            <p className="mt-1 text-xs text-neutral-500">{enabled.length} enabled</p>
          </CardBody>
        </Card>
        <Card className="md:col-span-2">
          <CardBody>
            <p className="text-sm text-neutral-500">Enabled destinations by platform</p>
            {byPlatform.size === 0 ? (
              <p className="mt-2 text-sm text-neutral-600">
                No enabled accounts yet.{' '}
                <Link href="/accounts" className="text-brand-600 hover:underline">
                  Connect one
                </Link>
                .
              </p>
            ) : (
              <ul className="mt-2 flex flex-wrap gap-3">
                {[...byPlatform.entries()].map(([platform, count]) => (
                  <li
                    key={platform}
                    className="flex items-center gap-2 rounded-md border border-neutral-200 px-3 py-1.5"
                  >
                    <PlatformBadge platform={platform} />
                    <span
                      className="text-sm text-neutral-500"
                      aria-label={`${count} ${platformLabel(platform)} accounts`}
                    >
                      {count}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Recent posts</CardTitle>
          <Link href="/history" className="text-sm text-brand-600 hover:underline">
            View all
          </Link>
        </CardHeader>
        {recent.items.length === 0 ? (
          <CardBody>
            <p className="text-sm text-neutral-500">Nothing published yet.</p>
          </CardBody>
        ) : (
          <ul className="divide-y divide-neutral-200">
            {recent.items.map((post) => (
              <PostSummaryRow key={post.id} post={post} subtitle={formatRelative(post.createdAt)} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
