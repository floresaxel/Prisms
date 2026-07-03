/**
 * import.validate (§13.1, M6): a DRY-RUN over a portable export manifest. It
 * validates the format, counts rows, and detects rows whose id already exists for
 * this user (an import would overwrite/merge them), then emits `import_warning`
 * review items summarising the findings. It writes NO data rows — only the
 * informational review item(s). The actual restore is the client's job (M13).
 */
import { randomUUID } from 'node:crypto';

import { ROW_SCHEMA_VERSION, exportManifestSchema, type ImportConflict, type ImportReport } from '@prisms/core';
import { sync_review_items, tables } from '@prisms/db';
import { and, eq, getTableColumns, inArray } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import type { JobClock } from './clock';

async function emitImportWarning(
  db: PostgresJsDatabase,
  userId: string,
  at: string,
  title: string,
  detail: typeof sync_review_items.$inferInsert.detail,
): Promise<void> {
  await db.insert(sync_review_items).values({
    id: randomUUID(),
    user_id: userId,
    command_id: null,
    item_type: 'import_warning',
    severity: 'warning',
    title,
    detail,
    status: 'open',
    source_kind: 'server_job',
    created_at: at,
    updated_at: at,
  });
}

export async function runImportValidate(
  db: PostgresJsDatabase,
  userId: string,
  manifest: unknown,
  clock: JobClock,
): Promise<ImportReport> {
  const at = new Date(clock.now()).toISOString();

  const parsed = exportManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    const warnings = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).slice(0, 10);
    await emitImportWarning(db, userId, at, 'Import file is not a valid prisms-export', { warnings });
    return { format_ok: false, row_counts: {}, conflicts: [], warnings };
  }
  const m = parsed.data;

  const row_counts: Record<string, number> = {};
  for (const [name, rows] of Object.entries(m.tables)) row_counts[name] = rows.length;

  const warnings: string[] = [];
  if (m.schema_version > ROW_SCHEMA_VERSION) {
    warnings.push(`export schema_version ${m.schema_version} is newer than this server (${ROW_SCHEMA_VERSION}); unknown columns would be ignored`);
  }

  const conflicts: ImportConflict[] = [];
  for (const [name, rows] of Object.entries(m.tables)) {
    const table = (tables as Record<string, PgTable | undefined>)[name];
    if (!table) {
      warnings.push(`unknown table '${name}' would be ignored on import`);
      continue;
    }
    const cols = getTableColumns(table) as Record<string, PgColumn | undefined>;
    // singletons keyed by user_id (e.g. user_settings) have no id column; skip collision detection.
    if (!cols['id'] || !cols['user_id']) continue;
    const ids = rows.map((r) => r['id']).filter((x): x is string => typeof x === 'string');
    if (ids.length === 0) continue;
    const existing = (await db
      .select({ id: cols['id'] })
      .from(table)
      .where(and(eq(cols['user_id'], userId), inArray(cols['id'], ids)))) as { id: string }[];
    const existingIds = new Set(existing.map((e) => e.id));
    for (const id of ids) {
      if (existingIds.has(id)) conflicts.push({ table: name, id, reason: 'a row with this id already exists; import would overwrite or merge it' });
    }
  }

  if (conflicts.length > 0 || warnings.length > 0) {
    await emitImportWarning(db, userId, at, `Import dry-run found ${conflicts.length} conflict(s) and ${warnings.length} warning(s)`, {
      conflicts: conflicts.slice(0, 100),
      warnings,
    });
  }

  return { format_ok: true, row_counts, conflicts, warnings };
}
