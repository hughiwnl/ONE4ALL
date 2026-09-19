import { describe, expect, it } from 'vitest';
import { describeEnvWarnings, EnvValidationError, loadEnv } from '../env.js';

const valid = {
  DATABASE_URL: 'postgresql://repeat:repeat@localhost:5432/repeat',
  REDIS_URL: 'redis://localhost:6379',
  APP_URL: 'http://localhost:3000',
  SESSION_SECRET: 'x'.repeat(32),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('loadEnv', () => {
  it('parses a minimal valid configuration with defaults', () => {
    const env = loadEnv(valid);
    expect(env.MAX_UPLOAD_SIZE_MB).toBe(2048);
    expect(env.MEDIA_STORAGE_DRIVER).toBe('local');
    expect(env.MOCK_PROVIDER_ENABLED).toBe(false);
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
  });

  it('resolves a relative media path against REPEAT_ROOT_DIR', () => {
    expect(
      loadEnv({ ...valid, MEDIA_STORAGE_PATH: './data/media', REPEAT_ROOT_DIR: '/srv/repeat' })
        .MEDIA_STORAGE_PATH,
    ).toBe('/srv/repeat/data/media');
    expect(loadEnv({ ...valid, MEDIA_STORAGE_PATH: '/data/media' }).MEDIA_STORAGE_PATH).toBe(
      '/data/media',
    );
  });

  it('accepts a hex-encoded encryption key', () => {
    expect(() => loadEnv({ ...valid, TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) })).not.toThrow();
  });

  it('lists every missing critical variable in one readable error', () => {
    try {
      loadEnv({});
      expect.fail('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('REDIS_URL');
      expect(message).toContain('SESSION_SECRET');
      expect(message).toContain('TOKEN_ENCRYPTION_KEY');
    }
  });

  it('rejects a short encryption key', () => {
    expect(() => loadEnv({ ...valid, TOKEN_ENCRYPTION_KEY: 'short' })).toThrow(/32-byte/);
  });

  it('requires provider credentials to be set in pairs', () => {
    expect(() => loadEnv({ ...valid, GOOGLE_CLIENT_ID: 'id' })).toThrow(/GOOGLE_CLIENT_SECRET/);
    expect(() => loadEnv({ ...valid, META_APP_SECRET: 'secret' })).toThrow(/META_APP_ID/);
    expect(() => loadEnv({ ...valid, TIKTOK_CLIENT_KEY: 'key' })).toThrow(/TIKTOK_CLIENT_SECRET/);
  });

  it('treats empty provider strings as unset', () => {
    const env = loadEnv({ ...valid, GOOGLE_CLIENT_ID: '  ', GOOGLE_CLIENT_SECRET: '' });
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
  });

  it('warns (without failing) about the mock provider, plain-http URLs and missing providers', () => {
    const warnings = describeEnvWarnings(
      loadEnv({ ...valid, APP_URL: 'http://203.0.113.4:3000', MOCK_PROVIDER_ENABLED: 'true' }),
    );
    expect(warnings.some((w) => w.includes('MOCK_PROVIDER_ENABLED'))).toBe(true);
    expect(warnings.some((w) => w.includes('HTTPS'))).toBe(true);
    expect(describeEnvWarnings(loadEnv(valid)).some((w) => w.includes('No providers'))).toBe(true);
    expect(
      describeEnvWarnings(
        loadEnv({
          ...valid,
          APP_URL: 'https://repeat.example.com',
          GOOGLE_CLIENT_ID: 'a',
          GOOGLE_CLIENT_SECRET: 'b',
        }),
      ),
    ).toEqual([]);
  });
});
