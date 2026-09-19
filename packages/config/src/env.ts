import path from 'node:path';
import { z } from 'zod';

/**
 * Application configuration, validated at startup.
 *
 * Every process (web, worker, scripts) calls `loadEnv()` once and passes the
 * resulting object down explicitly. Nothing else in the codebase should read
 * `process.env` directly, which keeps every package testable and makes the
 * complete list of settings discoverable from this one file (and .env.example).
 */

const booleanish = z.union([z.boolean(), z.string()]).transform((value) => {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
});

const optionalString = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  });

/** A 32-byte key encoded as base64 (44 chars) or hex (64 chars). */
const encryptionKey = z
  .string()
  .min(1, 'TOKEN_ENCRYPTION_KEY is required')
  .refine(
    (value) => {
      if (/^[0-9a-fA-F]{64}$/.test(value)) return true;
      try {
        return Buffer.from(value, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    {
      message:
        'TOKEN_ENCRYPTION_KEY must be a 32-byte key encoded as base64 or hex. Generate one with: openssl rand -base64 32',
    },
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Core infrastructure
  DATABASE_URL: z.string().url('DATABASE_URL must be a postgres:// connection string'),
  REDIS_URL: z.string().url('REDIS_URL must be a redis:// connection string'),

  // Public URL where this instance is reachable. OAuth callbacks and provider
  // media downloads (Instagram) are built from this value.
  APP_URL: z.string().url('APP_URL must be an absolute URL, e.g. http://localhost:3000'),

  // Secrets
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  TOKEN_ENCRYPTION_KEY: encryptionKey,

  // Registration: after the first user exists, new sign-ups require this flag.
  ALLOW_REGISTRATION: booleanish.default('true'),

  // Media storage. A relative MEDIA_STORAGE_PATH is resolved against
  // REPEAT_ROOT_DIR (set by loadDotenv to the directory holding .env) or cwd,
  // so the web and worker processes always agree on the location.
  MEDIA_STORAGE_DRIVER: z.enum(['local']).default('local'),
  MEDIA_STORAGE_PATH: z.string().min(1).default('./data/media'),
  REPEAT_ROOT_DIR: optionalString,
  MAX_UPLOAD_SIZE_MB: z.coerce.number().int().positive().max(100_000).default(2048),
  FFPROBE_PATH: optionalString,

  // Worker
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(64).default(2),

  // Providers (all optional: the app boots without them and shows "not configured")
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  META_APP_ID: optionalString,
  META_APP_SECRET: optionalString,
  TIKTOK_CLIENT_KEY: optionalString,
  TIKTOK_CLIENT_SECRET: optionalString,
  META_GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v21.0'),

  // Development-only mock provider that publishes nowhere. Logged loudly when enabled.
  MOCK_PROVIDER_ENABLED: booleanish.default('false'),
});

export type Env = z.infer<typeof envSchema>;
export type MediaStorageDriver = Env['MEDIA_STORAGE_DRIVER'];

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      [
        'Invalid or missing environment configuration:',
        ...issues.map((issue) => `  - ${issue}`),
        '',
        'Copy .env.example to .env and fill in the required values.',
      ].join('\n'),
    );
    this.name = 'EnvValidationError';
  }
}

/**
 * Parse and validate configuration from an env-like record.
 * Throws `EnvValidationError` with a readable list of problems on failure.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new EnvValidationError(issues);
  }

  const env = result.data;
  const problems: string[] = [];

  if (
    (env.GOOGLE_CLIENT_ID && !env.GOOGLE_CLIENT_SECRET) ||
    (!env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
  ) {
    problems.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together');
  }
  if ((env.META_APP_ID && !env.META_APP_SECRET) || (!env.META_APP_ID && env.META_APP_SECRET)) {
    problems.push('META_APP_ID and META_APP_SECRET must be set together');
  }
  if (Boolean(env.TIKTOK_CLIENT_KEY) !== Boolean(env.TIKTOK_CLIENT_SECRET)) {
    problems.push('TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET must be set together');
  }

  if (problems.length > 0) {
    throw new EnvValidationError(problems);
  }

  if (!path.isAbsolute(env.MEDIA_STORAGE_PATH)) {
    env.MEDIA_STORAGE_PATH = path.resolve(
      env.REPEAT_ROOT_DIR ?? process.cwd(),
      env.MEDIA_STORAGE_PATH,
    );
  }

  return env;
}

/**
 * Non-fatal configuration concerns worth logging at startup.
 */
export function describeEnvWarnings(env: Env): string[] {
  const warnings: string[] = [];
  if (env.MOCK_PROVIDER_ENABLED) {
    warnings.push(
      'MOCK_PROVIDER_ENABLED=true: the development-only "mock" platform is registered. Disable it on real deployments.',
    );
  }
  if (!env.APP_URL.startsWith('https://') && !isLoopback(env.APP_URL)) {
    warnings.push(
      `APP_URL (${env.APP_URL}) is not HTTPS. OAuth providers and Instagram media downloads require a public HTTPS URL.`,
    );
  }
  if (
    !env.GOOGLE_CLIENT_ID &&
    !env.META_APP_ID &&
    !env.TIKTOK_CLIENT_KEY &&
    !env.MOCK_PROVIDER_ENABLED
  ) {
    warnings.push(
      'No providers are configured; nothing can be published. Set GOOGLE_* / META_* / TIKTOK_* credentials or MOCK_PROVIDER_ENABLED=true.',
    );
  }
  return warnings;
}

function isLoopback(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}
