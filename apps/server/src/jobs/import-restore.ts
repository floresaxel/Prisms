/**
 * import.restore (§13.1, R20; M13): the explicit import transaction that RESTORES
 * a portable export's rows as DATA — it never re-executes historical commands.
 *
 * Contract:
 *   - Ownership is server-assigned (R17): every restored row's `user_id` is forced
 *     to the importing user; a forged/foreign exported user_id is ignored.
 *   - Imported fact rows are stamped `source_kind='import'` + `source_detail` import
 *     metadata (§7.8), so provenance answers "restored from an import".
 *   - Deterministic convergence (§7.10): an id already present is resolved by HLC —
 *     a strictly-newer local row is KEPT (import skipped); otherwise the import
 *     overwrites. Either way a subsequent local write dominates (client HLC floor).
 *   - `command_history` is restored into `command_log` as non-replayable records
 *     (insert-if-absent; never dispatched).
 *   - Conflicts and unsupported input create `import_warning` review items (§7.13).
 *
 * Rows are restored in FK-dependency order; `nodes` are additionally ordered
 * parent-before-child for their self-FK. The whole restore is one transaction.
 */
import { randomUUID } from 'node:crypto';

import {
  exportManifestSchema,
  hlcCompareEncoded,
  importSourceDetail,
  isSupportedExportVersion,
  ROW_SCHEMA_VERSION,
  type ImportConflict,
} from '@prisms/core';
import { command_log, sync_review_items, tables, user_settings } from '@prisms/db';
import { eq, getTableColumns, inArray } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import type { JobClock } from './clock';

type Row = Record<string, unknown>;
type Tx = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

export interface ImportRestoreResult {
  ok: boolean;
  restored: Record<string, number>;
  conflicts: ImportConflict[];
  warnings: string[];
  reviewItemIds: string[];
}

/**
 * FK-dependency order for the id+hlc fact tables (parents before children).
 * `user_settings` (keyed by user_id, no hlc) and `command_log` (via
 * command_history) are restored separately. Every table here carries `id`+`hlc`.
 */
const RESTORE_ORDER = [
  // level 0 — no FK to another user table (nodes' self-FK is handled by ordering)
  'nodes',
  'tags',
  'decision_boards',
  'sprints',
  'automation_rules',
  'blocker_rules',
  'external_facts',
  'computed_aggregates',
  'schedule_suggestion_batches',
  'sync_review_items',
  'journal_entries', // J1 — no FK; one live note per (user, entry_date)
  // level 1 — FK to a level-0 table (habits/edges/blocks/entries/memberships/diagrams → nodes)
  'habits',
  'edges',
  'schedule_blocks',
  'time_entries',
  'decision_criteria',
  'sprint_memberships',
  'diagram_layouts',
  'diagram_groups',
  // level 2 — FK to a level-1 table
  'habit_completions',
  'tag_placements',
  'decision_scores',
  // level 3
  'tag_answers',
] as const;

/** Order `nodes` so a parent always precedes its children (self-FK parent_id). */
function nodesParentFirst(rows: Row[]): Row[] {
  const byId = new Map<string, Row>();
  for (const r of rows) if (typeof r['id'] === 'string') byId.set(r['id'] as string, r);
  const out: Row[] = [];
  const done = new Set<string>();
  const active = new Set<string>();
  const visit = (r: Row): void => {
    const id = r['id'];
    if (typeof id !== 'string' || done.has(id) || active.has(id)) return;
    active.add(id);
    const pid = r['parent_id'];
    if (typeof pid === 'string' && byId.has(pid)) visit(byId.get(pid)!);
    active.delete(id);
    done.add(id);
    out.push(r);
  };
  for (const r of rows) visit(r);
  return out;
}

/** Build the insert values: only known columns, ownership + import provenance forced. */
function toValues(row: Row, cols: Record<string, PgColumn>, userId: string, importDetail: Row | null, at: string): Row {
  const v: Row = {};
  for (const key of Object.keys(cols)) if (key in row) v[key] = row[key];
  v['user_id'] = userId; // R17: server-assigned ownership
  if (importDetail && 'source_kind' in cols) {
    v['source_kind'] = 'import';
    v['source_detail'] = importDetail;
    v['source_id'] = null;
  }
  if ('created_at' in cols && v['created_at'] == null) v['created_at'] = at;
  if ('updated_at' in cols && v['updated_at'] == null) v['updated_at'] = at;
  return v;
}

const setExceptId = (v: Row): Row => {
  const { id: _id, ...rest } = v;
  void _id;
  return rest;
};

async function emitImportWarning(tx: Tx, userId: string, at: string, title: string, detail: Row): Promise<string> {
  const id = randomUUID();
  await tx.insert(sync_review_items).values({
    id,
    user_id: userId,
    command_id: null,
    item_type: 'import_warning',
    severity: 'warning',
    title,
    detail: detail as typeof sync_review_items.$inferInsert.detail,
    status: 'open',
    source_kind: 'server_job',
    created_at: at,
    updated_at: at,
  });
  return id;
}

