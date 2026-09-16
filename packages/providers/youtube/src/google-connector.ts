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
  type ProviderCredentials,
} from '@repeat/provider-sdk';
import { errorFromGoogleResponse } from './errors.js';
import { YOUTUBE_PLATFORM } from './youtube-publisher.js';

export const GOOGLE_CONNECTOR_ID = 'google';

/**
 * Scopes: upload videos + read the channel identity. `youtube.upload` alone
 * cannot list channels, and the broader `youtube` scope is unnecessary.
 */
export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';

export interface GoogleConnectorOptions {
  clientId: string;
  clientSecret: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

interface ChannelListResponse {
  items?: {
    id: string;
    snippet?: {
      title?: string;
      customUrl?: string;
      thumbnails?: { default?: { url?: string }; medium?: { url?: string } };
    };
  }[];
}

/**
 * Google OAuth connector for YouTube.
 *
 * Google's consent screen lets the user pick which channel (including brand
 * accounts) to authorize; the resulting token belongs to exactly one channel,
 * which is why `discoverAccounts` returns one entry. Connecting a second
 * channel simply means running the flow again and choosing another channel.
 */
export class GoogleConnector implements OAuthConnector {
  readonly id = GOOGLE_CONNECTOR_ID;
  readonly label = 'YouTube';
  readonly platforms = [YOUTUBE_PLATFORM];
  readonly usesPkce = true;

  constructor(private readonly options: GoogleConnectorOptions) {}

  getAuthorizationUrl(params: AuthorizationUrlParams): string {
    const url = new URL(AUTH_URL);
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', YOUTUBE_SCOPES.join(' '));
    url.searchParams.set('state', params.state);
    // offline + consent guarantees a refresh token on every connection, not only the first.
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent select_account');
    url.searchParams.set('include_granted_scopes', 'true');
    if (params.codeChallenge) {
      url.searchParams.set('code_challenge', params.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  async exchangeCode(params: ExchangeCodeParams, ctx: ProviderContext): Promise<OAuthTokens> {
    const response = await requestJson<TokenResponse>(TOKEN_URL, {
      method: 'POST',
      form: {
        code: params.code,
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        redirect_uri: params.redirectUri,
        grant_type: 'authorization_code',
        ...(params.codeVerifier ? { code_verifier: params.codeVerifier } : {}),
      },
      fetch: ctx.fetch,
      signal: ctx.signal,
    });
    if (!response.ok) throw errorFromGoogleResponse(response, 'token exchange');
    return tokensFromResponse(response.body, null);
  }

  async discoverAccounts(tokens: OAuthTokens, ctx: ProviderContext): Promise<ConnectableAccount[]> {
    if (!tokens.refreshToken) {
      throw ProviderError.permanent(
        ProviderErrorCode.INSUFFICIENT_PERMISSIONS,
        'Google did not return a refresh token. Remove Repeat from https://myaccount.google.com/permissions and connect again.',
      );
    }
    const url = new URL(CHANNELS_URL);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('mine', 'true');
    const response = await requestJson<ChannelListResponse>(url.toString(), {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      fetch: ctx.fetch,
      signal: ctx.signal,
    });
    if (!response.ok) throw errorFromGoogleResponse(response, 'list channels');
    const items = response.body?.items ?? [];
    if (items.length === 0) {
      throw ProviderError.permanent(
        ProviderErrorCode.UNSUPPORTED_ACCOUNT,
        'This Google account has no YouTube channel. Create a channel on YouTube first, then connect again.',
      );
    }
    const credentials: ProviderCredentials = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
    };
    return items.map((channel) => ({
      platform: YOUTUBE_PLATFORM,
      platformAccountId: channel.id,
      displayName: channel.snippet?.title ?? channel.id,
      username: channel.snippet?.customUrl ?? null,
      avatarUrl:
        channel.snippet?.thumbnails?.medium?.url ??
        channel.snippet?.thumbnails?.default?.url ??
        null,
      credentials,
      metadata: { channelUrl: `https://www.youtube.com/channel/${channel.id}` },
    }));
  }

  /** Exchange a refresh token for a new access token. Used by the publisher. */
  async refreshAccessToken(refreshToken: string, ctx: ProviderContext): Promise<OAuthTokens> {
    const response = await requestJson<TokenResponse>(TOKEN_URL, {
      method: 'POST',
      form: {
        refresh_token: refreshToken,
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        grant_type: 'refresh_token',
      },
      fetch: ctx.fetch,
      signal: ctx.signal,
    });
    if (!response.ok) throw errorFromGoogleResponse(response, 'token refresh');
    return tokensFromResponse(response.body, refreshToken);
  }
}

function tokensFromResponse(body: TokenResponse, fallbackRefreshToken: string | null): OAuthTokens {
  if (!body?.access_token) {
    throw ProviderError.permanent(
      ProviderErrorCode.UNKNOWN,
      'Google token response did not include an access token',
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? fallbackRefreshToken,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
    scopes: body.scope ? body.scope.split(' ') : [],
    raw: { token_type: body.token_type },
  };
}
