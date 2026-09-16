import { describe, expect, it } from 'vitest';
import { computeBackoffMs } from './backoff.js';

describe('computeBackoffMs', () => {
  it('grows exponentially and stays within [half, full] of the base', () => {
    expect(computeBackoffMs(1, undefined, () => 0)).toBe(7_500);
    expect(computeBackoffMs(1, undefined, () => 1)).toBe(15_000);
    expect(computeBackoffMs(2, undefined, () => 1)).toBe(30_000);
    expect(computeBackoffMs(3, undefined, () => 1)).toBe(60_000);
  });
  it('caps at fifteen minutes', () => {
    expect(computeBackoffMs(20, undefined, () => 1)).toBe(15 * 60_000);
  });
  it('honours a longer Retry-After hint, capped at an hour', () => {
    expect(computeBackoffMs(1, 120_000, () => 1)).toBe(120_000);
    expect(computeBackoffMs(1, 10_000, () => 1)).toBe(15_000);
    expect(computeBackoffMs(1, 99 * 60 * 60_000, () => 1)).toBe(60 * 60_000);
  });
});
