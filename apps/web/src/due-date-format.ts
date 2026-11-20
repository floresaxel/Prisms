/**
 * How a task's due date is written in lists: `20/Nov` by default.
 *
 * The rows used to print the raw tail of the ISO date (`11-20`), which nobody reads
 * as a date. The shapes offered here are the common ones; the example beside each in
 * Settings is computed live, not written down. Day and month names are fixed English
 * abbreviations, so the same date reads the same on every device.
 *
 * The preference is per-device (localStorage), for the reason `agenda-range` is: it
 * applies the moment it is picked, with nothing to sync and no `user_settings` column
 * behind it. The store is module-level so Settings (which writes it) and the lists
 * (which read it) stay in step.
 */
import { useSyncExternalStore } from 'react';

export const DUE_FORMAT_KEY = 'prisms.dueDate.format';

export type DueDateFormat = 'dd-mmm' | 'mmm-dd' | 'dd-mmm-yyyy' | 'dd-mm' | 'mm-dd' | 'iso';

/** The offered shapes, labelled the way they are written. */
export const DUE_DATE_FORMATS: readonly { value: DueDateFormat; label: string }[] = [
  { value: 'dd-mmm', label: 'DD/MMM' },
  { value: 'mmm-dd', label: 'MMM DD' },
  { value: 'dd-mmm-yyyy', label: 'DD/MMM/YYYY' },
  { value: 'dd-mm', label: 'DD/MM' },
  { value: 'mm-dd', label: 'MM/DD' },
  { value: 'iso', label: 'YYYY-MM-DD' },
];

export const DEFAULT_DUE_DATE_FORMAT: DueDateFormat = 'dd-mmm';

export const isDueDateFormat = (v: string): v is DueDateFormat => DUE_DATE_FORMATS.some((o) => o.value === v);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A `YYYY-MM-DD` date in the chosen shape. Anything that is not an ISO date is returned as it came. */
export function formatDueDate(iso: string, format: DueDateFormat = DEFAULT_DUE_DATE_FORMAT): string {
  const m = ISO_DATE.exec(iso);
  if (!m) return iso;
  const [, year, month, day] = m as unknown as [string, string, string, string];
  const mon = MONTHS[Number(month) - 1];
  if (!mon) return iso;
  switch (format) {
    case 'dd-mmm':
      return `${day}/${mon}`;
    case 'mmm-dd':
      return `${mon} ${day}`;
    case 'dd-mmm-yyyy':
      return `${day}/${mon}/${year}`;
    case 'dd-mm':
      return `${day}/${month}`;
    case 'mm-dd':
      return `${month}/${day}`;
    case 'iso':
      return iso;
  }
}

// --- the stored preference ------------------------------------------------

const listeners = new Set<() => void>();

/** Read straight through — a primitive snapshot is stable enough for React. */
function readFormat(): DueDateFormat {
  try {
    const stored = localStorage.getItem(DUE_FORMAT_KEY) ?? '';
    return isDueDateFormat(stored) ? stored : DEFAULT_DUE_DATE_FORMAT;
  } catch {
    return DEFAULT_DUE_DATE_FORMAT; // no storage (private mode, or a bare Node global)
  }
}

function onStorage(e: StorageEvent): void {
  // key === null is a whole-storage clear, which counts as a change.
  if (e.key !== null && e.key !== DUE_FORMAT_KEY) return;
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

export function setDueDateFormatPref(format: string): void {
  if (!isDueDateFormat(format)) return;
  try {
    localStorage.setItem(DUE_FORMAT_KEY, format);
  } catch {
    /* best-effort — nothing to fall back to but the default */
  }
  for (const l of [...listeners]) l();
}

/** The live due-date format. Re-renders its caller when Settings changes it. */
export function useDueDateFormatPref(): DueDateFormat {
  return useSyncExternalStore(subscribe, readFormat, () => DEFAULT_DUE_DATE_FORMAT);
}
