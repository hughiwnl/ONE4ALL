import type { PlatformId } from '@repeat/types';
import { ProviderError, ProviderErrorCode } from './errors.js';
import type { OAuthConnector } from './oauth.js';
import type { PublisherProvider } from './types.js';

/**
 * Registry of publishing providers, keyed by platform id.
 *
 * The composition root registers concrete providers; the engine and API only
 * ever look providers up here.
 */
export class ProviderRegistry {
  private readonly providers = new Map<PlatformId, PublisherProvider<never>>();

  register<TSettings>(provider: PublisherProvider<TSettings>): this {
    if (this.providers.has(provider.platform)) {
      throw new Error(`A provider for platform "${provider.platform}" is already registered`);
    }
    this.providers.set(provider.platform, provider as PublisherProvider<never>);
    return this;
  }

  has(platform: PlatformId): boolean {
    return this.providers.has(platform);
  }

  /** Untyped lookup for the engine: settings are validated via `settingsSchema` at runtime. */
  get(platform: PlatformId): PublisherProvider<Record<string, unknown>> {
    const provider = this.providers.get(platform);
    if (!provider) {
      throw ProviderError.permanent(
        ProviderErrorCode.NOT_CONFIGURED,
        `No publishing provider is registered for platform "${platform}". Is it configured on this server?`,
      );
    }
    return provider;
  }

  list(): PublisherProvider<Record<string, unknown>>[] {
    return [...this.providers.values()];
  }
}

export class ConnectorRegistry {
  private readonly connectors = new Map<string, OAuthConnector>();

  register(connector: OAuthConnector): this {
    if (this.connectors.has(connector.id)) {
      throw new Error(`An OAuth connector with id "${connector.id}" is already registered`);
    }
    this.connectors.set(connector.id, connector);
    return this;
  }

  get(id: string): OAuthConnector | undefined {
    return this.connectors.get(id);
  }

  /** The connector able to connect accounts for the given platform, if any. */
  forPlatform(platform: PlatformId): OAuthConnector | undefined {
    return [...this.connectors.values()].find((connector) =>
      connector.platforms.includes(platform),
    );
  }

  list(): OAuthConnector[] {
    return [...this.connectors.values()];
  }
}
