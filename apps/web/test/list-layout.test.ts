/** My Day / Tasks reflow rules — pure, since the live feed is a ResizeObserver. */
import { describe, expect, it } from 'vitest';

import { COMPACT_W, listLayout, listLayoutClass, STACK_W } from '../src/list-layout';

describe('listLayout', () => {
  it('assumes the roomy layout before the first measurement', () => {
    expect(listLayout(0)).toEqual({ stacked: false, compact: false });
    expect(listLayoutClass(0)).toBe('');
  });

  it('keeps the right rail beside the list when there is room', () => {
    expect(listLayout(STACK_W)).toEqual({ stacked: false, compact: false });
    expect(listLayout(1400)).toEqual({ stacked: false, compact: false });
  });

  it('moves the rail under the list below STACK_W', () => {
    expect(listLayout(STACK_W - 1)).toEqual({ stacked: true, compact: false });
    expect(listLayout(COMPACT_W)).toEqual({ stacked: true, compact: false });
  });

  it('reflows the rows themselves below COMPACT_W', () => {
    expect(listLayout(COMPACT_W - 1)).toEqual({ stacked: true, compact: true });
    expect(listLayoutClass(COMPACT_W - 1)).toBe(' px-list--stack px-list--compact');
  });

  it('compact always implies stacked', () => {
    for (let w = 1; w < 2000; w += 7) {
      const l = listLayout(w);
      if (l.compact) expect(l.stacked).toBe(true);
    }
  });
});
