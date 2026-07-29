/**
 * T1 (MOBILE_TODAY_PLAN): the Today itinerary's decisions, tested where RN
 * components cannot be. The tricky parts are all here — which blocks belong to
 * "today" when the day resets at 04:00, which state wins on a row, and which
 * duration a row shows.
 */
import { describe, expect, it } from 'vitest';

import { asEpochMillis, type IsoDate } from '@prisms/core';

import { buildItinerary, formatWallTime, loggedMinutesByTask, minutesOfDay } from '../src/today-itinerary';
import type { AgendaBlock, AgendaEntry } from '../src/hooks';

const TZ = 'UTC';
const RESET = 4; // day runs 04:00 → 03:59 next day
const TODAY = '2026-07-26' as IsoDate;

/** 2026-07-26T{hh}:{mm}Z, or a day offset for cross-reset cases. */
const at = (hh: number, mm = 0, dayOffset = 0) => asEpochMillis(Date.UTC(2026, 6, 26 + dayOffset, hh, mm));

const block = (over: Partial<AgendaBlock> & { id: string; taskId: string }): AgendaBlock => ({
  title: `Task ${over.taskId}`,
  startsAt: at(9),
  endsAt: at(10),
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
  ...over,
});

const entry = (taskId: string, startsAt: number, endsAt: number, id = `e-${taskId}-${startsAt}`): AgendaEntry => ({
  id,
  taskId,
  title: `Task ${taskId}`,
  startsAt: asEpochMillis(startsAt),
  endsAt: asEpochMillis(endsAt),
});

const build = (over: Partial<Parameters<typeof buildItinerary>[0]> = {}) =>
  buildItinerary({
    blocks: [],
    logged: new Map(),
    estimateMinutesByTask: new Map(),
    projectIdByTask: new Map(),
    doneTaskIds: new Set(),
    habitTaskIds: new Set(),
    runningTaskId: null,
    today: TODAY,
    timezone: TZ,
    dayResetHour: RESET,
    ...over,
  });

describe('buildItinerary — which blocks are "today"', () => {
  it('keeps blocks inside the day-reset bucket and drops other days', () => {
    const rows = build({
      blocks: [
        block({ id: 'b-morning', taskId: 't1', startsAt: at(9), endsAt: at(10) }),
        block({ id: 'b-yesterday', taskId: 't2', startsAt: at(9, 0, -1), endsAt: at(10, 0, -1) }),
        block({ id: 'b-tomorrow', taskId: 't3', startsAt: at(9, 0, 1), endsAt: at(10, 0, 1) }),
      ],
    });
    expect(rows.map((r) => r.blockId)).toEqual(['b-morning']);
  });

  it('counts 01:00 as still belonging to the previous day (reset is 04:00, not midnight)', () => {
    // 2026-07-27T01:00Z is before the 04:00 reset, so it is still 2026-07-26.
    const rows = build({ blocks: [block({ id: 'b-late', taskId: 't1', startsAt: at(1, 0, 1), endsAt: at(2, 0, 1) })] });
    expect(rows.map((r) => r.blockId)).toEqual(['b-late']);
  });

  it('drops 03:59 of today, which belongs to yesterday', () => {
    const rows = build({ blocks: [block({ id: 'b-early', taskId: 't1', startsAt: at(3, 59), endsAt: at(4, 30) })] });
    expect(rows).toEqual([]);
  });

  it('excludes suggested blocks — those belong to the day panel', () => {
    const rows = build({
      blocks: [
        block({ id: 'b-committed', taskId: 't1' }),
        block({ id: 'b-suggested', taskId: 't2', status: 'suggested' }),
      ],
    });
    expect(rows.map((r) => r.blockId)).toEqual(['b-committed']);
  });

  it('sorts by start time, tie-broken by block id', () => {
    const rows = build({
      blocks: [
        block({ id: 'b-c', taskId: 't3', startsAt: at(17), endsAt: at(18) }),
        block({ id: 'b-b', taskId: 't2', startsAt: at(7), endsAt: at(8) }),
        block({ id: 'b-a', taskId: 't1', startsAt: at(7), endsAt: at(9) }),
      ],
    });
    expect(rows.map((r) => r.blockId)).toEqual(['b-a', 'b-b', 'b-c']);
  });
});

