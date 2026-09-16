import { redirect } from 'next/navigation';
import { describeProviders } from '@repeat/core';
import { PageHeader } from '@/components/app-shell';
import { PlatformBadge } from '@/components/platform-badge';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate } from '@/lib/format';
import { getContainer } from '@/server/container';
import { getCurrentUser } from '@/server/session';

export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const { env, providerSetup } = getContainer();
  const providers = describeProviders(providerSetup.providers, providerSetup.connectors);

  const rows = [
    { label: 'Public URL (APP_URL)', value: env.APP_URL },
    { label: 'Max upload size', value: `${env.MAX_UPLOAD_SIZE_MB} MB` },
    { label: 'Media storage', value: `${env.MEDIA_STORAGE_DRIVER} (${env.MEDIA_STORAGE_PATH})` },
    { label: 'Worker concurrency', value: String(env.WORKER_CONCURRENCY) },
    { label: 'Registration', value: env.ALLOW_REGISTRATION ? 'open' : 'closed' },
    { label: 'Environment', value: env.NODE_ENV },
  ];

  return (
    <>
      <PageHeader
        title="Settings"
        description="This instance is configured through environment variables. See .env.example for every option."
      />
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Your account</CardTitle>
              <CardDescription>Signed in as {user.email}</CardDescription>
            </div>
          </CardHeader>
          <CardBody className="text-sm">
            <p>Name: {user.name ?? '—'}</p>
            <p>Member since: {formatDate(user.createdAt.toISOString())}</p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Platforms</CardTitle>
              <CardDescription>
                Providers register themselves when their credentials are present at startup.
              </CardDescription>
            </div>
          </CardHeader>
          <ul className="divide-y divide-neutral-200">
            {providers.map((provider) => (
              <li
                key={provider.platform}
                className="flex flex-wrap items-start justify-between gap-3 px-5 py-3"
              >
                <div>
                  <PlatformBadge platform={provider.platform} />
                  <ul className="mt-1 list-disc pl-4 text-xs text-neutral-500">
                    {provider.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </div>
                <Badge tone="green">Configured</Badge>
              </li>
            ))}
            {providerSetup.unconfigured.map((entry) => (
              <li
                key={entry.platform}
                className="flex flex-wrap items-start justify-between gap-3 px-5 py-3"
              >
                <div>
                  <PlatformBadge platform={entry.platform} />
                  <p className="mt-1 text-xs text-neutral-500">{entry.reason}</p>
                </div>
                <Badge tone="amber">Not configured</Badge>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Instance</CardTitle>
          </CardHeader>
          <dl className="divide-y divide-neutral-200 text-sm">
            {rows.map((row) => (
              <div key={row.label} className="flex justify-between gap-4 px-5 py-2.5">
                <dt className="text-neutral-500">{row.label}</dt>
                <dd className="truncate font-mono text-xs">{row.value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </>
  );
}
