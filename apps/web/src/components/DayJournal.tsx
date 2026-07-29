/**
 * DayJournal (J4/J7, D2/D3/D7): the left-panel editor for a calendar day's note.
 * The edit surface is the TipTap WYSIWYG (`RichJournalEditor`, J7) bound to the
 * markdown `content` field; a Preview toggle renders the same markdown read-only
 * via `react-markdown`+`remark-gfm` (the exact sanitized output shared with the
 * `.md` export and other clients). Mobile keeps the J4 toolbar/textarea editor.
 *
 * Rendering is SANITIZED (D2): raw HTML in the markdown is NEVER rendered
 * (react-markdown default — we deliberately do NOT add rehype-raw), link hrefs are
 * allowlisted to http/https/mailto (anything else, e.g. `javascript:`, is dropped),
 * and task-list checkboxes render disabled. Saves debounce (800ms) + flush on blur
 * (and on unmount) via `journal.write`; an explicit Delete soft-deletes; empty
 * saves are allowed.
 */
import { useEffect, useRef, useState } from 'react';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { composeDayMarkdown } from '@prisms/core';
import { journalDayFilename, useCommands, useDayLog, useJournalDay, useUserSettings, type CommandContext } from '@prisms/ui';

import { DayLogFooter } from './DayLogFooter';
import { RichJournalEditor } from './RichJournalEditor';

const SAVE_DEBOUNCE_MS = 800;

/** Allow only these link schemes; everything else (javascript:, data:, …) is dropped. */
const SAFE_URL = /^(https?:|mailto:)/i;
const urlTransform = (url: string): string => (SAFE_URL.test(url) ? url : '');

/**
 * Sanitized markdown renderer (D2). No raw-HTML path (no rehype-raw), href scheme
 * allowlist, task checkboxes disabled. Exported so tests can assert inertness.
 */
export function MarkdownView({ markdown }: { markdown: string }) {
  return (
    <div className="px-md" data-testid="journal-preview">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Editor for one day. Mounted with `key={date}` by the Agenda so it re-initializes
 * per day; the draft adopts the synced content when it first loads but never
 * clobbers an in-progress edit (`dirty`). `existingId` (the live row id) is passed
 * to `writeJournal` so edits patch that row — a new day mints one.
 */
export function DayJournalPanel({ date, ctx }: { date: string; ctx: CommandContext }) {
  const { entry, isLoading } = useJournalDay(date);
  const commands = useCommands(ctx);
  // Annex L: derived at render from the warm provider — null when the built-in
  // automation is off or the day holds nothing.
  const dayLog = useDayLog(date);
  const { timezone } = useUserSettings();
  const [draft, setDraft] = useState(entry?.content ?? '');
  const [preview, setPreview] = useState(false);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const existingId = entry?.id;

  // Adopt synced content when it arrives, unless the user has already edited.
  useEffect(() => {
    if (!dirty.current) setDraft(entry?.content ?? '');
  }, [entry?.content]);
  const write = (content: string) => commands.writeJournal({ existingId, entryDate: date, content });

  // Flush a pending debounced save if the panel unmounts (day switch) before the
  // debounce fires and without an onBlur — otherwise the last edit is dropped.
  // Guarded on `timer` so a clean unmount (already saved on blur) doesn't re-write.
  const flushPending = useRef<() => void>(() => undefined);
  flushPending.current = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
      void write(draft);
    }
  };
  useEffect(() => () => flushPending.current(), []);

  function scheduleSave(next: string) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void write(next), SAVE_DEBOUNCE_MS);
  }
  function flush(next: string) {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    void write(next);
  }
  function change(next: string) {
    dirty.current = true;
    setDraft(next);
    scheduleSave(next);
  }

  function exportDay() {
    // The note VERBATIM, then the day-log section (D7) — the same core compose
    // the archive zip and mobile Share use, so no two surfaces can disagree.
    const blob = new Blob([composeDayMarkdown(draft, dayLog, { timezone })], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = journalDayFilename(date);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function remove() {
    if (!existingId) return;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    void commands.deleteJournal(existingId);
    dirty.current = false;
    setDraft('');
  }

  return (
    <div className="px-journal" data-testid={`journal-${date}`} style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, flex: 1 }}>Note · {date}</h2>
        <button className="px-btn" data-testid="journal-preview-toggle" aria-pressed={preview} onClick={() => setPreview((p) => !p)}>
          {preview ? 'Edit' : 'Preview'}
        </button>
      </div>

      {isLoading ? (
        <p className="px-muted" data-testid="journal-loading">Loading…</p>
      ) : preview ? (
        <MarkdownView markdown={draft} />
      ) : (
        <RichJournalEditor value={draft} onChange={change} onBlur={flush} />
      )}

      {/* OUTSIDE the editor and the preview, in both modes — never part of the
          document the user types into. */}
      {!isLoading && <DayLogFooter entries={dayLog} timezone={timezone} />}

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="px-btn" data-testid="journal-export" onClick={exportDay}>Export .md</button>
        {existingId && (
          <button className="px-btn px-btn--danger" data-testid="journal-delete" onClick={remove}>Delete</button>
        )}
      </div>
    </div>
  );
}
