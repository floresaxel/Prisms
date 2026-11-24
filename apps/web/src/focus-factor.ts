/**
 * The focus multiple (§1.2, §8.1) as the Review tab edits it: a factor applied
 * to the time a session logged, anywhere from 0 ("doesn't count") to 1.0. The
 * arrows move it by a tenth, all the way — 1.0, 0.9 … 0.1, 0 — like the Duration
 * arrows in the task card; typed values may be any hundredth in range. Pure, so
 * the stepper's rules are unit-testable.
 *
 * The clock-out review's slider is narrower on purpose: it stops at
 * FOCUS_POPUP_MIN (0.3), so ×0 and ×0.1–0.2 are only set from the Review tab.
 */
import { FOCUS_FACTOR_MAX, FOCUS_FACTOR_NONE } from '@prisms/core';

/** The lowest a session can count: nothing at all. */
export const FOCUS_NONE = FOCUS_FACTOR_NONE;
export const FOCUS_MAX = FOCUS_FACTOR_MAX;
/** Where the clock-out review's slider bottoms out. */
export const FOCUS_POPUP_MIN = 0.3;
export const FOCUS_STEP = 0.1;

const hundredths = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number) => Math.min(FOCUS_MAX, Math.max(FOCUS_NONE, n));

/** `0.8` → `"0.8"`, `1` → `"1.0"`, `0.85` → `"0.85"`, `0` → `"0"`. */
export function focusText(f: number): string {
  const r = hundredths(f);
  if (r === FOCUS_NONE) return '0';
  return Number.isInteger(r * 10) ? r.toFixed(1) : r.toFixed(2);
}

/**
 * A typed multiple → the factor, held to 0–1.0. `undefined` when it is not a
 * number at all (the caller puts the stored value back). A leading `×`/`x` is
 * ignored and `,` counts as a decimal point.
 */
export function parseFocus(text: string): number | undefined {
  const t = text.trim().replace(/^[×x]\s*/i, '').replace(',', '.');
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? hundredths(clamp(n)) : undefined;
}

/** One arrow press: to the next tenth up or down from where it is, never leaving 0–1.0. */
export function stepFocus(current: number, dir: 1 | -1): number {
  const tenths = clamp(current) * 10;
  const next = dir === 1 ? Math.floor(tenths + 1e-9) + 1 : Math.ceil(tenths - 1e-9) - 1;
  return hundredths(clamp(next / 10));
}
