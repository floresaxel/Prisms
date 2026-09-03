// @vitest-environment jsdom
/**
 * Dragging onto the Agenda week: what the pointer shows you, what the drop
 * actually writes, and what the calendar says afterwards about a placement it
 * no longer refuses.
 *
 * Two load-bearing properties:
 *  - the dashed outline and the drop are the SAME number, so the calendar can
 *    never promise 9:30 and commit 9:00;
 *  - a clash is reported, never enforced — the drop lands, the block wears a
 *    caution, and it is drawn BESIDE what it clashes with (a block hidden
 *    underneath another would hide its own caution too).
 *
 * `@prisms/ui` hooks are mocked so the screen renders without a PowerSync
 * runtime; the scheduling core (`validWindowsFor`) stays REAL, so "free" here
 * means what it means in the app. `createElement` (no JSX in the test) matches
 * the repo's screen-test setup.
 */
import { createElement } from 'react';

import { asEpochMillis, localInstant, type Instant } from '@prisms/core';
import type { Agenda as AgendaData, AgendaBlock, AgendaTask } from '@prisms/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SNAP_KEY } from '../src/agenda-snap';
import { installMemoryStorage } from './util/memory-storage';

const TZ = 'UTC'; // the grid is wall-clock, so UTC keeps the arithmetic readable
const NOW = '2026-05-08T12:00:00.000Z';
/** Columns of the rendered week: [0] is today. */
const FREE_DAY = '2026-05-11'; // col 3 — nothing on it
const BUSY_DAY = '2026-05-12'; // col 4 — holds the block that gets moved
const CLASH_DAY = '2026-05-13'; // col 5 — holds the placements that went wrong
const FREE_COL = 3;
const BUSY_COL = 4;
const CLASH_COL = 5;

const HOUR_PX = 44; // must match the Agenda's own grid
const GRID_START_HOUR = 6;
/** Pixels down the column body for a wall-clock time on the grid. */
const px = (hour: number, minute = 0) => ((hour - GRID_START_HOUR) * 60 + minute) * (HOUR_PX / 60);

const at = (date: string, hour: number, minute = 0): Instant => localInstant(date, GRID_START_HOUR, TZ, (hour - GRID_START_HOUR) * 60 + minute);

const commandFns = new Map<string, ReturnType<typeof vi.fn>>();
const command = (name: string) => {
  if (!commandFns.has(name)) commandFns.set(name, vi.fn(async () => undefined));
  return commandFns.get(name)!;
};
const commands = new Proxy({} as Record<string, unknown>, { get: (_t, p: string) => command(p) });

/** Only `.id` and `.title` are read off the node here — the rest is not this screen's business. */
const node = (id: string, title: string) => ({ id, title }) as AgendaTask['task'];

const task = (id: string, title: string, minutes: number, scheduled = false): AgendaTask => ({
  task: node(id, title),
  schedulable: { id, estimateMinutes: minutes },
  estimated: true,
  scheduled,
  kind: 'task',
});

const block = (
  id: string,
  taskId: string,
  title: string,
  date: string,
  fromHour: number,
  toHour: number,
): AgendaBlock => ({
  id,
  taskId,
  title,
  startsAt: at(date, Math.floor(fromHour), Math.round((fromHour % 1) * 60)),
  endsAt: at(date, Math.floor(toHour), Math.round((toHour % 1) * 60)),
  status: 'committed',
  anchored: false,
  justified: true,
  suggestionReason: null,
  superseded: false,
  provenance: {
    source_kind: 'user',
    source_id: null,
    source_detail: {},
    created_by_command_id: null,
    last_modified_by_command_id: null,
  },
});

const TODO = task('t1', 'Write the retro', 60);
const PLACED = task('t2', 'Ship the fix', 60, true);
const OTHER = task('t3', 'Everything else', 60, true);

const MOVABLE = block('b1', 't2', 'Ship the fix', BUSY_DAY, 9, 10);
/** Two placements that were allowed to land on top of each other. */
const CLASH_A = block('b2', 't3', 'Standup', CLASH_DAY, 10, 11);
const CLASH_B = block('b3', 't3', 'Design review', CLASH_DAY, 10.5, 11.5);
/** …and one dropped before the day's hours open. */
const DAWN = block('b4', 't3', 'Dawn patrol', CLASH_DAY, 6.5, 7.5);
const BLOCKS = [MOVABLE, CLASH_A, CLASH_B, DAWN];

