/**
 * Database URL resolution for scripts and tests.
 *
 * Precedence: DATABASE_URL → compose defaults with PRISMS_POSTGRES_PORT (the
 * same variable the repo-root .env feeds to docker-compose port mappings).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

/** Loads the repo-root .env (port overrides) into process.env if present. */
export function loadRootEnv(): void {
  const envPath = path.join(repoRoot, '.env');
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch (error) {
    throw new Error(`failed to load ${envPath}`, { cause: error });
  }
}

/**
 * Refuse a connection URL that no driver can parse, at the point it is resolved.
 *
 * `docker-compose.prod.yml` interpolates POSTGRES_PASSWORD RAW into
 * `postgresql://user:PASSWORD@postgres:5432/db`, so a password holding `/` ends
 * the authority component early and the whole URI stops parsing — base64 output
 * contains `/` routinely, which is why `.env.example` requires a URL-SAFE value
 * (`openssl rand -hex 32`). That requirement was a comment and nothing else:
 * unguarded, the first symptom is postgres.js throwing `Invalid URL` from inside
 * the connection path, i.e. api + powersync crash-looping on a FRESH DEPLOY with
 * nothing naming the password as the cause.
 *
 * The check is the driver's own (both parse with WHATWG `URL`), so it cannot
 * reject a URL that postgres.js would have accepted. The message deliberately
 * does NOT include the URL: it embeds the password, and this throws on the exact
 * misconfigurations most likely to be pasted into an issue.
 */
function assertParsableUrl(url: string): string {
  try {
    new URL(url);
  } catch {
    throw new Error(
      '[prisms-db] FATAL: the resolved database URL does not parse. The usual cause is a ' +
        'POSTGRES_PASSWORD containing a character that ends the authority component — `/`, `@`, ' +
        '`?` or `#` (base64 output routinely contains `/`). Generate a URL-safe password with ' +
        '`openssl rand -hex 32`, or percent-encode it. See .env.example.',
    );
  }
  return url;
}

export function resolveDatabaseUrl(database = 'prisms'): string {
  loadRootEnv();
  if (process.env.DATABASE_URL) return assertParsableUrl(process.env.DATABASE_URL);
  const port = process.env.PRISMS_POSTGRES_PORT ?? '5432';
  return assertParsableUrl(`postgresql://prisms:prisms_dev_password@localhost:${port}/${database}`);
}
