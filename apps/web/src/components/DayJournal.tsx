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
 * and task-list checkboxes render disabled. Saves debounce (SAVE_DEBOUNCE_MS) + flush on blur
 * (and on unmount) via `journal.write`; an explicit Delete soft-deletes; empty
 * saves are allowed.
 */
import { useEffect, useRef, useState } from 'react';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { composeDayMarkdown } from '@prisms/core';
import {
  Ic,
  isJournalContentEmpty,
  journalDayFilename,
  journalTitleOf,
  useCommands,
  useDayLog,
  useJournalDay,
  useUserSettings,
  type CommandContext,
} from '@prisms/ui';

import { DayLogFooter } from './DayLogFooter';
import { RichJournalEditor } from './RichJournalEditor';

/**
 * How long after the last keystroke a note is written. Deliberately short: the
 * debounce exists to coalesce a typing burst into one command, and a shorter
 * window trades command volume for a note that reaches the server (and the
 * user's other devices) sooner. A blur still flushes immediately regardless.
 */
const SAVE_DEBOUNCE_MS = 100;

/**
 * How long the lock's fold runs, and therefore how long the lock ignores further
 * clicks. It is the LONGEST duration in theme.css's lock set — the toolbar
 * collapse and the field's min-height, both 194ms; the padlock's own turn (154ms
 * shutting, 184ms opening) finishes inside it. Keep this in step with those: too
 * short and a double click still gets through, too long and the control feels
 * stuck after it has visibly settled.
 */
