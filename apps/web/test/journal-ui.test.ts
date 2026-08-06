// @vitest-environment jsdom
/**
 * J4 web UI: the sanitized markdown renderer (hostile input inert), the day
 * editor (toolbar wraps a ZWJ-emoji selection; Export .md downloads the content),
 * and the Agenda integration (note dot + day-header → journal-panel swap).
 *
 * `@prisms/ui` hooks are mocked so the components render without a PowerSync
 * runtime; the pure helpers (applyMarkdownEdit / journalDayFilename / truncatePlain)
 * stay REAL. `createElement` (no JSX in the test) matches the repo's screen-test setup.
 */
import { createElement } from 'react';

import { addDays, asEpochMillis, bucketDate } from '@prisms/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = {
  entry: null as null | { id: string; content: string; deleted_at: null; locked?: boolean; title?: string },
  months: [] as { entry_date: string; content: string }[],
  loading: false,
};
const commandFns = new Map<string, ReturnType<typeof vi.fn>>();
const command = (name: string) => {
  if (!commandFns.has(name)) commandFns.set(name, vi.fn(async () => undefined));
  return commandFns.get(name)!;
};
const commands = new Proxy({} as Record<string, unknown>, { get: (_t, p: string) => command(p) });

vi.mock('@prisms/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prisms/ui')>();
  return {
    ...actual,
    useCommands: () => commands,
    useJournalDay: () => ({ entry: state.entry, isLoading: state.loading }),
    useJournalMonths: () => ({ entries: state.months, isLoading: false }),
    useAgenda: () => ({
      input: { tasks: [], committed: [], windows: [], timezone: 'UTC', horizon: { from: 0, to: 0 }, mode: 'greedy' },
      tasksById: new Map(),
      blocks: [],
      entries: [],
      todo: [],
      allTasks: [],
    }),
    useIsHydrated: () => true,
    useBlockTags: () => [],
    useTagCatalog: () => [],
    // Annex L: the panel now also reads the derived day log + the timezone. Off
    // here, so these cases stay about the editor — the footer has its own suite
    // (test/daylog-ui.test.ts).
    useDayLog: () => null,
    useUserSettings: () => ({ hasRow: true, dayResetHour: 0, timezone: 'UTC', weatherLocation: null, journalDayLog: false }),
  };
});

// TipTap needs a real browser DOM; jsdom can't run ProseMirror. Mock the rich
// editor as a controlled textarea so the SHELL (save/flush/export/delete/preview)
// stays unit-testable here — the real WYSIWYG is covered by Playwright e2e.
vi.mock('../src/components/RichJournalEditor', async () => {
  const { createElement: h } = await import('react');
  return {
    RichJournalEditor: ({ value, onChange, onBlur }: { value: string; onChange: (m: string) => void; onBlur?: (m: string) => void }) =>
      h('textarea', {
        'data-testid': 'journal-rich',
        value,
        onChange: (e: { target: { value: string } }) => onChange(e.target.value),
        onBlur: (e: { target: { value: string } }) => onBlur?.(e.target.value),
      }),
  };
});

// Imported AFTER the mock (vitest hoists vi.mock).
import { DayJournalPanel, MarkdownView } from '../src/components/DayJournal';
import { Agenda } from '../src/screens/Agenda';
import { downloadJournalArchive } from '../src/portability';
import { installMemoryStorage } from './util/memory-storage';

const store = installMemoryStorage();

const CTX = { userId: 'u1', deviceId: 'web-1', now: () => '2026-06-27T00:00:00.000Z' };
const ZWJ = '👨‍👩‍👧‍👦';

/** Lock-edit / Export / Delete live behind the corner "⋯" menu — open it first. */
const openNoteMenu = () => fireEvent.click(screen.getByTestId('journal-menu'));

afterEach(() => {
  cleanup();
  state.entry = null;
  state.months = [];
  state.loading = false;
  commandFns.clear();
  store.clear(); // per-day lock state persists across mounts by design
});

