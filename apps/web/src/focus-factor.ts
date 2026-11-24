/**
 * The focus multiple (§1.2, §8.1) as the Review tab edits it: a factor applied
 * to the time a session logged — 0 ("doesn't count"), or between 0.3 and 1.0.
 * The arrows move it by a tenth (like the Duration arrows in the task card), and
 * one step below 0.3 is 0; typed values may be any hundredth in range. Pure, so
 * the stepper's rules are unit-testable.
 */
import { FOCUS_FACTOR_MAX, FOCUS_FACTOR_MIN, FOCUS_FACTOR_NONE } from '@prisms/core';

export const FOCUS_MIN = FOCUS_FACTOR_MIN;
export const FOCUS_MAX = FOCUS_FACTOR_MAX;
/** The session doesn't count at all. */
export const FOCUS_NONE = FOCUS_FACTOR_NONE;
export const FOCUS_STEP = 0.1;

const hundredths = (n: number) => Math.round(n * 100) / 100;

/** Into the allowed set: 0 stays 0, anything above it is held to 0.3–1.0. */
function clamp(n: number): number {
  if (n <= FOCUS_NONE) return FOCUS_NONE;
  return Math.min(FOCUS_MAX, Math.max(FOCUS_MIN, n));
}

/** `0.8` → `"0.8"`, `1` → `"1.0"`, `0.85` → `"0.85"`, `0` → `"0"`. */
export function focusText(f: number): string {
  const r = hundredths(f);
  if (r === FOCUS_NONE) return '0';
  return Number.isInteger(r * 10) ? r.toFixed(1) : r.toFixed(2);
}

/**
 * A typed multiple → the factor, held to the allowed set (0, or 0.3–1.0).
 * `undefined` when it is not a number at all (the caller puts the stored value
 * back). A leading `×`/`x` is ignored and `,` counts as a decimal point.
 */
export function parseFocus(text: string): number | undefined {
  const t = text.trim().replace(/^[×x]\s*/i, '').replace(',', '.');
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? hundredths(clamp(n)) : undefined;
}

/**
 * One arrow press: to the next tenth up or down from where it is, never leaving
 * the range. Down from 0.3 is 0 (doesn't count); up from 0 is 0.3.
 */
export function stepFocus(current: number, dir: 1 | -1): number {
  const at = clamp(current);
  if (at === FOCUS_NONE) return dir === 1 ? FOCUS_MIN : FOCUS_NONE;
  const tenths = at * 10;
  const next = dir === 1 ? Math.floor(tenths + 1e-9) + 1 : Math.ceil(tenths - 1e-9) - 1;
  if (next / 10 < FOCUS_MIN - 1e-9) return FOCUS_NONE;
  return hundredths(clamp(next / 10));
}
