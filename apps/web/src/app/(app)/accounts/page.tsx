import { redirect } from 'next/navigation';
import { describeProviders } from '@repeat/core';
import { PageHeader } from '@/components/app-shell';
import { getContainer } from '@/server/container';
import { getCurrentUser } from '@/server/session';
import { AccountsView } from './accounts-view';

export const metadata = { title: 'Accounts' };

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; connected?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const { error, connected } = await searchParams;
  const { services, providerSetup } = getContainer();
  const accounts = await services.accounts.list(user.id);
  const providers = describeProviders(providerSetup.providers, providerSetup.connectors);

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Connect as many accounts per platform as you like. Disabled accounts stay connected but are hidden from publishing."
      />
      <AccountsView
        initialAccounts={accounts}
        providers={providers}
        unconfigured={providerSetup.unconfigured}
        flash={
          error
            ? { tone: 'error', message: error }
            : connected
              ? { tone: 'success', message: `Connected ${connected}.` }
              : null
        }
      />
    </>
  );
}
