'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import type { ConnectMockAccountRequest, ProviderInfoDto, SocialAccountDto } from '@repeat/types';
import { AccountAvatar, PlatformBadge } from '@/components/platform-badge';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api, ApiError } from '@/lib/api-client';
import { formatDate, platformLabel } from '@/lib/format';
import { formString } from '@/lib/utils';

interface Flash {
  tone: 'success' | 'error';
  message: string;
}

export function AccountsView({
  initialAccounts,
  providers,
  unconfigured,
  flash,
}: {
  initialAccounts: SocialAccountDto[];
  providers: ProviderInfoDto[];
  unconfigured: { platform: string; displayName: string; reason: string }[];
  flash: Flash | null;
}) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [notice, setNotice] = useState<Flash | null>(flash);
  const [busy, setBusy] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, SocialAccountDto[]>();
    for (const account of accounts) {
      map.set(account.platform, [...(map.get(account.platform) ?? []), account]);
    }
    return [...map.entries()];
  }, [accounts]);

  // OAuth connectors are shared by several platforms (Meta); show one button per connector.
  const connectors = useMemo(() => {
    const seen = new Map<
      string,
      { id: string; label: string; kind: 'oauth' | 'mock'; platforms: string[] }
    >();
    for (const provider of providers) {
      if (!provider.connector) continue;
      const entry = seen.get(provider.connector.id) ?? { ...provider.connector, platforms: [] };
      entry.platforms.push(provider.platform);
      seen.set(provider.connector.id, entry);
    }
    return [...seen.values()];
  }, [providers]);

  async function toggle(account: SocialAccountDto) {
    setBusy(account.id);
    try {
      const { account: updated } = await api.accounts.setEnabled(account.id, !account.enabled);
      setAccounts((list) => list.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof ApiError ? error.message : 'Could not update the account',
      });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(account: SocialAccountDto) {
    if (
      !window.confirm(
        `Disconnect ${account.displayName}? Stored credentials are deleted; publishing history is kept.`,
      )
    )
      return;
    setBusy(account.id);
    try {
      await api.accounts.disconnect(account.id);
      setAccounts((list) => list.filter((item) => item.id !== account.id));
      setNotice({ tone: 'success', message: `Disconnected ${account.displayName}.` });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof ApiError ? error.message : 'Could not disconnect the account',
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {notice ? <Alert tone={notice.tone}>{notice.message}</Alert> : null}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Connect an account</CardTitle>
            <p className="mt-0.5 text-sm text-neutral-500">
              Run the flow again to add another channel or page from the same platform.
            </p>
          </div>
        </CardHeader>
        <CardBody className="flex flex-wrap gap-2">
          {connectors.map((connector) =>
            connector.kind === 'mock' ? (
              <ConnectMockDialog
                key={connector.id}
                provider={providers.find((p) => p.platform === 'mock')!}
                onConnected={(account) => {
                  setAccounts((list) => [
                    ...list.filter((item) => item.id !== account.id),
                    account,
                  ]);
                  setNotice({ tone: 'success', message: `Connected ${account.displayName}.` });
                }}
              />
            ) : (
              <a key={connector.id} href={`/api/connect/${connector.id}/start`}>
                <Button variant="secondary">
                  <Plus className="size-4" aria-hidden="true" /> Connect {connector.label}
                </Button>
              </a>
            ),
          )}
          {unconfigured.map((entry) => (
            <span
              key={entry.platform}
              className="inline-flex h-10 items-center gap-2 rounded-md border border-dashed border-neutral-300 px-3 text-sm text-neutral-500"
              title={entry.reason}
            >
              {entry.displayName}: not configured
            </span>
          ))}
        </CardBody>
        {providers.some((p) => p.notes.length > 0) ? (
          <CardBody className="border-t border-neutral-200 text-xs text-neutral-500">
            <ul className="list-disc space-y-1 pl-4">
              {providers.flatMap((p) =>
                p.notes.map((note) => (
                  <li key={`${p.platform}-${note}`}>
                    {p.displayName}: {note}
                  </li>
                )),
              )}
            </ul>
          </CardBody>
        ) : null}
      </Card>

      {grouped.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-neutral-500">No accounts connected yet.</p>
          </CardBody>
        </Card>
      ) : (
        grouped.map(([platform, list]) => (
          <Card key={platform}>
            <CardHeader>
              <CardTitle>
                <PlatformBadge platform={platform} className="text-base" />
              </CardTitle>
              <span className="text-sm text-neutral-500">
                {list.length} account{list.length === 1 ? '' : 's'}
              </span>
            </CardHeader>
            <ul className="divide-y divide-neutral-200">
              {list.map((account) => (
                <li key={account.id} className="flex flex-wrap items-center gap-4 px-5 py-3">
                  <AccountAvatar name={account.displayName} url={account.avatarUrl} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-neutral-900">
                      {account.displayName}
                    </p>
                    <p className="truncate text-xs text-neutral-500">
                      {account.username ? `${account.username} · ` : ''}
                      {platformLabel(account.platform)} id {account.platformAccountId} · connected{' '}
                      {formatDate(account.createdAt)}
                    </p>
                  </div>
                  <Badge tone={account.enabled ? 'green' : 'neutral'}>
                    {account.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={account.enabled}
                      onCheckedChange={() => toggle(account)}
                      disabled={busy === account.id}
                      aria-label={`${account.enabled ? 'Disable' : 'Enable'} ${account.displayName}`}
                    />
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => disconnect(account)}
                      loading={busy === account.id}
                    >
                      Disconnect
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}
    </div>
  );
}

function ConnectMockDialog({
  provider,
  onConnected,
}: {
  provider: ProviderInfoDto;
  onConnected: (account: SocialAccountDto) => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSubmitting(true);
    setError(null);
    try {
      const { account } = await api.accounts.connectMock({
        displayName: formString(form, 'displayName'),
        behavior: (formString(form, 'behavior') ||
          'succeed') as ConnectMockAccountRequest['behavior'],
      });
      onConnected(account);
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the mock account');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <Plus className="size-4" aria-hidden="true" /> Add mock account
        </Button>
      </DialogTrigger>
      <DialogContent title="Add a mock account" description={provider.notes[0]}>
        <form onSubmit={onSubmit} className="space-y-4">
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div>
            <Label htmlFor="mock-name">Account name</Label>
            <Input
              id="mock-name"
              name="displayName"
              required
              maxLength={100}
              placeholder="Main Channel"
            />
          </div>
          <div>
            <Label htmlFor="mock-behavior">Simulated outcome</Label>
            <Select id="mock-behavior" name="behavior" defaultValue="succeed">
              <option value="succeed">Succeed</option>
              <option value="succeed_after_processing">Succeed after processing</option>
              <option value="fail_retryable">Fail (retryable, exhausts retries)</option>
              <option value="fail_permanent">Fail (permanent)</option>
              <option value="flaky">Fail once, then succeed</option>
            </Select>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Connect
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
