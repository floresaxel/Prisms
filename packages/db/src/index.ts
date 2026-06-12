/**
 * @prisms/db — Drizzle schema mirroring ARCHITECTURE.md §6.0, forward-only
 * migrations, PowerSync sync-rules.yaml, and the demo seed.
 *
 * Imports from @prisms/core are types only (§5 dependency rules).
 */
export const DB_PACKAGE = '@prisms/db' as const;

export * from './schema';
export { account, authSchema, session, user, verification } from './auth-schema';
export { loadRootEnv, resolveDatabaseUrl } from './url';
export { runMigrations } from './migrate';
export { DEMO_USER_ID, seedDemoUser, type SeedSummary } from './seed';
