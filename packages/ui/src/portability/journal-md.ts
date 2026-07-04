/**
 * Per-day `.md` archive (D7). Because journal storage is CommonMark text, a
 * day's export is the `content` field VERBATIM — the date lives in the filename;
 * no frontmatter, no conversion, byte-lossless (emoji included).
 * `buildJournalArchive` packages one `.md` per day into a zip via fflate (pure
 * JS: node/browser/Hermes). PURE — the platform supplies the source (the
 * server-sourced export) and the download/share of the returned bytes.
 */
import { strToU8, zipSync } from 'fflate';

/** A day's note as returned by `GET /sync/journal/export` — the archive input. */
export interface JournalExportEntry {
  entry_date: string; // 'YYYY-MM-DD'
  content: string;
}

/** `YYYY-MM-DD.md` — the single-day export filename. */
export const journalDayFilename = (entryDate: string): string => `${entryDate}.md`;

/** Stamp an ISO instant the same way `exportFilename` does (sortable, filename-safe). */
const stamp = (atIso: string): string => atIso.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');

/** `prisms-journal_<stamp>.zip` — the full-archive download filename. */
export const journalArchiveFilename = (atIso: string): string => `prisms-journal_${stamp(atIso)}.zip`;

/**
 * A zip of one `journal/YYYY/YYYY-MM-DD.md` per entry, content UTF-8-encoded
 * VERBATIM (emoji byte-exact via `strToU8`'s TextEncoder). Entries are written in
 * date order so the file layout is deterministic (testable); an empty-content day
 * still emits its (empty) file. Paths are pure ASCII — no zip UTF-8-flag pitfalls.
 */
export function buildJournalArchive(entries: readonly JournalExportEntry[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const sorted = [...entries].sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : 0));
  for (const e of sorted) {
    const year = e.entry_date.slice(0, 4);
    files[`journal/${year}/${e.entry_date}.md`] = strToU8(e.content);
  }
  return zipSync(files);
}
