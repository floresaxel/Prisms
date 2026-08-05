/**
 * Which day notes are locked from editing, remembered per day.
 *
 * A DEVICE preference, not user content: it says nothing about the note itself,
 * only how this browser last left it open — so it lives in localStorage beside
 * the sidebar-rail and agenda-span preferences rather than in the synced domain
 * model. Locking a day on the laptop does not lock it on the phone.
 *
 * Only LOCKED days are stored (absent = editable), which keeps the list to the
 * handful of days a user has deliberately frozen. It is still capped, because an
 * unbounded key that only ever grows is a slow leak; the oldest days go first.
 */
const KEY = 'prisms.journal.locked';

/** Locked days retained. Well past any real use; a ceiling, not a budget. */
export const MAX_LOCKED_DAYS = 500;

/**
 * The backing store, resolved per call. Node 26 exposes a `localStorage` global
 * that is `undefined` unless the process was started with `--localstorage-file`,
 * and it shadows the one jsdom installs — so the bare global alone is not enough
 * to find the real store under test.
 */
function storage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined' && localStorage !== null) return localStorage;
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // access itself throws in some privacy modes
  }
  return null;
}

function read(): string[] {
  try {
    const raw = storage()?.getItem(KEY) ?? null;
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    // unparseable, or storage unavailable (private mode) — treat as "none locked"
    return [];
  }
}

function write(dates: readonly string[]): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(dates));
  } catch {
    // storage unavailable or full: the lock is a preference, so losing it is not
    // worth failing the interaction the user just performed.
  }
}

/** Every day currently locked, oldest first. */
export function lockedDays(): string[] {
  return read();
}

export function isNoteLocked(date: string): boolean {
  return read().includes(date);
}

export function setNoteLocked(date: string, locked: boolean): void {
  const next = read().filter((d) => d !== date);
  if (locked) next.push(date);
  next.sort(); // ISO dates sort chronologically
  write(next.length > MAX_LOCKED_DAYS ? next.slice(next.length - MAX_LOCKED_DAYS) : next);
}