describe('buildItinerary — row state', () => {
  it('marks the running task live and the rest upcoming', () => {
    const rows = build({
      blocks: [block({ id: 'b1', taskId: 't1' }), block({ id: 'b2', taskId: 't2', startsAt: at(14), endsAt: at(15) })],
      runningTaskId: 't1',
    });
    expect(rows.map((r) => [r.blockId, r.state])).toEqual([
      ['b1', 'live'],
      ['b2', 'upcoming'],
    ]);
  });

  it('lets done beat live when a timer is still open on a finished task', () => {
    const rows = build({ blocks: [block({ id: 'b1', taskId: 't1' })], runningTaskId: 't1', doneTaskIds: new Set(['t1']) });
    expect(rows[0]!.state).toBe('done');
  });

  it('keeps the habit flag on a row that is already checked off', () => {
    const rows = build({
      blocks: [block({ id: 'b1', taskId: 't1' })],
      doneTaskIds: new Set(['t1']),
      habitTaskIds: new Set(['t1']),
    });
    expect(rows[0]!.state).toBe('done');
    expect(rows[0]!.isHabit).toBe(true);
  });
});

describe('buildItinerary — durations and tone', () => {
  it('falls back to the block length when the task carries no estimate', () => {
    const rows = build({ blocks: [block({ id: 'b1', taskId: 't1', startsAt: at(9), endsAt: at(10, 30) })] });
    expect(rows[0]!.plannedMinutes).toBe(90);
  });

  it('prefers the task estimate over the block length', () => {
    const rows = build({
      blocks: [block({ id: 'b1', taskId: 't1', startsAt: at(9), endsAt: at(10) })],
      estimateMinutesByTask: new Map([['t1', 45]]),
    });
    expect(rows[0]!.plannedMinutes).toBe(45);
  });

  it('reports logged minutes per task, defaulting to zero', () => {
    const rows = build({
      blocks: [block({ id: 'b1', taskId: 't1' }), block({ id: 'b2', taskId: 't2', startsAt: at(14), endsAt: at(15) })],
      logged: new Map([['t1', 97]]),
    });
    expect(rows.map((r) => r.loggedMinutes)).toEqual([97, 0]);
  });

  it('tones by parent project, greying a task that has none', () => {
    const rows = build({
      blocks: [block({ id: 'b1', taskId: 't1' }), block({ id: 'b2', taskId: 't2', startsAt: at(14), endsAt: at(15) })],
      projectIdByTask: new Map<string, string | null>([
        ['t1', 'proj-a'],
        ['t2', null],
      ]),
    });
    expect(rows[0]!.tone).not.toBe('grey');
    expect(rows[0]!.projectId).toBe('proj-a');
    expect(rows[1]!.tone).toBe('grey');
  });

  it('gives two tasks in the same project the same tone', () => {
    const rows = build({
      blocks: [block({ id: 'b1', taskId: 't1' }), block({ id: 'b2', taskId: 't2', startsAt: at(14), endsAt: at(15) })],
      projectIdByTask: new Map<string, string | null>([
        ['t1', 'proj-a'],
        ['t2', 'proj-a'],
      ]),
    });
    expect(rows[0]!.tone).toBe(rows[1]!.tone);
  });
});

describe('wall-clock helpers', () => {
  it('reads minutes-of-day in the account timezone, not the host one', () => {
    expect(minutesOfDay(at(9, 30), 'UTC')).toBe(9 * 60 + 30);
    // 09:30Z is 05:30 in New York (EDT, UTC-4) in July.
    expect(minutesOfDay(at(9, 30), 'America/New_York')).toBe(5 * 60 + 30);
  });

  it('normalises midnight to 0 rather than 1440', () => {
    expect(minutesOfDay(at(0, 0), 'UTC')).toBe(0);
  });

  it('formats the itinerary time column without a leading zero on the hour', () => {
    expect(formatWallTime(at(7, 0), 'UTC')).toBe('7:00');
    expect(formatWallTime(at(14, 5), 'UTC')).toBe('14:05');
    expect(formatWallTime(at(0, 0), 'UTC')).toBe('0:00');
  });
});

describe('loggedMinutesByTask', () => {
  const opts = { today: TODAY, timezone: TZ, dayResetHour: RESET };

  it('sums a task’s entries within the day bucket', () => {
    const logged = loggedMinutesByTask([entry('t1', at(9), at(10)), entry('t1', at(14), at(14, 30))], opts);
    expect(logged.get('t1')).toBe(90);
  });

  it('ignores entries from another day', () => {
    const logged = loggedMinutesByTask([entry('t1', at(9), at(10)), entry('t1', at(9, 0, -1), at(11, 0, -1))], opts);
    expect(logged.get('t1')).toBe(60);
  });

  it('counts a post-midnight session against the day that has not reset yet', () => {
    const logged = loggedMinutesByTask([entry('t1', at(1, 0, 1), at(2, 0, 1))], opts);
    expect(logged.get('t1')).toBe(60);
  });

  it('keeps tasks separate and omits zero-length entries', () => {
    const logged = loggedMinutesByTask([entry('t1', at(9), at(10)), entry('t2', at(11), at(11, 20)), entry('t3', at(12), at(12))], opts);
    expect([...logged.entries()].sort()).toEqual([
      ['t1', 60],
      ['t2', 20],
    ]);
  });
});
