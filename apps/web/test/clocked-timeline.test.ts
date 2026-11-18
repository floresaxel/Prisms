// @vitest-environment jsdom
/**
 * The day log's Clocked section: the pure shaping (day bounds, per-task rows,
 * bar regions + lanes, ticks, focus rules) and the interactions — hover a row or
 * a log to single out its TASK, click a log to single out that one SESSION, with
 * the bar greying in step with the lists.
 */
import { createElement } from 'react';

import type { DayLogClockedEntry } from '@prisms/core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { buildClockedDay, dayBounds, dayTicks, focusState, nowFrac } from '../src/clocked-day';
import { ClockedSection } from '../src/components/ClockedTimeline';

const H = 3_600_000;
const ref = (id: string, title: string) => ({ id, title });
function entry(id: string, task: string, start: string, end: string | null, title = `task ${task}`): DayLogClockedEntry {
  const minutes = end === null ? null : Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
  return {
    entry_id: id,
    task_id: task,
    title,
    project: ref(`p-${task}`, `Project ${task}`),
    vision: ref('v', 'Vision'),
    started_at: start,
    ended_at: end,
    minutes,
  };
}

// one UTC day, reset at midnight: 08:00–09:30 on A, 10:00–10:45 on B, 13:00–14:00 on A again
const DAY = '2026-06-18';
const day = [
  entry('e1', 'A', '2026-06-18T08:00:00.000Z', '2026-06-18T09:30:00.000Z', 'Long run'),
  entry('e2', 'B', '2026-06-18T10:00:00.000Z', '2026-06-18T10:45:00.000Z', 'Draft chapter'),
  entry('e3', 'A', '2026-06-18T13:00:00.000Z', '2026-06-18T14:00:00.000Z', 'Long run'),
];
const UTC_DAY = dayBounds(DAY, 0, 'UTC');
const LATER = Date.parse('2026-06-25T00:00:00.000Z'); // "now", a week on

describe('dayBounds / dayTicks / nowFrac', () => {
  it('spans reset hour to reset hour in the user zone', () => {
    const b = dayBounds('2026-11-17', 4, 'America/New_York');
    expect(new Date(b.startMs).toISOString()).toBe('2026-11-17T09:00:00.000Z'); // 04:00 EST
    expect(b.endMs - b.startMs).toBe(24 * H);
  });

  it('a DST spring-forward day is 23 hours long, and the labels stay on the wall clock', () => {
    const b = dayBounds('2026-03-08', 0, 'America/New_York');
    expect(b.endMs - b.startMs).toBe(23 * H);
    const ticks = dayTicks('2026-03-08', 0, 'America/New_York', b);
    expect(ticks.map((t) => t.label)).toEqual(['00:00', '06:00', '12:00', '18:00', '00:00']);
    expect(ticks[0]!.frac).toBe(0);
    expect(ticks[4]!.frac).toBe(1);
    expect(ticks[1]!.frac).toBeCloseTo(5 / 23); // 06:00 comes an hour "early" that day
  });

  it('labels every 6 hours from the reset hour', () => {
    const b = dayBounds(DAY, 4, 'UTC');
    expect(dayTicks(DAY, 4, 'UTC', b).map((t) => t.label)).toEqual(['04:00', '10:00', '16:00', '22:00', '04:00']);
  });

  it('places now only when it falls inside the day', () => {
    expect(nowFrac(UTC_DAY, UTC_DAY.startMs + 6 * H)).toBeCloseTo(0.25);
    expect(nowFrac(UTC_DAY, LATER)).toBeNull();
  });
});

