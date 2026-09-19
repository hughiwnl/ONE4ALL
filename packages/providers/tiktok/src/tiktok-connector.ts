import {
  ProviderError,
  ProviderErrorCode,
  requestJson,
  type AuthorizationUrlParams,
  type ConnectableAccount,
  type ExchangeCodeParams,
  type OAuthConnector,
  type OAuthTokens,
  type ProviderContext,
} from '@repeat/provider-sdk';
import { errorFromTikTokResponse, type TikTokApiErrorBody } from './errors.js';

export const TIKTOK_CONNECTOR_ID = 'tiktok';
const TIKTOK_PLATFORM_ID = 'tiktok';

/**
 * - user.info.basic: open_id, display name and avatar (identity of the connected account)
 * - video.publish: Content Posting API, Direct Post (also exposes creator_username)
 */
export const TIKTOK_SCOPES = ['user.info.basic', 'video.publish'];

const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
export const TIKTOK_API_BASE = 'https://open.tiktokapis.com';

export interface TikTokConnectorOptions {
  clientKey: string;
  clientSecret: string;
  /** Override for tests. */
  apiBase?: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  open_id?: string;
  refresh_token?: string;
  refresh_expires_in?: number;
  scope?: string;
  token_type?: string;
}

interface UserInfoResponse extends TikTokApiErrorBody {
  data?: { user?: { open_id?: string; display_name?: string; avatar_url?: string } };
}

export interface CreatorInfo {
  creator_avatar_url?: string;
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

/**
 * TikTok Login Kit (web) connector.
 * https://developers.tiktok.com/doc/login-kit-web
 *
 * One login authorizes exactly one TikTok account. Connect another account by
 * running the flow again while logged into that account on tiktok.com.
 * TikTok requires an HTTPS redirect URI, so APP_URL must be HTTPS.
 */
export class TikTokConnector implements OAuthConnector {
  readonly id = TIKTOK_CONNECTOR_ID;
  readonly label = 'TikTok';
  readonly platforms = [TIKTOK_PLATFORM_ID];
  // TikTok documents PKCE only for desktop/mobile apps; web apps use client_secret.
  readonly usesPkce = false;

  private readonly apiBase: string;

  constructor(private readonly options: TikTokConnectorOptions) {
    this.apiBase = options.apiBase ?? TIKTOK_API_BASE;
  }

  getAuthorizationUrl(params: AuthorizationUrlParams): string {
    const url = new URL(AUTH_URL);
    url.searchParams.set('client_key', this.options.clientKey);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', TIKTOK_SCOPES.join(','));
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('state', params.state);
    // Always show the consent page so a user can switch TikTok accounts to connect another one.
    url.searchParams.set('disable_auto_auth', '1');
    return url.toString();
  }

  async exchangeCode(params: ExchangeCodeParams, ctx: ProviderContext): Promise<OAuthTokens> {
    return this.tokenRequest(
      {
        client_key: this.options.clientKey,
        client_secret: this.options.clientSecret,
        code: params.code,
        grant_type: 'authorization_code',
        redirect_uri: params.redirectUri,
      },
      null,
      'token exchange',
      ctx,
    );
  }

  /** Exchange a refresh token for new tokens. TikTok may rotate the refresh token. */
  async refreshAccessToken(refreshToken: string, ctx: ProviderContext): Promise<OAuthTokens> {
    return this.tokenRequest(
      {
        client_key: this.options.clientKey,
        client_secret: this.options.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      },
      refreshToken,
      'token refresh',
      ctx,
    );
  }

  async discoverAccounts(tokens: OAuthTokens, ctx: ProviderContext): Promise<ConnectableAccount[]> {
    if (!tokens.refreshToken) {
      throw ProviderError.permanent(
        ProviderErrorCode.INSUFFICIENT_PERMISSIONS,
        'TikTok did not return a refresh token. Try connecting again.',
      );
    }
    if (!tokens.scopes.includes('video.publish')) {
      throw ProviderError.permanent(
        ProviderErrorCode.INSUFFICIENT_PERMISSIONS,
        'The video.publish permission was not granted. Add the Content Posting API (with Direct Post) to your TikTok app and accept all permissions when connecting.',
      );
    }

    const url = new URL('/v2/user/info/', this.apiBase);
    url.searchParams.set('fields', 'open_id,display_name,avatar_url');
    const response = await requestJson<UserInfoResponse>(url.toString(), {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      fetch: ctx.fetch,
      signal: ctx.signal,
    });
    if (!response.ok || (response.body?.error?.code && response.body.error.code !== 'ok')) {
      throw errorFromTikTokResponse(response, 'user info');
    }
    const user = response.body?.data?.user;
    const openId = user?.open_id ?? (tokens.raw?.open_id as string | undefined);
    if (!openId) {
      throw ProviderError.permanent(
        ProviderErrorCode.UNKNOWN,
        'TikTok did not return an account id',
      );
    }

    // The username comes from creator_info (video.publish scope). It is optional for connecting.
    let creator: CreatorInfo | null = null;
    try {
      creator = await queryCreatorInfo(this.apiBase, tokens.accessToken, ctx);
    } catch (error) {
      ctx.logger.warn({ err: error }, 'could not read TikTok creator info while connecting');
    }

    const username = creator?.creator_username ?? null;
    return [
      {
        platform: TIKTOK_PLATFORM_ID,
        platformAccountId: openId,
        displayName:
          user?.display_name || creator?.creator_nickname || (username ? `@${username}` : openId),
        username: username ? `@${username}` : null,
        avatarUrl: user?.avatar_url ?? creator?.creator_avatar_url ?? null,
        credentials: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          scopes: tokens.scopes,
        },
        metadata: {
          tiktokUsername: username,
          profileUrl: username ? `https://www.tiktok.com/@${username}` : null,
        },
      },
    ];
  }

  get apiBaseUrl(): string {
    return this.apiBase;
  }

  private async tokenRequest(
    form: Record<string, string>,
    fallbackRefreshToken: string | null,
    context: string,
    ctx: ProviderContext,
  ): Promise<OAuthTokens> {
    const response = await requestJson<TokenResponse>(
      new URL('/v2/oauth/token/', this.apiBase).toString(),
      {
        method: 'POST',
        form,
        fetch: ctx.fetch,
        signal: ctx.signal,
      },
    );
    // The token endpoint can report errors with HTTP 200, so check the body too.
    if (!response.ok || !response.body?.access_token) {
      throw errorFromTikTokResponse(response, context);
    }
    const body = response.body;
    return {
      accessToken: body.access_token!,
      refreshToken: body.refresh_token ?? fallbackRefreshToken,
      expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
      scopes: body.scope ? body.scope.split(/[,\s]+/).filter(Boolean) : [],
      raw: {
        open_id: body.open_id,
        token_type: body.token_type,
        refresh_expires_in: body.refresh_expires_in,
      },
    };
  }
}

/** POST /v2/post/publish/creator_info/query/ — required before every Direct Post. */
export async function queryCreatorInfo(
  apiBase: string,
  accessToken: string,
  ctx: ProviderContext,
): Promise<CreatorInfo> {
  const response = await requestJson<TikTokApiErrorBody & { data?: CreatorInfo }>(
    new URL('/v2/post/publish/creator_info/query/', apiBase).toString(),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json; charset=UTF-8',
      },
      fetch: ctx.fetch,
      signal: ctx.signal,
    },
  );
  if (!response.ok || (response.body?.error?.code && response.body.error.code !== 'ok')) {
    throw errorFromTikTokResponse(response, 'creator info');
  }
  return response.body?.data ?? {};
}
