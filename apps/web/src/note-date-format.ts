/**
 * How a note's day is written where it is shown read-only: the caption under the
 * note's title, and the default "Note · <date>" heading of an untitled note.
 *
 * Both used to print the raw ISO date (`2026-11-20`), which reads as a database
 * value rather than a day. The default now names the weekday too (`Fri 20 Nov 2026`);
 * Settings offers the other common shapes, each previewed live. Day and month names
 * are fixed English abbreviations so a date reads the same on every device.
 *
 * Per-device (localStorage), like `due-date-format` and `agenda-range`: it applies the
 * moment it is picked and there is nothing to sync. The store is module-level so
 * Settings (which writes it) and the note panel (which reads it) stay in step.
 */
import { useSyncExternalStore } from 'react';

export const NOTE_DATE_FORMAT_KEY = 'prisms.noteDate.format';

export type NoteDateFormat = 'long' | 'dd-mmm-yyyy' | 'mmm-dd-yyyy' | 'dd-mm-yyyy' | 'mm-dd-yyyy' | 'iso';

export const NOTE_DATE_FORMATS: readonly { value: NoteDateFormat; label: string }[] = [
  { value: 'long', label: 'Weekday D Mon YYYY' },
  { value: 'dd-mmm-yyyy', label: 'DD/MMM/YYYY' },
  { value: 'mmm-dd-yyyy', label: 'MMM DD, YYYY' },
  { value: 'dd-mm-yyyy', label: 'DD/MM/YYYY' },
  { value: 'mm-dd-yyyy', label: 'MM/DD/YYYY' },
  { value: 'iso', label: 'YYYY-MM-DD' },
];

export const DEFAULT_NOTE_DATE_FORMAT: NoteDateFormat = 'long';

export const isNoteDateFormat = (v: string): v is NoteDateFormat => NOTE_DATE_FORMATS.some((o) => o.value === v);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A `YYYY-MM-DD` date in the chosen shape. Anything that is not an ISO date is returned as it came. */
export function formatNoteDate(iso: string, format: NoteDateFormat = DEFAULT_NOTE_DATE_FORMAT): string {
  const m = ISO_DATE.exec(iso);
  if (!m) return iso;
  const [, year, month, day] = m as unknown as [string, string, string, string];
  const mon = MONTHS[Number(month) - 1];
  if (!mon) return iso;
  switch (format) {
    case 'long': {
      // UTC, so the weekday never drifts a day with the viewer's zone.
      const wd = WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
      return `${wd} ${Number(day)} ${mon} ${year}`;
    }
    case 'dd-mmm-yyyy':
      return `${day}/${mon}/${year}`;
    case 'mmm-dd-yyyy':
      return `${mon} ${day}, ${year}`;
    case 'dd-mm-yyyy':
      return `${day}/${month}/${year}`;
    case 'mm-dd-yyyy':
      return `${month}/${day}/${year}`;
    case 'iso':
      return iso;
  }
}

/** The heading an untitled note carries: `Note · <date>`. */
export const noteHeadingOf = (iso: string, format: NoteDateFormat = DEFAULT_NOTE_DATE_FORMAT): string =>
  `Note · ${formatNoteDate(iso, format)}`;

// --- the stored preference ------------------------------------------------

const listeners = new Set<() => void>();

function readFormat(): NoteDateFormat {
  try {
    const stored = localStorage.getItem(NOTE_DATE_FORMAT_KEY) ?? '';
    return isNoteDateFormat(stored) ? stored : DEFAULT_NOTE_DATE_FORMAT;
  } catch {
    return DEFAULT_NOTE_DATE_FORMAT; // no storage (private mode, or a bare Node global)
  }
}

function onStorage(e: StorageEvent): void {
  if (e.key !== null && e.key !== NOTE_DATE_FORMAT_KEY) return;
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

export function setNoteDateFormatPref(format: string): void {
  if (!isNoteDateFormat(format)) return;
  try {
    localStorage.setItem(NOTE_DATE_FORMAT_KEY, format);
  } catch {
    /* best-effort — nothing to fall back to but the default */
  }
  for (const l of [...listeners]) l();
}

/** The live note-date format. Re-renders its caller when Settings changes it. */
export function useNoteDateFormatPref(): NoteDateFormat {
  return useSyncExternalStore(subscribe, readFormat, () => DEFAULT_NOTE_DATE_FORMAT);
}