function agendaData(): AgendaData {
  const now = asEpochMillis(Date.parse(NOW));
  return {
    input: {
      tasks: [TODO.schedulable, PLACED.schedulable, OTHER.schedulable],
      committed: BLOCKS.map((b) => ({ id: b.id, taskId: b.taskId, startsAt: b.startsAt, endsAt: b.endsAt, anchored: false })),
      // the app's own default window: 8am–8pm, so 7am is genuinely out of hours
      windows: [{ id: 'day', startMinute: 8 * 60, endMinute: 20 * 60 }],
      timezone: TZ,
      horizon: { from: now, to: asEpochMillis(now + 7 * 86_400_000) },
      mode: 'greedy',
    },
    tasksById: new Map([TODO, PLACED, OTHER].map((t) => [t.task.id, t.schedulable])),
    blocks: BLOCKS,
    entries: [],
    todo: [TODO],
    allTasks: [TODO, PLACED, OTHER],
  };
}

vi.mock('@prisms/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prisms/ui')>();
  return {
    ...actual,
    useAgenda: () => agendaData(),
    useCommands: () => commands,
    useIsHydrated: () => true,
    useJournalMonths: () => ({ entries: [], isLoading: false, isSettled: true }),
    useBlockTags: () => [],
    useTagCatalog: () => [],
  };
});

// the note panel drags in TipTap, which cannot run in jsdom and has no part in this
vi.mock('../src/components/DayJournal', async () => {
  const { createElement: h } = await import('react');
  return { DayJournalPanel: () => h('div', { 'data-testid': 'journal-stub' }) };
});

// Imported AFTER the mocks (vitest hoists vi.mock).
import { Agenda } from '../src/screens/Agenda';

const CTX = { userId: 'u1', deviceId: 'web-1', now: () => NOW };

/**
 * jsdom has no layout, so every rect is zero. The Agenda positions everything
 * absolutely with an inline `top`, and that is the only geometry the drag math
 * reads — so serve it back as the rect. The drop overlay covers its column body
 * and carries no inline top, which is exactly the 0 it should report, so
 * `clientY` in these tests means "pixels down the column body".
 */
function stubLayout(): () => void {
  const proto = Element.prototype;
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    const top = Number.parseFloat(this.style?.top || '0') || 0;
    const height = Number.parseFloat(this.style?.height || '0') || 0;
    return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  };
  return () => {
    proto.getBoundingClientRect = original;
  };
}

let storage: Storage;
let restoreLayout: () => void;

beforeEach(() => {
  storage = installMemoryStorage();
  restoreLayout = stubLayout();
  commandFns.clear();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  restoreLayout();
  storage.clear();
});

const mount = () => render(createElement(Agenda, { ctx: CTX }));
const col = (n: number) => screen.getByTestId(`drop-col-${n}`);
const preview = (n: number) => screen.queryByTestId(`drop-preview-${n}`);
const freeShapes = (n: number) => [...col(n).querySelectorAll('.px-cal-free')];

/** Grab a to-do row and hold it over `clientY` in column `n`. */
function dragTodoOver(n: number, clientY: number, testId = 'todo-t1') {
  fireEvent.mouseDown(screen.getByTestId(testId), { clientX: 0, clientY: 0 });
  fireEvent.mouseMove(col(n), { clientY });
}

describe('the item being dragged', () => {
  it('rides the cursor from the moment it is picked up', () => {
    mount();
    expect(screen.queryByTestId('drag-ghost')).toBeNull();
    fireEvent.mouseDown(screen.getByTestId('todo-t1'), { clientX: 200, clientY: 300 });
    const ghost = screen.getByTestId('drag-ghost');
    expect(ghost.textContent).toContain('Write the retro');
    expect(ghost.textContent).toContain('60m');
    // it starts under the cursor rather than at the origin — no first-move jump
    expect(ghost.style.transform).toBe('translate3d(214px, 312px, 0)');
    fireEvent.mouseMove(window, { clientX: 260, clientY: 340 });
    expect(ghost.style.transform).toBe('translate3d(274px, 352px, 0)');
  });

  it('lets go of the calendar when the drag ends', () => {
    mount();
    dragTodoOver(FREE_COL, px(9, 30));
    expect(preview(FREE_COL)).not.toBeNull();
    fireEvent.mouseUp(window);
    expect(screen.queryByTestId('drag-ghost')).toBeNull();
    expect(preview(FREE_COL)).toBeNull();
    expect(document.querySelectorAll('.px-cal-free')).toHaveLength(0);
  });
});

