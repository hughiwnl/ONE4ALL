/**
 * Normalized error model for every provider.
 *
 * The publishing engine decides whether to retry a destination purely from
 * `retryable`, and shows `code`/`message` to the user. Providers translate their
 * platform-specific failures into this shape in `normalizeError()`.
 */

export const ProviderErrorCode = {
  // Retryable (transient)
  NETWORK: 'network_error',
  TIMEOUT: 'timeout',
  RATE_LIMITED: 'rate_limited',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  PROCESSING_TIMEOUT: 'processing_timeout',

  // Permanent (require user action or are unfixable by retrying)
  NOT_CONFIGURED: 'provider_not_configured',
  TOKEN_EXPIRED: 'token_expired',
  TOKEN_REVOKED: 'token_revoked',
  INSUFFICIENT_PERMISSIONS: 'insufficient_permissions',
  UNSUPPORTED_ACCOUNT: 'unsupported_account',
  INVALID_MEDIA: 'invalid_media',
  MEDIA_REJECTED: 'media_rejected',
  INVALID_SETTINGS: 'invalid_settings',
  QUOTA_EXCEEDED: 'quota_exceeded',
  ACCOUNT_DISCONNECTED: 'account_disconnected',
  UNKNOWN: 'unknown_error',
} as const;

export type ProviderErrorCode = (typeof ProviderErrorCode)[keyof typeof ProviderErrorCode];

export interface ProviderErrorOptions {
  /** One of ProviderErrorCode, or a provider-specific code. */
  code: string;
  message: string;
  /** Whether the publishing engine should retry with backoff. */
  retryable: boolean;
  /** Provider hint for the minimum delay before retrying (e.g. from Retry-After). */
  retryAfterMs?: number;
  /** Safe-to-log, non-sensitive diagnostic details (HTTP status, provider error id...). */
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class ProviderError extends Error {
  /** Structural marker so checks work across bundle boundaries (see isProviderError). */
  readonly isProviderError = true as const;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(options: ProviderErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'ProviderError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details;
  }

  static retryable(
    code: string,
    message: string,
    extra: Partial<ProviderErrorOptions> = {},
  ): ProviderError {
    return new ProviderError({ ...extra, code, message, retryable: true });
  }

  static permanent(
    code: string,
    message: string,
    extra: Partial<ProviderErrorOptions> = {},
  ): ProviderError {
    return new ProviderError({ ...extra, code, message, retryable: false });
  }

  toJSON(): {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

/** Structural check (not only `instanceof`) so it also works across duplicated bundles. */
export function isProviderError(error: unknown): error is ProviderError {
  if (error instanceof ProviderError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { isProviderError?: unknown }).isProviderError === true &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { retryable?: unknown }).retryable === 'boolean'
  );
}

/**
 * Conservative default classification of an HTTP status code.
 * Providers refine this with platform-specific knowledge.
 */
export function classifyHttpStatus(status: number): {
  code: ProviderErrorCode;
  retryable: boolean;
} {
  if (status === 429) return { code: ProviderErrorCode.RATE_LIMITED, retryable: true };
  if (status === 401) return { code: ProviderErrorCode.TOKEN_EXPIRED, retryable: false };
  if (status === 403) return { code: ProviderErrorCode.INSUFFICIENT_PERMISSIONS, retryable: false };
  if (status === 408) return { code: ProviderErrorCode.TIMEOUT, retryable: true };
  if (status >= 500) return { code: ProviderErrorCode.PROVIDER_UNAVAILABLE, retryable: true };
  return { code: ProviderErrorCode.UNKNOWN, retryable: false };
}

/**
 * Fallback normalization used by the engine when a provider throws something
 * that is not already a ProviderError. Network-ish errors are retryable; the
 * rest is treated as permanent so we never retry forever on a real bug.
 */
export function normalizeUnknownError(error: unknown): ProviderError {
  if (isProviderError(error)) return error;

  if (error instanceof Error) {
    const name = error.name;
    const message = error.message;
    const causeCode = (error.cause as { code?: string } | undefined)?.code;
    const networkCodes = new Set([
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EPIPE',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
    ]);
    if (name === 'AbortError' || name === 'TimeoutError') {
      return ProviderError.retryable(ProviderErrorCode.TIMEOUT, `Request timed out: ${message}`, {
        cause: error,
      });
    }
    if ((causeCode && networkCodes.has(causeCode)) || /fetch failed|network/i.test(message)) {
      return ProviderError.retryable(ProviderErrorCode.NETWORK, `Network error: ${message}`, {
        cause: error,
        details: causeCode ? { causeCode } : undefined,
      });
    }
    return ProviderError.permanent(ProviderErrorCode.UNKNOWN, message || 'Unknown error', {
      cause: error,
    });
  }

  return ProviderError.permanent(
    ProviderErrorCode.UNKNOWN,
    typeof error === 'string' ? error : 'Unknown error',
  );
}
