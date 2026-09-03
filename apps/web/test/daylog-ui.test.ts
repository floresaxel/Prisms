// @vitest-environment jsdom
/**
 * V4 web UI for the journal day log (Annex L).
 *
 * The load-bearing test here is the EDITABILITY REGRESSION: the footer subtree
 * must contain no input, textarea, contenteditable, or button. Combined with D1
 * (nothing is stored) and the fact that the footer is mounted outside the TipTap
 * document, that is the whole "the user cannot edit this" enforcement.
 *
 * `@prisms/ui` hooks are mocked so the components render without a PowerSync
 * runtime; the core compute/render stays REAL. `createElement` (no JSX in the
 * test) matches the repo's screen-test setup.
 */
import { createElement } from 'react';

import { computeDayLog, type DayLogEntries } from '@prisms/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';

const NY = 'America/New_York';
const ZWJ = '👨‍👩‍👧‍👦';

const state = {
  entry: null as null | { id: string; content: string; deleted_at: null; locked?: boolean },
  dayLog: null as DayLogEntries | null,
  journalDayLog: true,
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
    useJournalDay: () => ({ entry: state.entry, isLoading: false, isSettled: true }),
    useDayLog: () => (state.journalDayLog ? state.dayLog : null),
    useUserSettings: () => ({ hasRow: true, dayResetHour: 4, timezone: NY, weatherLocation: null, journalDayLog: state.journalDayLog }),
  };
});

vi.mock('../src/components/RichJournalEditor', async () => {
  const { createElement: h } = await import('react');
  return {
    // Owns both bodies: locking no longer swaps this component out, it renders
    // the injected read-only one instead (so the toolbar can animate away).
    RichJournalEditor: ({
      value,
      onChange,
      locked,
      renderLocked,
    }: {
      value: string;
      onChange: (m: string) => void;
      locked?: boolean;
      renderLocked?: (m: string) => unknown;
    }) =>
      locked
        ? renderLocked?.(value)
        : h('textarea', { 'data-testid': 'journal-rich', value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) }),
  };
});

// Imported AFTER the mock (vitest hoists vi.mock).
import { DayJournalPanel } from '../src/components/DayJournal';
import { DayLogFooter } from '../src/components/DayLogFooter';
import { BuiltIn } from '../src/screens/BuiltIn';
import { downloadJournalArchive } from '../src/portability';

const CTX = { userId: 'u1', deviceId: 'web-1', now: () => '2026-05-08T18:00:00.000Z' };
const DAY = '2026-05-08';

/** Lock-edit / Export / Delete live behind the corner "⋯" menu — open it first. */
const openNoteMenu = () => fireEvent.click(screen.getByTestId('journal-menu'));

/** Real entries from the real compute — the UI is tested against actual output. */
function sampleLog(): DayLogEntries {
  const base = {
    user_id: 'u1', created_at: 't', updated_at: 't', deleted_at: null, hlc: '000000000000-0000-legacy',
    schema_version: 1, created_by_command_id: null, last_modified_by_command_id: null,
    source_kind: 'legacy' as const, source_id: null, source_detail: {},
  };
  const task = (id: string, title: string, completed_at: string | null, disposition: 'completed' | 'obsolete' | null = null) => ({
    ...base, id, parent_id: null, node_type: 'task' as const, title, description: '', sort_order: 'a0',
    start_date: null, due_date: null, estimate_minutes: null, completed_at,
    completion_disposition: completed_at ? (disposition ?? 'completed') : null,
    completed_in_block_id: null, habit_id: null, attributes: {},
  });
  const block = (id: string, task_id: string, starts_at: string, ends_at: string) => ({
    ...base, id, task_id, starts_at, ends_at, anchor_type: 'none' as const, rrule: null,
    status: 'committed' as const, suggestion_reason: null, computed_at: null, external_event_id: null,
    suggestion_batch_id: null, replaces_block_id: null, superseded_at: null,
  });
  const done = task('t1', `Write the April retro ${ZWJ}`, `${DAY}T18:20:00.000Z`);
  const open = task('t2', 'Review PRs', null);
  const adhoc = task('t3', 'Fix the flaky test', `${DAY}T19:05:00.000Z`);
  const dead = task('t4', 'Old idea', `${DAY}T20:00:00.000Z`, 'obsolete');
  return computeDayLog({
    date: DAY,
    nodes: [done, open, adhoc, dead],
    blocks: [block('b1', 't1', `${DAY}T17:00:00.000Z`, `${DAY}T18:30:00.000Z`), block('b2', 't2', `${DAY}T21:00:00.000Z`, `${DAY}T22:00:00.000Z`)],
    dayResetHour: 4,
    timezone: NY,
  })!;
}