describe('where the item fits', () => {
  it('draws ONE shape for a continuous free stretch, not one per hour', () => {
    mount();
    fireEvent.mouseDown(screen.getByTestId('todo-t1'), { clientX: 0, clientY: 0 });
    const shapes = freeShapes(FREE_COL);
    expect(shapes).toHaveLength(1);
    // 8am–8pm: 120 minutes into the grid, 720 long
    expect((shapes[0] as HTMLElement).dataset.spanMin).toBe('720');
    expect((shapes[0] as HTMLElement).style.top).toBe(`${px(8)}px`);
    expect((shapes[0] as HTMLElement).style.height).toBe(`${px(20) - px(8)}px`);
  });

  it('splits into two where something already occupies the middle of the day', () => {
    mount();
    fireEvent.mouseDown(screen.getByTestId('todo-t1'), { clientX: 0, clientY: 0 });
    const spans = freeShapes(BUSY_COL).map((el) => (el as HTMLElement).dataset.spanMin);
    expect(spans).toEqual(['60', '600']); // 8–9 and 10–8pm, around the 9am block
  });

  it('leaves no per-hour rectangles behind at all', () => {
    // the stacked-cell grid this replaced
    mount();
    fireEvent.mouseDown(screen.getByTestId('todo-t1'), { clientX: 0, clientY: 0 });
    expect(document.querySelectorAll('.px-cal-cell')).toHaveLength(0);
  });

  it('shows nothing until something is being dragged', () => {
    mount();
    expect(document.querySelectorAll('.px-cal-free')).toHaveLength(0);
  });
});

describe('the outline where the drop would land', () => {
  it('appears only once the pointer is over the week', () => {
    mount();
    fireEvent.mouseDown(screen.getByTestId('todo-t1'), { clientX: 0, clientY: 0 });
    expect(document.querySelectorAll('.px-cal-preview')).toHaveLength(0);
    fireEvent.mouseMove(col(FREE_COL), { clientY: px(9, 30) });
    expect(document.querySelectorAll('.px-cal-preview')).toHaveLength(1);
  });

  it('reports the exact time the item would occupy', () => {
    mount();
    dragTodoOver(FREE_COL, px(9, 30));
    const el = preview(FREE_COL)!;
    expect(el.dataset.startMin).toBe('210'); // 9:30, as minutes past the 6am grid start
    expect(el.textContent).toContain('9:30am – 10:30am'); // its real duration, not a stub
    expect(el.style.height).toBe(`${HOUR_PX}px`);
    expect(el.style.top).toBe(`${px(9, 30)}px`);
  });

  it('lights the hour it would fall in, and only that one', () => {
    mount();
    dragTodoOver(FREE_COL, px(9, 30));
    const band = screen.getByTestId(`hot-hour-${FREE_COL}`);
    expect(band.dataset.hour).toBe('9');
    expect(band.style.top).toBe(`${px(9)}px`);
    expect(band.style.height).toBe(`${HOUR_PX}px`);
    expect(document.querySelectorAll('.px-cal-hot')).toHaveLength(1);
  });

  it('follows the pointer across columns without leaving a trail', () => {
    mount();
    dragTodoOver(FREE_COL, px(9, 30));
    // the pointer enters the next column BEFORE the old one hears it left, which
    // is the ordering an unguarded mouseleave would blank the fresh preview on
    fireEvent.mouseMove(col(BUSY_COL), { clientY: px(14) });
    fireEvent.mouseLeave(col(FREE_COL));
    expect(preview(FREE_COL)).toBeNull();
    expect(preview(BUSY_COL)!.dataset.startMin).toBe('480'); // 2pm
    expect(document.querySelectorAll('.px-cal-preview')).toHaveLength(1);
    expect(document.querySelectorAll('.px-cal-hot')).toHaveLength(1);
  });

  it('goes away when the pointer leaves the calendar', () => {
    mount();
    dragTodoOver(FREE_COL, px(9, 30));
    fireEvent.mouseLeave(col(FREE_COL));
    expect(document.querySelectorAll('.px-cal-preview')).toHaveLength(0);
    expect(screen.queryByTestId('drag-ghost')).not.toBeNull(); // still held, just not over a day
    expect(freeShapes(FREE_COL)).toHaveLength(1); // …and the day is still showing its room
  });
});

