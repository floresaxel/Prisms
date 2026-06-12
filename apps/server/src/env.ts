/**
 * Server configuration. Reads process.env (plus the repo-root .env via
 * @prisms/db's loader) and falls back to dev-stack defaults that match
 * infra/powersync/powersync.yaml. Production deployments must override both
 * secrets — the server warns loudly when dev secrets are active.
 */
import { loadRootEnv, resolveDatabaseUrl } from '@prisms/db';

/** Matches the HS256 `k` (base64url) in infra/powersync/powersync.yaml. */
export const DEV_POWERSYNC_SECRET = 'prisms-dev-secret-change-me-32by';
export const DEV_AUTH_SECRET = 'prisms-dev-better-auth-secret-change-me';

export interface PowersyncJwtConfig {
  secret: string;
  kid: string;
  audience: string;
  ttlSeconds: number;
}

export interface ServerConfig {
  port: number;
  baseUrl: string;
  databaseUrl: string;
  betterAuthSecret: string;
  powersync: PowersyncJwtConfig;
  rateLimit: { limit: number; windowMs: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  loadRootEnv();
  const port = Number(env.PORT ?? 3001);

  const betterAuthSecret = env.BETTER_AUTH_SECRET ?? DEV_AUTH_SECRET;
  const powersyncSecret = env.POWERSYNC_JWT_SECRET ?? DEV_POWERSYNC_SECRET;
  if (betterAuthSecret === DEV_AUTH_SECRET || powersyncSecret === DEV_POWERSYNC_SECRET) {
    console.warn(
      '[prisms-api] WARNING: dev secrets active (BETTER_AUTH_SECRET / POWERSYNC_JWT_SECRET unset) — never use in production (§13)',
    );
  }

  return {
    port,
    baseUrl: env.BETTER_AUTH_URL ?? `http://localhost:${port}`,
    databaseUrl: resolveDatabaseUrl(),
    betterAuthSecret,
    powersync: {
      secret: powersyncSecret,
      kid: env.POWERSYNC_JWT_KID ?? 'powersync-dev',
      audience: env.POWERSYNC_JWT_AUDIENCE ?? 'powersync-dev',
      // short-lived (§13); PowerSync clients re-fetch on expiry
      ttlSeconds: Number(env.POWERSYNC_JWT_TTL_SECONDS ?? 300),
    },
    rateLimit: {
      limit: Number(env.COMMAND_RATE_LIMIT ?? 120),
      windowMs: 60_000,
    },
  };
}
