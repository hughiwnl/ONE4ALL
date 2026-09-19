'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  checkMediaCompatibility,
  MAX_POST_MEDIA_ITEMS,
  type MediaDto,
  type ProviderInfoDto,
  type SettingsField,
  type SocialAccountDto,
} from '@repeat/types';
import { AccountAvatar, PlatformBadge } from '@/components/platform-badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { FieldHint, Input, Label, Select, Textarea } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api-client';
import { formatBytes, platformLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import { MediaPicker, type PickedItem } from './media-picker';

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
  const [items, setItems] = useState<PickedItem[]>([]);
  const [pickError, setPickError] = useState<string | null>(null);
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
  const keyCounter = useRef(0);

  // Release image previews when the page goes away.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(
    () => () => {
      for (const item of itemsRef.current)
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    },
    [],
  );

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

  const readyMedia: MediaDto[] = useMemo(
    () => items.flatMap((item) => (item.state === 'done' ? [item.media] : [])),
    [items],
  );
  const allUploaded = items.length > 0 && items.every((item) => item.state === 'done');

  // Accounts whose platform cannot take this media (e.g. YouTube and an image).
  // They stay selected in state, so removing the offending file brings them back.
  const incompatible = useMemo(() => {
    const reasons = new Map<string, string>();
    if (readyMedia.length === 0) return reasons;
    for (const account of accounts) {
      const provider = providerByPlatform.get(account.platform);
      const reason = provider ? checkMediaCompatibility(provider, readyMedia) : null;
      if (reason) reasons.set(account.id, reason);
    }
    return reasons;
  }, [accounts, providerByPlatform, readyMedia]);

  const effectiveSelected = useMemo(
    () => accounts.filter((account) => selected.has(account.id) && !incompatible.has(account.id)),
    [accounts, selected, incompatible],
  );
  const selectedPlatforms = useMemo(
    () => [...new Set(effectiveSelected.map((account) => account.platform))],
    [effectiveSelected],
  );

  function updateItem(key: string, update: (item: PickedItem) => PickedItem) {
    setItems((current) => current.map((item) => (item.key === key ? update(item) : item)));
  }

  function addFiles(files: File[]) {
    setPickError(null);
    const room = MAX_POST_MEDIA_ITEMS - items.length;
    if (files.length > room) {
      setPickError(
        `A post can contain at most ${MAX_POST_MEDIA_ITEMS} items; only the first ${room} were added.`,
      );
    }
    const added: PickedItem[] = [];
    for (const file of files.slice(0, Math.max(0, room))) {
      keyCounter.current += 1;
      const key = `item-${keyCounter.current}`;
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      if (file.size > maxUploadSizeMb * 1024 * 1024) {
        added.push({
          key,
          file,
          previewUrl,
          state: 'error',
          message: `${formatBytes(file.size)} is over the ${maxUploadSizeMb} MB limit.`,
        });
        continue;
      }
      const controller = new AbortController();
      added.push({ key, file, previewUrl, state: 'uploading', percent: 0, controller });
      api.media
        .upload(
          file,
          (percent) =>
            updateItem(key, (item) => (item.state === 'uploading' ? { ...item, percent } : item)),
          controller.signal,
        )
        .then((media) =>
          updateItem(key, (item) => ({
            key,
            file,
            previewUrl: item.previewUrl,
            state: 'done',
            media,
          })),
        )
        .catch((err: unknown) =>
          updateItem(key, (item) => ({
            key,
            file,
            previewUrl: item.previewUrl,
            state: 'error',
            message: err instanceof ApiError ? err.message : 'Upload failed',
          })),
        );
    }
    setItems((current) => [...current, ...added]);
  }

  function removeItem(key: string) {
    setItems((current) => {
      const item = current.find((entry) => entry.key === key);
      if (item?.state === 'uploading') item.controller.abort();
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return current.filter((entry) => entry.key !== key);
    });
  }

  function moveItem(key: string, direction: -1 | 1) {
    setItems((current) => {
      const index = current.findIndex((item) => item.key === key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
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
        if (account.platform !== platform || incompatible.has(account.id)) continue;
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
    if (!allUploaded || effectiveSelected.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const destinations = effectiveSelected.map((account) => ({
        socialAccountId: account.id,
        settings: buildSettings(
          providerByPlatform.get(account.platform),
          settings[account.platform],
        ),
      }));
      const { post } = await api.posts.create({
        mediaIds: readyMedia.map((media) => media.id),
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

  const canPublish = allUploaded && effectiveSelected.length > 0 && !submitting;
  const count = effectiveSelected.length;
  const kindLabel =
    readyMedia.length > 1
      ? `carousel of ${readyMedia.length}`
      : readyMedia[0]?.kind === 'image'
        ? 'image'
        : 'video';

  return (
    <div className="space-y-6">
      {/* Step 1: media */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>1. Media</CardTitle>
            <p className="mt-0.5 text-sm text-neutral-500">
              One video, one image, or up to {MAX_POST_MEDIA_ITEMS} items for a carousel.
            </p>
          </div>
        </CardHeader>
        <CardBody>
          <MediaPicker
            items={items}
            maxUploadSizeMb={maxUploadSizeMb}
            onAdd={addFiles}
            onRemove={removeItem}
            onMove={moveItem}
          />
          {pickError ? (
            <Alert tone="warning" className="mt-3">
              {pickError}
            </Alert>
          ) : null}
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
              placeholder="Used by Instagram, Facebook and TikTok"
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
          <span className="text-sm text-neutral-500">{count} selected</span>
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
              const usable = list.filter((account) => !incompatible.has(account.id));
              const allSelected =
                usable.length > 0 && usable.every((account) => selected.has(account.id));
              const someSelected = usable.some((account) => selected.has(account.id));
              const platformReason =
                usable.length === 0 ? incompatible.get(list[0]!.id) : undefined;
              return (
                <fieldset key={platform} className="px-5 py-4">
                  <legend className="sr-only">{platformLabel(platform)} accounts</legend>
                  <div className="mb-2 flex flex-wrap items-center gap-3">
                    <Checkbox
                      checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                      onCheckedChange={(checked) => togglePlatform(platform, checked === true)}
                      disabled={usable.length === 0}
                      aria-label={`Select all ${platformLabel(platform)} accounts`}
                    />
                    <PlatformBadge
                      platform={platform}
                      className={cn(platformReason && 'opacity-50')}
                    />
                    {platformReason ? (
                      <span className="text-xs text-neutral-500">{platformReason}</span>
                    ) : null}
                  </div>
                  <ul className="ml-8 space-y-2">
                    {list.map((account) => {
                      const problem = error?.details?.find((d) => d.socialAccountId === account.id);
                      const reason = incompatible.get(account.id);
                      return (
                        <li key={account.id}>
                          <label
                            className={cn(
                              'flex items-center gap-3 rounded-md px-2 py-1.5',
                              reason
                                ? 'cursor-not-allowed opacity-50'
                                : 'cursor-pointer hover:bg-neutral-50',
                            )}
                            title={reason}
                          >
                            <Checkbox
                              checked={selected.has(account.id) && !reason}
                              disabled={Boolean(reason)}
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
                          {reason && !platformReason ? (
                            <p className="ml-9 text-xs text-neutral-500">{reason}</p>
                          ) : null}
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
        {items.length === 0 ? (
          <span className="text-sm text-neutral-500">Add a video or image to continue</span>
        ) : !allUploaded ? (
          <span className="text-sm text-neutral-500">
            {items.some((item) => item.state === 'error')
              ? 'Remove the files that failed to upload'
              : 'Waiting for uploads to finish…'}
          </span>
        ) : (
          <span className="text-sm text-neutral-500">Posting a {kindLabel}</span>
        )}
        <Button size="lg" onClick={publish} disabled={!canPublish} loading={submitting}>
          Publish to {count} account{count === 1 ? '' : 's'}
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
