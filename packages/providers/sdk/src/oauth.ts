import type { PlatformId } from '@repeat/types';
import type { ProviderContext, ProviderCredentials } from './types.js';

/**
 * Token response from an OAuth authorization-code exchange.
 * Connectors normalize the provider payload into this shape.
 */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
  /** Raw non-sensitive fields worth keeping (e.g. token_type). */
  raw?: Record<string, unknown>;
}

/** An account discovered after OAuth, ready to be stored as a SocialAccount. */
export interface ConnectableAccount {
  platform: PlatformId;
  platformAccountId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  credentials: ProviderCredentials;
  /** Non-sensitive details persisted in SocialAccount.metadata. */
  metadata: Record<string, unknown>;
}

export interface AuthorizationUrlParams {
  state: string;
  redirectUri: string;
  /** PKCE S256 challenge, present when `usesPkce` is true. */
  codeChallenge?: string;
}

export interface ExchangeCodeParams {
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}

/**
 * Connects accounts through a third-party OAuth provider.
 *
 * One connector may expose several platforms (Meta -> Facebook Pages and
 * Instagram accounts) and one login may discover several accounts; the user
 * picks which ones to connect. Connectors never persist anything themselves.
 */
export interface OAuthConnector {
  /** Stable id used in routes: /api/connect/{id}/start */
  readonly id: string;
  /** Button label, e.g. "Connect YouTube". */
  readonly label: string;
  readonly platforms: PlatformId[];
  readonly usesPkce: boolean;

  getAuthorizationUrl(params: AuthorizationUrlParams): string;
  exchangeCode(params: ExchangeCodeParams, ctx: ProviderContext): Promise<OAuthTokens>;
  /** Discover every account this login can publish to. */
  discoverAccounts(tokens: OAuthTokens, ctx: ProviderContext): Promise<ConnectableAccount[]>;
}
