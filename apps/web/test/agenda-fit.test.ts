/**
 * Whether a placement fits, where a day has room, and how two events that
 * legally occupy the same minutes share a column.
 *
 * These three replaced a single rule — "a drop outside a free region is
 * refused" — so the properties worth pinning are the ones that rule used to
 * make impossible: a clash EXISTS and has to be described, and the thing it
 * clashes with must not be able to hide it.
 */
import { describe, expect, it } from 'vitest';

import {
  conflictMessage,
  fitProblems,
  laneLayout,
  mergeIntervals,
  overlapping,
  regionsInDay,
} from '../src/agenda-fit';

/** Minutes → ms, so the fixtures read as a clock rather than as epochs. */
const t = (min: number) => min * 60_000;
const span = (fromMin: number, toMin: number) => ({ start: t(fromMin), end: t(toMin) });
const DAY = [span(8 * 60, 20 * 60)]; // the app's own 8am–8pm window

describe('overlap', () => {
  it('is half-open — back-to-back events do not clash', () => {
    expect(overlapping(span(60, 120), span(120, 180))).toBe(false);
    expect(overlapping(span(120, 180), span(60, 120))).toBe(false);
  });

  it('catches every real intersection, whichever way round', () => {
    expect(overlapping(span(60, 120), span(90, 150))).toBe(true);
    expect(overlapping(span(90, 150), span(60, 120))).toBe(true);
    expect(overlapping(span(60, 180), span(90, 120))).toBe(true); // contained
    expect(overlapping(span(90, 120), span(60, 180))).toBe(true); // containing
  });
});

describe('merging spans', () => {
  it('fuses overlapping and merely touching spans', () => {
    expect(mergeIntervals([span(0, 60), span(60, 120)])).toEqual([span(0, 120)]);
    expect(mergeIntervals([span(0, 90), span(60, 120)])).toEqual([span(0, 120)]);
  });

  it('keeps a real gap', () => {
    expect(mergeIntervals([span(0, 60), span(90, 120)])).toEqual([span(0, 60), span(90, 120)]);
  });

  it('does not care what order it is handed', () => {
    expect(mergeIntervals([span(90, 120), span(0, 60), span(30, 100)])).toEqual([span(0, 120)]);
  });

  it('leaves its input alone', () => {
    const input = [span(90, 120), span(0, 60)];
    const copy = structuredClone(input);
    mergeIntervals(input);
    expect(input).toEqual(copy);
  });
});

describe('what is wrong with a placement', () => {
  it('is nothing, for a free span inside the hours', () => {
    expect(fitProblems(span(9 * 60, 10 * 60), [], DAY)).toEqual([]);
  });

  it('reports an overlap with something already there', () => {
    expect(fitProblems(span(9 * 60, 10 * 60), [span(9 * 60 + 30, 11 * 60)], DAY)).toEqual(['overlap']);
  });

  it('reports a span outside the hours work may land in', () => {
    expect(fitProblems(span(6 * 60, 7 * 60), [], DAY)).toEqual(['outside-hours']);
    // …including one that merely runs past the end
    expect(fitProblems(span(19 * 60, 21 * 60), [], DAY)).toEqual(['outside-hours']);
  });

  it('reports both when both are true', () => {
    expect(fitProblems(span(7 * 60, 9 * 60), [span(8 * 60, 10 * 60)], DAY)).toEqual(['overlap', 'outside-hours']);
  });

  it('accepts a span that straddles two touching windows', () => {
    // a morning and a day window that meet at noon are one stretch of allowed
    // time, not two — a span across the seam is not "outside" anything
    const touching = [span(8 * 60, 12 * 60), span(12 * 60, 18 * 60)];
    expect(fitProblems(span(11 * 60, 13 * 60), [], touching)).toEqual([]);
  });

  it('reports nothing about hours when no hours are configured', () => {
    // there is nothing to be outside of — flagging everything would be noise
    expect(fitProblems(span(3 * 60, 4 * 60), [], [])).toEqual([]);
  });

  it('describes itself in one line, or says nothing at all', () => {
    expect(conflictMessage([])).toBeNull();
    expect(conflictMessage(['overlap'])).toContain('overlaps another event');
    expect(conflictMessage(['outside-hours'])).toContain('outside your scheduling hours');
    const both = conflictMessage(['overlap', 'outside-hours'])!;
    expect(both).toContain('overlaps another event');
    expect(both).toContain('outside your scheduling hours');
  });
});

