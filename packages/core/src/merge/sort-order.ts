/**
 * The `(sort_order, hlc)` ordering key (1.3 §7.10a). PURE (§16).
 *
 * `sort_order` is a fractional index (graph/order.ts). Two devices inserting
 * "between the same pair" while offline can mint equal or near-equal fractions;
 * `sort_order` alone is therefore NOT a total order across devices. The
 * effective key is the pair `(sort_order, hlc)` — equal fractions break by HLC,
 * which is total and deterministic, so both devices converge to the same order.
 *
 * `layout.renormalize_order` (renormalize.ts) later rewrites collided fractions
 * to clean spacing; until then this comparator keeps the order stable.
 */
import type { HlcString } from '../domain/primitives';

/** A row positioned by a fractional index plus the HLC that last set it. */
export interface SortKey {
  readonly sort_order: string;
  readonly hlc: HlcString;
}

/**
 * Total order on `(sort_order, hlc)`: fractional index first, HLC as the
 * deterministic tiebreak on collision. Returns -1 | 0 | 1.
 */
export function compareSortKey(a: SortKey, b: SortKey): -1 | 0 | 1 {
  if (a.sort_order !== b.sort_order) return a.sort_order < b.sort_order ? -1 : 1;
  if (a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1;
  return 0;
}

/** Stable sort of rows by their `(sort_order, hlc)` key (does not mutate input). */
export function sortByKey<T extends SortKey>(rows: readonly T[]): T[] {
  return [...rows].sort(compareSortKey);
}

/** True when two rows collide on `sort_order` (the case HLC must break). */
export function sortOrderCollides(a: SortKey, b: SortKey): boolean {
  return a.sort_order === b.sort_order;
}
