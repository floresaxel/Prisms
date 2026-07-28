/**
 * SEC-1: boot-safety of the server config (no DB needed).
 *
 * Two classes of misconfiguration used to boot "successfully" into an insecure
 * state; both are now fatal at load:
 *   F4 — a non-numeric COMMAND_RATE_LIMIT became NaN, and `n + count > NaN` is
 *        always false, so the limiter silently allowed everything.
 *   F16 — PRISMS_ALLOW_DEV_SECRETS=1 let the repo-PUBLIC dev secrets sign real
 *        sessions and PowerSync tokens on a reachable origin.
 */
import { describe, expect, it } from 'vitest';

import { DEV_AUTH_SECRET, DEV_POWERSYNC_SECRET, loadConfig } from '../src/env';

/** A minimal env that loads cleanly; individual cases override one key. */
const baseEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  BETTER_AUTH_SECRET: 'test-better-auth-secret-32-bytes-long',
  POWERSYNC_JWT_SECRET: 'test-powersync-secret-32-bytes-long!',
  ...extra,
});

describe('loadConfig — numeric env validation (F4)', () => {
  it('defaults when the var is absent', () => {
    const config = loadConfig(baseEnv());
    expect(config.rateLimit.limit).toBe(120);
    expect(config.powersync.ttlSeconds).toBe(300);
    expect(config.port).toBe(3001);
  });

  it('accepts a valid positive integer', () => {
    expect(loadConfig(baseEnv({ COMMAND_RATE_LIMIT: '50' })).rateLimit.limit).toBe(50);
  });

  it.each(['abc', '', ' ', '0', '-5', '12.5', 'NaN', 'Infinity'])(
    'rejects COMMAND_RATE_LIMIT=%j rather than silently disabling the limiter',
    (raw) => {
      // '' falls back to the default by design (an unset-but-present var); every
      // other shape must throw instead of yielding NaN/0/negative.
      if (raw === '') {
        expect(loadConfig(baseEnv({ COMMAND_RATE_LIMIT: raw })).rateLimit.limit).toBe(120);
        return;
      }
      expect(() => loadConfig(baseEnv({ COMMAND_RATE_LIMIT: raw }))).toThrow(/COMMAND_RATE_LIMIT must be a positive integer/);
    },
  );

  it('rejects a non-numeric POWERSYNC_JWT_TTL_SECONDS and PORT', () => {
    expect(() => loadConfig(baseEnv({ POWERSYNC_JWT_TTL_SECONDS: 'soon' }))).toThrow(/POWERSYNC_JWT_TTL_SECONDS/);
    expect(() => loadConfig(baseEnv({ PORT: 'http' }))).toThrow(/PORT/);
  });
});

describe('loadConfig — dev-secret escape hatch is loopback-only (F16)', () => {
  const devSecrets = {
    BETTER_AUTH_SECRET: DEV_AUTH_SECRET,
    POWERSYNC_JWT_SECRET: DEV_POWERSYNC_SECRET,
  };

  it('is still fatal in production without the override', () => {
    expect(() => loadConfig({ ...devSecrets, NODE_ENV: 'production' })).toThrow(/dev-default secrets active in production/);
  });

  it('honours the override for a loopback origin (a local smoke test)', () => {
    const config = loadConfig({
      ...devSecrets,
      NODE_ENV: 'production',
      PRISMS_ALLOW_DEV_SECRETS: '1',
      BETTER_AUTH_URL: 'http://localhost:3001',
    });
    expect(config.betterAuthSecret).toBe(DEV_AUTH_SECRET);
  });

  it('refuses the override on a reachable origin', () => {
    expect(() =>
      loadConfig({
        ...devSecrets,
        NODE_ENV: 'production',
        PRISMS_ALLOW_DEV_SECRETS: '1',
        BETTER_AUTH_URL: 'https://prisms.example.com',
      }),
    ).toThrow(/only honoured for a loopback BETTER_AUTH_URL/);
  });

  it('refuses the override when the origin is unparseable', () => {
    expect(() =>
      loadConfig({
        ...devSecrets,
        NODE_ENV: 'production',
        PRISMS_ALLOW_DEV_SECRETS: '1',
        BETTER_AUTH_URL: 'not-a-url',
      }),
    ).toThrow(/only honoured for a loopback BETTER_AUTH_URL/);
  });

  it('leaves non-production runs alone', () => {
    expect(() => loadConfig({ ...devSecrets, BETTER_AUTH_URL: 'https://prisms.example.com' })).not.toThrow();
  });
});
