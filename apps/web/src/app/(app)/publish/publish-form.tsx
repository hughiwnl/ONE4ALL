'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { FileVideo, UploadCloud, X } from 'lucide-react';
import type { MediaDto, ProviderInfoDto, SettingsField, SocialAccountDto } from '@repeat/types';
import { AccountAvatar, PlatformBadge } from '@/components/platform-badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { FieldHint, Input, Label, Select, Textarea } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api-client';
import { formatBytes, formatDuration, platformLabel } from '@/lib/format';
import { cn } from '@/lib/utils';

type Upload =
  | { state: 'idle' }
  | { state: 'uploading'; file: File; percent: number; controller: AbortController }
  | { state: 'done'; media: MediaDto }
  | { state: 'error'; message: string };

type SettingsState = Record<string, Record<string, string | boolean>>;

export function PublishForm({
  accounts,
  providers,
  maxUploadSizeMb,
}: {
  accounts: SocialAccountDto[];
  providers: ProviderInfoDto[];
  maxUploadSizeMb: number;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<Upload>({ state: 'idle' });
  const [dragging, setDragging] = useState(false);
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<SettingsState>({});
  const [error, setError] = useState<{
    message: string;
    details?: { socialAccountId: string; message: string }[];
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const providerByPlatform = useMemo(
    () => new Map(providers.map((p) => [p.platform, p])),
    [providers],
  );
  const grouped = useMemo(() => {
    const map = new Map<string, SocialAccountDto[]>();
    for (const account of accounts)
      map.set(account.platform, [...(map.get(account.platform) ?? []), account]);
    return [...map.entries()];
  }, [accounts]);
  const selectedPlatforms = useMemo(() => {
    const set = new Set<string>();
    for (const account of accounts) if (selected.has(account.id)) set.add(account.platform);
    return [...set];
  }, [accounts, selected]);

  function startUpload(file: File) {
    if (file.size > maxUploadSizeMb * 1024 * 1024) {
      setUpload({
        state: 'error',
        message: `${file.name} is ${formatBytes(file.size)}; the limit is ${maxUploadSizeMb} MB.`,
      });
      return;
    }
    const controller = new AbortController();
    setUpload({ state: 'uploading', file, percent: 0, controller });
    api.media
      .upload(
        file,
        (percent) =>
          setUpload((current) =>
            current.state === 'uploading' ? { ...current, percent } : current,
          ),
        controller.signal,
      )
      .then((media) => setUpload({ state: 'done', media }))
      .catch((err: unknown) =>
        setUpload({
          state: 'error',
          message: err instanceof ApiError ? err.message : 'Upload failed',
        }),
      );
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) startUpload(file);
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) startUpload(file);
    event.target.value = '';
  }

  function toggleAccount(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function togglePlatform(platform: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const account of accounts) {
        if (account.platform !== platform) continue;
        if (checked) next.add(account.id);
        else next.delete(account.id);
      }
      return next;
    });
  }

  function setSetting(platform: string, key: string, value: string | boolean) {
    setSettings((current) => ({ ...current, [platform]: { ...current[platform], [key]: value } }));
  }

  async function publish() {
    if (upload.state !== 'done' || selected.size === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const destinations = accounts
        .filter((account) => selected.has(account.id))
        .map((account) => ({
          socialAccountId: account.id,
          settings: buildSettings(
            providerByPlatform.get(account.platform),
            settings[account.platform],
          ),
        }));
      const { post } = await api.posts.create({
        mediaId: upload.media.id,
        title: title.trim() || undefined,
        caption: caption.trim() || undefined,
        description: description.trim() || undefined,
        destinations,
      });
      router.push(`/posts/${post.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        const details = (
          err.details as
            { destinations?: { socialAccountId: string; message: string }[] } | undefined
        )?.destinations;
        setError({ message: err.message, details });
      } else {
        setError({ message: 'Publishing could not be started' });
      }
      setSubmitting(false);
    }
  }

  const canPublish = upload.state === 'done' && selected.size > 0 && !submitting;

  return (
    <div className="space-y-6">
      {/* Step 1: media */}
      <Card>
        <CardHeader>
          <CardTitle>1. Video</CardTitle>
        </CardHeader>
        <CardBody>
          {upload.state === 'done' ? (
            <div className="flex items-center gap-4">
              <span className="flex size-12 items-center justify-center rounded-md bg-neutral-100 text-neutral-600">
                <FileVideo className="size-6" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1 text-sm">
                <p className="truncate font-medium">{upload.media.filename}</p>
                <p className="text-neutral-500">
                  {formatBytes(upload.media.sizeBytes)} · {upload.media.mimeType}
                  {upload.media.durationSeconds != null
                    ? ` · ${formatDuration(upload.media.durationSeconds)}`
                    : ''}
                  {upload.media.width && upload.media.height
                    ? ` · ${upload.media.width}×${upload.media.height}`
                    : ''}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setUpload({ state: 'idle' })}>
                <X className="size-4" aria-hidden="true" /> Replace
              </Button>
            </div>
          ) : upload.state === 'uploading' ? (
            <div className="text-sm">
              <div className="flex items-center justify-between">
                <p className="truncate font-medium">{upload.file.name}</p>
                <Button variant="ghost" size="sm" onClick={() => upload.controller.abort()}>
                  Cancel
                </Button>
              </div>
              <div
                className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-200"
                role="progressbar"
                aria-valuenow={upload.percent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="h-full bg-brand-600 transition-[width]"
                  style={{ width: `${upload.percent}%` }}
                />
              </div>
              <p className="mt-1 text-neutral-500">Uploading {upload.percent}%…</p>
            </div>
          ) : (
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cn(
                'flex flex-col items-center justify-center rounded-md border-2 border-dashed px-6 py-10 text-center',
                dragging ? 'border-brand-500 bg-brand-50' : 'border-neutral-300',
              )}
            >
              <UploadCloud className="size-8 text-neutral-400" aria-hidden="true" />
              <p className="mt-3 text-sm text-neutral-700">Drag and drop a video here, or</p>
              <Button
                variant="secondary"
                className="mt-3"
                onClick={() => fileInput.current?.click()}
              >
                Choose file
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept="video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi,.mpeg,.mpg,.3gp"
                className="sr-only"
                onChange={onPick}
                aria-label="Choose a video file"
              />
              <p className="mt-3 text-xs text-neutral-500">
                MP4, MOV, WebM, MKV, AVI, MPEG or 3GP · up to {maxUploadSizeMb} MB
              </p>
              {upload.state === 'error' ? (
                <Alert tone="error" className="mt-4 w-full text-left">
                  {upload.message}
                </Alert>
              ) : null}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Step 2: common metadata */}
      <Card>
        <CardHeader>
          <CardTitle>2. Details</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={500}
              placeholder="Used by YouTube and Facebook"
            />
          </div>
          <div>
            <Label htmlFor="caption">Caption</Label>
            <Textarea
              id="caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              maxLength={5000}
              placeholder="Used by Instagram and Facebook"
            />
          </div>
          <div>
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={10000}
              placeholder="Used by YouTube"
            />
          </div>
        </CardBody>
      </Card>

      {/* Step 3: destinations */}
      <Card>
        <CardHeader>
          <CardTitle>3. Destinations</CardTitle>
          <span className="text-sm text-neutral-500">{selected.size} selected</span>
        </CardHeader>
        {grouped.length === 0 ? (
          <CardBody>
            <p className="text-sm text-neutral-500">
              No enabled accounts.{' '}
              <Link href="/accounts" className="text-brand-600 hover:underline">
                Connect or enable one
              </Link>{' '}
              first.
            </p>
          </CardBody>
        ) : (
          <div className="divide-y divide-neutral-200">
            {grouped.map(([platform, list]) => {
              const allSelected = list.every((account) => selected.has(account.id));
              const someSelected = list.some((account) => selected.has(account.id));
              return (
                <fieldset key={platform} className="px-5 py-4">
                  <legend className="sr-only">{platformLabel(platform)} accounts</legend>
                  <div className="mb-2 flex items-center gap-3">
                    <Checkbox
                      checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                      onCheckedChange={(checked) => togglePlatform(platform, checked === true)}
                      aria-label={`Select all ${platformLabel(platform)} accounts`}
                    />
                    <PlatformBadge platform={platform} />
                  </div>
                  <ul className="ml-8 space-y-2">
                    {list.map((account) => {
                      const problem = error?.details?.find((d) => d.socialAccountId === account.id);
                      return (
                        <li key={account.id}>
                          <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-neutral-50">
                            <Checkbox
                              checked={selected.has(account.id)}
                              onCheckedChange={(checked) =>
                                toggleAccount(account.id, checked === true)
                              }
                            />
                            <AccountAvatar
                              name={account.displayName}
                              url={account.avatarUrl}
                              className="size-7 text-xs"
                            />
                            <span className="text-sm">{account.displayName}</span>
                            {account.username ? (
                              <span className="text-xs text-neutral-500">{account.username}</span>
                            ) : null}
                          </label>
                          {problem ? (
                            <p className="ml-9 text-xs text-red-700">{problem.message}</p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              );
            })}
          </div>
        )}
      </Card>

      {/* Step 4: platform-specific settings */}
      {selectedPlatforms.some(
        (platform) => (providerByPlatform.get(platform)?.settingsFields.length ?? 0) > 0,
      ) ? (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>4. Platform settings</CardTitle>
              <p className="mt-0.5 text-sm text-neutral-500">
                Applied to every selected account of that platform. Empty fields fall back to the
                details above.
              </p>
            </div>
          </CardHeader>
          <div className="divide-y divide-neutral-200">
            {selectedPlatforms.map((platform) => {
              const provider = providerByPlatform.get(platform);
              if (!provider || provider.settingsFields.length === 0) return null;
              return (
                <div key={platform} className="px-5 py-4">
                  <PlatformBadge platform={platform} className="mb-3" />
                  <div className="grid gap-4 md:grid-cols-2">
                    {provider.settingsFields.map((field) => (
                      <SettingsFieldInput
                        key={field.key}
                        platform={platform}
                        field={field}
                        value={settings[platform]?.[field.key]}
                        onChange={(value) => setSetting(platform, field.key, value)}
                      />
                    ))}
                  </div>
                  {provider.notes.length > 0 ? (
                    <ul className="mt-3 list-disc pl-4 text-xs text-neutral-500">
                      {provider.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      {error ? (
        <Alert tone="error" title={error.message}>
          {error.details ? 'Fix the highlighted destinations and try again.' : null}
        </Alert>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        {upload.state !== 'done' ? (
          <span className="text-sm text-neutral-500">Upload a video to continue</span>
        ) : null}
        <Button size="lg" onClick={publish} disabled={!canPublish} loading={submitting}>
          Publish to {selected.size} account{selected.size === 1 ? '' : 's'}
        </Button>
      </div>
    </div>
  );
}

function SettingsFieldInput({
  platform,
  field,
  value,
  onChange,
}: {
  platform: string;
  field: SettingsField;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  const id = `${platform}-${field.key}`;
  if (field.type === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-4 rounded-md border border-neutral-200 px-3 py-2">
        <div>
          <Label htmlFor={id} className="mb-0">
            {field.label}
          </Label>
          {field.description ? <FieldHint>{field.description}</FieldHint> : null}
        </div>
        <Switch
          id={id}
          checked={typeof value === 'boolean' ? value : (field.default ?? false)}
          onCheckedChange={onChange}
        />
      </div>
    );
  }
  if (field.type === 'select') {
    return (
      <div>
        <Label htmlFor={id}>{field.label}</Label>
        <Select
          id={id}
          value={typeof value === 'string' ? value : (field.default ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        {field.description ? <FieldHint>{field.description}</FieldHint> : null}
      </div>
    );
  }
  const common = {
    id,
    value: typeof value === 'string' ? value : '',
    maxLength: field.maxLength,
    placeholder: field.placeholder,
  };
  return (
    <div className={field.type === 'textarea' ? 'md:col-span-2' : undefined}>
      <Label htmlFor={id}>{field.label}</Label>
      {field.type === 'textarea' ? (
        <Textarea {...common} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input {...common} onChange={(e) => onChange(e.target.value)} />
      )}
      {field.description ? <FieldHint>{field.description}</FieldHint> : null}
    </div>
  );
}

/** Drop empty strings so providers fall back to the common post fields; fill defaults for booleans/selects. */
function buildSettings(
  provider: ProviderInfoDto | undefined,
  values: Record<string, string | boolean> | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of provider?.settingsFields ?? []) {
    const value = values?.[field.key];
    if (field.type === 'boolean') {
      result[field.key] = typeof value === 'boolean' ? value : (field.default ?? false);
    } else if (field.type === 'select') {
      const chosen = typeof value === 'string' ? value : (field.default ?? '');
      if (chosen !== '') result[field.key] = chosen;
    } else if (typeof value === 'string' && value.trim() !== '') {
      result[field.key] = value;
    }
  }
  return result;
}
