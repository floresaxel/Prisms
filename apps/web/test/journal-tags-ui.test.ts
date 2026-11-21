// @vitest-environment jsdom
/**
 * Journal tags + the project/vision filter, at the component level:
 *  - `NoteTags` adds / removes / de-duplicates, and goes read-only with the lock;
 *  - the panel only offers tags for a note that exists, and writes through
 *    `setJournalTags`;
 *  - `DayLogSection` narrows the generated log by project and vision (view only);
 *  - the Journal screen sorts notes BY TAG and filters by tag / project / vision.
 *
 * `@prisms/ui` data hooks are mocked (no PowerSync runtime); the core day-log
 * computation stays REAL, so the filter is tested against genuine log output.
 */
import { createElement } from 'react';

import { computeDayLog, type DayLogEntries } from '@prisms/core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeEntry {
  id: string;
  entry_date: string;
  title: string;
  content: string;
  tags: string[];
  locked: boolean;
  deleted_at: null;
}
const state = {
  entry: null as null | Partial<FakeEntry>,
  months: [] as FakeEntry[],
  logs: new Map<string, DayLogEntries>(),
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
    useJournalMonths: () => ({ entries: state.months, isLoading: false, isSettled: true }),
    useDayLog: () => null,
    useDayLogsByDate: () => state.logs,
    useFactContext: () => ({ today: () => '2026-06-20', timezone: 'UTC' }),
    useUserSettings: () => ({ hasRow: true, dayResetHour: 0, timezone: 'UTC', weatherLocation: null, journalDayLog: true }),
  };
});

vi.mock('../src/components/RichJournalEditor', async () => {
  const { createElement: h } = await import('react');
  return { RichJournalEditor: () => h('div', { 'data-testid': 'journal-rich' }) };
});
// The Journal screen's editor pane is not under test here.
vi.mock('../src/components/DayJournal', () => ({
  DayJournalPanel: ({ date }: { date: string }) => createElement('div', { 'data-testid': `panel-${date}` }),
  MarkdownView: () => null,
}));
vi.mock('../src/components/NoteSwap', async () => {
  return { NoteSwap: ({ children }: { children: unknown }) => children };
});

import { NoteTags } from '../src/components/NoteTags';
import { DayLogSection } from '../src/components/DayLogSection';
import { resetJournalFilterForTests } from '../src/journal-filter';
import { Journal } from '../src/screens/Journal';
import { installMemoryStorage } from './util/memory-storage';

const store = installMemoryStorage();
const CTX = { userId: 'u1', deviceId: 'web-1', now: () => '2026-06-20T00:00:00.000Z' };

beforeEach(() => resetJournalFilterForTests());
afterEach(() => {
  cleanup();
  state.entry = null;
  state.months = [];
  state.logs = new Map();
  commandFns.clear();
  store.clear();
});

