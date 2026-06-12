/**
 * Fractional sort_order (§6.0: 'a0', 'a1', 'a0V', …).
 *
 * Wraps the battle-tested base-62 fractional-indexing algorithm: keys are
 * plain strings whose lexicographic order is the sibling order, and a new
 * key can always be generated strictly between two existing ones without
 * touching other rows (minimal-field mutations, §2 principle 8).
 *
 * Two offline devices inserting between the same neighbors can generate the
 * same key; rows then collide on sort_order and `compareSiblings` falls back
 * to the id tiebreak — ordering stays total and deterministic.
 */
import {
  generateKeyBetween,
  generateNKeysBetween,
} from 'fractional-indexing';

function checkBounds(before: string | null, after: string | null): void {
  if (before !== null && before.length === 0) {
    throw new TypeError('sortOrderBetween: "before" must be null or non-empty');
  }
  if (after !== null && after.length === 0) {
    throw new TypeError('sortOrderBetween: "after" must be null or non-empty');
  }
  if (before !== null && after !== null && before >= after) {
    throw new TypeError(
      `sortOrderBetween: "before" (${before}) must sort strictly before "after" (${after})`,
    );
  }
}

/**
 * A key strictly between `before` and `after` (null = open end).
 * `sortOrderBetween(null, null)` yields the first key for an empty list.
 */
export function sortOrderBetween(
  before: string | null,
  after: string | null,
): string {
  checkBounds(before, after);
  try {
    return generateKeyBetween(before, after);
  } catch (cause) {
    throw new TypeError(
      `sortOrderBetween(${String(before)}, ${String(after)}): ${String(cause)}`,
      { cause },
    );
  }
}

/** `n` keys strictly between the bounds, themselves in ascending order. */
export function sortOrdersBetween(
  before: string | null,
  after: string | null,
  n: number,
): string[] {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(`sortOrdersBetween: n must be a non-negative integer, got ${n}`);
  }
  checkBounds(before, after);
  try {
    return generateNKeysBetween(before, after, n);
  } catch (cause) {
    throw new TypeError(
      `sortOrdersBetween(${String(before)}, ${String(after)}, ${n}): ${String(cause)}`,
      { cause },
    );
  }
}

/** First key for an empty sibling list ('a0'). */
export function initialSortOrder(): string {
  return sortOrderBetween(null, null);
}
