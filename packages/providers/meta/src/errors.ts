import {
  classifyHttpStatus,
  normalizeUnknownError,
  ProviderError,
  ProviderErrorCode,
  type JsonResponse,
} from '@repeat/provider-sdk';

export interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_title?: string;
    error_user_msg?: string;
    is_transient?: boolean;
    fbtrace_id?: string;
  };
}

/**
 * Map a Graph API error to a ProviderError.
 * https://developers.facebook.com/docs/graph-api/guides/error-handling
 */
export function errorFromGraphResponse(
  response: JsonResponse<unknown>,
  context: string,
): ProviderError {
  const body =
    typeof response.body === 'object' && response.body ? (response.body as GraphErrorBody) : null;
  const error = body?.error;
  const code = error?.code;
  const subcode = error?.error_subcode;
  const message =
    error?.error_user_msg ??
    error?.message ??
    (typeof response.body === 'string' ? response.body.slice(0, 200) : `HTTP ${response.status}`);
  const details = {
    status: response.status,
    code,
    subcode,
    type: error?.type,
    fbtrace_id: error?.fbtrace_id,
    context,
  };
  const text = `Meta API error (${context}): ${message}`;

  if (error?.is_transient) {
    return ProviderError.retryable(ProviderErrorCode.PROVIDER_UNAVAILABLE, text, { details });
  }

  if (code === 10 || (code !== undefined && code >= 200 && code <= 299)) {
    return ProviderError.permanent(
      ProviderErrorCode.INSUFFICIENT_PERMISSIONS,
      `Meta refused the request (missing permission or app review): ${message}`,
      { details },
    );
  }

  switch (code) {
    case 190: // invalid/expired OAuth token
      return ProviderError.permanent(
        subcode === 460 || subcode === 458
          ? ProviderErrorCode.TOKEN_REVOKED
          : ProviderErrorCode.TOKEN_EXPIRED,
        'The Meta access token is no longer valid. Reconnect this account.',
        { details },
      );
    case 102: // session invalid
      return ProviderError.permanent(
        ProviderErrorCode.TOKEN_EXPIRED,
        'The Meta session is invalid. Reconnect this account.',
        { details },
      );
    case 4: // app rate limit
    case 17: // user rate limit
    case 32: // page rate limit
    case 613: // custom rate limit
    case 80001:
    case 80002:
    case 80003:
    case 80004:
    case 80005:
    case 80006:
    case 80008: // BUC rate limits
      return ProviderError.retryable(
        ProviderErrorCode.RATE_LIMITED,
        `Meta rate limit reached: ${message}`,
        { details, retryAfterMs: 15 * 60_000 },
      );
    case 1: // unknown/transient
    case 2: // service temporarily unavailable
      return ProviderError.retryable(ProviderErrorCode.PROVIDER_UNAVAILABLE, text, { details });
    case 368: // temporarily blocked for policy violations
      return ProviderError.permanent(
        ProviderErrorCode.MEDIA_REJECTED,
        `Meta blocked this action: ${message}`,
        { details },
      );
    case 9007: // IG: media not ready (used when publishing too early)
      return ProviderError.retryable(
        ProviderErrorCode.PROVIDER_UNAVAILABLE,
        'Instagram media container is not ready yet',
        { details, retryAfterMs: 15_000 },
      );
    case 9004: // IG: media download failed
      return ProviderError.permanent(
        ProviderErrorCode.INVALID_MEDIA,
        'Instagram could not download the video from this server. APP_URL must be a publicly reachable HTTPS address.',
        { details },
      );
    case 36000:
    case 36001:
    case 36003:
    case 36004: // IG media format issues
    case 2207026:
    case 2207032:
    case 2207051:
    case 2207052:
    case 2207053:
    case 2207057:
    case 2207067:
      return ProviderError.permanent(
        ProviderErrorCode.INVALID_MEDIA,
        `Instagram rejected the media: ${message}`,
        { details },
      );
    case 100: // invalid parameter
      return ProviderError.permanent(ProviderErrorCode.INVALID_SETTINGS, text, { details });
    default:
      break;
  }

  const classified = classifyHttpStatus(response.status);
  return new ProviderError({
    code: classified.code,
    retryable: classified.retryable,
    message: text,
    details,
  });
}

export function normalizeMetaError(error: unknown): ProviderError {
  return normalizeUnknownError(error);
}
