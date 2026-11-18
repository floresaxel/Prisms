/**
 * Tags on a day's note — chips you can remove, and a field to add more.
 *
 * Tags are free text, stored lower-cased and de-duplicated (`normalizeJournalTags`),
 * so typing "Work" on a note already tagged "work" is a no-op rather than a second
 * chip. Enter or a comma commits what you typed; Backspace on an empty field
 * removes the last chip. `readOnly` (a locked note) keeps the chips and drops the
 * controls, so a locked note still shows how it is filed.
 */
import { useEffect, useRef, useState } from 'react';

import { MAX_JOURNAL_TAG_LENGTH, MAX_JOURNAL_TAGS, normalizeJournalTag, normalizeJournalTags } from '@prisms/core';
import { Ic } from '@prisms/ui';

/** How long an edit keeps painting itself before the synced value must speak for it. */
const PENDING_MS = 3000;

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

export function NoteTags({
  tags: synced,
  readOnly,
  onChange,
  suggestions = [],
}: {
  tags: readonly string[];
  readOnly: boolean;
  onChange: (next: string[]) => void | Promise<unknown>;
  /** Tags used on other notes, offered as completions. */
  suggestions?: readonly string[];
}) {
  const [draft, setDraft] = useState('');
  /**
   * The list the user has ASKED for but the row has not caught up to yet, or null.
   *
   * Each edit is built from the CURRENT list, and the synced one lags a click by
   * the whole command round trip (zod, the overlay write, query invalidation, a
   * re-render across a worker). Two quick additions — or a paste followed by an
   * Enter — would both be built from the same stale list and the second would
   * silently replace the first. So edits compose on this, and it is dropped as
   * soon as the synced value agrees with it, when the command fails, or after
   * `PENDING_MS` — so a write that LOST a last-writer-wins race cannot leave a
   * list on screen that the note does not have.
   */
  const [pending, setPending] = useState<string[] | null>(null);
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (pending !== null && sameList(pending, synced)) setPending(null);
  }, [pending, synced]);
  useEffect(() => () => { if (expiry.current) clearTimeout(expiry.current); }, []);

  const tags = pending ?? synced;
  const full = tags.length >= MAX_JOURNAL_TAGS;

  function apply(next: string[]) {
    setPending(next);
    if (expiry.current) clearTimeout(expiry.current);
    expiry.current = setTimeout(() => setPending(null), PENDING_MS);
    // a rejected write puts the note back where the server thinks it is
    void Promise.resolve(onChange(next)).catch(() => setPending(null));
  }

  function commit(raw: string) {
    // a pasted "a, b, c" adds three
    const added = raw.split(',').map(normalizeJournalTag).filter((t): t is string => t !== null);
    setDraft('');
    if (added.length === 0) return;
    const next = normalizeJournalTags([...tags, ...added]);
    if (next.length !== tags.length) apply(next);
  }

  if (readOnly && tags.length === 0) return null;
  const offered = suggestions.filter((s) => !tags.includes(s));

  return (
    <div className="px-jn-tags" data-testid="journal-tags" aria-label="note tags">
      {tags.map((t) => (
        <span key={t} className="px-jn-tag" data-testid={`journal-tag-${t}`}>
          <span aria-hidden="true">#</span>
          {t}
          {!readOnly && (
            <button
              type="button"
              className="px-jn-tag-x"
              data-testid={`journal-tag-remove-${t}`}
              aria-label={`remove tag ${t}`}
              onClick={() => apply(tags.filter((x) => x !== t))}
            >
              <Ic name="x" />
            </button>
          )}
        </span>
      ))}
      {!readOnly && !full && (
        <>
          <input
            className="px-jn-tag-input"
            data-testid="journal-tag-input"
            aria-label="add a tag"
            placeholder={tags.length === 0 ? 'Add a tag…' : '+ tag'}
            maxLength={MAX_JOURNAL_TAG_LENGTH + 1}
            list="px-jn-tag-suggestions"
            value={draft}
            onChange={(e) => {
              // a comma ends a tag as you type it
              if (e.target.value.includes(',')) commit(e.target.value);
              else setDraft(e.target.value);
            }}
            onBlur={() => commit(draft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit(draft);
              } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
                apply(tags.slice(0, -1));
              } else if (e.key === 'Escape') {
                setDraft('');
              }
            }}
          />
          <datalist id="px-jn-tag-suggestions">
            {offered.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </>
      )}
    </div>
  );
}
