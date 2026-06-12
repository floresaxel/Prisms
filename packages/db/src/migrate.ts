/**
 * Forward-only migration runner (§16). Applies ./migrations to the target
 * database; drizzle records applied entries in `drizzle_migrations`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await migrate(drizzle(client), {
      migrationsFolder,
      migrationsTable: 'drizzle_migrations',
    });
  } finally {
    await client.end();
  }
}