afterEach(() => {
  cleanup();
  state.entry = null;
  state.dayLog = null;
  state.journalDayLog = true;
  commandFns.clear();
});

describe('DayLogFooter — the full marker matrix', () => {
  it('renders scheduled (done/not done, times) and completed (unplanned, descoped)', () => {
    render(createElement(DayLogFooter, { entries: sampleLog(), timezone: NY }));
    const log = screen.getByTestId('daylog');
    expect(screen.getByTestId('daylog-caption').textContent).toMatch(/Generated/);

    const sched = screen.getByTestId('daylog-scheduled');
    expect(sched.textContent).toContain('13:00–14:30'); // EDT, not UTC
    expect(sched.textContent).toContain(`Write the April retro ${ZWJ}`);
    expect(sched.querySelector('.px-daylog-box--on')).not.toBeNull(); // the done task
    expect(sched.querySelectorAll('.px-daylog-box')).toHaveLength(2);
    expect(sched.querySelectorAll('.px-daylog-box--on')).toHaveLength(1);

    const done = screen.getByTestId('daylog-completed');
    expect(done.textContent).toContain('14:20');
    expect(screen.getAllByTestId('daylog-unplanned')).toHaveLength(2); // ad-hoc + descoped
    expect(screen.getByTestId('daylog-descoped').textContent).toBe('descoped');
    expect(log.textContent).not.toContain('undefined');
  });

  it('THE EDITABILITY REGRESSION: the footer subtree has no interactive element', () => {
    render(createElement(DayLogFooter, { entries: sampleLog(), timezone: NY }));
    const log = screen.getByTestId('daylog');
    expect(log.querySelectorAll('input')).toHaveLength(0);
    expect(log.querySelectorAll('textarea')).toHaveLength(0);
    expect(log.querySelectorAll('button')).toHaveLength(0);
    expect(log.querySelectorAll('select')).toHaveLength(0);
    expect(log.querySelectorAll('a')).toHaveLength(0);
    expect(log.querySelectorAll('[contenteditable]')).toHaveLength(0);
    expect(log.querySelectorAll('[tabindex]')).toHaveLength(0);
    expect(log.querySelectorAll('[onclick]')).toHaveLength(0);
  });

  it('renders "+N more" for a truncated list', () => {
    const entries: DayLogEntries = { ...sampleLog(), truncated: { scheduled: 3, completed: 7 } };
    render(createElement(DayLogFooter, { entries, timezone: NY }));
    expect(screen.getByTestId('daylog-sched-more').textContent).toBe('+3 more');
    expect(screen.getByTestId('daylog-done-more').textContent).toBe('+7 more');
  });

  it('renders nothing for a null or empty log', () => {
    const { container, rerender } = render(createElement(DayLogFooter, { entries: null, timezone: NY }));
    expect(container.innerHTML).toBe('');
    rerender(createElement(DayLogFooter, { entries: { v: 1, scheduled: [], completed: [] }, timezone: NY }));
    expect(container.innerHTML).toBe('');
  });
});

