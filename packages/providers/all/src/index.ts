import type { Env } from '@repeat/config';
import {
  FacebookPublisher,
  GraphClient,
  InstagramPublisher,
  MetaConnector,
} from '@repeat/provider-meta';
import { MockPublisher } from '@repeat/provider-mock';
import { ConnectorRegistry, ProviderRegistry, type OAuthConnector } from '@repeat/provider-sdk';
import { GoogleConnector, YouTubePublisher } from '@repeat/provider-youtube';

export interface ProviderSetup {
  providers: ProviderRegistry;
  connectors: ConnectorRegistry;
  /** Platforms known to Repeat but not configured on this server (for UI hints). */
  unconfigured: { platform: string; displayName: string; reason: string }[];
}

/**
 * Composition root for providers. This is the ONLY place that knows which
 * concrete provider packages exist. To add a platform: implement
 * PublisherProvider (+ OAuthConnector) in a new package and register it here.
 */
export function createProviders(env: Env): ProviderSetup {
  const providers = new ProviderRegistry();
  const connectors = new ConnectorRegistry();
  const unconfigured: ProviderSetup['unconfigured'] = [];

  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    const google = new GoogleConnector({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    });
    connectors.register(google);
    providers.register(new YouTubePublisher(google));
  } else {
    unconfigured.push({
      platform: 'youtube',
      displayName: 'YouTube',
      reason: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET',
    });
  }

  if (env.META_APP_ID && env.META_APP_SECRET) {
    const graph = new GraphClient({
      appSecret: env.META_APP_SECRET,
      apiVersion: env.META_GRAPH_API_VERSION,
    });
    connectors.register(
      new MetaConnector({ appId: env.META_APP_ID, appSecret: env.META_APP_SECRET, graph }),
    );
    providers.register(new FacebookPublisher(graph));
    providers.register(new InstagramPublisher(graph));
  } else {
    unconfigured.push({
      platform: 'facebook',
      displayName: 'Facebook Page',
      reason: 'Set META_APP_ID and META_APP_SECRET',
    });
    unconfigured.push({
      platform: 'instagram',
      displayName: 'Instagram',
      reason: 'Set META_APP_ID and META_APP_SECRET',
    });
  }

  if (env.MOCK_PROVIDER_ENABLED) {
    providers.register(new MockPublisher());
    connectors.register(mockConnector);
  }

  return { providers, connectors, unconfigured };
}

/**
 * The mock provider has no OAuth: accounts are created directly through
 * POST /api/connect/mock. This placeholder connector only exists so the
 * provider description can advertise how mock accounts get connected.
 */
const mockConnector: OAuthConnector = {
  id: 'mock',
  label: 'Mock account',
  platforms: ['mock'],
  usesPkce: false,
  getAuthorizationUrl() {
    throw new Error('The mock connector does not use OAuth');
  },
  async exchangeCode() {
    throw new Error('The mock connector does not use OAuth');
  },
  async discoverAccounts() {
    return [];
  },
};
