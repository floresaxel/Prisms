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
import { Hono, type MiddlewareHandler } from 'hono';
import { SignJWT } from 'jose';
import postgres from 'postgres';

import { createAuth, type Auth } from './auth';
import { createDispatcher } from './dispatcher';
import type { PowersyncJwtConfig } from './env';
import { createRateLimiter } from './rate-limit';
import { requestLog } from './request-log';

export interface AppOptions {
  databaseUrl: string;
  baseUrl?: string;
  betterAuthSecret: string;
  powersync: PowersyncJwtConfig;
  rateLimit: { limit: number; windowMs: number };
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
  const auth = createAuth(db, {
    baseUrl: options.baseUrl ?? 'http://localhost:3001',
    secret: options.betterAuthSecret,
  });
  const limiter = createRateLimiter(options.rateLimit);
  const dispatcher = createDispatcher(db, limiter);
  const powersyncKey = new TextEncoder().encode(options.powersync.secret);

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

  app.get('/health', (c) => c.json({ status: 'ok', service: 'prisms-api' }));

  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  // Better Auth session → short-lived JWT consumable by PowerSync (§13).
  // HS256 with the shared key from infra/powersync/powersync.yaml; sub is the
  // user id that sync rules scope buckets to (request.user_id(), §7.3).
  app.get('/api/powersync/token', requireSession, async (c) => {
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

  app.post('/sync/upload', requireSession, async (c) => {
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

  return {
    app,
    auth,
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}
