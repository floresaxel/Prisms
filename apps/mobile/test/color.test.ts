/** T0: the gradient fades depend on `withAlpha` producing the *same* hue at 0 alpha. */
import { describe, expect, it } from 'vitest';

import { withAlpha } from '../src/color';

describe('withAlpha', () => {
  it('expands 6-digit hex', () => {
    expect(withAlpha('#f6f7f9', 0)).toBe('rgba(246, 247, 249, 0)');
    expect(withAlpha('#ffffff', 1)).toBe('rgba(255, 255, 255, 1)');
  });

  it('expands shorthand hex', () => {
    expect(withAlpha('#fff', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
  });

  it('drops an existing alpha channel and re-applies the new one', () => {
    expect(withAlpha('#18202b47', 0.28)).toBe('rgba(24, 32, 43, 0.28)');
    expect(withAlpha('rgba(24,32,43,0.28)', 0)).toBe('rgba(24, 32, 43, 0)');
  });

  it('clamps alpha into 0..1', () => {
    expect(withAlpha('#000000', -2)).toBe('rgba(0, 0, 0, 0)');
    expect(withAlpha('#000000', 9)).toBe('rgba(0, 0, 0, 1)');
  });

  it('passes unparseable colours through untouched', () => {
    expect(withAlpha('transparent', 0)).toBe('transparent');
    expect(withAlpha('#12345', 0)).toBe('#12345');
  });
});
