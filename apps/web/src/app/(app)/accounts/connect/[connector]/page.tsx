import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/app-shell';
import { getCurrentUser } from '@/server/session';
import { SelectAccountsView } from './select-view';

export const metadata = { title: 'Choose accounts' };

export default async function SelectAccountsPage({
  params,
  searchParams,
}: {
  params: Promise<{ connector: string }>;
  searchParams: Promise<{ pending?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const { connector } = await params;
  const { pending } = await searchParams;
  if (!pending) redirect('/accounts');
  return (
    <>
      <PageHeader
        title="Choose accounts to connect"
        description="Only the accounts you select are stored. You can run the connection again later to add more."
      />
      <SelectAccountsView connector={connector} pendingId={pending} />
    </>
  );
}
