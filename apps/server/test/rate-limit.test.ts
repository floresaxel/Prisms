import { describe, expect, it } from 'vitest';

import { createRateLimiter } from '../src/rate-limit';

describe('per-user+verb rate limiter (§13)', () => {
  it('allows up to the limit, then blocks with a retry-after', () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => t });
    expect(limiter.consume('u1:settings.update').allowed).toBe(true);
    expect(limiter.consume('u1:settings.update', 2).allowed).toBe(true);
    const blocked = limiter.consume('u1:settings.update');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(60);
    t = 30_000;
    expect(limiter.consume('u1:settings.update').allowed).toBe(false);
  });

  it('isolates budgets per user and per verb', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
    expect(limiter.consume('u1:settings.update').allowed).toBe(true);
    expect(limiter.consume('u2:settings.update').allowed).toBe(true);
    expect(limiter.consume('u1:node.create').allowed).toBe(true);
    expect(limiter.consume('u1:settings.update').allowed).toBe(false);
  });

  it('slides the window', () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => t });
    limiter.consume('k', 2);
    expect(limiter.consume('k').allowed).toBe(false);
    t = 60_001;
    expect(limiter.consume('k').allowed).toBe(true);
  });

  it('rejects an oversized batch atomically without consuming', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => 0 });
    limiter.consume('k', 2);
    expect(limiter.consume('k', 2).allowed).toBe(false);
    // the failed batch consumed nothing — one more single still fits
    expect(limiter.consume('k', 1).allowed).toBe(true);
  });
});