describe('the snap grid', () => {
  // One pointer position, five preferences. 150px is 204.5 minutes past 6am —
  // deliberately between lines, so each grid has to round it differently.
  const CASES: [number, string, string][] = [
    [5, '205', '9:25am'],
    [10, '200', '9:20am'],
    [15, '210', '9:30am'],
    [30, '210', '9:30am'],
    [60, '180', '9am'],
  ];

  it.each(CASES)('snaps to %i-minute steps', (minutes, startMin, label) => {
    storage.setItem(SNAP_KEY, String(minutes));
    mount();
    dragTodoOver(FREE_COL, 150);
    const el = preview(FREE_COL)!;
    expect(el.dataset.startMin).toBe(startMin);
    expect(el.textContent).toContain(label);
  });

  it('is 15 minutes when nothing has been chosen', () => {
    mount();
    dragTodoOver(FREE_COL, 150);
    expect(preview(FREE_COL)!.dataset.startMin).toBe('210');
    expect(screen.getByTestId('drag-hint').textContent).toContain('snap to 15 minutes');
  });

  it('says which grid is in force', () => {
    storage.setItem(SNAP_KEY, '60');
    mount();
    expect(screen.getByTestId('drag-hint').textContent).toContain('snap to 1 hour');
  });
});

describe('the drop', () => {
  it('writes the minute the outline promised, not the hour it sits in', async () => {
    mount();
    dragTodoOver(FREE_COL, 150);
    expect(preview(FREE_COL)!.textContent).toContain('9:30am');
    await act(async () => {
      fireEvent.mouseUp(col(FREE_COL), { clientY: 150 });
    });
    expect(command('createBlock')).toHaveBeenCalledWith({
      taskId: 't1',
      startsAt: `${FREE_DAY}T09:30:00.000Z`,
      endsAt: `${FREE_DAY}T10:30:00.000Z`,
    });
  });

  it('places at a finer minute when the grid is finer', async () => {
    storage.setItem(SNAP_KEY, '5');
    mount();
    dragTodoOver(FREE_COL, 150);
    await act(async () => {
      fireEvent.mouseUp(col(FREE_COL), { clientY: 150 });
    });
    expect(command('createBlock')).toHaveBeenCalledWith({
      taskId: 't1',
      startsAt: `${FREE_DAY}T09:25:00.000Z`,
      endsAt: `${FREE_DAY}T10:25:00.000Z`,
    });
  });

  it('marks a clean outline as such', () => {
    mount();
    dragTodoOver(FREE_COL, px(9, 30));
    expect(preview(FREE_COL)!.dataset.conflict).toBe('false');
    expect(preview(FREE_COL)!.className).not.toContain('px-cal-preview--clash');
  });
});

describe('a placement the calendar would rather you did not make', () => {
  it('is accepted outside your hours, and warns before the mouse comes up', async () => {
    mount();
    dragTodoOver(FREE_COL, px(7)); // 7am — the day's hours open at 8
    const el = preview(FREE_COL)!;
    expect(el.dataset.conflict).toBe('true');
    expect(el.dataset.problems).toBe('outside-hours');
    expect(el.className).toContain('px-cal-preview--clash');
    await act(async () => {
      fireEvent.mouseUp(col(FREE_COL), { clientY: px(7) });
    });
    // the drop LANDS — it used to be silently thrown away
    expect(command('createBlock')).toHaveBeenCalledWith({
      taskId: 't1',
      startsAt: `${FREE_DAY}T07:00:00.000Z`,
      endsAt: `${FREE_DAY}T08:00:00.000Z`,
    });
  });

  it('is accepted on top of another event, and says which problem it is', async () => {
    mount();
    dragTodoOver(BUSY_COL, px(9, 30)); // straight onto the 9–10 block
    const el = preview(BUSY_COL)!;
    expect(el.dataset.conflict).toBe('true');
    expect(el.dataset.problems).toBe('overlap');
    await act(async () => {
      fireEvent.mouseUp(col(BUSY_COL), { clientY: px(9, 30) });
    });
    expect(command('createBlock')).toHaveBeenCalledWith({
      taskId: 't1',
      startsAt: `${BUSY_DAY}T09:30:00.000Z`,
      endsAt: `${BUSY_DAY}T10:30:00.000Z`,
    });
  });

  it('reports both problems at once when both are true', () => {
    mount();
    dragTodoOver(CLASH_COL, px(7)); // 7am, on top of the dawn block
    expect(preview(CLASH_COL)!.dataset.problems).toBe('overlap outside-hours');
  });
});

