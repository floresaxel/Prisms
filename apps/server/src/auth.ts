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
}

export function createAuth(db: PostgresJsDatabase, config: AuthConfig) {
  return betterAuth({
    baseURL: config.baseUrl,
    secret: config.secret,
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
    emailAndPassword: { enabled: true },
    advanced: {
      database: {
        generateId: () => randomUUID(),
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
