import pino, { type Logger as PinoLogger, type LoggerOptions } from 'pino';
import type { ProviderLogger } from '@repeat/provider-sdk';

export type Logger = PinoLogger;

/** Field names that must never appear in logs, wherever they are nested. */
const REDACTED_PATHS = [
  'accessToken',
  'refreshToken',
  'access_token',
  'refresh_token',
  'accessTokenEncrypted',
  'refreshTokenEncrypted',
  'password',
  'passwordHash',
  'authorization',
  'cookie',
  'client_secret',
  'code',
  'token',
  '*.accessToken',
  '*.refreshToken',
  '*.access_token',
  '*.refresh_token',
  '*.password',
  '*.authorization',
  '*.cookie',
  '*.client_secret',
  '*.token',
  'credentials',
  '*.credentials',
  'headers.authorization',
  'headers.cookie',
];

export interface CreateLoggerOptions {
  level?: string;
  name?: string;
  pretty?: boolean;
}

/**
 * Structured JSON logger with credential redaction. Every publish job logs
 * with `post_id`, `destination_id`, `social_account_id`, `platform` and `job_id`
 * bindings (see the publishing engine).
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const base: LoggerOptions = {
    level: options.level ?? 'info',
    name: options.name,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    formatters: { level: (label) => ({ level: label }) },
  };
  if (options.pretty) {
    return pino({ ...base, transport: { target: 'pino-pretty', options: { colorize: true } } });
  }
  return pino(base);
}

/** pino's logger already satisfies the provider-facing contract. */
export function asProviderLogger(logger: Logger): ProviderLogger {
  return logger;
}
