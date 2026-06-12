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

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs } = options;
  const now = options.now ?? Date.now;
  const hits = new Map<string, number[]>();

  return {
    consume(key: string, count = 1): ConsumeResult {
      const t = now();
      const cutoff = t - windowMs;
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
      hits.set(key, recent);
      return { allowed: true, remaining: limit - recent.length, retryAfterSeconds: 0 };
    },
  };
}
