/**
 * The focus multiple (§1.2, §8.1) as the Review tab's log edits it: a factor
 * between 0.5 and 1.0 applied to the time a session logged. The arrows move it
 * by a tenth (like the Duration arrows in the task card); typed values may be
 * any hundredth. Pure, so the stepper's rules are unit-testable.
 */

export const FOCUS_MIN = 0.5;
export const FOCUS_MAX = 1.0;
export const FOCUS_STEP = 0.1;

const clamp = (n: number) => Math.min(FOCUS_MAX, Math.max(FOCUS_MIN, n));
const hundredths = (n: number) => Math.round(n * 100) / 100;

/** `0.8` → `"0.8"`, `1` → `"1.0"`, `0.85` → `"0.85"`. */
export function focusText(f: number): string {
  const r = hundredths(f);
  return Number.isInteger(r * 10) ? r.toFixed(1) : r.toFixed(2);
}

/**
 * A typed multiple → the factor, clamped into range. `undefined` when it is not
 * a number at all (the caller puts the stored value back). A leading `×`/`x` is
 * ignored and `,` counts as a decimal point.
 */
export function parseFocus(text: string): number | undefined {
  const t = text.trim().replace(/^[×x]\s*/i, '').replace(',', '.');
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? hundredths(clamp(n)) : undefined;
}

/** One arrow press: to the next tenth up or down from where it is, never leaving the range. */
export function stepFocus(current: number, dir: 1 | -1): number {
  const tenths = clamp(current) * 10;
  const next = dir === 1 ? Math.floor(tenths + 1e-9) + 1 : Math.ceil(tenths - 1e-9) - 1;
  return hundredths(clamp(next / 10));
}
