/**
 * `layout.renormalize_order` — deterministic, idempotent sort_order cleanup
 * (1.3 §7.10a, §8). PURE (§16). Built in M1; M5 wires the server applier.
 *
 * Concurrent "insert between the same pair" on two devices can mint colliding
 * fractional indices. The `(sort_order, hlc)` key (sort-order.ts) keeps order
 * stable meanwhile; this command then rewrites the collided fractions to clean,
 * evenly-spaced ones. Because the spacing generator is deterministic, re-running
 * over the same canonical order produces identical `sort_order`s — idempotent
 * over `(sort_order, hlc)`. Provenance (`source_kind`) is server-assigned (M5).
 */
import type { HlcString } from '../domain/primitives';
import { sortOrdersBetween } from '../graph/order';
import { buildUpdateEffect, type OverlayEffect } from '../sync/overlay';

export interface RenormalizeInput {
  readonly commandId: string;
  readonly hlc: HlcString;
  /** The sibling group being renormalized (documentary; effects are per-node). */
  readonly parentId: string | null;
  /** The children in their canonical `(sort_order, hlc)` order. */
  readonly nodeIds: readonly string[];
}

/** N clean, evenly-spaced fractional indices from an empty list — deterministic. */
export function renormalizedOrders(count: number): string[] {
  return sortOrdersBetween(null, null, count);
}

/**
 * The minimal-field `sort_order` update effects that renormalize a sibling
 * group. One effect per node, in canonical order; `seq` preserves intra-command
 * order. Idempotent: the same `nodeIds` order yields the same `sort_order`s.
 */
export function buildRenormalizeEffects(input: RenormalizeInput): OverlayEffect[] {
  const orders = renormalizedOrders(input.nodeIds.length);
  return input.nodeIds.map((nodeId, i) =>
    buildUpdateEffect({
      commandId: input.commandId,
      hlc: input.hlc,
      table: 'nodes',
      rowId: nodeId,
      fields: { sort_order: orders[i]! },
      seq: i,
    }),
  );
}
