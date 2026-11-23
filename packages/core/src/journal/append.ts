/**
 * `journal.append`: how a log line joins a day's note. One rule, used by the
 * server (authoritative) and the client's optimistic overlay, so both show the
 * same text: the line becomes its own paragraph after whatever the note holds.
 */
export const MAX_JOURNAL_CONTENT_LENGTH = 100_000;

export function appendJournalText(content: string | null | undefined, text: string): string {
  const base = (content ?? '').replace(/\s+$/, '');
  return base === '' ? text : `${base}\n\n${text}`;
}
