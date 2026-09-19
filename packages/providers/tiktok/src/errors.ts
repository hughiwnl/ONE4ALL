import {
  classifyHttpStatus,
  ProviderError,
  ProviderErrorCode,
  type JsonResponse,
} from '@repeat/provider-sdk';

/** Error envelope of the TikTok v2 Open API: `{ data, error: { code, message, log_id } }`. */
export interface TikTokApiErrorBody {
  error?: { code?: string; message?: string; log_id?: string };
}

/** Error envelope of the OAuth token endpoint: `{ error, error_description, log_id }`. */
export interface TikTokTokenErrorBody {
  error?: string;
  error_description?: string;
  log_id?: string;
}

/**
 * Map a TikTok API or token endpoint failure to a ProviderError.
 * Codes: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 */
export function errorFromTikTokResponse(
  response: JsonResponse<unknown>,
  context: string,
): ProviderError {
  const body =
    typeof response.body === 'object' && response.body !== null
      ? (response.body as TikTokApiErrorBody & TikTokTokenErrorBody)
      : null;

  // OAuth token endpoint shape: `error` is a string.
  if (body && typeof body.error === 'string') {
    const details = { status: response.status, error: body.error, log_id: body.log_id, context };
    const description = body.error_description ?? body.error;
    if (body.error === 'invalid_grant') {
      return ProviderError.permanent(
        ProviderErrorCode.TOKEN_REVOKED,
        'TikTok access was revoked or has expired. Reconnect this TikTok account.',
        { details },
      );
    }
    if (body.error === 'invalid_client') {
      return ProviderError.permanent(
        ProviderErrorCode.NOT_CONFIGURED,
        'TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are invalid.',
        { details },
      );
    }
    if (body.error === 'invalid_request' || body.error === 'unauthorized_client') {
      return ProviderError.permanent(
        ProviderErrorCode.NOT_CONFIGURED,
        `TikTok rejected the request (${context}): ${description}`,
        { details },
      );
    }
    const classified = classifyHttpStatus(response.status);
    return new ProviderError({
      code: classified.code,
      retryable: classified.retryable,
      message: `TikTok error (${context}): ${description}`,
      details,
    });
  }

  const code = body?.error?.code;
  const apiMessage =
    body?.error?.message ||
    (typeof response.body === 'string' && response.body
      ? response.body.slice(0, 200)
      : `HTTP ${response.status}`);
  const details = { status: response.status, code, log_id: body?.error?.log_id, context };

  switch (code) {
    case 'access_token_invalid':
      return ProviderError.permanent(
        ProviderErrorCode.TOKEN_EXPIRED,
        'The TikTok access token is no longer valid. Reconnect this TikTok account.',
        { details },
      );
    case 'scope_not_authorized':
      return ProviderError.permanent(
        ProviderErrorCode.INSUFFICIENT_PERMISSIONS,
        'This TikTok account did not grant the video.publish permission. Reconnect it and accept all permissions.',
        { details },
      );
    case 'rate_limit_exceeded':
      return ProviderError.retryable(
        ProviderErrorCode.RATE_LIMITED,
        'TikTok rate limit reached; retrying later.',
        { details, retryAfterMs: 60_000 },
      );
    case 'spam_risk_too_many_posts':
      return ProviderError.permanent(
        ProviderErrorCode.QUOTA_EXCEEDED,
        'This TikTok account reached its daily limit of posts made through the API. Try again tomorrow.',
        { details },
      );
    case 'spam_risk_user_banned_from_posting':
      return ProviderError.permanent(
        ProviderErrorCode.UNSUPPORTED_ACCOUNT,
        'TikTok has blocked this account from posting.',
        { details },
      );
    case 'reached_active_user_cap':
      return ProviderError.permanent(
        ProviderErrorCode.QUOTA_EXCEEDED,
        'Your TikTok app reached its daily cap of posting users (unaudited apps allow 5 per 24 hours).',
        { details },
      );
    case 'unaudited_client_can_only_post_to_private_accounts':
      return ProviderError.permanent(
        ProviderErrorCode.INSUFFICIENT_PERMISSIONS,
        'Your TikTok app has not passed TikTok\'s audit yet, so it can only post with "Only me" visibility, and the TikTok account itself must be set to private.',
        { details },
      );
    case 'privacy_level_option_mismatch':
      return ProviderError.permanent(
        ProviderErrorCode.INVALID_SETTINGS,
        'The chosen TikTok visibility is not available for this account.',
        { details },
      );
    case 'invalid_param':
    case 'invalid_params':
      return ProviderError.permanent(
        ProviderErrorCode.INVALID_SETTINGS,
        `TikTok rejected the request (${context}): ${apiMessage}`,
        { details },
      );
    case 'internal_error':
      return ProviderError.retryable(
        ProviderErrorCode.PROVIDER_UNAVAILABLE,
        `TikTok internal error (${context}); retrying later.`,
        { details },
      );
    default:
      break;
  }

  const classified = classifyHttpStatus(response.status);
  return new ProviderError({
    code: classified.code,
    retryable: classified.retryable,
    message: `TikTok API error (${context}): ${apiMessage}`,
    details,
  });
}

