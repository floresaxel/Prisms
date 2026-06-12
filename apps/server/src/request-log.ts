/**
 * Structured request logging (§13/S10): one JSON line per request.
 */
import type { MiddlewareHandler } from 'hono';

export function requestLog(
  write: (line: string) => void = console.log,
): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = Date.now();
    await next();
    write(
      JSON.stringify({
        t: new Date().toISOString(),
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: c.res.status,
        ms: Date.now() - startedAt,
      }),
    );
  };
}