describe('buildClockedDay', () => {
  it('rolls sessions up per task, in the order tasks were first clocked, with stable tones', () => {
    const { tasks } = buildClockedDay(day, UTC_DAY, LATER);
    expect(tasks.map((t) => [t.taskId, t.minutes, t.sessions, t.tone])).toEqual([
      ['A', 150, 2, 'blue'],
      ['B', 45, 1, 'teal'],
    ]);
    expect(tasks[0]).toMatchObject({ title: 'Long run', project: { title: 'Project A' }, running: false });
  });

  it('draws each session as a region at its time of day', () => {
    const { segments } = buildClockedDay(day, UTC_DAY, LATER);
    const e1 = segments.find((s) => s.entryId === 'e1')!;
    expect(e1.top).toBeCloseTo(8 / 24);
    expect(e1.height).toBeCloseTo(1.5 / 24);
    expect(e1).toMatchObject({ lane: 0, lanes: 1, tone: 'blue', running: false });
  });

  it('puts overlapping sessions (split focus) side by side, and only those', () => {
    const overlap = [
      entry('x1', 'A', '2026-06-18T08:00:00.000Z', '2026-06-18T10:00:00.000Z'),
      entry('x2', 'B', '2026-06-18T09:00:00.000Z', '2026-06-18T11:00:00.000Z'),
      entry('x3', 'C', '2026-06-18T15:00:00.000Z', '2026-06-18T16:00:00.000Z'),
    ];
    const { segments, tasks } = buildClockedDay(overlap, UTC_DAY, LATER);
    const lanes = Object.fromEntries(segments.map((s) => [s.entryId, [s.lane, s.lanes]]));
    expect(lanes).toEqual({ x1: [0, 2], x2: [1, 2], x3: [0, 1] });
    // each task still reports its own full time; the day total (core) counts the overlap once
    expect(tasks.map((t) => t.minutes)).toEqual([120, 120, 60]);
  });

  it('a task\'s own overlapping sessions count once in its total', () => {
    const twice = [
      entry('y1', 'A', '2026-06-18T08:00:00.000Z', '2026-06-18T10:00:00.000Z'),
      entry('y2', 'A', '2026-06-18T09:00:00.000Z', '2026-06-18T11:00:00.000Z'),
    ];
    expect(buildClockedDay(twice, UTC_DAY, LATER).tasks[0]!.minutes).toBe(180);
  });

  it('runs a live session to now, and clips anything that crosses the end of the day', () => {
    const now = Date.parse('2026-06-18T12:00:00.000Z');
    const live = [entry('r1', 'A', '2026-06-18T11:00:00.000Z', null)];
    const r = buildClockedDay(live, UTC_DAY, now);
    expect(r.segments[0]).toMatchObject({ running: true });
    expect(r.segments[0]!.height).toBeCloseTo(1 / 24);
    expect(r.tasks[0]).toMatchObject({ running: true, minutes: 0 });

    const late = [entry('c1', 'A', '2026-06-18T23:00:00.000Z', '2026-06-19T02:00:00.000Z')];
    const c = buildClockedDay(late, UTC_DAY, LATER).segments[0]!;
    expect(c.top + c.height).toBeCloseTo(1); // stops at the bottom of the bar
  });
});

describe('focusState', () => {
  it('task focus singles out the task; entry focus singles out one session (its task row stays lit)', () => {
    expect(focusState(null, { taskId: 'A', entryId: 'e1' })).toBe('none');
    const task = { kind: 'task', taskId: 'A' } as const;
    expect(focusState(task, { taskId: 'A', entryId: 'e3' })).toBe('on');
    expect(focusState(task, { taskId: 'B', entryId: 'e2' })).toBe('dim');
    const one = { kind: 'entry', entryId: 'e1', taskId: 'A' } as const;
    expect(focusState(one, { taskId: 'A', entryId: 'e1' })).toBe('on');
    expect(focusState(one, { taskId: 'A', entryId: 'e3' })).toBe('dim'); // same task, other session
    expect(focusState(one, { taskId: 'A' })).toBe('on'); // the task ROW
    expect(focusState(one, { taskId: 'B' })).toBe('dim');
  });
});

