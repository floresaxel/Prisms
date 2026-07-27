/**
 * T2 (MOBILE_TODAY_PLAN D3/D4): the day map is the one selector behind both the
 * 14 px bar and the swipe-out calendar, so everything it decides is pinned here.
 */
import { describe, expect, it } from 'vitest';

import { asEpochMillis, DEFAULT_WINDOWS, expandWindows, type ConcreteWindow, type IsoDate } from '@prisms/core';

import { buildDayMap } from '../src/day-map';
import type { AgendaBlock } from '../src/hooks';

const TZ = 'UTC';
const TODAY = '2026-07-26' as IsoDate;

const at = (hh: number, mm = 0, dayOffset = 0) => asEpochMillis(Date.UTC(2026, 6, 26 + dayOffset, hh, mm));

/** The account's real windows for this day, via the same core call the app makes. */
const todaysWindows = (): ConcreteWindow[] =>
  expandWindows(DEFAULT_WINDOWS, TZ, { from: at(0), to: at(0, 0, 1) });

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

const build = (over: Partial<Parameters<typeof buildDayMap>[0]> = {}) =>
  buildDayMap({
    blocks: [],
    loggedMinutesByTask: new Map(),
    projectIdByTask: new Map(),
    windows: todaysWindows(),
    runningTaskId: null,
    doneTaskIds: new Set(),
    now: at(9, 30),
    today: TODAY,
    timezone: TZ,
    ...over,
  });

const round = (n: number) => Math.round(n * 100) / 100;

describe('buildDayMap — inactive zones are the window complement (D4)', () => {
  it('greys midnight→08:00 and 20:00→midnight for the default 08–20 window', () => {
    const map = build();
    expect(map.inactive.map((z) => [round(z.topPct), round(z.heightPct)])).toEqual([
      [0, round((480 / 1440) * 100)], // 00:00 → 08:00
      [round((1200 / 1440) * 100), round((240 / 1440) * 100)], // 20:00 → 24:00
    ]);
  });

  it('greys the entire day when no window covers it', () => {
    const map = build({ windows: [] });
    expect(map.inactive).toEqual([{ topPct: 0, heightPct: 100 }]);
  });

  it('greys nothing when a window spans the whole day', () => {
    const map = build({ windows: [{ windowId: 'all', start: at(0), end: at(0, 0, 1) }] });
    expect(map.inactive).toEqual([]);
  });

  it('merges overlapping windows instead of emitting a sliver between them', () => {
    const map = build({
      windows: [
        { windowId: 'a', start: at(8), end: at(13) },
        { windowId: 'b', start: at(12), end: at(20) },
      ],
    });
    expect(map.inactive).toHaveLength(2); // still just before-08 and after-20
  });

  it('ignores windows belonging to neighbouring days', () => {
    const map = build({
      windows: [...todaysWindows(), { windowId: 'tomorrow', start: at(8, 0, 1), end: at(20, 0, 1) }],
    });
    expect(map.inactive).toHaveLength(2);
  });

  it('reports the active ranges in minutes, for the day panel header', () => {
    expect(build().active).toEqual([{ startMin: 480, endMin: 1200 }]);
    expect(build({ windows: [] }).active).toEqual([]);
  });

  it('reports two active ranges for a split day, and they complement the grey zones', () => {
    const map = build({
      windows: [
        { windowId: 'am', start: at(9), end: at(12) },
        { windowId: 'pm', start: at(14), end: at(18) },
      ],
    });
    expect(map.active).toEqual([
      { startMin: 540, endMin: 720 },
      { startMin: 840, endMin: 1080 },
    ]);
    expect(map.inactive).toHaveLength(3); // before 9, the 12–14 gap, after 18
  });
});

