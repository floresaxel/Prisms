/**
 * M1 — the `(sort_order, hlc)` ordering key (1.3 §7.10a). The convergence
 * property: two devices inserting between the same neighbors offline converge
 * to ONE total order.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { compareSortKey, sortByKey, sortOrderCollides, type SortKey } from '../../src/merge/sort-order';

const at = (n: number, dev: string): string => `${n.toString(16).padStart(12, '0')}-0000-${dev}`;

describe('compareSortKey', () => {
  it('orders by fractional index first', () => {
    expect(compareSortKey({ sort_order: 'a0', hlc: at(9, 'd') }, { sort_order: 'a1', hlc: at(1, 'd') })).toBe(-1);
  });

  it('breaks an equal fraction by HLC (total + deterministic)', () => {
    const a: SortKey = { sort_order: 'a1', hlc: at(1, 'dev-a') };
    const b: SortKey = { sort_order: 'a1', hlc: at(2, 'dev-b') };
    expect(sortOrderCollides(a, b)).toBe(true);
    expect(compareSortKey(a, b)).toBe(-1);
    expect(compareSortKey(b, a)).toBe(1);
    expect(compareSortKey(a, a)).toBe(0);
  });

  it('is a total order (antisymmetric, transitive)', () => {
    const keyArb: fc.Arbitrary<SortKey> = fc.record({
      sort_order: fc.constantFrom('a0', 'a1', 'a2', 'a0V'),
      hlc: fc.integer({ min: 1, max: 50 }).chain((n) => fc.constantFrom(at(n, 'dev-a'), at(n, 'dev-b'))),
    });
    fc.assert(
      fc.property(keyArb, keyArb, keyArb, (a, b, c) => {
        const ba = compareSortKey(b, a);
        expect(compareSortKey(a, b)).toBe(ba === 0 ? 0 : ((-ba) as -1 | 1));
        if (compareSortKey(a, b) <= 0 && compareSortKey(b, c) <= 0) {
          expect(compareSortKey(a, c)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  it('two devices that mint the SAME fraction converge to one order regardless of input order', () => {
    // device-a and device-b both inserted "between the same pair" → same 'a1V'
    const fromA: SortKey = { sort_order: 'a1V', hlc: at(5, 'dev-a') };
    const fromB: SortKey = { sort_order: 'a1V', hlc: at(7, 'dev-b') };
    const neighbours: SortKey[] = [
      { sort_order: 'a1', hlc: at(1, 'dev-a') },
      { sort_order: 'a2', hlc: at(1, 'dev-a') },
    ];
    const orderingA = sortByKey([neighbours[0]!, fromA, fromB, neighbours[1]!]).map((k) => k.hlc);
    const orderingB = sortByKey([neighbours[1]!, fromB, fromA, neighbours[0]!]).map((k) => k.hlc);
    expect(orderingA).toEqual(orderingB); // both devices show the identical total order
    // and the lower-HLC insert sorts first within the collision
    expect(orderingA).toEqual([at(1, 'dev-a'), at(5, 'dev-a'), at(7, 'dev-b'), at(1, 'dev-a')]);
  });
});