describe('the caution a placed block wears', () => {
  it('is absent from a block that sits cleanly', () => {
    mount();
    expect(screen.queryByTestId('conflict-b1')).toBeNull();
    expect(screen.getByTestId('block-b1').dataset.conflict).toBe('false');
  });

  it('marks both sides of an overlap', () => {
    mount();
    for (const id of ['b2', 'b3']) {
      expect(screen.getByTestId(`block-${id}`).dataset.conflict).toBe('true');
      expect(screen.getByTestId(`conflict-${id}`).dataset.problems).toBe('overlap');
    }
  });

  it('marks a block dropped outside your hours', () => {
    mount();
    expect(screen.getByTestId('conflict-b4').dataset.problems).toBe('outside-hours');
  });

  it('says what is wrong in words, not just in colour', () => {
    mount();
    expect(screen.getByTestId('conflict-b2').textContent).toContain('overlaps another event');
    expect(screen.getByTestId('conflict-b4').textContent).toContain('outside your scheduling hours');
  });

  it('sits in the block, so it travels with it', () => {
    mount();
    expect(screen.getByTestId('block-b2').contains(screen.getByTestId('conflict-b2'))).toBe(true);
  });
});

describe('two events on the same minutes', () => {
  it('splits the column so neither hides the other — nor the other’s caution', () => {
    mount();
    const a = screen.getByTestId('block-b2');
    const b = screen.getByTestId('block-b3');
    expect(a.style.left).toBe('0%');
    expect(a.style.right).toBe('50%');
    expect(b.style.left).toBe('50%');
    expect(b.style.right).toBe('0%');
  });

  it('leaves a block that clashes with nothing at full width', () => {
    mount();
    for (const id of ['b1', 'b4']) {
      expect(screen.getByTestId(`block-${id}`).style.left).toBe('0%');
      expect(screen.getByTestId(`block-${id}`).style.right).toBe('0%');
    }
  });
});

describe('moving a block that is already placed', () => {
  /** Grab the 9am block 30 minutes down its own body, where a hand would hold it. */
  const grabMidBlock = () => fireEvent.mouseDown(screen.getByTestId('block-b1'), { clientY: px(9, 30) });

  it('keeps the block under the hand rather than yanking its top to the cursor', () => {
    mount();
    grabMidBlock();
    fireEvent.mouseMove(col(BUSY_COL), { clientY: px(9, 30) }); // held still
    expect(preview(BUSY_COL)!.dataset.startMin).toBe('180'); // still 9am, where it already is
  });

  it('does not count the place it is leaving as a clash with itself', () => {
    mount();
    grabMidBlock();
    fireEvent.mouseMove(col(BUSY_COL), { clientY: px(9, 30) });
    expect(preview(BUSY_COL)!.dataset.conflict).toBe('false');
  });

  it('moves by how far the pointer moved', () => {
    mount();
    grabMidBlock();
    fireEvent.mouseMove(col(BUSY_COL), { clientY: px(10, 30) }); // an hour down
    expect(preview(BUSY_COL)!.dataset.startMin).toBe('240'); // 10am
    expect(preview(BUSY_COL)!.textContent).toContain('10am – 11am');
  });

  it('commits the move to the snapped time', async () => {
    mount();
    grabMidBlock();
    fireEvent.mouseMove(col(BUSY_COL), { clientY: px(10, 30) });
    await act(async () => {
      fireEvent.mouseUp(col(BUSY_COL), { clientY: px(10, 30) });
    });
    expect(command('moveBlock')).toHaveBeenCalledWith('b1', `${BUSY_DAY}T10:00:00.000Z`, `${BUSY_DAY}T11:00:00.000Z`);
  });
});
