/**
 * DayJournal (J4/J7, D2/D3/D7): the left-panel editor for a calendar day's note.
 * The edit surface is the TipTap WYSIWYG (`RichJournalEditor`, J7) bound to the
 * markdown `content` field; locking renders the same markdown read-only via
 * `react-markdown`+`remark-gfm` (the exact sanitized output shared with the `.md`
 * export and other clients). The chrome around it depends on where the panel is
 * mounted — see the `actions` prop. Mobile keeps the J4 toolbar/textarea editor
 * and its own Preview/Export/Delete buttons.
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
import { Ic, journalDayFilename, useCommands, useDayLog, useJournalDay, useUserSettings, type CommandContext } from '@prisms/ui';

import { isNoteLocked, setNoteLocked } from '../note-locks';
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
export function DayJournalPanel({
  date,
  ctx,
  actions = 'menu',
}: {
  date: string;
  ctx: CommandContext;
  /**
   * Which chrome the panel carries.
   * - `menu` (default, the Journal screen): the "⋯" menu — lock/edit, Export .md,
   *   Delete. That screen is where a note is managed, so it keeps the full set.
   * - `lock`: a single lock/pencil toggle and nothing else. The Agenda uses this
   *   — there the note is a side panel next to the week, and export/delete are a
   *   click away on the Journal screen.
   */
  actions?: 'menu' | 'lock';
}) {
  const { entry, isLoading } = useJournalDay(date);
  const commands = useCommands(ctx);
  // Annex L: derived at render from the warm provider — null when the built-in
  // automation is off or the day holds nothing.
  const dayLog = useDayLog(date);
  const { timezone } = useUserSettings();
  const [draft, setDraft] = useState(entry?.content ?? '');
  // `preview` is the LOCKED (read-only) state, surfaced as "Lock edit" ⇄ "Edit".
  // It is PER DAY and remembered: each day keeps whichever state it was left in,
  // so locking one note does not lock the rest.
  const [preview, setPreview] = useState(() => isNoteLocked(date));
  // Both call sites mount this with key={date}, so the initializer above already
  // re-runs per day. This keeps that correct if a future one forgets the key.
  useEffect(() => setPreview(isNoteLocked(date)), [date]);

  function toggleLock() {
    const next = !preview;
    setPreview(next);
    setNoteLocked(date, next);
  }

  const [menuOpen, setMenuOpen] = useState(false);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const existingId = entry?.id;
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Dismiss the overflow menu on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as HTMLElement)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

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
        {/* `lock`: one button, nothing else — the icon is the affordance for what
            the click DOES (a padlock while editing, a pencil while locked). */}
        {actions === 'lock' ? (
          <button
            className="px-btn px-btn--icon"
            data-testid="journal-preview-toggle"
            aria-pressed={preview}
            aria-label={preview ? 'Edit this note' : 'Lock this note from editing'}
            title={preview ? 'Edit' : 'Lock edit'}
            onClick={toggleLock}
          >
            <Ic name={preview ? 'pen' : 'lock'} />
          </button>
        ) : (
        /* Lock/edit, export and delete all live in this corner menu so the note
           itself is the only thing competing for the panel. */
        <div className="px-menu" ref={menuRef}>
          <button
            className="px-btn px-menu-btn"
            data-testid="journal-menu"
            aria-label="note options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <Ic name="dots" />
          </button>
          {menuOpen && (
            <div className="px-menu-pop" role="menu" data-testid="journal-menu-pop">
              <button
                className="px-menu-item"
                role="menuitem"
                data-testid="journal-preview-toggle"
                aria-pressed={preview}
                onClick={() => {
                  toggleLock();
                  setMenuOpen(false);
                }}
              >
                <Ic name={preview ? 'pen' : 'lock'} />
                {preview ? 'Edit' : 'Lock edit'}
              </button>
              <button
                className="px-menu-item"
                role="menuitem"
                data-testid="journal-export"
                onClick={() => {
                  exportDay();
                  setMenuOpen(false);
                }}
              >
                <Ic name="down" />
                Export .md
              </button>
              {existingId && (
                <>
                  <div className="px-menu-sep" />
                  <button
                    className="px-menu-item px-menu-item--danger"
                    role="menuitem"
                    data-testid="journal-delete"
                    onClick={() => {
                      remove();
                      setMenuOpen(false);
                    }}
                  >
                    <Ic name="trash" />
                    Delete
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        )}
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
    </div>
  );
}