describe('buildDayMap — segments', () => {
  it('places a block at its true position on the 0–24 h scale', () => {
    const map = build({ blocks: [block({ id: 'b1', taskId: 't1', startsAt: at(6), endsAt: at(12) })] });
    expect(round(map.segments[0]!.topPct)).toBe(25); // 06:00 of 24 h
    expect(round(map.segments[0]!.heightPct)).toBe(25); // 6 h of 24 h
    expect(map.segments[0]!.startMin).toBe(360);
    expect(map.segments[0]!.endMin).toBe(720);
  });

  it('sorts by start time regardless of input order', () => {
    const map = build({
      blocks: [
        block({ id: 'b-late', taskId: 't2', startsAt: at(17), endsAt: at(18) }),
        block({ id: 'b-early', taskId: 't1', startsAt: at(7), endsAt: at(8) }),
      ],
    });
    expect(map.segments.map((s) => s.blockId)).toEqual(['b-early', 'b-late']);
  });

  it('gives a very short block a floor height so it stays visible', () => {
    const map = build({ blocks: [block({ id: 'b1', taskId: 't1', startsAt: at(9), endsAt: at(9, 1) })] });
    expect(map.segments[0]!.heightPct).toBeGreaterThan(0);
    expect(map.segments[0]!.endMin - map.segments[0]!.startMin).toBe(6);
  });

  it('keeps suggested blocks — unlike the itinerary, the map shows what is proposed', () => {
    const map = build({
      blocks: [block({ id: 'b1', taskId: 't1' }), block({ id: 'b2', taskId: 't2', status: 'suggested', startsAt: at(14), endsAt: at(15) })],
    });
    expect(map.segments.map((s) => [s.blockId, s.state])).toEqual([
      ['b1', 'upcoming'],
      ['b2', 'suggested'],
    ]);
  });

  it('ranks state suggested > done > live > upcoming', () => {
    const args = { doneTaskIds: new Set(['t1', 't3']), runningTaskId: 't1' };
    const map = build({
      ...args,
      blocks: [
        block({ id: 'b1', taskId: 't1', startsAt: at(7), endsAt: at(8) }), // done AND running
        block({ id: 'b2', taskId: 't2', startsAt: at(9), endsAt: at(10) }),
        block({ id: 'b3', taskId: 't3', status: 'suggested', startsAt: at(11), endsAt: at(12) }), // done but only suggested
      ],
    });
    expect(map.segments.map((s) => s.state)).toEqual(['done', 'upcoming', 'suggested']);
  });

  it('carries tone, anchor and logged minutes through for the day panel', () => {
    const map = build({
      blocks: [block({ id: 'b1', taskId: 't1', anchored: true })],
      projectIdByTask: new Map<string, string | null>([['t1', 'proj-a']]),
      loggedMinutesByTask: new Map([['t1', 97]]),
    });
    expect(map.segments[0]).toMatchObject({ anchored: true, loggedMinutes: 97, title: 'Task t1' });
    expect(map.segments[0]!.tone).not.toBe('grey');
  });

  it('greys a block whose task has no parent project', () => {
    const map = build({ blocks: [block({ id: 'b1', taskId: 't1' })] });
    expect(map.segments[0]!.tone).toBe('grey');
  });

  it('is empty for a day with nothing on it, but still greys the inactive hours', () => {
    const map = build();
    expect(map.segments).toEqual([]);
    expect(map.inactive).toHaveLength(2);
  });

  it('clamps a post-midnight block from the same day-reset bucket rather than dropping it', () => {
    // With a 04:00 reset, 01:00 on the 27th still belongs to the 26th, so the
    // itinerary lists it — the bar must show it too, at the foot of the scale.
    const map = build({ blocks: [block({ id: 'b1', taskId: 't1', startsAt: at(1, 0, 1), endsAt: at(2, 0, 1) })] });
    expect(map.segments).toHaveLength(1);
    expect(map.segments[0]!.endMin).toBe(1440);
    expect(round(map.segments[0]!.topPct)).toBeGreaterThan(99);
  });
});

describe('buildDayMap — the now-line', () => {
  it('tracks the wall clock', () => {
    expect(round(build({ now: at(12) }).nowPct!)).toBe(50);
    expect(build({ now: at(0) }).nowPct).toBe(0);
  });

  it('is null when the day shown is not the day `now` falls in', () => {
    expect(build({ now: at(12, 0, 1) }).nowPct).toBeNull();
    expect(build({ now: at(12, 0, -1) }).nowPct).toBeNull();
  });
});
