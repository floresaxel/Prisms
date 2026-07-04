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

import { createAuth, type Auth } from './auth';
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
