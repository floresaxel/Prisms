import { describe, expect, it } from 'vitest';

import { focusText, parseFocus, stepFocus } from '../src/focus-factor';

describe('stepFocus', () => {
  it('moves by a tenth', () => {
    expect(stepFocus(1.0, -1)).toBe(0.9);
    expect(stepFocus(0.8, 1)).toBe(0.9);
    expect(stepFocus(0.8, -1)).toBe(0.7);
  });

  it('never leaves 0–1.0', () => {
    expect(stepFocus(1.0, 1)).toBe(1.0);
    expect(stepFocus(0, -1)).toBe(0);
    expect(stepFocus(0, 1)).toBe(0.1);
    expect(stepFocus(0.1, -1)).toBe(0);
  });

  it('walks the whole range one tenth at a time — no jumps, either way', () => {
    const down: number[] = [1.0];
    for (let i = 0; i < 10; i++) down.push(stepFocus(down.at(-1)!, -1));
    expect(down).toEqual([1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0]);
    const up: number[] = [0];
    for (let i = 0; i < 10; i++) up.push(stepFocus(up.at(-1)!, 1));
    expect(up).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
  });
  it('snaps an in-between value to the next tenth in the direction pressed', () => {
    expect(stepFocus(0.85, 1)).toBe(0.9);
    expect(stepFocus(0.85, -1)).toBe(0.8);
  });

  it('has no floating-point drift across repeated presses', () => {
    let f = 1.0;
    for (let i = 0; i < 10; i++) f = stepFocus(f, -1);
    expect(f).toBe(0);
    for (let i = 0; i < 10; i++) f = stepFocus(f, 1);
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
    expect(parseFocus('0.1')).toBe(0.1); // in range now
    expect(parseFocus('0.45')).toBe(0.45); // now in range
    expect(parseFocus('0')).toBe(0); // doesn't count
    expect(parseFocus('-1')).toBe(0);
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
    expect(focusText(0.3)).toBe('0.3');
    expect(focusText(0.1)).toBe('0.1');
    expect(focusText(0)).toBe('0');
  });
});
