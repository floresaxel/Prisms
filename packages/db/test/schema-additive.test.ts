/**
 * S2-F2 / S6-F5 — the additive-only schema gate, made MECHANICAL. Migration 0008
 * was verified additive by inspection; migration 0009 would be verified by nobody.
 *
 * This derives each domain table's row shape from the live Drizzle schema and
 * asserts it is an ADDITIVE-ONLY change from a committed per-ROW_SCHEMA_VERSION
 * baseline (core `isAdditiveSchemaChange`, §7.11): a change may only ADD nullable
 * / defaulted columns. Removing a column, changing a type, or tightening NOT NULL
 * fails the test — so a breaking change can't merge silently. Making one requires a
 * MAJOR row-schema bump, which here is the explicit act of regenerating the
 * baseline:  UPDATE_SCHEMA_BASELINE=1 pnpm --filter @prisms/db test schema-additive
 * (and, in real life, bumping ROW_SCHEMA_VERSION + writing a migrator).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isAdditiveSchemaChange, ROW_SCHEMA_VERSION, type TableShape } from '@prisms/core';
import { getTableColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { tables } from '../src/schema';

/** Derive one table's row shape (SQL type + nullability + has-default per column). */
function shapeOf(table: PgTable): TableShape {
  const shape: Record<string, { type: string; nullable: boolean; hasDefault: boolean }> = {};
  for (const col of Object.values(getTableColumns(table))) {
    shape[col.name] = { type: col.getSQLType(), nullable: !col.notNull, hasDefault: col.hasDefault };
  }
  return shape;
}

const currentShapes: Record<string, TableShape> = Object.fromEntries(
  Object.entries(tables).map(([name, table]) => [name, shapeOf(table as PgTable)]),
);

const baselinePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  `schema-baseline.v${ROW_SCHEMA_VERSION}.json`,
);

// Regenerate the committed baseline on demand (the explicit major-version act).
if (process.env.UPDATE_SCHEMA_BASELINE === '1') {
  writeFileSync(baselinePath, `${JSON.stringify(currentShapes, null, 2)}\n`);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, TableShape>;

describe(`additive-only schema gate (§7.11, ROW_SCHEMA_VERSION=${ROW_SCHEMA_VERSION})`, () => {
  it('every baselined table still exists (a dropped table is a breaking change)', () => {
    const missing = Object.keys(baseline).filter((t) => !(t in currentShapes));
    expect(missing, `dropped table(s): ${missing.join(', ')}`).toEqual([]);
  });

  it.each(Object.keys(baseline))('%s changed only additively vs the committed baseline', (table) => {
    const prev = baseline[table];
    const next = currentShapes[table];
    expect(next, `table "${table}" is in the baseline but missing from the current schema`).toBeDefined();
    const result = isAdditiveSchemaChange(prev!, next!);
    // The error message names the exact breaking change (removed col, type change,
    // tightened nullability, new NOT-NULL-without-default).
    expect(result.ok ? null : result.error.message).toBeNull();
  });
});
