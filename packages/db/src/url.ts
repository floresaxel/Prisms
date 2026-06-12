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

export function resolveDatabaseUrl(database = 'prisms'): string {
  loadRootEnv();
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const port = process.env.PRISMS_POSTGRES_PORT ?? '5432';
  return `postgresql://prisms:prisms_dev_password@localhost:${port}/${database}`;
}
