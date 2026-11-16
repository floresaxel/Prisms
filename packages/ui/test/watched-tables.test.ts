/**
 * A watched query's tables are read from its SQL text where that is exact, so
 * PowerSync does not spend two round-trips per watch (EXPLAIN + a sqlite_master
 * lookup) discovering them. The contract has two halves, and the second is the
 * one that matters: a WRONG answer is a watch that never re-runs, so anything
 * the text cannot settle must fall through to the database's own lookup.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { CLIENT_TABLE_NAMES } from '../src/powersync/schema';
import { tablesFromSql, watchTablesFromSql, type ResolvesTables } from '../src/powersync/watched-tables';

const KNOWN = new Set(CLIENT_TABLE_NAMES);

describe('tablesFromSql — the table a single-table SELECT names', () => {
  it.each([
    ['SELECT * FROM nodes', 'nodes'],
    ['SELECT * FROM edges WHERE deleted_at IS NULL', 'edges'],
    ['SELECT * FROM user_settings LIMIT 1', 'user_settings'],
    ['SELECT * FROM tags WHERE deleted_at IS NULL ORDER BY label', 'tags'],
    ['SELECT command_id, hlc, table_name, row_id, op, fields, seq FROM overlay_effects', 'overlay_effects'],
    ["SELECT count(*) AS n FROM client_commands WHERE status = 'pending'", 'client_commands'],
    ['SELECT count(*) AS n FROM client_commands WHERE status = ?', 'client_commands'],
    ['SELECT * FROM journal_entries WHERE deleted_at IS NULL AND month_key IN (?,?)', 'journal_entries'],
    ['SELECT * FROM journal_entries WHERE 0', 'journal_entries'],
    ["SELECT * FROM computed_aggregates WHERE deleted_at IS NULL AND subject_kind = 'habit'", 'computed_aggregates'],
    ['  select *\n  from   Task_Steps\n  where task_id = ?', 'task_steps'],
  ])('%s → %s', (sql, table) => {
    expect(tablesFromSql(sql, KNOWN)).toEqual([table]);
  });

  it.each([
    ['a join', 'SELECT n.* FROM nodes n JOIN edges e ON e.successor_id = n.id'],
    ['a comma join', 'SELECT * FROM nodes, edges'],
    ['a subquery', 'SELECT * FROM nodes WHERE id IN (SELECT row_id FROM overlay_effects)'],
    ['a compound select', 'SELECT id FROM nodes UNION SELECT id FROM habits'],
    ['a CTE', 'WITH t AS (SELECT * FROM nodes) SELECT * FROM t'],
    ['a table-valued function', 'SELECT value FROM json_each(?)'],
    ['a schema-qualified name', 'SELECT * FROM main.nodes'],
    ['a table the schema does not have', 'SELECT * FROM sqlite_master'],
    ['the word FROM inside a literal', "SELECT * FROM nodes WHERE title = 'back from lunch'"],
    ['no table at all', 'SELECT 1'],
    ['a write', "UPDATE nodes SET title = 'x'"],
  ])('leaves %s to the database', (_what, sql) => {
    expect(tablesFromSql(sql, KNOWN)).toBeNull();
  });

  it('covers every watch the app opens — none of them falls back to EXPLAIN', () => {
    // The point of the module: if a new watched query is written in a shape this
    // cannot read, it silently costs two round-trips again. Catch it here.
    const hooks = readFileSync(new URL('../src/hooks.ts', import.meta.url), 'utf8');
    const provider = readFileSync(new URL('../src/powersync/data-provider.tsx', import.meta.url), 'utf8');
    const connector = readFileSync(new URL('../src/powersync/connector.ts', import.meta.url), 'utf8');
    const literals = [...`${hooks}\n${provider}\n${connector}`.matchAll(/(['"`])(SELECT\b(?:(?!\1).)*)\1/gs)].map((m) => m[2]!);
    // Doc comments quote SQL shapes with an ellipsis (`SELECT … FROM <table> …`):
    // prose, not queries. Template placeholders (the journal's `IN (${…})` list)
    // are bound values in the real SQL.
    const watched = literals
      .filter((sql) => /\bFROM\b/i.test(sql) && !sql.includes('…'))
      .map((sql) => sql.replace(/\$\{[^}]*\}/g, '?'));
    expect(watched.length).toBeGreaterThan(25);
    for (const sql of watched) {
      expect(tablesFromSql(sql, KNOWN), `not resolvable from its text: ${sql}`).not.toBeNull();
    }
  });
});

describe('watchTablesFromSql — answers resolveTables from the text, else defers', () => {
  function fakeDb() {
    const viaExplain = vi.fn<ResolvesTables['resolveTables']>(async () => ['from-explain']);
    return { db: watchTablesFromSql<ResolvesTables>({ resolveTables: viaExplain }, CLIENT_TABLE_NAMES), viaExplain };
  }

  it('resolves a single-table SELECT without touching the database', async () => {
    const { db, viaExplain } = fakeDb();
    await expect(db.resolveTables('SELECT * FROM habits WHERE deleted_at IS NULL')).resolves.toEqual(['habits']);
    expect(viaExplain).not.toHaveBeenCalled();
  });

  it('defers anything else to the original lookup, arguments intact', async () => {
    const { db, viaExplain } = fakeDb();
    const sql = 'SELECT n.* FROM nodes n JOIN edges e ON e.successor_id = n.id';
    await expect(db.resolveTables(sql, ['p'])).resolves.toEqual(['from-explain']);
    expect(viaExplain).toHaveBeenCalledWith(sql, ['p'], undefined);
  });

  it('takes explicitly passed tables as given', async () => {
    const { db, viaExplain } = fakeDb();
    await db.resolveTables('SELECT * FROM habits', [], { tables: ['nodes'] });
    expect(viaExplain).toHaveBeenCalledWith('SELECT * FROM habits', [], { tables: ['nodes'] });
  });

  it('keeps `this` for the original lookup, and tolerates a database without one', async () => {
    class Db {
      calls = 0;
      async resolveTables(): Promise<string[]> {
        this.calls += 1;
        return [];
      }
    }
    const raw = new Db();
    const db: ResolvesTables = watchTablesFromSql(raw, CLIENT_TABLE_NAMES);
    await db.resolveTables('SELECT 1');
    expect(raw.calls).toBe(1);
    // a test double with no resolveTables at all must still install cleanly
    expect(() => watchTablesFromSql({} as ResolvesTables, CLIENT_TABLE_NAMES)).not.toThrow();
  });
});