const LOCK_ANIM_MS = 194;

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
  const { entry, isLoading, isSettled } = useJournalDay(date);
  const commands = useCommands(ctx);
  // Annex L: derived at render from the warm provider — null when the built-in
  // automation is off or the day holds nothing.
  const dayLog = useDayLog(date);
  const { timezone } = useUserSettings();
  const [draft, setDraft] = useState(entry?.content ?? '');
  const [menuOpen, setMenuOpen] = useState(false);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const existingId = entry?.id;
  const menuRef = useRef<HTMLDivElement | null>(null);

  /** Title and lock belong to a note that EXISTS; a blank day has neither. */
  const hasNote = existingId !== undefined && !isJournalContentEmpty(draft);
  const storedTitle = (entry?.title ?? '').trim();
  /**
   * The heading: the stored title, else "Note · <date>" — but the two are NOT
   * equally safe to render early, so they are gated differently.
   *
   * A stored title is shown the instant it arrives: it is the note's own value,
   * so it can never be contradicted by a later read.
   *
   * The default is the opposite — it asserts that this note has NO title, which
   * is only true once the row has actually been read. Deriving it from
   * `entry?.title` alone assumes the absence: `entry` also carries an empty
   * `title` while the read is unsettled (a cold load, or `ROWS_CACHE` standing in
   * with rows this mount has not re-produced), so the default would paint for a
   * frame and then be overwritten by the real title. It waits for `isSettled`.
   *
   * A day with NO note yet gets the default too — it names the day the note WILL
   * be filed under. The panel used to blank there on the reasoning that a title
   * belongs to a note that exists, but both screens open on TODAY, which usually
   * has nothing written yet: the common view of the Agenda's note panel was a
   * headerless box. The input stays disabled, so this reads as a heading rather
   * than an editable value that has been filled in for you.
   */
  const heading = storedTitle || (isSettled ? journalTitleOf('', date) : '');
  /**
   * The LOCKED (read-only) state of THIS day, surfaced as "Lock edit" ⇄ "Edit".
   * It is a SYNCED field on the day's row (`journal_entries.locked`), not local
   * UI state, so a day locked here opens locked on every other device.
   *
   * Gated on `hasNote`: a row with no text is not a note, and a row that is BOTH
   * empty and locked would otherwise be a dead end — the empty-note rule denies
   * it a title or an unlock, while the lock denies it an editor to type into.
   * Such rows cannot be created any more, but they exist in databases that
   * predate that rule, so an empty one is simply editable.
   */
  /**
   * The lock the user has ASKED for but the row has not caught up to yet, or null
   * when there is nothing outstanding.
   *
   * The panel used to render straight off the synced field, which meant a click
   * moved nothing until the command had been through zod, the overlay store's
   * write transaction, the query invalidation and a re-render — all of it across
   * a web worker. That whole round trip was dead air before the fold so much as
   * began, and it does not shrink when the animation is shortened, so it grew
   * more obvious with every speed-up.
   *
   * The intent paints immediately and is dropped the moment the synced value
   * agrees with it — or the moment the command fails, which puts the note back
   * where the server thinks it is rather than leaving a lie on screen.
   */
  const [lockIntent, setLockIntent] = useState<boolean | null>(null);
  const syncedLocked = entry?.locked ?? false;
  useEffect(() => {
    if (lockIntent !== null && syncedLocked === lockIntent) setLockIntent(null);
  }, [lockIntent, syncedLocked]);

  const preview = hasNote && (lockIntent ?? syncedLocked);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);

  function commitTitle() {
    if (titleDraft === null) return; // nothing typed
    // typing the default back is the same as clearing it — stay untitled so the
    // heading keeps tracking the date.
    const typed = titleDraft.trim();
    const next = typed === journalTitleOf('', date) ? '' : typed;
    setTitleDraft(null);
    if (!existingId || next === (entry?.title ?? '')) return;
    void commands.setJournalTitle(existingId, next);
  }

  /**
   * Has the lock been WORKED yet, this mounting of this day?
   *
   * Gates the swing animation. The keyframes are keyed off `data-state`, and CSS
   * cannot tell "this attribute just changed" from "this attribute was rendered
   * with that value" — so without a gate the shackle would swing itself open
   * every time a locked day is opened, as if someone had just unlocked it. Set on
   * the click, so the animation belongs to the act of locking rather than to
   * arriving at a note that happens to be locked. Resets per day: the panel is
   * mounted with `key={date}`.
   */
  const [lockWorked, setLockWorked] = useState(false);
  /** Mid-transition: the lock is deaf until the fold it started has finished. */
  const [lockBusy, setLockBusy] = useState(false);
  const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (lockTimer.current) clearTimeout(lockTimer.current); }, []);

  /**
   * Toggling is IGNORED while the fold it starts is still running. A double click
   * would otherwise lock and immediately unlock — two commands and two half-played
   * animations for what reads as one gesture — and, worse, the second command
   * races the first to the server on a field that has no ordering of its own.
   *
   * Deliberately not `disabled`: the button greying out for a fifth of a second
   * mid-animation looks like a fault. It simply stops answering.
   */
  function toggleLock() {
    if (!existingId || lockBusy) return;
    const next = !preview;
    setLockWorked(true);
    setLockBusy(true);
    setLockIntent(next); // paints THIS frame; the command catches up behind it
    if (lockTimer.current) clearTimeout(lockTimer.current);
    lockTimer.current = setTimeout(() => {
      lockTimer.current = null;
      setLockBusy(false);
    }, LOCK_ANIM_MS);
    // The write is queued, not awaited — the sync indicator is what reports it as
    // outstanding. A rejection puts the note back rather than stranding the
    // optimistic state; the queue survives a reload either way.
    void commands.setJournalLocked(existingId, next).catch(() => setLockIntent(null));
  }

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

  /**
   * An empty note is not a note. Writing blank content used to store a row that
   * showed up as a note everywhere (the day marker, the month list, the export),
   * so:
   *   - blank + no row  → nothing happens; the day stays untouched.
   *   - blank + a row   → the row is soft-deleted, taking its title and lock with
   *                       it. Typing again re-creates it (the §7.7 partial unique
   *                       permits re-creating a soft-deleted day).
   */
  const write = (content: string) => {
    if (isJournalContentEmpty(content)) {
      if (existingId) void commands.deleteJournal(existingId);
      return;
    }
    void commands.writeJournal({ existingId, entryDate: date, content });
  };

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
      {/* The title is editable; the DATE moves below it, so renaming a note
          never costs you the day it belongs to. The action sits ON the title's
          line (not the block's top edge) — the date underneath is a caption, and
          top-aligning against it left the button floating above the title. */}
      <div className="px-jn-head">
        <div className="px-jn-titlerow">
          {/* Blank until we KNOW what to put here (see `heading`): an untitled
              note — or a day with nothing written yet — reads "Note · <date>",
              but only once the row has been read. An unsettled read carries an
              empty title too, and painting the default from that would flash it
              for a frame before the real title lands. */}
          <input
            className="px-jn-title"
            data-testid="journal-title"
            aria-label="note title"
            value={titleDraft ?? heading}
            disabled={!hasNote || preview}
            title={hasNote ? heading || undefined : 'Write something first — an empty day is not saved'}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setTitleDraft(null);
            }}
          />
          {/* `lock`: one button, nothing else. The icon shows the note's STATE —
              the shackle stands open while the note can be edited and drops shut
              once it is locked. Body and shackle are drawn as separate parts so
              the shackle can actually swing on its hinge; the body never moves,
              which is what keeps the icon centred in the button while it animates.

              It is INVISIBLE until there is something to lock, but keeps its slot
              (opacity, not display), so becoming lockable never nudges the title
              sideways — the button fades in exactly where it already was. */}
          {actions === 'lock' ? (
            <button
              className="px-btn px-btn--icon px-jn-lock"
              data-testid="journal-preview-toggle"
              data-state={preview ? 'locked' : 'unlocked'}
              data-ready={hasNote ? 'true' : 'false'}
              data-animate={lockWorked ? 'true' : undefined}
              aria-pressed={preview}
              disabled={!hasNote}
              // Hidden from assistive tech too while it does nothing — a control
              // announced but inoperable is worse than one that is not there.
              aria-hidden={hasNote ? undefined : true}
              aria-label={preview ? 'Edit this note' : 'Lock this note from editing'}
              title={hasNote ? (preview ? 'Edit' : 'Lock edit') : 'Nothing to lock — this day has no note'}
              onClick={toggleLock}
            >
              <span className="px-jn-lock-ic" aria-hidden="true">
                <Ic name="lockbody" className="px-ic px-jn-lk" />
                <Ic name="lockshackle" className="px-ic px-jn-lk px-jn-shackle" />
              </span>
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
                disabled={!hasNote}
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
                // Exporting mid-load wrote the file from an empty `draft` — a
                // silently blank .md for a note that has text. A day-log-only day
                // exports fine; it is the LOADING window that must be refused.
                disabled={isLoading}
                title={isLoading ? 'Still loading this day' : undefined}
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
        <span className="px-jn-date" data-testid="journal-date">{date}</span>
      </div>

      {/* One body in both states, rather than swapping the editor out for the
          read-only render: locking now FOLDS the editing chrome away — the
          toolbar rides up under the title block and the field's bottom edge draws
          up to the last line of text — and none of that can be animated by an
          element that unmounts. The sanitized renderer is handed down rather than
          imported there, so D2 stays this file's business. */}
      {isLoading ? (
        <p className="px-muted" data-testid="journal-loading">Loading…</p>
      ) : (
        <RichJournalEditor
          value={draft}
          onChange={change}
          onBlur={flush}
          locked={preview}
          animate={lockWorked}
          renderLocked={(markdown) => <MarkdownView markdown={markdown} />}
        />
      )}

      {/* OUTSIDE the editor and the preview, in both modes — never part of the
          document the user types into. */}
      {!isLoading && <DayLogFooter entries={dayLog} timezone={timezone} />}
    </div>
  );
}
