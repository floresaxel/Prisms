/**
 * M1 — per-field LWW by HLC (1.3 §7.10), the default scalar merge.
 */
import { describe, expect, it } from 'vitest';

import { lwwMerge, lwwMergeFields, lwwWins, type Stamped } from '../../src/merge/lww';

const at = (n: number): string => `${n.toString(16).padStart(12, '0')}-0000-dev`;
const s = <T>(value: T, n: number): Stamped<T> => ({ value, hlc: at(n) });

describe('lwwWins / lwwMerge', () => {
  it('takes the incoming value when its HLC is later', () => {
    expect(lwwWins(s('old', 1), s('new', 2))).toBe(true);
    expect(lwwMerge(s('old', 1), s('new', 2)).value).toBe('new');
  });

  it('keeps the current value when the incoming HLC is earlier or equal (idempotent)', () => {
    expect(lwwWins(s('cur', 2), s('older', 1))).toBe(false);
    expect(lwwMerge(s('cur', 2), s('older', 1)).value).toBe('cur');
    // equal HLC: keep current (no spurious overwrite)
    expect(lwwWins(s('cur', 2), s('same', 2))).toBe(false);
  });

  it('takes the incoming value when there is no current', () => {
    expect(lwwWins(null, s('first', 1))).toBe(true);
    expect(lwwMerge(null, s('first', 1)).value).toBe('first');
  });
});

describe('lwwMergeFields', () => {
  it('resolves each field to its largest HLC, order-independently', () => {
    const base = { title: s('A', 1) };
    const p1 = { title: s('B', 3), description: s('d', 2) };
    const p2 = { title: s('C', 2) }; // earlier than p1 for title
    const forward = lwwMergeFields(base, [p1, p2]);
    const reverse = lwwMergeFields(base, [p2, p1]);
    expect(forward['title']!.value).toBe('B');
    expect(forward['description']!.value).toBe('d');
    expect(reverse).toEqual(forward); // order does not matter
  });

  it('is idempotent under re-merge', () => {
    const base = { title: s('A', 1) };
    const once = lwwMergeFields(base, [{ title: s('B', 3) }]);
    const twice = lwwMergeFields(once, [{ title: s('B', 3) }]);
    expect(twice).toEqual(once);
  });
});
