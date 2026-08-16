/**
 * What each day's note was last KNOWN to be — locked, or open for editing.
 *
 * `journal_entries.locked` is a synced field, so the panel can only read it once
 * the day's row has been read. Mounting a day it has never seen, it has to guess,
 * and the only safe guess was "not locked" — so switching to a locked note drew
 * the full editing chrome first and folded it away once the row arrived.
 * Measured on the Agenda: the incoming panel mounted at +24ms reading unlocked
 * and corrected itself at +60ms, i.e. ~36ms of toolbar that should never have
 * been there. Short, and exactly long enough to read as a flicker.
 *
 * So the answer is remembered per day and consulted while the read is still
 * unsettled. It is a HINT, never the truth: the moment the row settles it is
 * overwritten by what the row actually says, so a note locked (or unlocked) on
 * another device corrects itself on arrival the same way it always did. The
 * worst a stale hint can do is what the old default did unconditionally — draw
 * the wrong chrome for a frame — and it now does that only when the answer has
 * genuinely changed elsewhere, rather than every single time.
 *
 * Persisted, so the first switch after a reload is smooth too, and capped so a
 * long-lived journal cannot grow it without bound. Best-effort throughout: no
 * storage (private mode) simply means the old behaviour.
 */
const KEY = 'prisms.journal.locked';

/** Days remembered before the oldest are dropped. A year and a bit of journal. */
const CAP = 400;

/** Insertion-ordered, so trimming from the front drops the least recently written. */
let cache: Map<string, boolean> | null = null;

function load(): Map<string, boolean> {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      // Anything not shaped like the record we wrote is discarded rather than
      // trusted — this seeds a rendering decision, and a junk value would paint.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [date, locked] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof locked === 'boolean') cache.set(date, locked);
        }
      }
    }
  } catch {
    /* unreadable or unparseable — start empty, which is the old behaviour */
  }
  return cache;
}

function persist(map: Map<string, boolean>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    /* the in-memory map still serves this session */
  }
}

/**
 * What `date` opened as last time, or undefined for a day never seen — in which
 * case the caller has nothing better than the old assumption.
 */
export function readJournalLocked(date: string): boolean | undefined {
  return load().get(date);
}

/** Remember the settled answer for `date`. A no-op when it has not changed. */
export function writeJournalLocked(date: string, locked: boolean): void {
  const map = load();
  if (map.get(date) === locked) return;
  map.delete(date); // re-insert so the most recently written sits at the end
  map.set(date, locked);
  while (map.size > CAP) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
  persist(map);
}

/** Test-only: drop everything, in memory and on disk. */
export function __resetJournalLockCache(): void {
  cache = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