describe('DayJournalPanel — the footer sits outside the editor', () => {
  it('renders below the editor AND below the preview, never inside either', () => {
    state.entry = { id: 'j1', content: 'my note', deleted_at: null };
    state.dayLog = sampleLog();
    const editable = render(createElement(DayJournalPanel, { date: DAY, ctx: CTX }));

    const editor = screen.getByTestId('journal-rich');
    expect(screen.getByTestId('daylog')).toBeTruthy();
    expect(editor.contains(screen.getByTestId('daylog'))).toBe(false);
    editable.unmount();

    // locked is a SYNCED field on the row now, so the read-only mode is reached
    // by the row saying so — not by a click on local state.
    state.entry = { id: 'j1', content: 'my note', deleted_at: null, locked: true };
    render(createElement(DayJournalPanel, { date: DAY, ctx: CTX }));
    expect(screen.getByTestId('daylog')).toBeTruthy();
    expect(screen.getByTestId('journal-preview').contains(screen.getByTestId('daylog'))).toBe(false);
  });

  it('is hidden when the built-in automation is off', () => {
    state.entry = { id: 'j1', content: 'my note', deleted_at: null };
    state.dayLog = sampleLog();
    state.journalDayLog = false;
    render(createElement(DayJournalPanel, { date: DAY, ctx: CTX }));
    expect(screen.queryByTestId('daylog')).toBeNull();
  });

  it('Export .md is the typed content VERBATIM plus the Day log section', async () => {
    state.entry = { id: 'j1', content: `note 🚀`, deleted_at: null };
    state.dayLog = sampleLog();
    render(createElement(DayJournalPanel, { date: DAY, ctx: CTX }));
    let captured: Blob | null = null;
    const createURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { captured = b as Blob; return 'blob:mock'; });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    openNoteMenu();
    fireEvent.click(screen.getByTestId('journal-export'));

    const text = await captured!.text();
    expect(text.startsWith('note 🚀')).toBe(true); // verbatim prefix
    expect(text).toContain('\n\n---\n\n### Day log\n');
    expect(text).toContain(`- [x] 13:00–14:30 Write the April retro ${ZWJ}`);
    expect(text).toContain('- 16:00 Old idea (unplanned) (descoped)');
    createURL.mockRestore();
    revoke.mockRestore();
    click.mockRestore();
  });

  it('Export .md is the content ALONE when the automation is off', async () => {
    state.entry = { id: 'j1', content: 'note only', deleted_at: null };
    state.dayLog = sampleLog();
    state.journalDayLog = false;
    render(createElement(DayJournalPanel, { date: DAY, ctx: CTX }));
    let captured: Blob | null = null;
    const createURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { captured = b as Blob; return 'blob:mock'; });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    openNoteMenu();
    fireEvent.click(screen.getByTestId('journal-export'));

    expect(await captured!.text()).toBe('note only');
    createURL.mockRestore();
    revoke.mockRestore();
    click.mockRestore();
  });
});

describe('Automations → Built-in', () => {
  it('shows the card as On and toggles it OFF through settings.update', () => {
    render(createElement(BuiltIn, { ctx: CTX }));
    const toggle = screen.getByTestId('builtin-daylog-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.getAttribute('role')).toBe('switch');
    fireEvent.click(toggle);
    expect(command('updateSettings')).toHaveBeenCalledWith({ journal_day_log: false });
  });

  it('shows the card as Off and toggles it back ON', () => {
    state.journalDayLog = false;
    render(createElement(BuiltIn, { ctx: CTX }));
    const toggle = screen.getByTestId('builtin-daylog-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(command('updateSettings')).toHaveBeenCalledWith({ journal_day_log: true });
  });
});

describe('the archive zip carries log-only days', () => {
  it('writes a file for a day that has a day_log and no note', async () => {
    const days = [
      { entry_date: '2026-04-15', content: '# Kickoff', updated_at: 't' },
      { entry_date: DAY, content: '', day_log: sampleLog() }, // LOG-ONLY: no note row
    ];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ entries: days }), { status: 200, headers: { 'content-type': 'application/json' } }));
    let captured: Blob | null = null;
    const createURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { captured = b as Blob; return 'blob:mock'; });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await downloadJournalArchive(NY);

    const files = unzipSync(new Uint8Array(await captured!.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(['journal/2026/2026-04-15.md', `journal/2026/${DAY}.md`]);
    // the note-only day is untouched by the feature
    expect(strFromU8(files['journal/2026/2026-04-15.md']!)).toBe('# Kickoff');
    // the log-only day is the rendered section alone (no leading blank lines)
    const logOnly = strFromU8(files[`journal/2026/${DAY}.md`]!);
    expect(logOnly.startsWith('### Day log\n')).toBe(true);
    expect(logOnly).toContain(`- 14:20 Write the April retro ${ZWJ}`);
    fetchSpy.mockRestore();
    createURL.mockRestore();
    revoke.mockRestore();
    click.mockRestore();
  });
});