describe('the free stretches of one day', () => {
  const dayStart = t(1000 * 60); // an arbitrary grid origin
  const GRID = 16 * 60; // 6am–10pm
  const rel = (fromMin: number, toMin: number) => ({ start: dayStart + t(fromMin), end: dayStart + t(toMin) });

  it('is ONE shape for a continuous stretch, not one per hour', () => {
    // the whole point: 8am–8pm used to be fourteen stacked rectangles
    expect(regionsInDay([rel(120, 840)], dayStart, GRID)).toEqual([{ startMin: 120, endMin: 840 }]);
  });

  it('splits where something occupies the middle of the day', () => {
    expect(regionsInDay([rel(120, 180), rel(240, 840)], dayStart, GRID)).toEqual([
      { startMin: 120, endMin: 180 },
      { startMin: 240, endMin: 840 },
    ]);
  });

  it('fuses stretches that meet, so no seam shows', () => {
    expect(regionsInDay([rel(120, 300), rel(300, 480)], dayStart, GRID)).toEqual([{ startMin: 120, endMin: 480 }]);
  });

  it('clips to the grid rather than overflowing it', () => {
    expect(regionsInDay([rel(-600, 2000)], dayStart, GRID)).toEqual([{ startMin: 0, endMin: GRID }]);
  });

  it('drops the other days entirely', () => {
    const yesterday = { start: dayStart - t(600), end: dayStart - t(60) };
    const tomorrow = { start: dayStart + t(GRID + 60), end: dayStart + t(GRID + 600) };
    expect(regionsInDay([yesterday, rel(120, 180), tomorrow], dayStart, GRID)).toEqual([{ startMin: 120, endMin: 180 }]);
  });

  it('has nothing to draw when nothing is free', () => {
    expect(regionsInDay([], dayStart, GRID)).toEqual([]);
  });
});

describe('lanes for overlapping events', () => {
  const ev = (id: string, fromMin: number, toMin: number) => ({ id, ...span(fromMin, toMin) });

  it('gives an event that overlaps nothing the whole column', () => {
    const out = laneLayout([ev('a', 60, 120), ev('b', 180, 240)]);
    expect(out.get('a')).toEqual({ lane: 0, lanes: 1 });
    expect(out.get('b')).toEqual({ lane: 0, lanes: 1 });
  });

  it('splits a clashing pair side by side', () => {
    const out = laneLayout([ev('a', 60, 120), ev('b', 90, 150)]);
    expect(out.get('a')).toEqual({ lane: 0, lanes: 2 });
    expect(out.get('b')).toEqual({ lane: 1, lanes: 2 });
  });

  it('widens the whole cluster to its deepest pile-up, so edges line up', () => {
    const out = laneLayout([ev('a', 60, 300), ev('b', 90, 150), ev('c', 100, 200)]);
    for (const id of ['a', 'b', 'c']) expect(out.get(id)!.lanes).toBe(3);
    expect(new Set(['a', 'b', 'c'].map((id) => out.get(id)!.lane))).toEqual(new Set([0, 1, 2]));
  });

  it('reuses a lane once its event has finished', () => {
    // a and b clash; c starts after a ends, so it takes a's lane back
    const out = laneLayout([ev('a', 60, 120), ev('b', 90, 240), ev('c', 130, 200)]);
    expect(out.get('a')).toEqual({ lane: 0, lanes: 2 });
    expect(out.get('b')).toEqual({ lane: 1, lanes: 2 });
    expect(out.get('c')).toEqual({ lane: 0, lanes: 2 });
  });

  it('starts a fresh cluster after a clear gap', () => {
    const out = laneLayout([ev('a', 60, 120), ev('b', 90, 150), ev('c', 300, 360)]);
    expect(out.get('b')!.lanes).toBe(2);
    expect(out.get('c')).toEqual({ lane: 0, lanes: 1 }); // full width again
  });

  it('never hides one event under another — every clash gets its own lane', () => {
    const events = [ev('a', 60, 120), ev('b', 90, 150), ev('c', 100, 130), ev('d', 400, 460), ev('e', 450, 500)];
    const out = laneLayout(events);
    for (const x of events) {
      for (const y of events) {
        if (x.id === y.id || !overlapping(x, y)) continue;
        expect(out.get(x.id)!.lane).not.toBe(out.get(y.id)!.lane);
      }
    }
  });

  it('places every event exactly once, in a lane that exists', () => {
    const events = [ev('a', 60, 120), ev('b', 90, 150), ev('c', 300, 360)];
    const out = laneLayout(events);
    expect(out.size).toBe(events.length);
    for (const { lane, lanes } of out.values()) {
      expect(lane).toBeGreaterThanOrEqual(0);
      expect(lane).toBeLessThan(lanes);
    }
  });

  it('is stable however the events arrive', () => {
    const events = [ev('a', 60, 120), ev('b', 90, 150), ev('c', 300, 360)];
    const forward = laneLayout(events);
    const backward = laneLayout([...events].reverse());
    for (const e of events) expect(backward.get(e.id)).toEqual(forward.get(e.id));
  });
});
