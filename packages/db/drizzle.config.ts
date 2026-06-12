import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  // Migrations are forward-only (§16); never edit an applied migration.
  migrations: {
    table: 'drizzle_migrations',
  },
});
