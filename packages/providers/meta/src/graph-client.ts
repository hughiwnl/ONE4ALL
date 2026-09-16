import { createHmac } from 'node:crypto';
import { requestJson, type JsonResponse, type ProviderContext } from '@repeat/provider-sdk';
import { errorFromGraphResponse, type GraphErrorBody } from './errors.js';

export interface GraphClientOptions {
  appSecret: string;
  apiVersion: string;
  /** Override for tests. */
  baseUrl?: string;
  videoBaseUrl?: string;
}

/**
 * Thin Graph API client shared by the Meta connector and publishers.
 * Every call carries `appsecret_proof`, which Meta recommends (and lets apps
 * require) for server-to-server calls.
 */
export class GraphClient {
  private readonly baseUrl: string;
  private readonly videoBaseUrl: string;

  constructor(private readonly options: GraphClientOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://graph.facebook.com') + `/${options.apiVersion}`;
    this.videoBaseUrl =
      (options.videoBaseUrl ?? 'https://graph-video.facebook.com') + `/${options.apiVersion}`;
  }

  get apiVersion(): string {
    return this.options.apiVersion;
  }

  async get<T>(
    path: string,
    params: Record<string, string>,
    accessToken: string,
    ctx: ProviderContext,
    context = path,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\//, '')}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    this.applyAuth(url.searchParams, accessToken);
    const response = await requestJson<T & GraphErrorBody>(url.toString(), {
      fetch: ctx.fetch,
      signal: ctx.signal,
    });
    return this.unwrap(response, context);
  }

  async post<T>(
    path: string,
    params: Record<string, string>,
    accessToken: string,
    ctx: ProviderContext,
    context = path,
  ): Promise<T> {
    const form = new URLSearchParams(params);
    this.applyAuth(form, accessToken);
    const response = await requestJson<T & GraphErrorBody>(
      `${this.baseUrl}/${path.replace(/^\//, '')}`,
      {
        method: 'POST',
        form: Object.fromEntries(form),
        fetch: ctx.fetch,
        signal: ctx.signal,
        timeoutMs: 120_000,
      },
    );
    return this.unwrap(response, context);
  }

  /** Multipart POST against graph-video.facebook.com (chunked video upload). */
  async postVideoMultipart<T>(
    path: string,
    form: FormData,
    accessToken: string,
    ctx: ProviderContext,
    context = path,
  ): Promise<T> {
    form.set('access_token', accessToken);
    form.set('appsecret_proof', this.proof(accessToken));
    const fetchImpl = ctx.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${this.videoBaseUrl}/${path.replace(/^\//, '')}`, {
        method: 'POST',
        body: form,
        signal: ctx.signal,
      });
    } catch (error) {
      throw errorFromGraphResponse(
        { status: 0, ok: false, headers: new Headers(), body: null, text: '' },
        `${context}: ${String(error)}`,
      );
    }
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return this.unwrap(
      {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        body: body as T & GraphErrorBody,
        text,
      },
      context,
    );
  }

  /** Long-lived and page tokens are looked up through a token-less exchange; expose the plain URL builder for those. */
  url(path: string): string {
    return `${this.baseUrl}/${path.replace(/^\//, '')}`;
  }

  proof(accessToken: string): string {
    return createHmac('sha256', this.options.appSecret).update(accessToken).digest('hex');
  }

  private applyAuth(params: URLSearchParams, accessToken: string): void {
    params.set('access_token', accessToken);
    params.set('appsecret_proof', this.proof(accessToken));
  }

  private unwrap<T>(response: JsonResponse<T & GraphErrorBody>, context: string): T {
    if (
      !response.ok ||
      (response.body &&
        typeof response.body === 'object' &&
        'error' in response.body &&
        response.body.error)
    ) {
      throw errorFromGraphResponse(response, context);
    }
    return response.body;
  }
}
