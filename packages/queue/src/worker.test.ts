import { describe, expect, it } from 'vitest';
import { ProviderError } from '@repeat/provider-sdk';
import { backoffStrategy } from './worker.js';

describe('backoffStrategy', () => {
  it('grows with the attempt count', () => {
    const first = backoffStrategy(1, 'custom', undefined);
    const third = backoffStrategy(3, 'custom', undefined);
    expect(first).toBeGreaterThanOrEqual(7_500);
    expect(first).toBeLessThanOrEqual(15_000);
    expect(third).toBeGreaterThanOrEqual(30_000);
  });
  it('honours a provider Retry-After hint', () => {
    const error = ProviderError.retryable('rate_limited', 'slow down', { retryAfterMs: 90_000 });
    expect(backoffStrategy(1, 'custom', error)).toBe(90_000);
  });
});