describe('NoteTags', () => {
  const setup = (tags: string[], readOnly = false) => {
    const onChange = vi.fn();
    render(createElement(NoteTags, { tags, readOnly, onChange }));
    return onChange;
  };
  const type = (text: string, key = 'Enter') => {
    const input = screen.getByTestId('journal-tag-input');
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key });
  };

  it('adds a tag on Enter, canonicalised', () => {
    const onChange = setup([]);
    type('  #Deep Work ');
    expect(onChange).toHaveBeenCalledWith(['deep work']);
  });

  it('a comma ends a tag as you type, and a pasted list adds each one', () => {
    const onChange = setup(['a']);
    fireEvent.change(screen.getByTestId('journal-tag-input'), { target: { value: 'b, c, A' } });
    expect(onChange).toHaveBeenCalledWith(['a', 'b', 'c']); // "A" is a duplicate of "a"
  });

  it('typing a tag the note already has changes nothing', () => {
    const onChange = setup(['work']);
    type('Work');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes a tag with its x, and the last one with Backspace on an empty field', () => {
    const onChange = setup(['a', 'b']);
    fireEvent.click(screen.getByTestId('journal-tag-remove-a'));
    expect(onChange).toHaveBeenLastCalledWith(['b']);
    // edits COMPOSE on the pending list, not the (lagging) synced prop: with "a"
    // already gone, Backspace takes the last of what is left.
    fireEvent.keyDown(screen.getByTestId('journal-tag-input'), { key: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('two quick additions both land — the second is built on the first, not on the stale prop', () => {
    const onChange = setup([]);
    type('first');
    type('second');
    expect(onChange).toHaveBeenNthCalledWith(1, ['first']);
    expect(onChange).toHaveBeenNthCalledWith(2, ['first', 'second']);
    expect(screen.getByTestId('journal-tag-first')).toBeTruthy(); // painted before any sync
  });

  it('a rejected write puts the chips back to what the note really has', async () => {
    const onChange = vi.fn(async () => {
      throw new Error('rejected');
    });
    render(createElement(NoteTags, { tags: ['a'], readOnly: false, onChange }));
    type('b');
    expect(screen.getByTestId('journal-tag-b')).toBeTruthy();
    await vi.waitFor(() => expect(screen.queryByTestId('journal-tag-b')).toBeNull());
    expect(screen.getByTestId('journal-tag-a')).toBeTruthy();
  });

  it('read-only (a locked note) keeps the chips but drops every control', () => {
    setup(['a'], true);
    expect(screen.getByTestId('journal-tag-a')).toBeTruthy();
    expect(screen.queryByTestId('journal-tag-input')).toBeNull();
    expect(screen.queryByTestId('journal-tag-remove-a')).toBeNull();
  });

  it('read-only and untagged renders nothing at all', () => {
    setup([], true);
    expect(screen.queryByTestId('journal-tags')).toBeNull();
  });
});

describe('DayLogSection — project / vision filter', () => {
  const node = (id: string, node_type: string, title: string, parent_id: string | null, extra: object = {}) => ({
    id,
    node_type,
    title,
    parent_id,
    deleted_at: null,
    completed_at: null,
    completion_disposition: null,
    ...extra,
  });
  const nodes = [
    node('v1', 'vision', 'Health', null),
    node('p1', 'project', 'Marathon', 'v1'),
    node('t1', 'task', 'Long run', 'p1'),
    node('v2', 'vision', 'Craft', null),
    node('p2', 'project', 'Novel', 'v2'),
    node('t2', 'task', 'Draft chapter', 'p2'),
  ];
  const timeEntries = [
    { id: 'e1', task_id: 't1', started_at: '2026-06-18T08:00:00.000Z', ended_at: '2026-06-18T09:30:00.000Z', deleted_at: null },
    { id: 'e2', task_id: 't2', started_at: '2026-06-18T13:00:00.000Z', ended_at: '2026-06-18T13:45:00.000Z', deleted_at: null },
  ];
  const log = computeDayLog({
    date: '2026-06-18',
    nodes: nodes as never,
    blocks: [],
    timeEntries: timeEntries as never,
    dayResetHour: 0,
    timezone: 'UTC',
  });
  const mount = () => render(createElement(DayLogSection, { entries: log, timezone: 'UTC' }));

  it('shows the clocked time per task, rolled up, and the day total', () => {
    mount();
    expect(screen.getByTestId('daylog-clocked-total').textContent).toBe('2h 15m');
    expect(screen.getByTestId('daylog-clock-task-t1').textContent).toContain('1h 30m');
    expect(screen.getByTestId('daylog-clock-task-t1').textContent).toContain('Health › Marathon');
  });

  it('narrows to one project, recomputes the total, and clears', () => {
    mount();
    fireEvent.change(screen.getByTestId('daylog-filter-project'), { target: { value: 'p2' } });
    expect(screen.queryByTestId('daylog-seg-e1')).toBeNull();
    expect(screen.getByTestId('daylog-seg-e2')).toBeTruthy();
    expect(screen.getByTestId('daylog-clocked-total').textContent).toBe('45m');
    fireEvent.click(screen.getByTestId('daylog-filter-clear'));
    expect(screen.getByTestId('daylog-seg-e1')).toBeTruthy();
  });

  it('narrows by vision', () => {
    mount();
    fireEvent.change(screen.getByTestId('daylog-filter-vision'), { target: { value: 'v1' } });
    expect(screen.getByTestId('daylog-seg-e1')).toBeTruthy();
    expect(screen.queryByTestId('daylog-seg-e2')).toBeNull();
  });

  it('a filter this day has nothing for says so instead of going blank, and can be cleared', () => {
    const { rerender } = mount();
    fireEvent.change(screen.getByTestId('daylog-filter-project'), { target: { value: 'p2' } });
    // step to a day that holds only the OTHER project's work
    const other = computeDayLog({
      date: '2026-06-18',
      nodes: nodes as never,
      blocks: [],
      timeEntries: [timeEntries[0]] as never,
      dayResetHour: 0,
      timezone: 'UTC',
    });
    rerender(createElement(DayLogSection, { entries: other, timezone: 'UTC' }));
    expect(screen.getByTestId('daylog-filter-empty').textContent).toContain('Novel');
    // the chosen project stays selectable even though this day does not mention it
    expect((screen.getByTestId('daylog-filter-project') as HTMLSelectElement).value).toBe('p2');
    fireEvent.click(screen.getByTestId('daylog-filter-clear'));
    expect(screen.getByTestId('daylog-seg-e1')).toBeTruthy();
  });

  it('renders nothing for an empty day with no filter (as the footer always did)', () => {
    const { container } = render(createElement(DayLogSection, { entries: null, timezone: 'UTC' }));
    expect(container.innerHTML).toBe('');
  });
});

describe('Journal screen — sort by tag and filters', () => {
  const note = (entry_date: string, tags: string[], content = `note ${entry_date}`): FakeEntry => ({
    id: `id-${entry_date}`,
    entry_date,
    title: '',
    content,
    tags,
    locked: false,
    deleted_at: null,
  });
  const load = () => {
    state.months = [
      note('2026-06-19', ['work', 'health']),
      note('2026-06-18', ['work']),
      note('2026-06-17', []),
      note('2026-05-30', ['health']),
    ];
  };
  const mount = () => render(createElement(Journal, { ctx: CTX }));

  it('by date (default) lists days under their month, with tag chips', () => {
    load();
    mount();
    expect(screen.getByTestId('journal-day-2026-06-19')).toBeTruthy();
    expect(screen.getByTestId('journal-day-tags-2026-06-19').textContent).toContain('#work');
    expect(screen.queryByTestId('journal-tag-groups')).toBeNull();
  });

  it('the Today row is the FIRST row of the list, even when today has no note', () => {
    load(); // notes on the 17th-19th, none on today (the 20th)
    mount();
    const list = screen.getByTestId('journal-months');
    const first = list.querySelector('button');
    expect(first?.getAttribute('data-testid')).toBe('journal-today'); // above every month header
    expect(screen.getByTestId('journal-today').textContent).toContain('Today');
    expect(screen.getByTestId('journal-today').textContent).toContain('Sat 20');
    expect(screen.getByTestId('journal-today-empty').textContent).toBe('No note yet');
    expect(screen.queryByTestId('journal-day-2026-06-20')).toBeNull(); // there is no note row for it…
    expect(screen.getByTestId('panel-2026-06-20')).toBeTruthy(); // …yet it is the open day
    expect(screen.getByTestId('journal-today').getAttribute('aria-current')).toBe('true');
  });

  it('Today shows what is written once there is a note, and its tags', () => {
    load();
    state.months = [{ ...state.months[0]!, entry_date: '2026-06-20', content: '# Standup\nnotes', tags: ['work'] }, ...state.months];
    mount();
    const row = screen.getByTestId('journal-today');
    expect(row.textContent).toContain('Standup');
    expect(row.textContent).toContain('#work');
    expect(screen.queryByTestId('journal-today-empty')).toBeNull();
  });

  it('clicking Today jumps back from another day and re-expands the current month', () => {
    load();
    mount();
    fireEvent.click(screen.getByTestId('journal-day-2026-06-18')); // wander to another day
    expect(screen.getByTestId('panel-2026-06-18')).toBeTruthy();
    expect(screen.getByTestId('journal-today').getAttribute('aria-current')).toBe('false');

    fireEvent.click(screen.getByTestId('journal-month-2026-06')); // collapse the current month
    expect(screen.queryByTestId('journal-day-2026-06-18')).toBeNull();
    fireEvent.click(screen.getByTestId('journal-today'));
    expect(screen.getByTestId('panel-2026-06-20')).toBeTruthy(); // an empty day opens fine
    expect(screen.getByTestId('journal-day-2026-06-18')).toBeTruthy(); // month open again
    expect(screen.getByTestId('journal-today').getAttribute('aria-current')).toBe('true');
  });

  it('the Today row stays through By tag and through every filter', () => {
    load();
    mount();
    fireEvent.click(screen.getByTestId('journal-view-tag'));
    expect(screen.getByTestId('journal-months').querySelector('button')?.getAttribute('data-testid')).toBe('journal-today');
    fireEvent.change(screen.getByTestId('journal-filter-tag'), { target: { value: 'health' } });
    expect(screen.getByTestId('journal-today')).toBeTruthy(); // a way back, not a note: never filtered out
    expect(screen.queryByTestId('journal-day-2026-06-18')).toBeNull(); // while the notes ARE
    fireEvent.click(screen.getAllByTestId('journal-day-2026-06-19')[0]!); // listed under each of its tags
    expect(screen.getByTestId('panel-2026-06-19')).toBeTruthy();
    fireEvent.click(screen.getByTestId('journal-today'));
    expect(screen.getByTestId('panel-2026-06-20')).toBeTruthy();
  });

  it('there is no Today button in the page header any more', () => {
    load();
    mount();
    expect(document.querySelector('.px-page-head [data-testid="journal-today"]')).toBeNull();
  });
  it('By tag groups notes per tag, A–Z, a note under EACH of its tags, untagged last', () => {
    load();
    mount();
    fireEvent.click(screen.getByTestId('journal-view-tag'));
    const groups = [...screen.getByTestId('journal-tag-groups').querySelectorAll('[data-testid^="journal-group-"]')];
    expect(groups.map((g) => g.getAttribute('data-testid'))).toEqual([
      'journal-group-health',
      'journal-group-work',
      'journal-group-untagged',
    ]);
    const work = within(screen.getByTestId('journal-group-work'));
    expect(work.getByTestId('journal-day-2026-06-19')).toBeTruthy(); // also under #health
    expect(work.getByTestId('journal-day-2026-06-18')).toBeTruthy();
    expect(within(screen.getByTestId('journal-group-health')).getByTestId('journal-day-2026-06-19')).toBeTruthy();
    expect(within(screen.getByTestId('journal-group-untagged')).getByTestId('journal-day-2026-06-17')).toBeTruthy();
  });

  it('a tag filter narrows both views', () => {
    load();
    mount();
    fireEvent.change(screen.getByTestId('journal-filter-tag'), { target: { value: 'health' } });
    expect(screen.getByTestId('journal-day-2026-06-19')).toBeTruthy();
    expect(screen.queryByTestId('journal-day-2026-06-18')).toBeNull();
    fireEvent.click(screen.getByTestId('journal-filter-clear'));
    expect(screen.getByTestId('journal-day-2026-06-18')).toBeTruthy();
  });

  describe('a day with activity is a note even with no text', () => {
    const busy = (): DayLogEntries => ({
      v: 2,
      scheduled: [],
      clocked: [
        {
          entry_id: 'c1',
          task_id: 't',
          title: 'work',
          project: { id: 'p1', title: 'Marathon' },
          vision: null,
          started_at: '2026-06-12T08:00:00.000Z',
          ended_at: '2026-06-12T09:00:00.000Z',
          minutes: 60,
        },
      ],
      clocked_minutes: 60,
      completed: [],
    });

    it('lists a day that has time clocked on it but no note row', () => {
      load();
      state.logs = new Map([['2026-06-12', busy()]]);
      mount();
      const row = screen.getByTestId('journal-day-2026-06-12');
      expect(row.textContent).toContain('Note · Fri 12 Jun 2026'); // untitled: the default heading
      expect(screen.queryByTestId('journal-day-tags-2026-06-12')).toBeNull();
    });

    it('lists a day whose row has no text, once it is active or titled', () => {
      load();
      state.months = [
        { ...note('2026-06-10', [], ''), title: 'Rest day' },
        note('2026-06-11', [], ''), // blank, untitled, quiet: not a note
        note('2026-06-12', [], ''), // blank, but something happened
        ...state.months,
      ];
      state.logs = new Map([['2026-06-12', busy()]]);
      mount();
      expect(screen.getByTestId('journal-day-2026-06-10').textContent).toContain('Rest day');
      expect(screen.getByTestId('journal-day-2026-06-12')).toBeTruthy();
      expect(screen.queryByTestId('journal-day-2026-06-11')).toBeNull();
    });

    it('a quiet day with nothing written is still not listed', () => {
      load();
      mount();
      expect(screen.queryByTestId('journal-day-2026-06-12')).toBeNull();
    });

    it('Today names itself instead of saying "No note yet" once something happened today', () => {
      load();
      state.logs = new Map([['2026-06-20', busy()]]);
      mount();
      expect(screen.queryByTestId('journal-today-empty')).toBeNull();
      expect(screen.getByTestId('journal-today').textContent).toContain('Note · Sat 20 Jun 2026');
    });

    it('a collapsed or older month does not pull in its activity-only days', () => {
      load();
      state.logs = new Map([['2026-02-03', busy()]]); // outside the held months
      mount();
      expect(screen.queryByTestId('journal-day-2026-02-03')).toBeNull();
    });
  });

  it('a project filter keeps only days whose day log touches that project', () => {
    load();
    const entries = (project: { id: string; title: string }): DayLogEntries => ({
      v: 2,
      scheduled: [],
      clocked: [
        {
          entry_id: `c-${project.id}`,
          task_id: 't',
          title: 'work',
          project,
          vision: null,
          started_at: '2026-06-19T08:00:00.000Z',
          ended_at: '2026-06-19T09:00:00.000Z',
          minutes: 60,
        },
      ],
      clocked_minutes: 60,
      completed: [],
    });
    state.logs = new Map([
      ['2026-06-19', entries({ id: 'p1', title: 'Marathon' })],
      ['2026-06-18', entries({ id: 'p2', title: 'Novel' })],
    ]);
    mount();
    fireEvent.change(screen.getByTestId('journal-filter-project'), { target: { value: 'p1' } });
    expect(screen.getByTestId('journal-day-2026-06-19')).toBeTruthy();
    expect(screen.queryByTestId('journal-day-2026-06-18')).toBeNull(); // Novel's day
    expect(screen.queryByTestId('journal-day-2026-06-17')).toBeNull(); // no log at all
  });

  it('says so when the filters together match nothing', () => {
    load();
    // the only project-p1 day (05-30) is tagged #health, never #work
    state.logs = new Map([
      [
        '2026-05-30',
        {
          v: 2,
          scheduled: [],
          clocked: [
            {
              entry_id: 'c1',
              task_id: 't',
              title: 'x',
              project: { id: 'p1', title: 'Marathon' },
              vision: null,
              started_at: '2026-05-30T08:00:00.000Z',
              ended_at: '2026-05-30T09:00:00.000Z',
              minutes: 60,
            },
          ],
          clocked_minutes: 60,
          completed: [],
        } satisfies DayLogEntries,
      ],
    ]);
    mount();
    fireEvent.click(screen.getByTestId('journal-view-tag'));
    fireEvent.change(screen.getByTestId('journal-filter-tag'), { target: { value: 'work' } });
    fireEvent.change(screen.getByTestId('journal-filter-project'), { target: { value: 'p1' } });
    expect(screen.getByTestId('journal-empty').textContent).toContain('No notes match');
  });
});
