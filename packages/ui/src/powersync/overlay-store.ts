/**
 * Two-layer client store — the overlay repository (1.3 §7.2, §7.2a; R15).
 *
 * A thin typed repository over the local-only `client_commands` /
 * `overlay_effects` / `sync_review_items` tables (schema.ts). It is defined
 * against a minimal `SqlExecutor` so the SAME SQL runs on PowerSync's SQLite in
 * the app AND on a plain SQLite handle in the convergence/integration harness —
 * the spike exercises the real statements without a browser.
 *
 * Invariant: `overlay_effects` only ever holds effects of still-`pending`
 * commands. Reconciling an applied command (its identical canonical row has
 * synced back) and rolling back a rejected one both delete the effects, so the
 * read-merge never double-applies.
 */
import {
  defaultCommandMeta,
  mergeTable,
  type OverlayEffect,
  type OverlayRow,
  type ClientCommand,
} from '@prisms/core';

/**
 * A queued command enriched with the §8/§7.11 version axes + §7.2e causal deps
 * stamped at enqueue. `pendingCommands()` returns these so `upload-commands`
 * sends a complete envelope (`command_version`/`schema_version`/`depends_on`);
 * the server enforces the schema-version floor against it (§7.11).
 */
export interface PendingCommand extends ClientCommand {
  readonly command_version: number;
  readonly schema_version: number;
  readonly client_version: string | null;
  readonly depends_on: readonly string[];
}

/** The slice of a SQLite handle the overlay store needs (PowerSync satisfies it). */
export interface SqlTx {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  getAll<T = OverlayRow>(sql: string, params?: unknown[]): Promise<T[]>;
}
export interface SqlExecutor extends SqlTx {
  writeTransaction<T>(fn: (tx: SqlTx) => Promise<T>): Promise<T>;
}

export interface ReviewItem {
  id: string;
  item_type: string;
  severity: string;
  title: string;
  detail: string;
  status: string;
  command_id: string;
  created_at: string;
}

/** The repository the writer (execute.ts) and uploader (upload-commands.ts) use. */
export interface OverlayStore {
  /**
   * One txn (R15): append the pending command + its optimistic effects. Stamps
   * the §8/§7.11 version axes (via `defaultCommandMeta`) and the §7.2e
   * `dependsOn` causal deps R5's write path derives (default none).
   */
  enqueue(command: ClientCommand, effects: readonly OverlayEffect[], dependsOn?: readonly string[]): Promise<void>;
  /** Pending commands in HLC (causal) order — the upload set (with versions). */
  pendingCommands(): Promise<PendingCommand[]>;
  /** Pending overlay effects for one table — the read-merge input. */
  effectsFor(table: string): Promise<OverlayEffect[]>;
  /** Canonical replica rows for one table. */
  replicaRows(table: string): Promise<OverlayRow[]>;
  /** Applied/noop: drop the overlay; the identical canonical row carries it. */
  reconcileApplied(commandId: string): Promise<void>;
  /**
   * Rejected: drop the overlay (rollback) + mark the command. The durable review
   * item is SERVER-created (M5) and syncs down (§7.13) — the client writes none
   * (sync_review_items is a synced, server-owned table, never a client write).
   */
  rollbackRejected(args: { commandId: string; rejectCode?: string; rejectReason?: string }): Promise<void>;
  /** Open review items (the inbox), newest first — the synced server-owned inbox. */
  reviewItems(): Promise<ReviewItem[]>;
}

