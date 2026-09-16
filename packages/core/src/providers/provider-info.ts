import type { ConnectorRegistry, ProviderRegistry } from '@repeat/provider-sdk';
import type { ProviderInfoDto } from '@repeat/types';

/**
 * Describe the providers available on this server for clients: which are
 * configured, how accounts get connected, and what settings they accept.
 */
export function describeProviders(
  providers: ProviderRegistry,
  connectors: ConnectorRegistry,
): ProviderInfoDto[] {
  return providers.list().map((provider) => {
    const connector = connectors.forPlatform(provider.platform);
    return {
      platform: provider.platform,
      displayName: provider.displayName,
      configured: true,
      connector: connector
        ? {
            id: connector.id,
            label: connector.label,
            kind: connector.id === 'mock' ? 'mock' : 'oauth',
          }
        : null,
      settingsFields: provider.settingsFields,
      capabilities: provider.capabilities,
      notes: provider.notes,
    };
  });
}
