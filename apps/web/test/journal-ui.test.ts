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

import { asEpochMillis, bucketDate } from '@prisms/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = {
  entry: null as null | { id: string; content: string; deleted_at: null },
  months: [] as { entry_date: string; content: string }[],
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
    useJournalDay: () => ({ entry: state.entry, isLoading: false }),
    useJournalMonths: () => ({ entries: state.months, isLoading: false }),
    useAgenda: () => ({
      input: { tasks: [], committed: [], windows: [], timezone: 'UTC', horizon: { from: 0, to: 0 }, mode: 'greedy' },
      tasksById: new Map(),
      blocks: [],
      entries: [],
      todo: [],
    }),
    useIsHydrated: () => true,
    useBlockTags: () => [],
    useTagCatalog: () => [],
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

const CTX = { userId: 'u1', deviceId: 'web-1', now: () => '2026-06-27T00:00:00.000Z' };
const ZWJ = '👨‍👩‍👧‍👦';

afterEach(() => {
  cleanup();
  state.entry = null;
  state.months = [];
  commandFns.clear();
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

  it('preview toggle renders the markdown', () => {
    state.entry = { id: 'j1', content: '# Title', deleted_at: null };
    render(createElement(DayJournalPanel, { date: '2026-06-11', ctx: CTX }));
    fireEvent.click(screen.getByTestId('journal-preview-toggle'));
    expect(screen.getByTestId('journal-preview').querySelector('h1')?.textContent).toBe('Title');
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
    fireEvent.click(screen.getByTestId('journal-delete'));
    expect(command('deleteJournal')).toHaveBeenCalledWith('j1');
  });

  it('flushes a pending debounced save on unmount (day switch, no blur) — last edit not lost', () => {
    state.entry = { id: 'j1', content: 'start', deleted_at: null };
    const { unmount } = render(createElement(DayJournalPanel, { date: '2026-06-11', ctx: CTX }));
    fireEvent.change(screen.getByTestId('journal-rich'), { target: { value: 'start + more' } });
    expect(command('writeJournal')).not.toHaveBeenCalled(); // still inside the 800ms debounce

    unmount(); // switch day before the debounce fires AND without an onBlur flush
    expect(command('writeJournal')).toHaveBeenCalledWith({ existingId: 'j1', entryDate: '2026-06-11', content: 'start + more' });
    expect(command('writeJournal')).toHaveBeenCalledTimes(1); // exactly once — no double-write
  });
});

describe('Agenda — journal integration', () => {
  const today = bucketDate(asEpochMillis(Date.now()), 0, 'UTC'); // days[0] of the visible week

  it('shows a note dot on a day that has a note, and the header swaps in the journal panel', () => {
    state.months = [{ entry_date: today, content: 'has a note' }];
    state.entry = { id: 'j1', content: 'has a note', deleted_at: null };
    render(createElement(Agenda, { ctx: CTX }));

    // dot present for today's column
    expect(screen.getByTestId(`note-dot-${today}`)).toBeTruthy();
    // no journal panel until a day is selected
    expect(screen.queryByTestId(`journal-${today}`)).toBeNull();

    fireEvent.click(screen.getByTestId('day-head-0'));
    expect(screen.getByTestId(`journal-${today}`)).toBeTruthy();
    expect((screen.getByTestId('journal-rich') as HTMLTextAreaElement).value).toBe('has a note');
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