export async function runImportRestore(
  db: PostgresJsDatabase,
  userId: string,
  manifestInput: unknown,
  clock: JobClock,
): Promise<ImportRestoreResult> {
  const at = new Date(clock.now()).toISOString();

  const parsed = exportManifestSchema.safeParse(manifestInput);
  if (!parsed.success) {
    const warnings = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).slice(0, 10);
    const reviewItemIds = await db.transaction((tx) => emitImportWarning(tx, userId, at, 'Import file is not a valid prisms-export', { warnings }).then((x) => [x]));
    return { ok: false, restored: {}, conflicts: [], warnings, reviewItemIds };
  }
  const m = parsed.data;
  if (!isSupportedExportVersion(m.format_version)) {
    const warnings = [`export format version ${m.format_version} is not supported (this server: 1)`];
    const reviewItemIds = await db.transaction((tx) => emitImportWarning(tx, userId, at, 'Import format version not supported', { warnings }).then((x) => [x]));
    return { ok: false, restored: {}, conflicts: [], warnings, reviewItemIds };
  }

  const detail = importSourceDetail(m) as Row;
  const restored: Record<string, number> = {};
  const conflicts: ImportConflict[] = [];
  const warnings: string[] = [];
  const reviewItemIds: string[] = [];

  if (m.schema_version > ROW_SCHEMA_VERSION) {
    warnings.push(`export schema_version ${m.schema_version} is newer than this server (${ROW_SCHEMA_VERSION}); unknown columns were ignored`);
  }
  for (const name of Object.keys(m.tables)) {
    if (name !== 'user_settings' && !(RESTORE_ORDER as readonly string[]).includes(name)) {
      warnings.push(`unknown table '${name}' was ignored on import`);
    }
  }

  await db.transaction(async (tx) => {
    // id + hlc fact tables, in FK order
    for (const name of RESTORE_ORDER) {
      const rows = m.tables[name];
      if (!rows || rows.length === 0) continue;
      const table = (tables as Record<string, PgTable>)[name]!;
      const cols = getTableColumns(table) as Record<string, PgColumn>;

      // `id` is a GLOBAL primary key, so look up existing rows by id WITHOUT a
      // user filter: a colliding id owned by ANOTHER account must be skipped (never
      // stolen via the id-targeted upsert). Same-account collisions resolve by HLC.
      const ids = rows.map((r) => r['id']).filter((x): x is string => typeof x === 'string');
      const owner = new Map<string, { user_id: string; hlc: string }>();
      if (ids.length > 0) {
        const ex = (await tx
          .select({ id: cols['id']!, user_id: cols['user_id']!, hlc: cols['hlc']! })
          .from(table)
          .where(inArray(cols['id']!, ids))) as { id: string; user_id: string; hlc: string }[];
        for (const e of ex) owner.set(e.id, { user_id: e.user_id, hlc: e.hlc });
      }

      const ordered = name === 'nodes' ? nodesParentFirst(rows) : rows;
      let count = 0;
      for (const row of ordered) {
        const values = toValues(row, cols, userId, detail, at);
        const id = values['id'];
        if (typeof id !== 'string') continue;
        const existing = owner.get(id);
        const incomingHlc = String(values['hlc'] ?? '');
        if (existing !== undefined) {
          if (existing.user_id !== userId) {
            conflicts.push({ table: name, id, reason: 'id belongs to another account; import skipped (cross-account import needs id remapping)' });
            continue;
          }
          if (hlcCompareEncoded(existing.hlc, incomingHlc) >= 0) {
            conflicts.push({ table: name, id, reason: 'a newer local row was kept (LWW); import skipped' });
            continue;
          }
          conflicts.push({ table: name, id, reason: 'existing row overwritten by newer imported row' });
        }
        await tx
          .insert(table)
          .values(values as typeof table.$inferInsert)
          .onConflictDoUpdate({ target: cols['id']!, set: setExceptId(values) });
        count += 1;
      }
      restored[name] = count;
    }

    // user_settings — singleton keyed by user_id, no hlc (LWW by updated_at)
    const settings = m.tables['user_settings'];
    if (settings && settings.length > 0) {
      const row = settings[0]!;
      const cols = getTableColumns(user_settings) as Record<string, PgColumn>;
      const values = toValues(row, cols, userId, null, at);
      const existing = (await tx.select({ updated_at: user_settings.updated_at }).from(user_settings).where(eq(user_settings.user_id, userId))) as { updated_at: string }[];
      const incomingUpdated = String(values['updated_at'] ?? at);
      if (existing[0] && String(existing[0].updated_at) >= incomingUpdated) {
        conflicts.push({ table: 'user_settings', id: userId, reason: 'newer local settings kept (LWW); import skipped' });
      } else {
        await tx
          .insert(user_settings)
          .values(values as typeof user_settings.$inferInsert)
          .onConflictDoUpdate({ target: user_settings.user_id, set: setExceptId({ ...values, id: undefined }) });
        restored['user_settings'] = 1;
      }
    }

    // command_history → command_log, non-replayable (insert-if-absent, never dispatched)
    if (m.command_history && m.command_history.length > 0) {
      const cols = getTableColumns(command_log) as Record<string, PgColumn>;
      let count = 0;
      for (const row of m.command_history) {
        const values = toValues(row, cols, userId, null, at);
        if (typeof values['id'] !== 'string') continue;
        await tx.insert(command_log).values(values as typeof command_log.$inferInsert).onConflictDoNothing();
        count += 1;
      }
      restored['command_log'] = count;
    }

    if (conflicts.length > 0 || warnings.length > 0) {
      const id = await emitImportWarning(tx, userId, at, `Import restored data with ${conflicts.length} conflict(s) and ${warnings.length} warning(s)`, {
        conflicts: conflicts.slice(0, 100),
        warnings,
      });
      reviewItemIds.push(id);
    }
  });

  return { ok: true, restored, conflicts, warnings, reviewItemIds };
}
