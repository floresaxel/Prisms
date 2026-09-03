/**
 * Where a dragged item lands on the Agenda grid.
 *
 * A drop used to take the whole hour cell it was released over, so the calendar
 * could only ever express o'clock starts. It now follows the pointer and snaps
 * to a grid of `snap` minutes — 15 by default, configurable in Settings — which
 * is the same rounding the drop preview draws, so what you see under the cursor
 * is exactly what gets written.
 *
 * The math is pure and lives here (not in the screen) for the same reason
 * `agenda-layout` does: in the app it is fed by pointer geometry, which is
 * exactly what a unit test cannot drive.
 *
 * The preference is per-device (localStorage), like the day-span picker beside
 * it — how finely THIS pointer on THIS screen places things is a property of
 * the device, not of the account, so it is deliberately not a synced
 * `user_settings` column.
 */
import { useSyncExternalStore } from 'react';

export const SNAP_KEY = 'prisms.agenda.snap';

/** The offered grids. `short` is the segmented-control face. */
export const SNAP_OPTIONS = [
  { value: 5, label: '5 minutes', short: '5m' },
  { value: 10, label: '10 minutes', short: '10m' },
  { value: 15, label: '15 minutes', short: '15m' },
  { value: 30, label: '30 minutes', short: '30m' },
  { value: 60, label: '1 hour', short: '1h' },
] as const;

export const DEFAULT_SNAP = 15;

export const isSnapMinutes = (n: number): boolean => SNAP_OPTIONS.some((o) => o.value === n);

/**
 * `minutes` from the top of the grid → the nearest snap line, kept inside
 * `limit`. Rounding (not flooring) is what makes the drop feel like it follows
 * the cursor rather than trailing it.
 */
export function snapMinutes(minutes: number, snap: number, limit: number): number {
  if (!Number.isFinite(minutes)) return 0;
  const snapped = Math.round(minutes / snap) * snap;
  return Math.min(limit, Math.max(0, snapped));
}

/**
 * Minutes from the top of the grid for a pointer at `clientY`, less however far
 * into the item it was grabbed — so a block held by its middle keeps its shape
 * under the cursor instead of jumping its top up to meet it.
 */
export function pointerMinutes(clientY: number, rectTop: number, hourPx: number, grabOffsetMin: number): number {
  return ((clientY - rectTop) / hourPx) * 60 - grabOffsetMin;
}

/**
 * Minutes past the grid's first hour → a wall clock like the gutter's own
 * labels (`9am`, `9:15am`). Grid-relative arithmetic, so it says the same thing
 * the hour labels beside it do.
 */
export function fmtGridClock(gridStartHour: number, minutes: number): string {
  const total = gridStartHour * 60 + Math.round(minutes);
  const h = Math.floor(total / 60) % 24;
  const m = ((total % 60) + 60) % 60;
  const ampm = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

// --- the stored preference ------------------------------------------------
// A module-level store rather than screen state: Settings writes it and the
// Agenda reads it, and both are mounted at once on a wide window.

const listeners = new Set<() => void>();

/** Read straight through — a primitive snapshot is stable enough for React. */
function readSnap(): number {
  try {
    const stored = Number(localStorage.getItem(SNAP_KEY));
    return isSnapMinutes(stored) ? stored : DEFAULT_SNAP;
  } catch {
    return DEFAULT_SNAP; // no storage (private mode, or a bare Node global)
  }
}

function onStorage(e: StorageEvent): void {
  // key === null is a whole-storage clear, which counts as a change.
  if (e.key !== null && e.key !== SNAP_KEY) return;
  for (const l of [...listeners]) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

export function setSnapPref(minutes: number): void {
  if (!isSnapMinutes(minutes)) return;
  try {
    localStorage.setItem(SNAP_KEY, String(minutes));
  } catch {
    /* preference is best-effort — the session still honours it below */
  }
  for (const l of [...listeners]) l();
}

/** The live snap grid, in minutes. Re-renders its caller when Settings changes it. */
export function useSnapPref(): number {
  return useSyncExternalStore(subscribe, readSnap, () => DEFAULT_SNAP);
}
