/**
 * How a note's day is written where it is shown read-only. Two separate settings:
 * the CAPTION under the note's title, and the DEFAULT TITLE ("Note · <date>") of an
 * untitled note.
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
export const NOTE_TITLE_FORMAT_KEY = 'prisms.noteTitle.format';

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

// --- the stored preferences -----------------------------------------------

/**
 * Two independent preferences share one shape: the format of the caption under a
 * note's title, and the format used in an untitled note's default "Note · <date>"
 * title. Each is its own localStorage key and its own live store.
 */
function createFormatPref(key: string) {
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of [...listeners]) l();
  };
  const read = (): NoteDateFormat => {
    try {
      const stored = localStorage.getItem(key) ?? '';
      return isNoteDateFormat(stored) ? stored : DEFAULT_NOTE_DATE_FORMAT;
    } catch {
      return DEFAULT_NOTE_DATE_FORMAT; // no storage (private mode, or a bare Node global)
    }
  };
  const onStorage = (e: StorageEvent): void => {
    // key === null is a whole-storage clear, which counts as a change.
    if (e.key === null || e.key === key) notify();
  };
  const subscribe = (cb: () => void): (() => void) => {
    listeners.add(cb);
    if (listeners.size === 1) window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(cb);
      if (listeners.size === 0) window.removeEventListener('storage', onStorage);
    };
  };
  return {
    set(format: string): void {
      if (!isNoteDateFormat(format)) return;
      try {
        localStorage.setItem(key, format);
      } catch {
        /* best-effort — nothing to fall back to but the default */
      }
      notify();
    },
    use: (): NoteDateFormat => useSyncExternalStore(subscribe, read, () => DEFAULT_NOTE_DATE_FORMAT),
  };
}

const caption = createFormatPref(NOTE_DATE_FORMAT_KEY);
const title = createFormatPref(NOTE_TITLE_FORMAT_KEY);

/** The caption's format: set from Settings, read live by the note panel. */
export const setNoteDateFormatPref = caption.set;
export const useNoteDateFormatPref = caption.use;
/** The default title's format: set from Settings, read live wherever an untitled note is named. */
export const setNoteTitleFormatPref = title.set;
export const useNoteTitleFormatPref = title.use;

/** Is `text` the default heading of this day in ANY format — i.e. the user typed the default back? */
export const isDefaultNoteHeading = (text: string, iso: string): boolean =>
  NOTE_DATE_FORMATS.some((o) => text === noteHeadingOf(iso, o.value));