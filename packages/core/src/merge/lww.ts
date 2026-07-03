/**
 * Per-field last-writer-wins by HLC (1.3 §7.10) — the DEFAULT conflict
 * resolution for scalar fields (title, description, dates, estimates, …).
 * PURE (§16). `sort_order` and timer intervals are the two documented
 * exceptions (sort-order.ts / time-entries.ts).
 *
 * The winner is the larger HLC (lexicographic == causal order, §7.9a). Equal
 * HLCs are impossible across devices (the device id is the final tiebreak baked
 * into the encoding), so a tie keeps the current value — making the rule
 * idempotent and order-independent.
 */
import type { HlcString } from '../domain/primitives';

/** A field value stamped with the HLC of the command that wrote it. */
export interface Stamped<T> {
  readonly value: T;
  readonly hlc: HlcString;
}

/** True when `incoming` should overwrite `current` (strictly later HLC). */
export function lwwWins<T>(current: Stamped<T> | null, incoming: Stamped<T>): boolean {
  if (current === null) return true;
  return incoming.hlc > current.hlc;
}

/** The winning stamped value under per-field LWW (current on an HLC tie). */
export function lwwMerge<T>(current: Stamped<T> | null, incoming: Stamped<T>): Stamped<T> {
  return lwwWins(current, incoming) ? incoming : current!;
}

/**
 * Merge a batch of stamped patches for ONE row into the surviving value per
 * field. Order-independent and idempotent: each field resolves to its largest
 * HLC regardless of the order patches are seen.
 */
export function lwwMergeFields(
  base: Readonly<Record<string, Stamped<unknown>>>,
  patches: readonly Readonly<Record<string, Stamped<unknown>>>[],
): Record<string, Stamped<unknown>> {
  const out: Record<string, Stamped<unknown>> = { ...base };
  for (const patch of patches) {
    for (const [field, incoming] of Object.entries(patch)) {
      out[field] = lwwMerge(out[field] ?? null, incoming);
    }
  }
  return out;
}
