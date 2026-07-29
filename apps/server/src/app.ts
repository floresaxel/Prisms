/**
 * Hono app factory (§13, S10). Routes:
 * - GET  /health                 liveness
 * - *    /api/auth/*             Better Auth (email+password sessions)
 * - GET  /api/powersync/token    short-lived HS256 JWT for PowerSync
 * - POST /sync/upload            command dispatcher (settings.update, s10)
 *
 * Returned as a factory so tests run the app in-process via app.request()
 * against a throwaway database.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { SignJWT } from 'jose';
import postgres from 'postgres';

import { createAuth, TRUSTED_CLIENT_IP_HEADER, type Auth } from './auth';
import { createDispatcher, type BackstopJob } from './dispatcher';
import type { PowersyncJwtConfig } from './env';
import { runBackupSnapshot } from './jobs/backup-snapshot';
import { systemClock } from './jobs/clock';
import { runImportRestore } from './jobs/import-restore';
import { runImportValidate } from './jobs/import-validate';
import { runJournalExport } from './jobs/journal-export';
import { createRateLimiter } from './rate-limit';
import { requestLog } from './request-log';

export interface AppOptions {
  databaseUrl: string;
  baseUrl?: string;
  betterAuthSecret: string;
  /** Cross-origin clients allowed to use cookie auth (CSRF + CORS, §13). */
  trustedOrigins?: string[];
  powersync: PowersyncJwtConfig;
  rateLimit: { limit: number; windowMs: number };
  /** SEC-2/F1: credential-endpoint throttle (per client IP). Defaults to 10/min. */
  authRateLimit?: { limit: number; windowMs: number };
  /** SEC-2/F10: refuse new self-service registrations. */
  disableSignUp?: boolean;
  /** SEC-2/F10: minimum password length (default 12). */
  minPasswordLength?: number;
  /** Fire automation.backstop on completions/creations (§9.4); wired to pg-boss in main.ts. */
  enqueueBackstop?: (job: BackstopJob) => void;
  /** Disable request logging (tests). */
  quiet?: boolean;
}

type AppEnv = { Variables: { userId: string } };

export interface PrismsServer {
  app: Hono<AppEnv>;
  auth: Auth;
  close(): Promise<void>;
}

