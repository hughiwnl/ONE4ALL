import {
  classifyHttpStatus,
  normalizeUnknownError,
  ProviderError,
  ProviderErrorCode,
  type JsonResponse,
} from '@repeat/provider-sdk';

interface GoogleErrorBody {
  error?:
    | string
    | {
        code?: number;
        message?: string;
        status?: string;
        errors?: { reason?: string; message?: string; domain?: string }[];
      };
  error_description?: string;
}

/**
 * Map a non-2xx Google/YouTube API response to a ProviderError.
 * Reason codes: https://developers.google.com/youtube/v3/docs/errors
 */
export function errorFromGoogleResponse(
  response: JsonResponse<unknown>,
  context: string,
): ProviderError {
  const body =
    typeof response.body === 'object' && response.body ? (response.body as GoogleErrorBody) : null;
  const errorObject = body && typeof body.error === 'object' ? body.error : null;
  const reason = errorObject?.errors?.[0]?.reason;
  const message =
    errorObject?.message ??
    (body && typeof body.error === 'string'
      ? `${body.error}${body.error_description ? `: ${body.error_description}` : ''}`
      : null) ??
    (typeof response.body === 'string' && response.body
      ? response.body.slice(0, 200)
      : `HTTP ${response.status}`);
  const details = { status: response.status, reason, context };

  // OAuth token endpoint errors
  if (body && typeof body.error === 'string') {
    if (body.error === 'invalid_grant') {
      return ProviderError.permanent(
        ProviderErrorCode.TOKEN_REVOKED,
        'Google access was revoked or expired. Reconnect this YouTube channel.',
        { details },
      );
    }
    if (body.error === 'invalid_client') {
      return ProviderError.permanent(
        ProviderErrorCode.NOT_CONFIGURED,
        'GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are invalid.',
        { details },
      );
    }
  }

  switch (reason) {
    case 'quotaExceeded':
    case 'dailyLimitExceeded':
    case 'userRateLimitExceeded':
      return ProviderError.permanent(
        ProviderErrorCode.QUOTA_EXCEEDED,
        'YouTube Data API quota exceeded for this project. Quota resets daily (Pacific time); each upload costs ~1,600 units.',
        { details },
      );
    case 'rateLimitExceeded':
      return ProviderError.retryable(
        ProviderErrorCode.RATE_LIMITED,
        'YouTube rate limit hit; retrying later.',
        { details, retryAfterMs: 60_000 },
      );
    case 'uploadLimitExceeded':
      return ProviderError.permanent(
        ProviderErrorCode.QUOTA_EXCEEDED,
        'This channel has exceeded its upload limit for today.',
        { details },
      );
    case 'authError':
    case 'invalidCredentials':
    case 'authorizationRequired':
      return ProviderError.permanent(
        ProviderErrorCode.TOKEN_EXPIRED,
        'YouTube credentials are no longer valid. Reconnect this channel.',
        { details },
      );
    case 'forbidden':
    case 'insufficientPermissions':
    case 'insufficientAuthorizedScopes':
      return ProviderError.permanent(
        ProviderErrorCode.INSUFFICIENT_PERMISSIONS,
        `YouTube refused the request: ${message}`,
        { details },
      );
    case 'youtubeSignupRequired':
    case 'channelNotFound':
      return ProviderError.permanent(
        ProviderErrorCode.UNSUPPORTED_ACCOUNT,
        'This Google account has no YouTube channel.',
        { details },
      );
    case 'invalidVideoMetadata':
    case 'invalidTitle':
    case 'invalidDescription':
    case 'invalidTags':
    case 'invalidCategoryId':
      return ProviderError.permanent(
        ProviderErrorCode.INVALID_SETTINGS,
        `YouTube rejected the metadata: ${message}`,
        { details },
      );
    case 'mediaBodyRequired':
    case 'invalidFilename':
      return ProviderError.permanent(
        ProviderErrorCode.INVALID_MEDIA,
        `YouTube rejected the media: ${message}`,
        { details },
      );
    case 'backendError':
    case 'internalError':
      return ProviderError.retryable(
        ProviderErrorCode.PROVIDER_UNAVAILABLE,
        `YouTube backend error: ${message}`,
        { details },
      );
    default:
      break;
  }

  const classified = classifyHttpStatus(response.status);
  if (response.status === 401) {
    return ProviderError.permanent(
      ProviderErrorCode.TOKEN_EXPIRED,
      'YouTube credentials are no longer valid. Reconnect this channel.',
      { details },
    );
  }
  return new ProviderError({
    code: classified.code,
    retryable: classified.retryable,
    message: `YouTube API error (${context}): ${message}`,
    details,
  });
}

export function normalizeGoogleError(error: unknown): ProviderError {
  return normalizeUnknownError(error);
}
