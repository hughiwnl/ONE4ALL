import { ProviderError, ProviderErrorCode } from './errors.js';

export interface JsonRequestOptions extends Omit<RequestInit, 'body' | 'signal'> {
  body?: unknown;
  /** Send `body` as application/x-www-form-urlencoded instead of JSON. */
  form?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export interface JsonResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Headers;
  /** Parsed JSON body, or the raw text when the response is not JSON. */
  body: T;
  text: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Small fetch wrapper used by providers: applies a timeout, parses JSON, and
 * converts transport failures into retryable ProviderErrors. It never throws
 * on non-2xx responses; providers inspect `status`/`body` and decide.
 */
export async function requestJson<T = unknown>(
  url: string,
  options: JsonRequestOptions = {},
): Promise<JsonResponse<T>> {
  const {
    body,
    form,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    fetch: fetchImpl = fetch,
    headers,
    ...rest
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(new Error(`Request to ${new URL(url).host} timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const onOuterAbort = () => controller.abort(signal?.reason as Error | undefined);
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  const init: RequestInit = { ...rest, signal: controller.signal, headers: new Headers(headers) };
  const initHeaders = init.headers as Headers;
  if (form) {
    initHeaders.set('content-type', 'application/x-www-form-urlencoded');
    init.body = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    initHeaders.set('content-type', 'application/json');
    init.body = JSON.stringify(body);
  }
  if (!initHeaders.has('accept')) initHeaders.set('accept', 'application/json');

  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw ProviderError.retryable(
        ProviderErrorCode.TIMEOUT,
        `Request to ${new URL(url).host} timed out`,
        { cause: error },
      );
    }
    throw ProviderError.retryable(
      ProviderErrorCode.NETWORK,
      `Network error calling ${new URL(url).host}`,
      {
        cause: error,
        details: { causeCode: (error as { cause?: { code?: string } })?.cause?.code },
      },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }

  const text = await response.text();
  let parsed: unknown = text;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  } else {
    parsed = null;
  }

  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    body: parsed as T,
    text,
  };
}

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}
