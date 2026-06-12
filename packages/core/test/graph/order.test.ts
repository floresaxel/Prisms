/**
 * S4 DoD: ordering test — 1k generate-between without collision.
 */
import { describe, expect, it } from 'vitest';

import {
  initialSortOrder,
  sortOrderBetween,
  sortOrdersBetween,
} from '../../src/graph/order';
import { createSeededRng } from '../../src/time/rng';

function assertStrictlyAscending(keys: readonly string[]): void {
  for (let i = 1; i < keys.length; i += 1) {
    const prev = keys[i - 1] as string;
    const next = keys[i] as string;
    expect(prev < next, `${prev} < ${next} at ${i}`).toBe(true);
  }
}

describe('sortOrderBetween', () => {
  it('starts lists at a0', () => {
    expect(initialSortOrder()).toBe('a0');
  });

  it('generates strictly between its bounds', () => {
    const key = sortOrderBetween('a0', 'a1');
    expect(key > 'a0' && key < 'a1').toBe(true);
  });

  it('appends and prepends with open ends', () => {
    const first = initialSortOrder();
    const after = sortOrderBetween(first, null);
    const before = sortOrderBetween(null, first);
    expect(before < first && first < after).toBe(true);
  });

  it('1000 inserts at seeded-random positions: no collisions, total order', () => {
    const rng = createSeededRng(2026);
    const keys: string[] = [initialSortOrder()];
    for (let i = 0; i < 1000; i += 1) {
      const byte = rng.randomBytes(2);
      const gap = ((byte[0] as number) * 256 + (byte[1] as number)) % (keys.length + 1);
      const before = gap === 0 ? null : (keys[gap - 1] as string);
      const after = gap === keys.length ? null : (keys[gap] as string);
      const key = sortOrderBetween(before, after);
      if (before !== null) expect(key > before).toBe(true);
      if (after !== null) expect(key < after).toBe(true);
      keys.splice(gap, 0, key);
    }
    expect(keys).toHaveLength(1001);
    expect(new Set(keys).size).toBe(1001);
    assertStrictlyAscending(keys);
  });

  it('1000 adversarial inserts into the same narrowing gap: still no collisions', () => {
    const left = initialSortOrder();
    let right = sortOrderBetween(left, null);
    const seen = new Set<string>([left, right]);
    for (let i = 0; i < 1000; i += 1) {
      const key = sortOrderBetween(left, right);
      expect(key > left && key < right).toBe(true);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      right = key;
    }
  });

  it('rejects misordered or empty bounds', () => {
    expect(() => sortOrderBetween('a1', 'a0')).toThrow(TypeError);
    expect(() => sortOrderBetween('a0', 'a0')).toThrow(TypeError);
    expect(() => sortOrderBetween('', 'a0')).toThrow(TypeError);
    expect(() => sortOrderBetween('a0', '')).toThrow(TypeError);
  });
});

describe('sortOrdersBetween', () => {
  it('bulk-generates ascending unique keys', () => {
    const keys = sortOrdersBetween(null, null, 50);
    expect(keys).toHaveLength(50);
    expect(new Set(keys).size).toBe(50);
    assertStrictlyAscending(keys);
  });

  it('fits n keys between tight bounds', () => {
    const keys = sortOrdersBetween('a0', 'a1', 25);
    expect(keys.every((k) => k > 'a0' && k < 'a1')).toBe(true);
    assertStrictlyAscending(keys);
  });

  it('handles n = 0 and rejects invalid n', () => {
    expect(sortOrdersBetween(null, null, 0)).toEqual([]);
    expect(() => sortOrdersBetween(null, null, -1)).toThrow(TypeError);
    expect(() => sortOrdersBetween(null, null, 1.5)).toThrow(TypeError);
  });
});
