/**
 * Two-layer client store — overlay merge + trust-field stripping (1.3 §7.2,
 * §7.2a–§7.2c). PURE (§16): no IO, no clock, no randomness. The browser tier
 * (`@prisms/ui`) supplies the command id (UUIDv7) and HLC and does the SQLite
 * writes; this module only defines the shapes and the deterministic merge the
 * read path applies over the canonical replica.
 *
 * The client store is a read-only canonical replica (synced down from Postgres)
 * PLUS a local-only optimistic overlay of pending commands and their computed
 * effects (`client_commands` + `overlay_effects`). The UI reads
 * `mergeTable(replica, overlay)`. Overlay effects are NEVER uploaded as row
 * patches — only the named command envelope is (1.3 §7.2). Rollback = drop the
 * overlay entry; reconcile = drop it once the identical canonical row syncs back.
 *
 * M0 builds the minimal slice for `node.rename`; M1 broadens the effect builders
 * and the merge exceptions (`(sort_order, hlc)`, `mergeTimeEntries`).
 */
import type { HlcString, JsonObject, JsonValue } from '../domain/primitives';

/** A plain row as it lives in the local replica / merged read (loosely typed). */
export type OverlayRow = Record<string, unknown>;

/** How a pending command changes one row. */
export type OverlayOp = 'insert' | 'update' | 'delete';

/**
 * One row-level effect of a pending command (1.3 §7.2a). `fields` carries only
 * the columns the command names (minimal-field overlay, §2.8); a `delete`
 * carries no fields. `seq` orders multiple effects spawned by the same command
 * (e.g. an automation fixpoint); across commands, `hlc` is the order key.
 */
export interface OverlayEffect {
  readonly command_id: string;
  readonly hlc: HlcString;
  readonly table: string;
  readonly row_id: string;
  readonly op: OverlayOp;
  readonly fields: JsonObject;
  readonly seq: number;
}

/** Lifecycle of a locally-issued command awaiting/after server reconciliation. */
export type ClientCommandStatus = 'pending' | 'applied' | 'rejected';

/**
 * A locally-issued command queued for upload (1.3 §7.2a/§7.2b). `id` is the
 * client-minted UUIDv7 — it is preserved verbatim on upload and becomes
 * `command_log.id` server-side (the idempotency key + provenance link, V2).
 */
export interface ClientCommand {
  readonly id: string;
  readonly name: string;
  readonly hlc: HlcString;
  readonly payload: JsonValue;
  readonly status: ClientCommandStatus;
  readonly created_at: string;
}

/**
 * Server-owned trust fields stripped from every command payload before it is
 * queued (R17 / 1.3 §7.2c). Ownership, provenance, system version-of-record,
 * row schema version, the server HLC, and the base `*_at` server timestamps are
 * assigned by the server; a client-supplied value is never trusted. Note: the
 * row `id` and *fact* timestamps a command legitimately sets (`completed_at`,
 * `started_at`, `ended_at`, `answered_at`, …) are NOT trust fields.
 */
export const TRUST_FIELDS: readonly string[] = [
  'user_id',
  'created_at',
  'updated_at',
  'deleted_at',
  'hlc',
  'schema_version',
  'created_by_command_id',
  'last_modified_by_command_id',
  'source_kind',
  'source_id',
  'source_detail',
  'computed_by',
];

const TRUST_FIELD_SET = new Set(TRUST_FIELDS);

/**
 * Remove server-owned trust fields from a command payload (1.3 §7.2c). Returns a
 * new object; the input is untouched. Non-object inputs pass through unchanged.
 */
export function stripTrustFields<T>(payload: T): T {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!TRUST_FIELD_SET.has(key)) out[key] = value;
  }
  return out as T;
}

/** Total order on effects: HLC first (causal order), then intra-command `seq`. */
function compareEffects(a: OverlayEffect, b: OverlayEffect): number {
  if (a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1;
  return a.seq - b.seq;
}

/**
 * Apply a row's pending overlay effects over its canonical replica value
 * (1.3 §7.2). Effects apply in (HLC, seq) order:
 * - `insert` seeds / overlays the named fields,
 * - `update` patches the named fields onto the current value,
 * - `delete` tombstones the row (→ null).
 * Returns the effective row, or null when it does not exist / was deleted.
 */
export function mergeRow(
  replica: OverlayRow | null,
  effects: readonly OverlayEffect[],
): OverlayRow | null {
  let current: OverlayRow | null = replica;
  for (const effect of [...effects].sort(compareEffects)) {
    switch (effect.op) {
      case 'insert':
      case 'update':
        // insert seeds a not-yet-synced row; update patches the canonical one.
        // Both overlay the named minimal fields onto the current value.
        current = { ...(current ?? {}), ...effect.fields };
        break;
      case 'delete':
        current = null;
        break;
    }
  }
  return current;
}

/**
 * Merge a canonical replica table with the pending overlay effects for it
 * (1.3 §7.2). Replica rows are patched in place; overlay-only inserts (a row
 * not yet in the replica) are appended; deleted rows drop out. `idKey` is the
 * row identity column (default `id`).
 */
export function mergeTable(
  replica: readonly OverlayRow[],
  effects: readonly OverlayEffect[],
  idKey = 'id',
): OverlayRow[] {
  const byRow = new Map<string, OverlayEffect[]>();
  for (const effect of effects) {
    const list = byRow.get(effect.row_id);
    if (list) list.push(effect);
    else byRow.set(effect.row_id, [effect]);
  }

  const out: OverlayRow[] = [];
  const seen = new Set<string>();
  for (const row of replica) {
    const rowId = String(row[idKey]);
    seen.add(rowId);
    const merged = mergeRow(row, byRow.get(rowId) ?? []);
    if (merged !== null) out.push(merged);
  }
  // overlay-only inserts (a pending create whose canonical row has not synced yet)
  for (const [rowId, rowEffects] of byRow) {
    if (seen.has(rowId)) continue;
    const merged = mergeRow(null, rowEffects);
    if (merged !== null) out.push(merged);
  }
  return out;
}

/** The minimal-field overlay effect for a row UPDATE (the M0/M1 default). */
export function buildUpdateEffect(args: {
  commandId: string;
  hlc: HlcString;
  table: string;
  rowId: string;
  fields: JsonObject;
  seq?: number;
}): OverlayEffect {
  return {
    command_id: args.commandId,
    hlc: args.hlc,
    table: args.table,
    row_id: args.rowId,
    op: 'update',
    fields: args.fields,
    seq: args.seq ?? 0,
  };
}

/**
 * The optimistic effect of `node.rename` (M0 slice): a minimal-field update of
 * `nodes.title`. The seed of M1's full per-command effect builders.
 */
export function buildRenameEffect(args: {
  commandId: string;
  hlc: HlcString;
  nodeId: string;
  title: string;
}): OverlayEffect {
  return buildUpdateEffect({
    commandId: args.commandId,
    hlc: args.hlc,
    table: 'nodes',
    rowId: args.nodeId,
    fields: { title: args.title },
  });
}
