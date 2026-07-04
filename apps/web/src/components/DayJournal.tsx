/**
 * DayJournal (J4, D2/D3/D7): the left-panel editor for a calendar day's note.
 * Markdown textarea + a formatting toolbar (the shared, unit-tested
 * `applyMarkdownEdit`) + a preview toggle rendered by `react-markdown`+`remark-gfm`.
 *
 * Rendering is SANITIZED (D2): raw HTML in the markdown is NEVER rendered
 * (react-markdown default — we deliberately do NOT add rehype-raw), link hrefs are
 * allowlisted to http/https/mailto (anything else, e.g. `javascript:`, is dropped),
 * and task-list checkboxes render disabled. Saves debounce (800ms) + flush on blur
 * via `journal.write`; an explicit Delete soft-deletes; empty saves are allowed.
 */
import { useEffect, useRef, useState } from 'react';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { applyMarkdownEdit, journalDayFilename, useCommands, useJournalDay, type CommandContext, type MarkdownAction } from '@prisms/ui';

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

const TOOLBAR: { action: MarkdownAction; label: string; title: string }[] = [
  { action: 'bold', label: 'B', title: 'Bold' },
  { action: 'italic', label: 'I', title: 'Italic' },
  { action: 'strikethrough', label: 'S', title: 'Strikethrough' },
  { action: 'h1', label: 'H1', title: 'Heading 1' },
  { action: 'h2', label: 'H2', title: 'Heading 2' },
  { action: 'h3', label: 'H3', title: 'Heading 3' },
  { action: 'bulletList', label: '•', title: 'Bullet list' },
  { action: 'numberList', label: '1.', title: 'Numbered list' },
  { action: 'taskList', label: '☑', title: 'Task list' },
  { action: 'quote', label: '❝', title: 'Quote' },
  { action: 'code', label: '‹›', title: 'Inline code' },
  { action: 'codeBlock', label: '{ }', title: 'Code block' },
  { action: 'link', label: '🔗', title: 'Link' },
];

/**
 * Editor for one day. Mounted with `key={date}` by the Agenda so it re-initializes
 * per day; the draft adopts the synced content when it first loads but never
 * clobbers an in-progress edit (`dirty`). `existingId` (the live row id) is passed
 * to `writeJournal` so edits patch that row — a new day mints one.
 */
export function DayJournalPanel({ date, ctx }: { date: string; ctx: CommandContext }) {
  const { entry, isLoading } = useJournalDay(date);
  const commands = useCommands(ctx);
  const [draft, setDraft] = useState(entry?.content ?? '');
  const [preview, setPreview] = useState(false);
  const dirty = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
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

  function toolbar(action: MarkdownAction) {
    const ta = taRef.current;
    if (!ta) return;
    const result = applyMarkdownEdit(draft, { start: ta.selectionStart, end: ta.selectionEnd }, action);
    change(result.value);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(result.selection.start, result.selection.end);
    });
  }

  function exportDay() {
    const blob = new Blob([draft], { type: 'text/markdown;charset=utf-8' });
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
        <>
          <div className="px-md-toolbar" role="toolbar" aria-label="formatting">
            {TOOLBAR.map((t) => (
              <button
                key={t.action}
                className="px-btn"
                data-testid={`md-${t.action}`}
                title={t.title}
                aria-label={t.title}
                onMouseDown={(e) => e.preventDefault()} // keep the textarea selection
                onClick={() => toolbar(t.action)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <textarea
            ref={taRef}
            className="px-journal-editor"
            data-testid="journal-editor"
            value={draft}
            placeholder="Write a note for this day… (markdown)"
            onChange={(e) => change(e.target.value)}
            onBlur={(e) => flush(e.target.value)}
            rows={12}
            style={{ width: '100%', marginTop: 8, resize: 'vertical' }}
          />
        </>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="px-btn" data-testid="journal-export" onClick={exportDay}>Export .md</button>
        {existingId && (
          <button className="px-btn px-btn--danger" data-testid="journal-delete" onClick={remove}>Delete</button>
        )}
      </div>
    </div>
  );
}
