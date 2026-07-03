/**
 * M1 — `layout.renormalize_order` pure effect builder (1.3 §7.10a):
 * deterministic, idempotent sort_order cleanup over `(sort_order, hlc)`.
 */
import { describe, expect, it } from 'vitest';

import { buildRenormalizeEffects, renormalizedOrders } from '../../src/merge/renormalize';
import { compareSortKey } from '../../src/merge/sort-order';

const HLC = '000000000001-0000-dev';

describe('renormalizedOrders', () => {
  it('produces N strictly-increasing, evenly-spaced fractions, deterministically', () => {
    const a = renormalizedOrders(4);
    const b = renormalizedOrders(4);
    expect(a).toEqual(b); // deterministic
    expect(a).toHaveLength(4);
    for (let i = 1; i < a.length; i += 1) expect(a[i - 1]! < a[i]!).toBe(true);
  });
});

describe('buildRenormalizeEffects', () => {
  const nodeIds = ['n-a', 'n-b', 'n-c'];

  it('emits one minimal-field sort_order update per node, in canonical order', () => {
    const effects = buildRenormalizeEffects({ commandId: 'c1', hlc: HLC, parentId: 'p1', nodeIds });
    expect(effects).toHaveLength(3);
    expect(effects.map((e) => e.row_id)).toEqual(nodeIds);
    for (const e of effects) {
      expect(e.op).toBe('update');
      expect(e.table).toBe('nodes');
      expect(Object.keys(e.fields)).toEqual(['sort_order']);
    }
    // the assigned orders sort the nodes back into the given order
    expect(effects.map((e) => e.fields['sort_order'])).toEqual(renormalizedOrders(3));
  });

  it('is idempotent over (sort_order, hlc): re-running yields identical orders', () => {
    const first = buildRenormalizeEffects({ commandId: 'c1', hlc: HLC, parentId: null, nodeIds });
    const second = buildRenormalizeEffects({ commandId: 'c2', hlc: '000000000002-0000-dev', parentId: null, nodeIds });
    expect(second.map((e) => e.fields['sort_order'])).toEqual(first.map((e) => e.fields['sort_order']));
  });

  it('the renormalized keys are a strict total order under compareSortKey', () => {
    const effects = buildRenormalizeEffects({ commandId: 'c1', hlc: HLC, parentId: null, nodeIds });
    const keys = effects.map((e) => ({ sort_order: String(e.fields['sort_order']), hlc: HLC }));
    for (let i = 1; i < keys.length; i += 1) {
      expect(compareSortKey(keys[i - 1]!, keys[i]!)).toBe(-1);
    }
  });
});
