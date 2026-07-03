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
}

export function createAuth(db: PostgresJsDatabase, config: AuthConfig) {
  return betterAuth({
    baseURL: config.baseUrl,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins ?? [],
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
    emailAndPassword: { enabled: true },
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
      // better-auth silently skips its CSRF origin check when it detects a
      // test environment; pin it on so vitest exercises exactly the
      // production behavior (§13) and the suite can assert the 403s.
      disableOriginCheck: false,
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
