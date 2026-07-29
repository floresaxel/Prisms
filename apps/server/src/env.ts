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
  /**
   * Origins allowed to make cookie-bearing cross-origin requests (CSRF +
   * CORS, §13). The API's own origin is always trusted. Browsers send an
   * Origin header on every POST; native clients without one can only
   * sign in cookie-less (their first login) — re-auth flows must send an
   * Origin/Referer or use a trusted scheme here.
   */
  trustedOrigins: string[];
  powersync: PowersyncJwtConfig;
  rateLimit: { limit: number; windowMs: number };
  /** SEC-2/F1: per-IP throttle on the credential endpoints. */
  authRateLimit: { limit: number; windowMs: number };
  /** SEC-2/F10: refuse new self-service registrations (PRISMS_DISABLE_SIGNUP=1). */
  disableSignUp: boolean;
  /** SEC-2/F10: minimum password length. */
  minPasswordLength: number;
  /** Start pg-boss workers (§11). Disable for API-only deployments or tests. */
  jobsEnabled: boolean;
}

/**
 * SEC-1/F4: parse a numeric env var STRICTLY. `Number('unset-by-typo')` is NaN,
 * and NaN silently disables the thing it configures — `recent.length + count >
 * NaN` is always false in rate-limit.ts, so a typo'd COMMAND_RATE_LIMIT left the
 * limiter permanently open with no error anywhere. A bad value is now a boot
 * failure: loud and immediate beats silently unprotected.
 */
/** True when `url` addresses this machine only (the dev-secret escape hatch's blast radius). */
function isLoopbackOrigin(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false; // unparseable ⇒ treat as reachable, i.e. refuse
  }
}

function positiveIntEnv(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `[prisms-api] FATAL: ${name} must be a positive integer, got ${JSON.stringify(raw)} ` +
        '(a non-numeric value would silently disable the limit it configures).',
    );
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  loadRootEnv();
  const port = positiveIntEnv('PORT', env.PORT, 3001);

  const baseUrl = env.BETTER_AUTH_URL ?? `http://localhost:${port}`;

  const betterAuthSecret = env.BETTER_AUTH_SECRET ?? DEV_AUTH_SECRET;
  const powersyncSecret = env.POWERSYNC_JWT_SECRET ?? DEV_POWERSYNC_SECRET;
  const usingDevSecret = betterAuthSecret === DEV_AUTH_SECRET || powersyncSecret === DEV_POWERSYNC_SECRET;
  if (usingDevSecret) {
    // S4-F4: in production, dev-default secrets are FATAL, not a warning — a
    // deploy that forgot to set them would sign forgeable sessions/tokens. The
    // escape hatch is for intentional non-prod-mode runs (a local smoke test).
    if (env.NODE_ENV === 'production' && env.PRISMS_ALLOW_DEV_SECRETS !== '1') {
      throw new Error(
        '[prisms-api] FATAL: dev-default secrets active in production — set BETTER_AUTH_SECRET and ' +
          'POWERSYNC_JWT_SECRET (or PRISMS_ALLOW_DEV_SECRETS=1 to override intentionally) (§13).',
      );
    }
    // SEC-1/F16: the escape hatch exists for a LOCAL smoke test, so scope it to
    // one. These secrets are published in this repo — anyone can mint a session
    // cookie or a PowerSync token for any `sub` (i.e. read any user's rows).
    // Allowing that on a non-loopback origin is never an intentional trade-off,
    // it is a misconfiguration, so refuse rather than warn.
    if (env.NODE_ENV === 'production' && !isLoopbackOrigin(baseUrl)) {
      throw new Error(
        `[prisms-api] FATAL: PRISMS_ALLOW_DEV_SECRETS=1 is only honoured for a loopback BETTER_AUTH_URL; ` +
          `got ${JSON.stringify(baseUrl)}. The dev secrets are public in this repository — on a reachable ` +
          'origin they let anyone forge sessions and PowerSync tokens for ANY user (§13).',
      );
    }
    console.warn(
      '[prisms-api] WARNING: dev secrets active (BETTER_AUTH_SECRET / POWERSYNC_JWT_SECRET unset) — never use in production (§13)',
    );
  }
  // S10-F5: the PowerSync jwks `k` (PS_JWT_K_B64URL) must equal base64url(secret).
  // A mismatch (typo, rotating one but not the other) boots every service healthy
  // yet every PowerSync token fails validation — the app renders but never syncs,
  // with nothing pointing at the cause. Verify at boot when the var is present.
  const jwkB64 = env.PS_JWT_K_B64URL;
  if (jwkB64 !== undefined && jwkB64.length > 0) {
    const derived = Buffer.from(powersyncSecret, 'utf8').toString('base64url');
    if (derived !== jwkB64) {
      throw new Error(
        '[prisms-api] FATAL: PS_JWT_K_B64URL does not match base64url(POWERSYNC_JWT_SECRET); every PowerSync ' +
          "token would fail validation (S10-F5). Re-derive: printf %s \"$PS_JWT_SECRET\" | basenc --base64url | tr -d '='.",
      );
    }
  }

  return {
    port,
    baseUrl,
    databaseUrl: resolveDatabaseUrl(),
    betterAuthSecret,
    trustedOrigins: (env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    powersync: {
      secret: powersyncSecret,
      kid: env.POWERSYNC_JWT_KID ?? 'powersync-dev',
      audience: env.POWERSYNC_JWT_AUDIENCE ?? 'powersync-dev',
      // short-lived (§13); PowerSync clients re-fetch on expiry
      ttlSeconds: positiveIntEnv('POWERSYNC_JWT_TTL_SECONDS', env.POWERSYNC_JWT_TTL_SECONDS, 300),
    },
    rateLimit: {
      limit: positiveIntEnv('COMMAND_RATE_LIMIT', env.COMMAND_RATE_LIMIT, 120),
      windowMs: 60_000,
    },
    authRateLimit: {
      limit: positiveIntEnv('AUTH_RATE_LIMIT', env.AUTH_RATE_LIMIT, 10),
      windowMs: 60_000,
    },
    disableSignUp: env.PRISMS_DISABLE_SIGNUP === '1',
    minPasswordLength: positiveIntEnv('PRISMS_MIN_PASSWORD_LENGTH', env.PRISMS_MIN_PASSWORD_LENGTH, 12),
    jobsEnabled: env.PRISMS_JOBS_ENABLED !== 'false',
  };
}
