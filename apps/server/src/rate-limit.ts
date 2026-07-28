/**
 * Per-user+verb rate limiter (§13). Sliding window over an in-memory map —
 * sufficient for the single-node v1 server; a multi-node deployment would
 * move this to postgres/redis without changing the call sites.
 *
 * Keys are `${userId}:${verb}`. Batches consume atomically: a batch larger
 * than the remaining budget is rejected whole and consumes nothing, so a 429
 * never leaves an upload half-applied.
 */
export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  /** Injected for tests. */
  now?: () => number;
}

export interface ConsumeResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(key: string, count?: number): ConsumeResult;
}

/**
 * SEC-6/F11: how often (in `consume` calls) to sweep fully-expired keys.
 * Amortised so the common path stays O(1)-ish rather than O(keys).
 */
const SWEEP_EVERY = 512;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs } = options;
  const now = options.now ?? Date.now;
  const hits = new Map<string, number[]>();
  let sinceSweep = 0;

  /**
   * SEC-6/F11: drop keys whose window has fully elapsed.
   *
   * `hits` previously only ever grew: a key was written back even when its
   * filtered array was EMPTY, so every distinct key seen since boot was retained
   * forever. Keys include the auth limiter's per-client-IP entries, so an
   * unauthenticated caller could inflate the map indefinitely — an unbounded
   * memory leak on a long-lived single-node process.
   */
  const sweep = (t: number): void => {
    const cutoff = t - windowMs;
    for (const [key, stamps] of hits) {
      if (stamps.length === 0 || stamps[stamps.length - 1]! <= cutoff) hits.delete(key);
    }
  };

  return {
    consume(key: string, count = 1): ConsumeResult {
      const t = now();
      const cutoff = t - windowMs;

      sinceSweep += 1;
      if (sinceSweep >= SWEEP_EVERY) {
        sinceSweep = 0;
        sweep(t);
      }

      const recent = (hits.get(key) ?? []).filter((ts) => ts > cutoff);

      if (recent.length + count > limit) {
        hits.set(key, recent);
        const oldest = recent[0] ?? t;
        return {
          allowed: false,
          remaining: Math.max(0, limit - recent.length),
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - t) / 1000)),
        };
      }

      for (let i = 0; i < count; i += 1) recent.push(t);
      // An empty array carries no information — don't retain the key for it.
      if (recent.length === 0) hits.delete(key);
      else hits.set(key, recent);
      return { allowed: true, remaining: limit - recent.length, retryAfterSeconds: 0 };
    },
  };
}
