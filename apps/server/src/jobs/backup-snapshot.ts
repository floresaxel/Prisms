/**
 * backup.snapshot (§13.1, R20): assemble a portable, versioned export of a user's
 * rows-as-data. Secrets are never exported — the `tables` registry already
 * excludes push_subscriptions and auth, so iterating it is safe. command_log goes
 * into the non-replayable `command_history` field; everything else is restorable
 * data. `hlc_high_water` lets an importer advance its clock past the export so HLC
 * monotonicity holds (the import RESTORES rows, it does not replay history).
 */
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  LEGACY_HLC,
  ROW_SCHEMA_VERSION,
  type ExportManifest,
} from '@prisms/core';
import { tables } from '@prisms/db';
import { eq, getTableColumns } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import type { JobClock } from './clock';

const SERVER_DEVICE = 'server-backup';

export async function runBackupSnapshot(db: PostgresJsDatabase, userId: string, clock: JobClock): Promise<ExportManifest> {
  const exportedAt = new Date(clock.now()).toISOString();
  const out: Record<string, Record<string, unknown>[]> = {};
  let commandHistory: Record<string, unknown>[] = [];
  let highWater = LEGACY_HLC;

  for (const [name, table] of Object.entries(tables)) {
    const cols = getTableColumns(table as PgTable) as Record<string, PgColumn>;
    const rows = (await db.select().from(table as PgTable).where(eq(cols['user_id']!, userId))) as Record<string, unknown>[];
    if (name === 'command_log') {
      commandHistory = rows; // recoverable but non-replayable (§13.1)
      continue;
    }
    out[name] = rows;
    for (const row of rows) {
      const hlc = row['hlc'];
      if (typeof hlc === 'string' && hlc > highWater) highWater = hlc;
    }
  }

  return {
    format: EXPORT_FORMAT,
    format_version: EXPORT_FORMAT_VERSION,
    schema_version: ROW_SCHEMA_VERSION,
    exported_at: exportedAt,
    device_id: SERVER_DEVICE,
    hlc_high_water: highWater,
    tables: out as ExportManifest['tables'],
    command_history: commandHistory as ExportManifest['command_history'],
  };
}
