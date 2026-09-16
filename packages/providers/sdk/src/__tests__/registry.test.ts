import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConnectorRegistry, ProviderRegistry } from '../registry.js';
import type { OAuthConnector, PublisherProvider } from '../index.js';
import { ProviderError } from '../errors.js';

function fakeProvider(platform: string): PublisherProvider<Record<string, unknown>> {
  return {
    platform,
    displayName: platform,
    capabilities: { media: { video: true, image: false }, requiresPublicMediaUrl: false },
    settingsFields: [],
    settingsSchema: z.record(z.string(), z.unknown()),
    notes: [],
    validateAccount: async () => ({ ok: true }),
    refreshCredentialsIfNeeded: async () => null,
    validateMedia: () => ({ ok: true }),
    publish: async () => ({ state: 'published', platformPostId: '1', platformPostUrl: null }),
    getStatus: async () => ({ state: 'published', platformPostId: '1', platformPostUrl: null }),
    normalizeError: (e) =>
      e instanceof ProviderError ? e : ProviderError.permanent('unknown', String(e)),
  };
}

describe('ProviderRegistry', () => {
  it('registers and resolves providers by platform', () => {
    const registry = new ProviderRegistry()
      .register(fakeProvider('youtube'))
      .register(fakeProvider('tiktok'));
    expect(registry.get('tiktok').platform).toBe('tiktok');
    expect(registry.list().map((p) => p.platform)).toEqual(['youtube', 'tiktok']);
  });
  it('rejects duplicate platforms', () => {
    const registry = new ProviderRegistry().register(fakeProvider('youtube'));
    expect(() => registry.register(fakeProvider('youtube'))).toThrow(/already registered/);
  });
  it('throws a permanent ProviderError for unknown platforms', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.get('nope')).toThrow(ProviderError);
    try {
      registry.get('nope');
    } catch (error) {
      expect((error as ProviderError).retryable).toBe(false);
    }
  });
});

describe('ConnectorRegistry', () => {
  const connector: OAuthConnector = {
    id: 'meta',
    label: 'Meta',
    platforms: ['facebook', 'instagram'],
    usesPkce: false,
    getAuthorizationUrl: () => 'https://example.com',
    exchangeCode: async () => ({
      accessToken: 'a',
      refreshToken: null,
      expiresAt: null,
      scopes: [],
    }),
    discoverAccounts: async () => [],
  };
  it('finds the connector that serves a platform', () => {
    const registry = new ConnectorRegistry().register(connector);
    expect(registry.forPlatform('instagram')?.id).toBe('meta');
    expect(registry.forPlatform('youtube')).toBeUndefined();
  });
});
