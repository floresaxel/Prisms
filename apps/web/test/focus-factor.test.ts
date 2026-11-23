import { describe, expect, it } from 'vitest';

import { focusText, parseFocus, stepFocus } from '../src/focus-factor';

describe('stepFocus', () => {
  it('moves by a tenth', () => {
    expect(stepFocus(1.0, -1)).toBe(0.9);
    expect(stepFocus(0.8, 1)).toBe(0.9);
    expect(stepFocus(0.8, -1)).toBe(0.7);
  });

  it('never leaves 0.5–1.0', () => {
    expect(stepFocus(1.0, 1)).toBe(1.0);
    expect(stepFocus(0.5, -1)).toBe(0.5);
  });

  it('snaps an in-between value to the next tenth in the direction pressed', () => {
    expect(stepFocus(0.85, 1)).toBe(0.9);
    expect(stepFocus(0.85, -1)).toBe(0.8);
  });

  it('has no floating-point drift across repeated presses', () => {
    let f = 1.0;
    for (let i = 0; i < 5; i++) f = stepFocus(f, -1);
    expect(f).toBe(0.5);
    for (let i = 0; i < 5; i++) f = stepFocus(f, 1);
    expect(f).toBe(1.0);
  });
});

describe('parseFocus', () => {
  it('reads plain, ×-prefixed and comma decimals', () => {
    expect(parseFocus('0.8')).toBe(0.8);
    expect(parseFocus('×0.7')).toBe(0.7);
    expect(parseFocus('x 0.6')).toBe(0.6);
    expect(parseFocus('0,9')).toBe(0.9);
  });

  it('clamps into range and keeps hundredths', () => {
    expect(parseFocus('2')).toBe(1.0);
    expect(parseFocus('0.1')).toBe(0.5);
    expect(parseFocus('0.755')).toBe(0.76);
  });

  it('is undefined for anything that is not a number', () => {
    expect(parseFocus('')).toBeUndefined();
    expect(parseFocus('abc')).toBeUndefined();
  });
});

describe('focusText', () => {
  it('shows tenths with one decimal and hundredths with two', () => {
    expect(focusText(1)).toBe('1.0');
    expect(focusText(0.8)).toBe('0.8');
    expect(focusText(0.85)).toBe('0.85');
  });
});