const parseJson = (value: unknown, fallback: unknown): unknown => {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const toPendingCommand = (r: OverlayRow): PendingCommand => ({
  id: String(r['id']),
  name: String(r['name']),
  hlc: String(r['hlc']),
  payload: parseJson(r['payload'], null) as ClientCommand['payload'],
  status: r['status'] as ClientCommand['status'],
  created_at: String(r['created_at'] ?? ''),
  // Legacy rows (pre-R6) lack the version columns → default to the current axes.
  command_version: r['command_version'] == null ? defaultCommandMeta().command_version : Number(r['command_version']),
  schema_version: r['schema_version'] == null ? defaultCommandMeta().schema_version : Number(r['schema_version']),
  client_version: r['client_version'] == null ? null : String(r['client_version']),
  depends_on: (parseJson(r['depends_on'], []) as string[]) ?? [],
});

const toEffect = (r: OverlayRow): OverlayEffect => ({
  command_id: String(r['command_id']),
  hlc: String(r['hlc']),
  table: String(r['table_name']),
  row_id: String(r['row_id']),
  op: r['op'] as OverlayEffect['op'],
  fields: parseJson(r['fields'], {}) as OverlayEffect['fields'],
  seq: Number(r['seq'] ?? 0),
});

const toReviewItem = (r: OverlayRow): ReviewItem => ({
  id: String(r['id']),
  item_type: String(r['item_type']),
  severity: String(r['severity']),
  title: String(r['title']),
  detail: String(r['detail'] ?? ''),
  status: String(r['status']),
  command_id: String(r['command_id'] ?? ''),
  created_at: String(r['created_at'] ?? ''),
});

/** The production overlay store: real SQL over the local-only tables. */
export function createSqlOverlayStore(sql: SqlExecutor): OverlayStore {
  return {
    async enqueue(command, effects, dependsOn = []) {
      // §8/§7.11: stamp the version axes at enqueue (the minting version) + the
      // §7.2e causal deps R5's write path derives. Persisted so the upload sends
      // a complete envelope and a reload survives with versions intact.
      const meta = defaultCommandMeta([...dependsOn]);
      await sql.writeTransaction(async (tx) => {
        await tx.execute(
          'INSERT INTO client_commands (id, name, hlc, payload, status, created_at, command_version, schema_version, client_version, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            command.id,
            command.name,
            command.hlc,
            JSON.stringify(command.payload),
            command.status,
            command.created_at,
            meta.command_version,
            meta.schema_version,
            null,
            JSON.stringify([...dependsOn]),
          ],
        );
        for (const e of effects) {
          await tx.execute(
            'INSERT INTO overlay_effects (id, command_id, hlc, table_name, row_id, op, fields, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [`${e.command_id}:${e.seq}`, e.command_id, e.hlc, e.table, e.row_id, e.op, JSON.stringify(e.fields), e.seq, command.created_at],
          );
        }
      });
    },
    async pendingCommands() {
      const rows = await sql.getAll("SELECT * FROM client_commands WHERE status = 'pending' ORDER BY hlc");
      return rows.map(toPendingCommand);
    },
    async effectsFor(table) {
      const rows = await sql.getAll('SELECT * FROM overlay_effects WHERE table_name = ?', [table]);
      return rows.map(toEffect);
    },
    async replicaRows(table) {
      // `table` is an internal constant (never user input); no injection surface.
      return sql.getAll(`SELECT * FROM ${table}`);
    },
    async reconcileApplied(commandId) {
      await sql.writeTransaction(async (tx) => {
        await tx.execute('DELETE FROM overlay_effects WHERE command_id = ?', [commandId]);
        await tx.execute('DELETE FROM client_commands WHERE id = ?', [commandId]);
      });
    },
    async rollbackRejected({ commandId, rejectCode, rejectReason }) {
      // only the local overlay tables — the server-owned review item syncs down.
      await sql.writeTransaction(async (tx) => {
        await tx.execute('DELETE FROM overlay_effects WHERE command_id = ?', [commandId]);
        await tx.execute('UPDATE client_commands SET status = ?, reject_code = ?, reject_reason = ? WHERE id = ?', [
          'rejected',
          rejectCode ?? null,
          rejectReason ?? null,
          commandId,
        ]);
      });
    },
    async reviewItems() {
      const rows = await sql.getAll("SELECT * FROM sync_review_items WHERE status = 'open' AND deleted_at IS NULL ORDER BY created_at DESC");
      return rows.map(toReviewItem);
    },
  };
}

/**
 * The merged read (1.3 §7.2): canonical replica + pending overlay for one
 * table. The UI reads this instead of the raw replica so optimistic edits show
 * instantly and roll back when their overlay is dropped.
 */
export async function readMergedRows(store: OverlayStore, table: string): Promise<OverlayRow[]> {
  const [replica, effects] = await Promise.all([store.replicaRows(table), store.effectsFor(table)]);
  return mergeTable(replica, effects);
}
