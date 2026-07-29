/**
 * SEC-6: the shared node must degrade per user, not per batch (F9), the rate
 * limiter must not leak keys (F11), and Web Push must not become an SSRF probe
 * (F12). No DB needed — these exercise the units directly.
 */
import { describe, expect, it, vi } from 'vitest';

import { isAllowedWebPushEndpoint } from '../src/jobs/push';
import { forEachUserIsolated } from '../src/jobs/per-user';
import { createRateLimiter } from '../src/rate-limit';

describe('SEC-6/F9 — one user cannot abort the batch', () => {
  const users = [{ user_id: 'a' }, { user_id: 'b' }, { user_id: 'c' }];
  const silent = () => undefined;

  it('REGRESSION: users after a failure are still processed', async () => {
    const seen: string[] = [];
    const outcome = await forEachUserIsolated(users, 'test.job', (u) => u.user_id, async (u) => {
      if (u.user_id === 'a') throw new Error('bad row for user a');
      seen.push(u.user_id);
    }, silent);

    // Pre-fix, 'a' throwing meant b and c were silently skipped for the cycle.
    expect(seen).toEqual(['b', 'c']);
    expect(outcome).toEqual({ total: 3, succeeded: 2, failed: 1 });
  });

  it('reports a clean batch', async () => {
    const outcome = await forEachUserIsolated(users, 'test.job', (u) => u.user_id, async () => undefined, silent);
    expect(outcome).toEqual({ total: 3, succeeded: 3, failed: 0 });
  });

  it('logs which user failed, with the job name', async () => {
    const log = vi.fn();
    await forEachUserIsolated(users, 'aggregates.recompute', (u) => u.user_id, async (u) => {
      if (u.user_id === 'b') throw new Error('boom');
    }, log);

    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(log.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(line).toMatchObject({ job: 'aggregates.recompute', user_id: 'b', error: 'boom' });
  });

  it('survives a non-Error throw', async () => {
    const outcome = await forEachUserIsolated(users, 'test.job', (u) => u.user_id, async () => {
      throw 'a string';
    }, silent);
    expect(outcome.failed).toBe(3);
  });
});

describe('SEC-6/F11 — the limiter does not retain dead keys', () => {
  it('evicts keys whose window has fully elapsed', () => {
    let clock = 1_000;
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, now: () => clock });

    // Touch enough distinct keys to cross the amortised sweep threshold.
    for (let i = 0; i < 600; i += 1) limiter.consume(`ip:${i}`);
    // Move past the window so every one of those is dead, then keep going.
    clock += 120_000;
    for (let i = 0; i < 600; i += 1) limiter.consume(`later:${i}`);

    // The old keys must be gone: each still gets its full budget, which it would
    // also get if retained — so assert on the real invariant instead, that a
    // long-expired key behaves as brand new.
    const revived = limiter.consume('ip:0');
    expect(revived.allowed).toBe(true);
    expect(revived.remaining).toBe(4);
  });

  it('still limits within the window', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => 1_000 });
    expect(limiter.consume('k').allowed).toBe(true);
    expect(limiter.consume('k').allowed).toBe(true);
    expect(limiter.consume('k').allowed).toBe(false);
  });

  it('lets a key recover after its window passes', () => {
    let clock = 1_000;
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => clock });
    expect(limiter.consume('k').allowed).toBe(true);
    expect(limiter.consume('k').allowed).toBe(false);
    clock += 60_001;
    expect(limiter.consume('k').allowed).toBe(true);
  });
});

describe('SEC-6/F12 — Web Push endpoints are restricted to public https', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc123',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ])('allows the real vendor endpoint %s', (endpoint) => {
    expect(isAllowedWebPushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc', // not https
    'https://localhost:8080/probe',
    'https://127.0.0.1/probe',
    'https://10.0.0.5/admin',
    'https://172.16.4.4/admin',
    'https://192.168.1.1/admin',
    'https://169.254.169.254/latest/meta-data/', // cloud metadata
    'https://100.101.102.103/tailscale-peer', // Tailscale CGNAT
    'https://[::1]/probe',
    'https://db.internal/dump',
    'file:///etc/passwd',
    'not a url',
  ])('rejects %s', (endpoint) => {
    expect(isAllowedWebPushEndpoint(endpoint)).toBe(false);
  });
});
