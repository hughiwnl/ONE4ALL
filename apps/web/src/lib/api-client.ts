'use client';

import type {
  ApiErrorBody,
  CompleteConnectionRequest,
  ConnectMockAccountRequest,
  ConnectableAccountDto,
  CreatePostRequest,
  MediaDto,
  PostDestinationDto,
  PostDto,
  PostSummaryDto,
  ProviderInfoDto,
  SocialAccountDto,
  UserDto,
} from '@repeat/types';

/**
 * Typed browser client for the HTTP API. A future mobile app would ship an
 * equivalent client against the same contracts in @repeat/types.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    credentials: 'same-origin',
  });
  if (!response.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(
      response.status,
      body?.error.code ?? 'http_error',
      body?.error.message ?? `Request failed (${response.status})`,
      body?.error.details,
    );
  }
  return (await response.json()) as T;
}

export const api = {
  auth: {
    login: (body: { email: string; password: string }) =>
      request<{ user: UserDto }>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
    register: (body: { email: string; password: string; name?: string }) =>
      request<{ user: UserDto }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  },
  providers: {
    list: () =>
      request<{
        providers: ProviderInfoDto[];
        unconfigured: { platform: string; displayName: string; reason: string }[];
      }>('/api/providers'),
  },
  accounts: {
    list: (enabledOnly = false) =>
      request<{ accounts: SocialAccountDto[] }>(
        `/api/accounts${enabledOnly ? '?enabled=true' : ''}`,
      ),
    setEnabled: (id: string, enabled: boolean) =>
      request<{ account: SocialAccountDto }>(`/api/accounts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    disconnect: (id: string) => request<{ ok: true }>(`/api/accounts/${id}`, { method: 'DELETE' }),
    connectMock: (body: ConnectMockAccountRequest) =>
      request<{ account: SocialAccountDto }>('/api/connect/mock', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    pending: (connector: string, id: string) =>
      request<{
        pendingConnectionId: string;
        connectorId: string;
        accounts: ConnectableAccountDto[];
      }>(`/api/connect/${connector}/pending/${id}`),
    complete: (connector: string, body: CompleteConnectionRequest) =>
      request<{ created: SocialAccountDto[]; updated: SocialAccountDto[] }>(
        `/api/connect/${connector}/complete`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
  },
  media: {
    /** Streams the file with upload progress (XHR is the only browser API exposing it). */
    upload: (file: File, onProgress: (percent: number) => void, signal?: AbortSignal) =>
      new Promise<MediaDto>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/media');
        xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
        xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
        xhr.setRequestHeader('accept', 'application/json');
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
        };
        xhr.onload = () => {
          let body: unknown = null;
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            /* ignore */
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve((body as { media: MediaDto }).media);
          } else {
            const error = (body as ApiErrorBody | null)?.error;
            reject(
              new ApiError(
                xhr.status,
                error?.code ?? 'upload_failed',
                error?.message ?? `Upload failed (${xhr.status})`,
                error?.details,
              ),
            );
          }
        };
        xhr.onerror = () =>
          reject(new ApiError(0, 'network_error', 'Upload failed: network error'));
        xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload canceled'));
        signal?.addEventListener('abort', () => xhr.abort(), { once: true });
        xhr.send(file);
      }),
  },
  posts: {
    create: (body: CreatePostRequest) =>
      request<{ post: PostDto }>('/api/posts', { method: 'POST', body: JSON.stringify(body) }),
    get: (id: string) => request<{ post: PostDto }>(`/api/posts/${id}`),
    list: (cursor?: string) =>
      request<{ items: PostSummaryDto[]; nextCursor: string | null }>(
        `/api/posts${cursor ? `?cursor=${cursor}` : ''}`,
      ),
    retry: (postId: string, destinationId: string) =>
      request<{ destination: PostDestinationDto }>(
        `/api/posts/${postId}/destinations/${destinationId}/retry`,
        { method: 'POST' },
      ),
    cancel: (postId: string, destinationId: string) =>
      request<{ destination: PostDestinationDto }>(
        `/api/posts/${postId}/destinations/${destinationId}/cancel`,
        { method: 'POST' },
      ),
  },
};
