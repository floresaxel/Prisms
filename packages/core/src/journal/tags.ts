/**
 * Journal note tags — free-text labels on a day's note ("work", "health", …) used
 * to group and filter notes. They live on the note's own row (`journal_entries.tags`,
 * migration 0016), not in the confirmable-event `tags` catalog, which is a different
 * feature (yes/no answers on schedule blocks).
 *
 * Normalisation is one function, shared by the client (before it writes, and in the
 * optimistic effect) and the server (before it stores), so the two cannot disagree
 * about what "the same tag" means.
 */

/** Per-note ceiling — generous next to real use; it exists to have a ceiling at all. */
export const MAX_JOURNAL_TAGS = 20;
/** Per-tag length ceiling, after normalisation. */
export const MAX_JOURNAL_TAG_LENGTH = 40;

/**
 * One tag in canonical form: trimmed, a leading `#` dropped, inner whitespace
 * collapsed, lower-cased. Returns null when nothing is left. Lower-casing makes
 * "Work" and "work" one tag, which is what a user who typed both meant.
 */
export function normalizeJournalTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const flat = raw.replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '').trim().toLowerCase();
  if (flat.length === 0) return null;
  return flat.length > MAX_JOURNAL_TAG_LENGTH ? flat.slice(0, MAX_JOURNAL_TAG_LENGTH).trim() : flat;
}

/** A tag list in canonical form: each tag normalised, duplicates dropped, capped. */
export function normalizeJournalTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const tag = normalizeJournalTag(item);
    if (tag === null || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_JOURNAL_TAGS) break;
  }
  return out;
}
