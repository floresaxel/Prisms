/**
 * SEC-2/F1: the credential-endpoint throttle must not be steerable by the client.
 *
 * The bug: nginx used `X-Forwarded-For $proxy_add_x_forwarded_for` (append) and
 * better-auth resolves the client IP as `xff.split(",")[0]` — the element the
 * client controls. Rotating that header per request gave every password guess a
 * fresh bucket, so the sign-in cap never fired.
 *
 * These tests exercise the limiter middleware directly (no DB): the auth handler
 * itself is never reached, because the 429 is returned before it.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { describe, expect, it } from 'vitest';

import { TRUSTED_CLIENT_IP_HEADER } from '../src/auth';
import { createRateLimiter } from '../src/rate-limit';

/**
 * A faithful copy of the middleware wired in app.ts. Kept in the test rather
 * than booting createApp() so these cases need no Postgres; the app-level
 * integration path is covered by api.integration.test.ts.
 */
function throttleApp(limit: number) {
  const CREDENTIAL_PATHS = ['sign-in', 'sign-up', 'change-password', 'change-email', 'forget-password', 'reset-password'];
  const limiter = createRateLimiter({ limit, windowMs: 60_000 });
  const clientIpKey = (c: Context): string => c.req.header(TRUSTED_CLIENT_IP_HEADER)?.trim() || 'unknown-peer';

  const mw: MiddlewareHandler = async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (!CREDENTIAL_PATHS.some((verb) => path.includes(verb))) return next();
    const res = limiter.consume(`auth-ip:${clientIpKey(c)}`);
    if (!res.allowed) {
      c.header('Retry-After', String(res.retryAfterSeconds));
      return c.json({ error: 'E_RATE_LIMITED', retry_after_seconds: res.retryAfterSeconds }, 429);
    }
    return next();
  };

  const app = new Hono();
  app.use('/api/auth/*', mw);
  app.all('/api/auth/*', (c) => c.json({ reached: true }));
  return app;
}

const signIn = (app: Hono, headers: Record<string, string> = {}) =>
  app.request('/api/auth/sign-in/email', { method: 'POST', headers });

describe('SEC-2/F1 — credential throttle', () => {
  it('throttles repeated sign-in attempts from one client', async () => {
    const app = throttleApp(3);
    const ip = { [TRUSTED_CLIENT_IP_HEADER]: '203.0.113.7' };
    for (let i = 0; i < 3; i += 1) expect((await signIn(app, ip)).status).toBe(200);

    const blocked = await signIn(app, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    await expect(blocked.json()).resolves.toMatchObject({ error: 'E_RATE_LIMITED' });
  });

  it('REGRESSION: a rotating X-Forwarded-For no longer buys fresh buckets', async () => {
    const app = throttleApp(3);
    // The exact attack: a different forged XFF on every request. The limiter keys
    // on the proxy-set header, which the attacker cannot write, so all of these
    // land in the SAME bucket.
    const attempt = (n: number) =>
      signIn(app, {
        [TRUSTED_CLIENT_IP_HEADER]: '198.51.100.9', // what nginx observed
        'x-forwarded-for': `10.0.0.${n}, 198.51.100.9`, // what the attacker claims
      });

    for (let i = 1; i <= 3; i += 1) expect((await attempt(i)).status).toBe(200);
    expect((await attempt(4)).status).toBe(429);
    expect((await attempt(5)).status).toBe(429);
  });

  it('keeps distinct real clients in distinct buckets', async () => {
    const app = throttleApp(2);
    const a = { [TRUSTED_CLIENT_IP_HEADER]: '203.0.113.1' };
    const b = { [TRUSTED_CLIENT_IP_HEADER]: '203.0.113.2' };
    expect((await signIn(app, a)).status).toBe(200);
    expect((await signIn(app, a)).status).toBe(200);
    expect((await signIn(app, a)).status).toBe(429);
    // b is unaffected by a's exhaustion.
    expect((await signIn(app, b)).status).toBe(200);
  });

  it('fails CLOSED into a shared bucket when no trusted IP header is present', async () => {
    const app = throttleApp(2);
    // better-auth would skip limiting entirely here (`if (!ip) return null`).
    // Over-throttling is the safe failure; unbounded guessing is not.
    expect((await signIn(app)).status).toBe(200);
    expect((await signIn(app)).status).toBe(200);
    expect((await signIn(app)).status).toBe(429);
  });

  it('does not throttle session reads', async () => {
    const app = throttleApp(2);
    const ip = { [TRUSTED_CLIENT_IP_HEADER]: '203.0.113.5' };
    for (let i = 0; i < 20; i += 1) {
      expect((await app.request('/api/auth/get-session', { headers: ip })).status).toBe(200);
    }
  });

  it('covers every credential verb, not just sign-in', async () => {
    for (const verb of ['sign-up/email', 'change-password', 'forget-password', 'reset-password']) {
      const app = throttleApp(1);
      const ip = { [TRUSTED_CLIENT_IP_HEADER]: '203.0.113.9' };
      expect((await app.request(`/api/auth/${verb}`, { method: 'POST', headers: ip })).status).toBe(200);
      expect((await app.request(`/api/auth/${verb}`, { method: 'POST', headers: ip })).status).toBe(429);
    }
  });
});
