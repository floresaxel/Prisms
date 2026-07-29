/**
 * Better Auth (§4, §13): email+password, drizzle adapter over the auth tables
 * in @prisms/db. Ids are forced to UUIDs so better-auth's user.id is always a
 * valid value for the domain tables' `user_id uuid` columns and for the
 * PowerSync JWT `sub` claim.
 */
import { randomUUID } from 'node:crypto';

import { authSchema } from '@prisms/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

export interface AuthConfig {
  baseUrl: string;
  secret: string;
  /** Extra origins allowed for cookie-bearing requests (the baseUrl origin is always trusted). */
  trustedOrigins?: string[];
  /**
   * SEC-2/F10: refuse new self-service registrations. A self-hosted family
   * deployment provisions its handful of accounts once; leaving sign-up open on
   * an internet-reachable origin lets anyone create accounts (each seeding rows
   * and PowerSync buckets on a small single node).
   */
  disableSignUp?: boolean;
  /** SEC-2/F10: minimum password length (better-auth's own default is 8). */
  minPasswordLength?: number;
}

/**
 * SEC-2/F1: the header carrying the client IP that better-auth keys its
 * brute-force limiter on.
 *
 * better-auth defaults to `x-forwarded-for` and reads element 0 of the list,
 * which the client can set. nginx now OVERWRITES both X-Real-IP and
 * X-Forwarded-For with the observed peer address (infra/nginx/web.conf), so
 * either is trustworthy behind the supported topology; pinning the single-valued
 * X-Real-IP removes the list-parsing question entirely.
 *
 * NOTE: better-auth SKIPS rate limiting altogether when it cannot resolve an IP
 * (`if (!ip) return null` in dist/api/rate-limiter/index.mjs) — it fails OPEN.
 * That is why this is defence in depth only; the fail-CLOSED limiter in app.ts
 * is the control we actually rely on.
 */
export const TRUSTED_CLIENT_IP_HEADER = 'x-real-ip';

export function createAuth(db: PostgresJsDatabase, config: AuthConfig) {
  return betterAuth({
    baseURL: config.baseUrl,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins ?? [],
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
    emailAndPassword: {
      enabled: true,
      // SEC-2/F10: opt-in lockdown for a provisioned deployment (PRISMS_DISABLE_SIGNUP=1).
      disableSignUp: config.disableSignUp ?? false,
      // SEC-2/F10: better-auth's default floor is 8 with no complexity rule. On a
      // box where the sign-in throttle is the only other barrier, 8 is thin.
      minPasswordLength: config.minPasswordLength ?? 12,
    },
    // S4-F5: rate-limit the auth endpoints (brute-force bound on sign-in/up). Made
    // explicit rather than relying on better-auth's implicit default; ON in
    // production, OFF in test so the suite's rapid sign-ins don't hit 429. The
    // in-memory store is fine for v1's single node (§13).
    rateLimit: {
      enabled: process.env.NODE_ENV === 'production',
      window: 60,
      max: 100,
    },
    advanced: {
      database: {
        generateId: () => randomUUID(),
      },
      // SEC-2/F1: read the client IP from the proxy-set header only — never from
      // a client-suppliable X-Forwarded-For list (see TRUSTED_CLIENT_IP_HEADER).
      ipAddress: {
        ipAddressHeaders: [TRUSTED_CLIENT_IP_HEADER],
      },
      // better-auth silently skips its CSRF origin check when it detects a
      // test environment; pin it on so vitest exercises exactly the
      // production behavior (§13) and the suite can assert the 403s.
      disableOriginCheck: false,
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
