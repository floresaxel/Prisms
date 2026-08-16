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

/** An authoritative row a command wrote, per the `/sync/upload` ack (D5). */
export interface AckEffect {
  table: string;
  row_id: string;
  op: 'insert' | 'update' | 'delete';
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
  /**
   * Applied/noop ack (§7.2d): mark the command `applied` but KEEP its overlay
   * effects — they stay applied in the merged read until the identical canonical
   * row syncs down, so there is NO revert-flicker between ack and download
   * (S7-F6). `reconcileConfirmed` drops them once the canonical row arrives.
   *
   * D5: `effects` is the server's authoritative `{table,row_id,op}` per command.
   * When it targets a DIFFERENT row than the client optimistically minted (two
   * offline devices minted ids for the SAME new day → the server converged onto
   * one), the local overlay effect's `row_id` (and its `fields.id`) is rewritten
   * to the server's id so `reconcileConfirmed` clears it when the canonical row
   * arrives — instead of ghosting forever on a minted id that never syncs down.
   */
  markApplied(commandId: string, effects?: readonly AckEffect[]): Promise<void>;
  /**
   * Drop the overlay of every `applied` command whose canonical rows have now
   * arrived (present + carrying `last_modified_by_command_id === id`, or gone/
   * tombstoned for a delete), and prune `rejected` command rows older than 30
   * days (S7-F9). Returns the cleared command ids. Idempotent.
   */
  reconcileConfirmed(nowMs?: number): Promise<{ cleared: string[] }>;
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

/**
 * A UUIDv7 — the version nibble sits at index 14, and only v7 carries the
 * leading millisecond timestamp that makes ids sort by mint time.
 */
const isUuidV7 = (id: string): boolean => id.length === 36 && id[14] === '7';

/**
 * `stamp` was minted AFTER `commandId`, i.e. the row already carries a write the
 * server took later than ours. Ordering is only readable when BOTH ids are v7:
 * a v4 id (an import, a seeded fixture, anything not minted by `newId`) is
 * random, so comparing it would be a coin flip. Unreadable → not superseded,
 * which falls back to the exact-stamp wait this replaced.
 */
const supersedes = (stamp: string, commandId: string): boolean =>
  isUuidV7(stamp) && isUuidV7(commandId) && stamp > commandId;

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
    async markApplied(commandId, effects) {
      // D5: reconcile a divergent authoritative row id. When the server applied
      // this command onto a DIFFERENT row than the client optimistically minted,
      // rewrite the local overlay effect's row_id (+ fields.id, + insert→update) to
      // the server's id so reconcileConfirmed clears it on canonical arrival. Only
      // an UNAMBIGUOUS single effect on a table can be a minted-id upsert
      // (journal.write / tag.answer …); a multi-effect command is left untouched.
      const rewrites: { effectId: string; rowId: string; fields: string }[] = [];
      if (effects && effects.length > 0) {
        const local = await sql.getAll<{ id: string; table_name: string; row_id: string; fields: string }>(
          'SELECT id, table_name, row_id, fields FROM overlay_effects WHERE command_id = ?',
          [commandId],
        );
        for (const ack of effects) {
          const matches = local.filter((l) => l.table_name === ack.table);
          if (matches.length !== 1) continue;
          const m = matches[0]!;
          if (m.row_id === ack.row_id) continue; // no divergence
          const fields = { ...(parseJson(m.fields, {}) as Record<string, unknown>), id: ack.row_id };
          rewrites.push({ effectId: m.id, rowId: ack.row_id, fields: JSON.stringify(fields) });
        }
      }
      if (rewrites.length === 0) {
        // Common case (no divergence): keep the single-statement flip; the overlay
        // stays until reconcileConfirmed drops it on canonical arrival (no flicker).
        await sql.execute("UPDATE client_commands SET status = 'applied' WHERE id = ?", [commandId]);
        return;
      }
      // Divergent: rewrite the overlay effect(s) + flip status atomically.
      await sql.writeTransaction(async (tx) => {
        for (const r of rewrites) {
          await tx.execute("UPDATE overlay_effects SET row_id = ?, op = 'update', fields = ? WHERE id = ?", [r.rowId, r.fields, r.effectId]);
        }
        await tx.execute("UPDATE client_commands SET status = 'applied' WHERE id = ?", [commandId]);
      });
    },
    async reconcileConfirmed(nowMs = Date.now()) {
      const cleared: string[] = [];
      const applied = await sql.getAll<{ id: string }>("SELECT id FROM client_commands WHERE status = 'applied'");
      for (const { id: commandId } of applied) {
        const effects = await sql.getAll<{ table_name: string; row_id: string; op: string }>(
          'SELECT table_name, row_id, op FROM overlay_effects WHERE command_id = ?',
          [commandId],
        );
        let allArrived = true;
        for (const e of effects) {
          // `table_name` is a catalog constant (never user input) — no injection.
          const [canonical] = await sql.getAll(`SELECT * FROM ${e.table_name} WHERE id = ? LIMIT 1`, [e.row_id]);
          if (e.op === 'delete') {
            // confirmed once the row is gone or tombstoned.
            if (canonical && canonical['deleted_at'] == null) { allArrived = false; break; }
          } else {
            // insert/update: confirmed once the row is present, not tombstoned, and
            // (when the table carries provenance) stamped by THIS command (V2). A
            // table without last_modified_by_command_id falls back to presence.
            if (!canonical || canonical['deleted_at'] != null) { allArrived = false; break; }
            /**
             * Confirmed when the row is stamped by THIS command — or by one that
             * came AFTER it.
             *
             * A row records only its LAST modifier, so two commands touching the
             * same row left the earlier one unable to ever match: it waited on a
             * stamp that had already moved on. Its overlay was then held forever,
             * and since `mergeRow` replays effects over the canonical row in HLC
             * order, that stranded older effect kept overwriting the newer truth
             * underneath it — the row said 9, the screen said 3, permanently, and
             * a reload made it worse rather than better because the queue was
             * empty and nothing ran reconciliation again.
             *
             * Client command ids are UUIDv7, so they sort by mint time: a stamp
             * GREATER than ours is a write the server took after ours, which
             * means the row already carries work newer than the effect we are
             * holding, and holding it can only revert. Anything else — an older
             * stamp, or an id whose ordering is unreadable — is the old value
             * still on its way down, so keep waiting, which is the revert-flicker
             * this design exists to avoid (S7-F6).
             *
             * Ordering across devices is only as good as their clocks; a skewed
             * peer can at worst make this clear one beat early (a flicker), where
             * before it could strand an overlay permanently.
             */
            const stamp = canonical['last_modified_by_command_id'];
            if (stamp != null && String(stamp) !== commandId && !supersedes(String(stamp), commandId)) { allArrived = false; break; }
          }
        }
        if (allArrived) {
          // A confirmed DELETE supersedes every overlay still held for that row.
          // Without this, writing a row and deleting it before the canonical row
          // has synced down strands the earlier insert effect forever: its row
          // can never "arrive" (it is gone server-side), so the insert/update
          // branch above waits on it indefinitely and the merged read keeps
          // resurrecting a note the user deleted. Clearing an insert on absence
          // ALONE would be wrong — absence is also just "not downloaded yet",
          // which is exactly the revert-flicker this design avoids (S7-F6) — so
          // it is scoped to rows a CONFIRMED delete has settled.
          const deleted = effects.filter((e) => e.op === 'delete');
          await sql.writeTransaction(async (tx) => {
            for (const e of deleted) {
              await tx.execute('DELETE FROM overlay_effects WHERE table_name = ? AND row_id = ?', [e.table_name, e.row_id]);
            }
            await tx.execute('DELETE FROM overlay_effects WHERE command_id = ?', [commandId]);
            await tx.execute('DELETE FROM client_commands WHERE id = ?', [commandId]);
          });
          cleared.push(commandId);
        }
      }
      // S7-F9: prune long-dead rejected rows (their effects were dropped on reject).
      const cutoff = new Date(nowMs - 30 * 86_400_000).toISOString();
      await sql.execute("DELETE FROM client_commands WHERE status = 'rejected' AND created_at < ?", [cutoff]);
      return { cleared };
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
