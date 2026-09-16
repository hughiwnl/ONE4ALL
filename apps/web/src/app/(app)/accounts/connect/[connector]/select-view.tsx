'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ConnectableAccountDto } from '@repeat/types';
import { AccountAvatar, PlatformBadge } from '@/components/platform-badge';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, Spinner } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { api, ApiError } from '@/lib/api-client';

const key = (account: { platform: string; platformAccountId: string }) =>
  `${account.platform}:${account.platformAccountId}`;

export function SelectAccountsView({
  connector,
  pendingId,
}: {
  connector: string;
  pendingId: string;
}) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<ConnectableAccountDto[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    api.accounts
      .pending(connector, pendingId)
      .then((result) => {
        if (!active) return;
        setAccounts(result.accounts);
        setSelected(new Set(result.accounts.filter((a) => !a.alreadyConnected).map(key)));
      })
      .catch((err: unknown) => {
        if (active)
          setError(err instanceof ApiError ? err.message : 'Could not load the pending connection');
      });
    return () => {
      active = false;
    };
  }, [connector, pendingId]);

  async function submit() {
    if (!accounts) return;
    setSubmitting(true);
    setError(null);
    try {
      const chosen = accounts
        .filter((a) => selected.has(key(a)))
        .map((a) => ({ platform: a.platform, platformAccountId: a.platformAccountId }));
      const result = await api.accounts.complete(connector, {
        pendingConnectionId: pendingId,
        selected: chosen,
      });
      const names = [...result.created, ...result.updated].map((a) => a.displayName).join(', ');
      router.push(`/accounts?connected=${encodeURIComponent(names)}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not connect the accounts');
      setSubmitting(false);
    }
  }

  if (error && !accounts) return <Alert tone="error">{error}</Alert>;
  if (!accounts) {
    return (
      <p className="flex items-center gap-2 text-sm text-neutral-500">
        <Spinner className="size-4" /> Loading accounts…
      </p>
    );
  }

  return (
    <Card>
      {error ? (
        <CardBody>
          <Alert tone="error">{error}</Alert>
        </CardBody>
      ) : null}
      <ul className="divide-y divide-neutral-200">
        {accounts.map((account) => {
          const id = key(account);
          return (
            <li key={id}>
              <label className="flex cursor-pointer items-center gap-4 px-5 py-3 hover:bg-neutral-50">
                <Checkbox
                  checked={selected.has(id)}
                  onCheckedChange={(checked) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked) next.add(id);
                      else next.delete(id);
                      return next;
                    })
                  }
                />
                <AccountAvatar name={account.displayName} url={account.avatarUrl} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{account.displayName}</span>
                  <span className="block truncate text-xs text-neutral-500">
                    {account.username ? `${account.username} · ` : ''}
                    {typeof account.metadata.facebookPageName === 'string'
                      ? `via Page "${account.metadata.facebookPageName}"`
                      : account.platformAccountId}
                  </span>
                </span>
                <PlatformBadge platform={account.platform} />
                {account.alreadyConnected ? <Badge tone="blue">Already connected</Badge> : null}
              </label>
            </li>
          );
        })}
      </ul>
      <CardBody className="flex items-center justify-between border-t border-neutral-200">
        <span className="text-sm text-neutral-500">
          {selected.size} of {accounts.length} selected
        </span>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => router.push('/accounts')}>
            Cancel
          </Button>
          <Button onClick={submit} loading={submitting} disabled={selected.size === 0}>
            Connect {selected.size} account{selected.size === 1 ? '' : 's'}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
