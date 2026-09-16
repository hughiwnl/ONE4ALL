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
import { errorFromGraphResponse } from './errors.js';
import { FACEBOOK_PLATFORM } from './facebook/facebook-publisher.js';
import type { GraphClient } from './graph-client.js';
import { INSTAGRAM_PLATFORM } from './instagram/instagram-publisher.js';

export const META_CONNECTOR_ID = 'meta';

/**
 * Permissions requested from Facebook Login.
 * - pages_show_list / pages_read_engagement / pages_manage_posts: list Pages and publish videos to them
 * - instagram_basic / instagram_content_publish: discover and publish to Instagram professional accounts linked to those Pages
 * - business_management: needed for Pages/IG accounts owned through Business Manager
 * All of these require App Review before users outside the app's roles can grant them.
 */
export const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
  'business_management',
];

export interface MetaConnectorOptions {
  appId: string;
  appSecret: string;
  graph: GraphClient;
  /** Override for tests. */
  dialogBaseUrl?: string;
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

interface PageListResponse {
  data?: {
    id: string;
    name: string;
    access_token: string;
    category?: string;
    picture?: { data?: { url?: string } };
    instagram_business_account?: {
      id: string;
      username?: string;
      name?: string;
      profile_picture_url?: string;
    };
  }[];
  paging?: { next?: string };
}

/**
 * Meta (Facebook Login) connector.
 *
 * One login discovers every Facebook Page the user manages and every
 * Instagram professional account linked to those Pages. Each becomes its own
 * connectable account with a long-lived Page access token (Instagram publishing
 * also uses the linked Page's token).
 */
export class MetaConnector implements OAuthConnector {
  readonly id = META_CONNECTOR_ID;
  readonly label = 'Facebook / Instagram';
  readonly platforms = [FACEBOOK_PLATFORM, INSTAGRAM_PLATFORM];
  readonly usesPkce = false;

  constructor(private readonly options: MetaConnectorOptions) {}

  getAuthorizationUrl(params: AuthorizationUrlParams): string {
    const url = new URL(
      `${this.options.dialogBaseUrl ?? 'https://www.facebook.com'}/${this.options.graph.apiVersion}/dialog/oauth`,
    );
    url.searchParams.set('client_id', this.options.appId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('state', params.state);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', META_SCOPES.join(','));
    return url.toString();
  }

  async exchangeCode(params: ExchangeCodeParams, ctx: ProviderContext): Promise<OAuthTokens> {
    const { graph, appId, appSecret } = this.options;

    const short = new URL(graph.url('oauth/access_token'));
    short.searchParams.set('client_id', appId);
    short.searchParams.set('client_secret', appSecret);
    short.searchParams.set('redirect_uri', params.redirectUri);
    short.searchParams.set('code', params.code);
    const shortResponse = await requestJson<TokenResponse>(short.toString(), {
      fetch: ctx.fetch,
      signal: ctx.signal,
    });
    if (!shortResponse.ok || !shortResponse.body?.access_token)
      throw errorFromGraphResponse(shortResponse, 'code exchange');

    // Exchange for a long-lived (~60 day) user token; Page tokens derived from it do not expire.
    const long = new URL(graph.url('oauth/access_token'));
    long.searchParams.set('grant_type', 'fb_exchange_token');
    long.searchParams.set('client_id', appId);
    long.searchParams.set('client_secret', appSecret);
    long.searchParams.set('fb_exchange_token', shortResponse.body.access_token);
    const longResponse = await requestJson<TokenResponse>(long.toString(), {
      fetch: ctx.fetch,
      signal: ctx.signal,
    });
    if (!longResponse.ok || !longResponse.body?.access_token)
      throw errorFromGraphResponse(longResponse, 'long-lived token exchange');

    return {
      accessToken: longResponse.body.access_token,
      refreshToken: null,
      expiresAt: longResponse.body.expires_in
        ? new Date(Date.now() + longResponse.body.expires_in * 1000)
        : null,
      scopes: META_SCOPES,
    };
  }

  async discoverAccounts(tokens: OAuthTokens, ctx: ProviderContext): Promise<ConnectableAccount[]> {
    const { graph } = this.options;
    const accounts: ConnectableAccount[] = [];
    let response = await graph.get<PageListResponse>(
      'me/accounts',
      {
        fields:
          'id,name,access_token,category,picture{url},instagram_business_account{id,username,name,profile_picture_url}',
        limit: '100',
      },
      tokens.accessToken,
      ctx,
      'list pages',
    );

    for (;;) {
      for (const page of response.data ?? []) {
        if (!page.access_token) continue;
        const pageCredentials = {
          accessToken: page.access_token,
          refreshToken: null,
          expiresAt: null,
          scopes: tokens.scopes,
        };
        accounts.push({
          platform: FACEBOOK_PLATFORM,
          platformAccountId: page.id,
          displayName: page.name,
          username: null,
          avatarUrl: page.picture?.data?.url ?? null,
          credentials: pageCredentials,
          metadata: {
            category: page.category ?? null,
            pageUrl: `https://www.facebook.com/${page.id}`,
          },
        });
        const ig = page.instagram_business_account;
        if (ig) {
          accounts.push({
            platform: INSTAGRAM_PLATFORM,
            platformAccountId: ig.id,
            displayName: ig.name ?? (ig.username ? `@${ig.username}` : ig.id),
            username: ig.username ?? null,
            avatarUrl: ig.profile_picture_url ?? null,
            credentials: pageCredentials,
            metadata: {
              facebookPageId: page.id,
              facebookPageName: page.name,
              profileUrl: ig.username ? `https://www.instagram.com/${ig.username}/` : null,
            },
          });
        }
      }
      const next = response.paging?.next;
      if (!next) break;
      const nextResponse = await requestJson<PageListResponse>(next, {
        fetch: ctx.fetch,
        signal: ctx.signal,
      });
      if (!nextResponse.ok) throw errorFromGraphResponse(nextResponse, 'list pages (next page)');
      response = nextResponse.body;
    }

    if (accounts.length === 0) {
      throw ProviderError.permanent(
        ProviderErrorCode.UNSUPPORTED_ACCOUNT,
        'No Facebook Pages were found for this login. Repeat can only publish to Facebook Pages and to Instagram professional accounts linked to a Page, not to personal profiles.',
      );
    }
    return accounts;
  }
}