/** Map a `fail_reason` from the post status endpoint to a ProviderError. */
export function errorFromTikTokFailReason(reason: string | undefined): ProviderError {
  const details = { fail_reason: reason };
  switch (reason) {
    case 'file_format_check_failed':
      return ProviderError.permanent(
        ProviderErrorCode.INVALID_MEDIA,
        'TikTok does not support this video format. Use MP4 (H.264) or MOV/WebM.',
        { details },
      );
    case 'duration_check_failed':
      return ProviderError.permanent(
        ProviderErrorCode.INVALID_MEDIA,
        'The video is too long or too short for this TikTok account.',
        { details },
      );
    case 'frame_rate_check_failed':
      return ProviderError.permanent(
        ProviderErrorCode.INVALID_MEDIA,
        'TikTok requires a frame rate between 23 and 60 fps.',
        { details },
      );
    case 'picture_size_check_failed':
      return ProviderError.permanent(
        ProviderErrorCode.INVALID_MEDIA,
        'TikTok requires a resolution between 360 and 4096 pixels on each side.',
        { details },
      );
    case 'auth_removed':
      return ProviderError.permanent(
        ProviderErrorCode.TOKEN_REVOKED,
        "The creator removed Repeat's access on TikTok. Reconnect the account.",
        { details },
      );
    case 'spam_risk_too_many_posts':
      return ProviderError.permanent(
        ProviderErrorCode.QUOTA_EXCEEDED,
        'This TikTok account reached its daily limit of posts made through the API.',
        { details },
      );
    case 'spam_risk_user_banned_from_posting':
      return ProviderError.permanent(
        ProviderErrorCode.UNSUPPORTED_ACCOUNT,
        'TikTok has blocked this account from posting.',
        { details },
      );
    case 'spam_risk_text':
      return ProviderError.permanent(
        ProviderErrorCode.MEDIA_REJECTED,
        'TikTok flagged the caption as risky. Edit it and publish again.',
        { details },
      );
    case 'spam_risk':
      return ProviderError.permanent(
        ProviderErrorCode.MEDIA_REJECTED,
        'TikTok flagged this post as risky and did not publish it.',
        { details },
      );
    case 'publish_cancelled':
      return ProviderError.permanent(
        ProviderErrorCode.MEDIA_REJECTED,
        'The TikTok post was cancelled.',
        { details },
      );
    case 'internal':
    case 'video_pull_failed':
      return ProviderError.retryable(
        ProviderErrorCode.PROVIDER_UNAVAILABLE,
        'TikTok could not finish processing the video due to a temporary error. Retry this destination.',
        { details },
      );
    default:
      return ProviderError.permanent(
        ProviderErrorCode.MEDIA_REJECTED,
        `TikTok did not publish the video (${reason ?? 'no reason given'}).`,
        { details },
      );
  }
}
