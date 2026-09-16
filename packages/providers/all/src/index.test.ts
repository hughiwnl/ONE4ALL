import { describe, expect, it } from 'vitest';
import { loadEnv } from '@repeat/config';
import { createProviders } from './index.js';

const base = {
  DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
  REDIS_URL: 'redis://localhost:6379',
  APP_URL: 'http://localhost:3000',
  SESSION_SECRET: 's'.repeat(32),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
};

describe('createProviders', () => {
  it('boots with nothing configured and reports what is missing', () => {
    const setup = createProviders(loadEnv(base));
    expect(setup.providers.list()).toHaveLength(0);
    expect(setup.unconfigured.map((u) => u.platform).sort()).toEqual([
      'facebook',
      'instagram',
      'youtube',
    ]);
  });
  it('registers providers when credentials are present', () => {
    const setup = createProviders(
      loadEnv({
        ...base,
        GOOGLE_CLIENT_ID: 'a',
        GOOGLE_CLIENT_SECRET: 'b',
        META_APP_ID: 'c',
        META_APP_SECRET: 'd',
        MOCK_PROVIDER_ENABLED: 'true',
      }),
    );
    expect(
      setup.providers
        .list()
        .map((p) => p.platform)
        .sort(),
    ).toEqual(['facebook', 'instagram', 'mock', 'youtube']);
    expect(setup.connectors.forPlatform('instagram')?.id).toBe('meta');
    expect(setup.connectors.forPlatform('youtube')?.id).toBe('google');
    expect(setup.unconfigured).toHaveLength(0);
  });
});