export function createApp(options: AppOptions): PrismsServer {
  const client = postgres(options.databaseUrl, { max: 10, onnotice: () => undefined });
  const db = drizzle(client);
  const baseUrl = options.baseUrl ?? 'http://localhost:3001';
  const trustedOrigins = options.trustedOrigins ?? [];
  const auth = createAuth(db, {
    baseUrl,
    secret: options.betterAuthSecret,
    trustedOrigins,
    disableSignUp: options.disableSignUp,
    minPasswordLength: options.minPasswordLength,
  });
  const limiter = createRateLimiter(options.rateLimit);
  const dispatcher = createDispatcher(db, limiter, { enqueueBackstop: options.enqueueBackstop });
  const powersyncKey = new TextEncoder().encode(options.powersync.secret);

  // S4-F5: a dedicated limiter for the heavy/sensitive per-user endpoints (token
  // mint, export snapshot, import restore), separate from the command limiter. A
  // modest per-user-per-minute ceiling — abuse-bounding, not a UX limit.
  const endpointLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });
  const rateGate = (c: Context<AppEnv>, key: string): Response | null => {
    const r = endpointLimiter.consume(key);
    if (r.allowed) return null;
    c.header('Retry-After', String(r.retryAfterSeconds));
    return c.json({ error: 'E_RATE_LIMITED', retry_after_seconds: r.retryAfterSeconds }, 429);
  };

  const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) {
      return c.json({ error: 'E_UNAUTHENTICATED', message: 'sign in first' }, 401);
    }
    c.set('userId', session.user.id);
    await next();
  };

  const app = new Hono<AppEnv>();
  if (!options.quiet) app.use('*', requestLog());

  // CORS for browser clients on other origins (e.g. the Vite dev server);
  // same allow-list better-auth uses for its CSRF origin check. Untrusted
  // origins get no CORS headers, so their scripted responses stay opaque.
  const allowedOrigins = new Set([new URL(baseUrl).origin, ...trustedOrigins]);
  const corsMiddleware = cors({
    origin: (origin) => (allowedOrigins.has(origin) ? origin : undefined),
    credentials: true,
    maxAge: 600,
  });
  app.use('/api/*', corsMiddleware);
  app.use('/sync/*', corsMiddleware);

  app.get('/health', (c) => c.json({ status: 'ok', service: 'prisms-api' }));

  // --- SEC-2/F1: credential-endpoint brute-force throttle ---------------------
  // better-auth ships its own per-IP limiter, but it FAILS OPEN: when it cannot
  // resolve a client IP it skips limiting entirely (`if (!ip) return null` in
  // dist/api/rate-limiter/index.mjs), and it is disabled outside production. This
  // limiter is the one we rely on — it is always on and it fails CLOSED.
  //
  // Only the credential-bearing verbs are throttled. /api/auth/get-session is
  // polled by every client on load and must not be rate-limited.
  const CREDENTIAL_PATHS = ['sign-in', 'sign-up', 'change-password', 'change-email', 'forget-password', 'reset-password'];
  const authLimiter = createRateLimiter(options.authRateLimit ?? { limit: 10, windowMs: 60_000 });
  /**
   * The client IP, taken ONLY from the header the reverse proxy overwrites
   * (never a client-suppliable XFF list). When it is absent — a topology where
   * the API is reached directly — every request collapses into one shared
   * bucket. That is deliberate: a shared bucket over-throttles, which is a UX
   * annoyance, whereas skipping the limit leaves password guessing unbounded.
   */
  let warnedNoClientIp = false;
  const clientIpKey = (c: Context<AppEnv>): string => {
    const ip = c.req.header(TRUSTED_CLIENT_IP_HEADER)?.trim();
    if (ip) return ip;
    // Make the degraded mode diagnosable: a shared bucket produces 429s that
    // look inexplicable ("I only signed in twice") unless you know every caller
    // is being counted together. Warn once per process, not per request.
    if (!warnedNoClientIp && !options.quiet) {
      warnedNoClientIp = true;
      console.warn(
        JSON.stringify({
          msg: `no ${TRUSTED_CLIENT_IP_HEADER} header — credential throttling is falling back to a SINGLE shared bucket for all callers. ` +
            'Put the API behind the bundled reverse proxy (which sets it), or raise AUTH_RATE_LIMIT for this environment (SEC-2).',
          limit: (options.authRateLimit ?? { limit: 10 }).limit,
        }),
      );
    }
    return 'unknown-peer';
  };

  app.use('/api/auth/*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (!CREDENTIAL_PATHS.some((verb) => path.includes(verb))) return next();
    const res = authLimiter.consume(`auth-ip:${clientIpKey(c)}`);
    if (!res.allowed) {
      c.header('Retry-After', String(res.retryAfterSeconds));
      return c.json({ error: 'E_RATE_LIMITED', retry_after_seconds: res.retryAfterSeconds }, 429);
    }
    return next();
  });

  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  // Better Auth session → short-lived JWT consumable by PowerSync (§13).
  // HS256 with the shared key from infra/powersync/powersync.yaml; sub is the
  // user id that sync rules scope buckets to (request.user_id(), §7.3).
  app.get('/api/powersync/token', requireSession, async (c) => {
    const limited = rateGate(c, `${c.get('userId')}:ps-token`);
    if (limited) return limited;
    const expiresAtSeconds =
      Math.floor(Date.now() / 1000) + options.powersync.ttlSeconds;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: options.powersync.kid })
      .setSubject(c.get('userId'))
      .setAudience(options.powersync.audience)
      .setIssuedAt()
      .setExpirationTime(expiresAtSeconds)
      .sign(powersyncKey);
    return c.json({
      token,
      expires_at: new Date(expiresAtSeconds * 1000).toISOString(),
    });
  });

  // S4-F6: bound the upload body (a batch of command envelopes) at 2 MB — larger
  // than any legitimate chunked upload (R6 caps batches at 100 commands), small
  // enough to reject a memory-exhaustion attempt before parsing.
  const uploadBodyLimit = bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (c) => c.json({ error: 'E_TOO_LARGE', message: 'upload body exceeds 2 MB' }, 413),
  });
  app.post('/sync/upload', requireSession, uploadBodyLimit, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'E_PARSE', message: 'body must be JSON' }, 400);
    }
    const outcome = await dispatcher.handleUpload(c.get('userId'), body);
    switch (outcome.kind) {
      case 'parse_error':
        return c.json({ error: 'E_PARSE', issues: outcome.issues }, 400);
      case 'rate_limited':
        c.header('Retry-After', String(outcome.retryAfterSeconds));
        return c.json(
          { error: 'E_RATE_LIMITED', verb: outcome.verb, retry_after_seconds: outcome.retryAfterSeconds },
          429,
        );
      case 'ok':
        return c.json({ results: outcome.results });
    }
  });

  // Portable export (§13.1): a versioned prisms-export of the user's rows-as-data
  // (secrets excluded). The client optionally passphrase-encrypts it before saving.
  app.get('/sync/export', requireSession, async (c) => {
    const limited = rateGate(c, `${c.get('userId')}:export`);
    if (limited) return limited;
    const manifest = await runBackupSnapshot(db, c.get('userId'), systemClock);
    return c.json(manifest);
  });

  // D7: source for the per-day `.md` archive — ALL of a user's live journal notes,
  // date-ordered. Server-sourced (never the local replica): under the lazy
  // journal_month stream a fresh device holds only viewed months, so a local
  // "export all" would truncate. JSON; the client packages the .md files into a zip.
  app.get('/sync/journal/export', requireSession, async (c) => {
    const limited = rateGate(c, `${c.get('userId')}:journal-export`);
    if (limited) return limited;
    const entries = await runJournalExport(db, c.get('userId'));
    return c.json({ entries });
  });

  // Import (§13.1): `?dry_run=1` returns the validation report and writes only
  // import_warning items; otherwise the explicit import transaction RESTORES the
  // rows as data (never replays commands) and returns what it restored.
  // S4-F6: imports carry a full portable export (all of a user's rows-as-data),
  // so the ceiling is larger — 32 MB — but still bounded against exhaustion.
  const importBodyLimit = bodyLimit({
    maxSize: 32 * 1024 * 1024,
    onError: (c) => c.json({ error: 'E_TOO_LARGE', message: 'import body exceeds 32 MB' }, 413),
  });
  app.post('/sync/import', requireSession, importBodyLimit, async (c) => {
    const limited = rateGate(c, `${c.get('userId')}:import`);
    if (limited) return limited;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'E_PARSE', message: 'body must be JSON' }, 400);
    }
    const userId = c.get('userId');
    if (c.req.query('dry_run') !== undefined && c.req.query('dry_run') !== '0') {
      const report = await runImportValidate(db, userId, body, systemClock);
      return c.json(report);
    }
    const result = await runImportRestore(db, userId, body, systemClock);
    return c.json(result, result.ok ? 200 : 400);
  });

  return {
    app,
    auth,
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}