describe('ClockedSection — collapsed card', () => {
  afterEach(cleanup);
  const mount = (entries = day) =>
    render(createElement(ClockedSection, { entries, totalMinutes: 195, truncated: 0, date: DAY, dayResetHour: 0, timezone: 'UTC' }));
  const state = (id: string) => screen.getByTestId(id).getAttribute('data-state');

  it('shows one row per task with its day total, the bar, and no session list', () => {
    mount();
    expect(screen.getByTestId('daylog-clocked-total').textContent).toBe('3h 15m');
    expect(screen.getByTestId('daylog-clock-task-A').textContent).toContain('2h 30m');
    expect(screen.getByTestId('daylog-clock-task-A').textContent).toContain('2 sessions');
    expect(screen.getByTestId('daylog-clock-task-B').textContent).toContain('45m');
    expect(screen.getByTestId('daylog-clock-bar').querySelectorAll('.px-cbar-seg')).toHaveLength(3);
    expect(screen.queryByTestId('daylog-clock-e1')).toBeNull(); // sessions live in the popup
    expect(screen.getByTestId('daylog-clock-all').textContent).toContain('All logs (3)');
  });

  it('hovering a task row lights its rows and regions and greys the rest', () => {
    mount();
    fireEvent.mouseEnter(screen.getByTestId('daylog-clock-task-A'));
    expect(state('daylog-seg-e1')).toBe('on');
    expect(state('daylog-seg-e3')).toBe('on');
    expect(state('daylog-seg-e2')).toBe('dim');
    expect(state('daylog-clock-task-B')).toBe('dim');
    fireEvent.mouseLeave(screen.getByTestId('daylog-clock-task-A'));
    expect(state('daylog-seg-e2')).toBe('none');
  });

  it('hovering a region singles out its task too; clicking one pins just that session', () => {
    mount();
    fireEvent.mouseEnter(screen.getByTestId('daylog-seg-e2'));
    expect(state('daylog-clock-task-B')).toBe('on');
    expect(state('daylog-clock-task-A')).toBe('dim');
    fireEvent.click(screen.getByTestId('daylog-seg-e3'));
    fireEvent.mouseLeave(screen.getByTestId('daylog-seg-e2'));
    expect(state('daylog-seg-e3')).toBe('on');
    expect(state('daylog-seg-e1')).toBe('dim');
    expect(state('daylog-clock-task-A')).toBe('on');
  });

  it('a clicked task row stays pinned while the pointer wanders, until clicked again', () => {
    mount();
    const a = screen.getByTestId('daylog-clock-task-A');
    fireEvent.click(a);
    expect(a.getAttribute('aria-pressed')).toBe('true');
    fireEvent.mouseEnter(screen.getByTestId('daylog-clock-task-B'));
    expect(state('daylog-clock-task-A')).toBe('on'); // the pin outranks hover
    expect(state('daylog-seg-e2')).toBe('dim');
    fireEvent.click(a);
    fireEvent.mouseLeave(screen.getByTestId('daylog-clock-task-B'));
    expect(state('daylog-seg-e2')).toBe('none');
  });

  it('a running session shows as live on the bar and on its row', () => {
    // a session running RIGHT NOW, so the bar must be the day it started on
    const start = new Date(Date.now() - 30 * 60_000).toISOString();
    render(
      createElement(ClockedSection, {
        entries: [entry('r1', 'A', start, null, 'Now thing')],
        totalMinutes: 0,
        truncated: 0,
        date: start.slice(0, 10),
        dayResetHour: 0,
        timezone: 'UTC',
      }),
    );
    expect(screen.getByTestId('daylog-seg-r1').className).toContain('px-cbar-seg--live');
    expect(screen.getByTestId('daylog-clock-task-A').textContent).toContain('running');
  });
});

describe('ClockedSection — All logs popup', () => {
  afterEach(cleanup);
  const open = () => {
    render(createElement(ClockedSection, { entries: day, totalMinutes: 195, truncated: 2, date: DAY, dayResetHour: 0, timezone: 'UTC' }));
    fireEvent.click(screen.getByTestId('daylog-clock-all'));
    return screen.getByTestId('daylog-clock-popup');
  };
  const state = (id: string) => screen.getByTestId(id).getAttribute('data-state');

  it('lists every session in time order with its range, duration and context', () => {
    const pop = open();
    const rows = [...pop.querySelectorAll('[data-testid^="daylog-clock-e"]')].map((r) => r.getAttribute('data-testid'));
    expect(rows).toEqual(['daylog-clock-e1', 'daylog-clock-e2', 'daylog-clock-e3']);
    const e1 = within(pop).getByTestId('daylog-clock-e1');
    expect(e1.textContent).toContain('08:00–09:30');
    expect(e1.textContent).toContain('1h 30m');
    expect(e1.textContent).toContain('Vision › Project A');
    expect(within(pop).getByTestId('daylog-clock-more').textContent).toContain('+2 more');
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Clocked · Thu 18 Jun');
  });

  it('hovering a log lights every log of the same task, in the list and on the bar', () => {
    open();
    fireEvent.mouseEnter(screen.getByTestId('daylog-clock-e1'));
    expect(state('daylog-clock-e3')).toBe('on'); // same task
    expect(state('daylog-clock-e2')).toBe('dim');
    expect(state('daylog-popup-seg-e3')).toBe('on');
    expect(state('daylog-popup-seg-e2')).toBe('dim');
  });

  it('clicking a log singles out only that session and its region; clicking again lets go', () => {
    open();
    const e1 = screen.getByTestId('daylog-clock-e1');
    fireEvent.mouseEnter(e1);
    fireEvent.click(e1);
    expect(state('daylog-clock-e1')).toBe('on');
    expect(state('daylog-clock-e3')).toBe('dim'); // same task, but not the one clicked
    expect(state('daylog-popup-seg-e1')).toBe('on');
    expect(state('daylog-popup-seg-e3')).toBe('dim');
    expect(e1.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(e1);
    fireEvent.mouseLeave(e1);
    expect(state('daylog-clock-e3')).toBe('none');
  });

  it('closes on Close and on Escape, and comes back unhighlighted', () => {
    open();
    fireEvent.click(screen.getByTestId('daylog-clock-e2'));
    fireEvent.click(screen.getByTestId('daylog-clock-close'));
    expect(screen.queryByTestId('daylog-clock-popup')).toBeNull();
    fireEvent.click(screen.getByTestId('daylog-clock-all'));
    expect(state('daylog-clock-e2')).toBe('none');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('daylog-clock-popup')).toBeNull();
  });
});