describe('MarkdownView — sanitized rendering (D2)', () => {
  it('renders bold, lists, and an allowed link', () => {
    render(createElement(MarkdownView, { markdown: '**bold** x\n\n- one\n- two\n\n[ok](https://ok.test)' }));
    const view = screen.getByTestId('journal-preview');
    expect(view.querySelector('strong')?.textContent).toBe('bold');
    expect(view.querySelectorAll('li')).toHaveLength(2);
    expect(view.querySelector('a')?.getAttribute('href')).toBe('https://ok.test');
  });

  it('renders hostile markdown INERT: no raw HTML, no onerror img, javascript: href dropped', () => {
    (window as unknown as { __pwned?: number }).__pwned = undefined;
    const hostile = '<script>window.__pwned=1</script>\n\n[x](javascript:alert(1))\n\n<img src=x onerror="window.__pwned=1">';
    render(createElement(MarkdownView, { markdown: hostile }));
    const view = screen.getByTestId('journal-preview');
    expect(view.querySelector('script')).toBeNull(); // raw HTML is escaped text, not an element
    expect(view.querySelector('img')).toBeNull();
    const href = view.querySelector('a')?.getAttribute('href') ?? '';
    expect(href).not.toMatch(/javascript:/i); // urlTransform stripped it
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe('DayJournalPanel — editor', () => {
  it('adopts the synced content into the editor (ZWJ emoji intact)', () => {
    // J7: the edit surface is the TipTap WYSIWYG (mocked here to a textarea). Its
    // markdown formatting (bold/task toggle/…) is covered by e2e; the pure
    // `applyMarkdownEdit` transform keeps its unit tests in @prisms/ui.
    state.entry = { id: 'j1', content: `${ZWJ} family`, deleted_at: null };
    render(createElement(DayJournalPanel, { date: '2026-06-11', ctx: CTX }));
    expect((screen.getByTestId('journal-rich') as HTMLTextAreaElement).value).toBe(`${ZWJ} family`);
  });

  it('the menu offers "Lock edit" while editable and "Edit" once the row is locked', () => {
    state.entry = { id: 'j1', content: '# Title', deleted_at: null, locked: false };
    const editable = render(createElement(DayJournalPanel, { date: '2026-06-11', ctx: CTX }));
    openNoteMenu();
    expect(screen.getByTestId('journal-preview-toggle').textContent).toBe('Lock edit');
    fireEvent.click(screen.getByTestId('journal-preview-toggle'));
    expect(screen.queryByTestId('journal-menu-pop')).toBeNull(); // acting closes it
    editable.unmount();

    state.entry = { id: 'j1', content: '# Title', deleted_at: null, locked: true };
    render(createElement(DayJournalPanel, { date: '2026-06-11', ctx: CTX }));
    expect(screen.getByTestId('journal-preview').querySelector('h1')?.textContent).toBe('Title');
    openNoteMenu();
    expect(screen.getByTestId('journal-preview-toggle').textContent).toBe('Edit');
  });

  it('Export .md downloads the current content as YYYY-MM-DD.md', async () => {
    state.entry = { id: 'j1', content: 'my note 🚀', deleted_at: null };
    render(createElement(DayJournalPanel, { date: '2026-06-11', ctx: CTX }));
    let captured: { name: string; blob: Blob } | null = null;
    const createURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      captured = { name: '', blob: b as Blob };
      return 'blob:mock';
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      if (captured) captured.name = this.download;
    });

    openNoteMenu();
    fireEvent.click(screen.getByTestId('journal-export'));

    expect(captured).not.toBeNull();
    expect(captured!.name).toBe('2026-06-11.md');
    expect(await captured!.blob.text()).toBe('my note 🚀');
    createURL.mockRestore();
    revoke.mockRestore();
    click.mockRestore();
  });

  it('Delete calls journal.delete for the live row', () => {
    state.entry = { id: 'j1', content: 'x', deleted_at: null };
    render(createElement(DayJournalPanel, { date: '2026-06-11', ctx: CTX }));
    openNoteMenu();
    fireEvent.click(screen.getByTestId('journal-delete'));
    expect(command('deleteJournal')).toHaveBeenCalledWith('j1');
  });

  it('the note actions are ONLY reachable through the corner menu', () => {
    state.entry = { id: 'j1', content: 'x', deleted_at: null };
    render(createElement(DayJournalPanel, { date: '2026-06-11', ctx: CTX }));
    for (const id of ['journal-preview-toggle', 'journal-export', 'journal-delete']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    openNoteMenu();
    for (const id of ['journal-preview-toggle', 'journal-export', 'journal-delete']) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
  });

  it('actions="lock" (the Agenda) shows ONE control and no menu at all', () => {
    state.entry = { id: 'j1', content: '# Title', deleted_at: null, locked: false };
    const editable = render(createElement(DayJournalPanel, { date: '2026-06-11', ctx: CTX, actions: 'lock' }));
    for (const id of ['journal-menu', 'journal-export', 'journal-delete']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    // the icon IS the affordance: a padlock while editable, a pencil while locked
    const toggle = screen.getByTestId('journal-preview-toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.querySelector('use')?.getAttribute('href')).toBe('#i-lock');
    expect(toggle.getAttribute('title')).toBe('Lock edit');
    editable.unmount();

    state.entry = { id: 'j1', content: '# Title', deleted_at: null, locked: true };
    render(createElement(DayJournalPanel, { date: '2026-06-11', ctx: CTX, actions: 'lock' }));
    expect(screen.getByTestId('journal-preview').querySelector('h1')?.textContent).toBe('Title');
    const locked = screen.getByTestId('journal-preview-toggle');
    expect(locked.getAttribute('aria-pressed')).toBe('true');
    expect(locked.querySelector('use')?.getAttribute('href')).toBe('#i-pen');
    expect(locked.getAttribute('title')).toBe('Edit');
  });

  it('renders the lock state from the SYNCED row, not local state', () => {
    // `locked` is a field on the day's own row, so it arrives with the entry and
    // is per-day by construction — the panel holds no lock state of its own.
    state.entry = { id: 'j1', content: '# Mon', deleted_at: null, locked: true };
    const locked = render(createElement(DayJournalPanel, { date: '2026-08-03', ctx: CTX, actions: 'lock' }));
    expect(screen.getByTestId('journal-preview')).toBeTruthy();
    expect(screen.getByTestId('journal-preview-toggle').getAttribute('aria-pressed')).toBe('true');
    locked.unmount();

    state.entry = { id: 'j2', content: '# Tue', deleted_at: null, locked: false };
    render(createElement(DayJournalPanel, { date: '2026-08-04', ctx: CTX, actions: 'lock' }));
    expect(screen.getByTestId('journal-rich')).toBeTruthy();
    expect(screen.queryByTestId('journal-preview')).toBeNull();
  });

  it('a day with no row yet is editable', () => {
    state.entry = null;
    render(createElement(DayJournalPanel, { date: '2026-08-09', ctx: CTX, actions: 'lock' }));
    expect(screen.getByTestId('journal-rich')).toBeTruthy();
    expect(screen.getByTestId('journal-preview-toggle').getAttribute('aria-pressed')).toBe('false');
  });

  it('the lock toggle uploads journal.set_locked for THAT note', () => {
    state.entry = { id: 'j1', content: 'x', deleted_at: null, locked: false };
    render(createElement(DayJournalPanel, { date: '2026-08-07', ctx: CTX, actions: 'lock' }));
    fireEvent.click(screen.getByTestId('journal-preview-toggle'));
    expect(command('setJournalLocked')).toHaveBeenCalledWith('j1', true);
  });

  it('a day with no note cannot be locked — there is nothing to lock', () => {
    state.entry = null;
    render(createElement(DayJournalPanel, { date: '2026-08-09', ctx: CTX, actions: 'lock' }));
    const toggle = screen.getByTestId('journal-preview-toggle') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(command('setJournalLocked')).not.toHaveBeenCalled();
  });

  it('the menu variant issues the same command', () => {
    state.entry = { id: 'j1', content: 'x', deleted_at: null, locked: true };
    render(createElement(DayJournalPanel, { date: '2026-08-07', ctx: CTX }));
    openNoteMenu();
    fireEvent.click(screen.getByTestId('journal-preview-toggle'));
    expect(command('setJournalLocked')).toHaveBeenCalledWith('j1', false);
  });

  it('Delete is absent for a day with no saved note', () => {
    state.entry = null;
    render(createElement(DayJournalPanel, { date: '2026-06-11', ctx: CTX }));
    openNoteMenu();
    expect(screen.queryByTestId('journal-delete')).toBeNull();
    expect(screen.getByTestId('journal-export')).toBeTruthy();
  });

  // --- an empty note is not a note -----------------------------------------

  it('typing nothing on a blank day stores NOTHING', () => {
    state.entry = null;
    const { unmount } = render(createElement(DayJournalPanel, { date: '2026-08-11', ctx: CTX }));
    fireEvent.change(screen.getByTestId('journal-rich'), { target: { value: '   \n\n' } });
    unmount(); // flush
    expect(command('writeJournal')).not.toHaveBeenCalled();
    expect(command('deleteJournal')).not.toHaveBeenCalled();
  });

  it('clearing all the text DELETES the entry rather than storing a blank one', () => {
    state.entry = { id: 'j1', content: 'had words', deleted_at: null, locked: false };
    const { unmount } = render(createElement(DayJournalPanel, { date: '2026-08-11', ctx: CTX }));
    fireEvent.change(screen.getByTestId('journal-rich'), { target: { value: '' } });
    unmount();
    expect(command('deleteJournal')).toHaveBeenCalledWith('j1');
    expect(command('writeJournal')).not.toHaveBeenCalled();
  });

  it('a leftover bullet or heading marker still counts as empty', () => {
    state.entry = { id: 'j1', content: 'had words', deleted_at: null, locked: false };
    const { unmount } = render(createElement(DayJournalPanel, { date: '2026-08-11', ctx: CTX }));
    fireEvent.change(screen.getByTestId('journal-rich'), { target: { value: '- \n\n#' } });
    unmount();
    expect(command('deleteJournal')).toHaveBeenCalledWith('j1');
    expect(command('writeJournal')).not.toHaveBeenCalled();
  });

  // --- the editable title ---------------------------------------------------

  it('defaults an untitled note to "Note · <date>" once it has loaded', () => {
    state.entry = { id: 'j1', content: 'x', deleted_at: null, locked: false };
    render(createElement(DayJournalPanel, { date: '2026-08-05', ctx: CTX, actions: 'lock' }));
    expect((screen.getByTestId('journal-title') as HTMLInputElement).value).toBe('Note · 2026-08-05');
    expect(screen.getByTestId('journal-date').textContent).toBe('2026-08-05');
  });

  it('is BLANK while the day is still loading — the default must not flash first', () => {
    state.entry = null;
    state.loading = true;
    render(createElement(DayJournalPanel, { date: '2026-08-05', ctx: CTX, actions: 'lock' }));
    const input = screen.getByTestId('journal-title') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe(''); // nothing claimed about a note we do not have
    expect(screen.getByTestId('journal-date').textContent).toBe('2026-08-05'); // the day IS known
  });

  it('an EMPTY row that is locked is still editable — not a dead end', () => {
    // Rows predating the empty-note rule can be both empty and locked. Honouring
    // the lock there would leave the day unusable: no title and no unlock
    // (it is not a note), and no editor to type into (it is locked).
    state.entry = { id: 'j1', content: '', deleted_at: null, locked: true };
    render(createElement(DayJournalPanel, { date: '2026-08-07', ctx: CTX, actions: 'lock' }));
    expect(screen.getByTestId('journal-rich')).toBeTruthy(); // the editor, not the read-only render
    expect(screen.queryByTestId('journal-preview')).toBeNull();
  });

  it('is blank for a day that has no note at all', () => {
    state.entry = null;
    render(createElement(DayJournalPanel, { date: '2026-08-05', ctx: CTX, actions: 'lock' }));
    const input = screen.getByTestId('journal-title') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.disabled).toBe(true);
  });

  it('shows a stored title, with the date still visible', () => {
    state.entry = { id: 'j1', content: 'x', deleted_at: null, locked: false, title: 'Trip planning' };
    render(createElement(DayJournalPanel, { date: '2026-08-05', ctx: CTX, actions: 'lock' }));
    expect((screen.getByTestId('journal-title') as HTMLInputElement).value).toBe('Trip planning');
    expect(screen.getByTestId('journal-date').textContent).toBe('2026-08-05');
  });

  it('renaming uploads journal.set_title on blur', () => {
    state.entry = { id: 'j1', content: 'x', deleted_at: null, locked: false };
    render(createElement(DayJournalPanel, { date: '2026-08-05', ctx: CTX, actions: 'lock' }));
    const input = screen.getByTestId('journal-title');
    fireEvent.change(input, { target: { value: 'Trip planning' } });
    fireEvent.blur(input);
    expect(command('setJournalTitle')).toHaveBeenCalledWith('j1', 'Trip planning');
  });

  it('typing the default back clears the title, so it keeps tracking the date', () => {
    state.entry = { id: 'j1', content: 'x', deleted_at: null, locked: false, title: 'Trip planning' };
    render(createElement(DayJournalPanel, { date: '2026-08-05', ctx: CTX, actions: 'lock' }));
    const input = screen.getByTestId('journal-title');
    fireEvent.change(input, { target: { value: 'Note · 2026-08-05' } });
    fireEvent.blur(input);
    expect(command('setJournalTitle')).toHaveBeenCalledWith('j1', '');
  });

  it('a day with no note cannot be titled', () => {
    state.entry = null;
    render(createElement(DayJournalPanel, { date: '2026-08-11', ctx: CTX, actions: 'lock' }));
    expect((screen.getByTestId('journal-title') as HTMLInputElement).disabled).toBe(true);
  });

  it('a loaded note with a title shows the TITLE, never the default', () => {
    state.entry = { id: 'j1', content: 'x', deleted_at: null, locked: false, title: 'Trip planning' };
    render(createElement(DayJournalPanel, { date: '2026-08-05', ctx: CTX, actions: 'lock' }));
    expect((screen.getByTestId('journal-title') as HTMLInputElement).value).toBe('Trip planning');
  });

  it('flushes a pending debounced save on unmount (day switch, no blur) — last edit not lost', () => {
    state.entry = { id: 'j1', content: 'start', deleted_at: null };
    const { unmount } = render(createElement(DayJournalPanel, { date: '2026-06-11', ctx: CTX }));
    fireEvent.change(screen.getByTestId('journal-rich'), { target: { value: 'start + more' } });
    expect(command('writeJournal')).not.toHaveBeenCalled(); // still inside the debounce window

    unmount(); // switch day before the debounce fires AND without an onBlur flush
    expect(command('writeJournal')).toHaveBeenCalledWith({ existingId: 'j1', entryDate: '2026-06-11', content: 'start + more' });
    expect(command('writeJournal')).toHaveBeenCalledTimes(1); // exactly once — no double-write
  });
});

describe('Agenda — journal integration', () => {
  const today = bucketDate(asEpochMillis(Date.now()), 0, 'UTC'); // days[0] of the visible week
  const tomorrow = addDays(today, 1); // days[1]

  it('shows a note dot on a day with a note; the journal panel defaults to today and swaps on a day-header click', () => {
    state.months = [{ entry_date: today, content: 'has a note' }];
    state.entry = { id: 'j1', content: 'has a note', deleted_at: null };
    render(createElement(Agenda, { ctx: CTX }));

    // dot present for today's column
    expect(screen.getByTestId(`note-dot-${today}`)).toBeTruthy();
    // W6: the journal panel shows today's note by DEFAULT (no click needed)
    expect(screen.getByTestId(`journal-${today}`)).toBeTruthy();
    expect((screen.getByTestId('journal-rich') as HTMLTextAreaElement).value).toBe('has a note');

    // clicking another day header swaps the panel to that day
    fireEvent.click(screen.getByTestId('day-head-1'));
    expect(screen.getByTestId(`journal-${tomorrow}`)).toBeTruthy();
  });
});

describe('downloadJournalArchive (Settings .md archive, D7)', () => {
  it('fetches the notes and downloads a zip whose entries match the days (emoji byte-exact)', async () => {
    const days = [
      { entry_date: '2026-03-09', content: `hi ${ZWJ}`, updated_at: 't' },
      { entry_date: '2026-05-02', content: 'may', updated_at: 't' },
    ];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ entries: days }), { status: 200, headers: { 'content-type': 'application/json' } }));
    let captured: Blob | null = null;
    const createURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      captured = b as Blob;
      return 'blob:mock';
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const name = await downloadJournalArchive();

    expect(name).toMatch(/^prisms-journal_.*\.zip$/);
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/sync/journal/export'), expect.objectContaining({ credentials: 'include' }));
    const files = unzipSync(new Uint8Array(await captured!.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(['journal/2026/2026-03-09.md', 'journal/2026/2026-05-02.md']);
    expect(strFromU8(files['journal/2026/2026-03-09.md']!)).toBe(`hi ${ZWJ}`);
    fetchSpy.mockRestore();
    createURL.mockRestore();
    revoke.mockRestore();
    click.mockRestore();
  });
});
