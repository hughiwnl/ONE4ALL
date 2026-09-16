import { redirect } from 'next/navigation';
import { describeProviders } from '@repeat/core';
import { PageHeader } from '@/components/app-shell';
import { getContainer } from '@/server/container';
import { getCurrentUser } from '@/server/session';
import { PublishForm } from './publish-form';

export const metadata = { title: 'Publish' };

export default async function PublishPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const { services, providerSetup, env } = getContainer();
  const accounts = await services.accounts.list(user.id, { enabledOnly: true });
  const providers = describeProviders(providerSetup.providers, providerSetup.connectors);
  return (
    <>
      <PageHeader
        title="Publish"
        description="Upload one video, pick the destinations, publish everywhere at once."
      />
      <PublishForm
        accounts={accounts}
        providers={providers}
        maxUploadSizeMb={env.MAX_UPLOAD_SIZE_MB}
      />
    </>
  );
}
