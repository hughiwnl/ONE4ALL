import { describe, expect, it } from 'vitest';
import {
  classifyHttpStatus,
  normalizeUnknownError,
  ProviderError,
  ProviderErrorCode,
} from '../errors.js';

describe('ProviderError', () => {
  it('carries code, retryable flag and safe details', () => {
    const error = ProviderError.retryable(ProviderErrorCode.RATE_LIMITED, 'slow down', {
      retryAfterMs: 5000,
      details: { status: 429 },
    });
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(5000);
    expect(error.toJSON()).toEqual({
      code: 'rate_limited',
      message: 'slow down',
      retryable: true,
      details: { status: 429 },
    });
  });
});

describe('classifyHttpStatus', () => {
  it('treats 429 and 5xx as retryable', () => {
    expect(classifyHttpStatus(429)).toEqual({
      code: ProviderErrorCode.RATE_LIMITED,
      retryable: true,
    });
    expect(classifyHttpStatus(503).retryable).toBe(true);
  });
  it('treats 401/403/400 as permanent', () => {
    expect(classifyHttpStatus(401)).toEqual({
      code: ProviderErrorCode.TOKEN_EXPIRED,
      retryable: false,
    });
    expect(classifyHttpStatus(403).retryable).toBe(false);
    expect(classifyHttpStatus(400).retryable).toBe(false);
  });
});

describe('normalizeUnknownError', () => {
  it('returns ProviderErrors unchanged', () => {
    const original = ProviderError.permanent('x', 'y');
    expect(normalizeUnknownError(original)).toBe(original);
  });
  it('classifies socket failures as retryable network errors', () => {
    const error = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    const normalized = normalizeUnknownError(error);
    expect(normalized.code).toBe(ProviderErrorCode.NETWORK);
    expect(normalized.retryable).toBe(true);
  });
  it('classifies aborts as retryable timeouts', () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    expect(normalizeUnknownError(error).code).toBe(ProviderErrorCode.TIMEOUT);
  });
  it('treats arbitrary errors as permanent', () => {
    const normalized = normalizeUnknownError(new Error('undefined is not a function'));
    expect(normalized.retryable).toBe(false);
    expect(normalized.code).toBe(ProviderErrorCode.UNKNOWN);
  });
});
