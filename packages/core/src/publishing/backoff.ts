export const DEFAULT_MAX_JOB_ATTEMPTS = 5;

const BASE_DELAY_MS = 15_000;
const MAX_DELAY_MS = 15 * 60_000;

/**
 * Exponential backoff with full jitter: 15s, 30s, 60s, 120s... capped at 15
 * minutes. A provider's Retry-After hint always wins when it is longer.
 *
 * @param attempt 1-based number of the attempt that just failed.
 */
export function computeBackoffMs(
  attempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(exponential / 2 + random() * (exponential / 2));
  if (retryAfterMs && retryAfterMs > jittered) return Math.min(retryAfterMs, 60 * 60_000);
  return jittered;
}
