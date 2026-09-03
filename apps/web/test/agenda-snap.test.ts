// @vitest-environment jsdom
/**
 * Where a dragged item lands: the snap grid the Agenda rounds a drop to, and
 * the per-device preference behind it.
 *
 * Pure by construction — in the app this is fed by pointer geometry, which is
 * exactly what a unit test cannot drive, so the geometry is a function of
 * (clientY, rect, grab offset) and tested as one. The screen test next door
 * drives the same math through real mouse events.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SNAP,
  fmtGridClock,
  isSnapMinutes,
  pointerMinutes,
  setSnapPref,
  snapMinutes,
  SNAP_KEY,
  SNAP_OPTIONS,
  useSnapPref,
} from '../src/agenda-snap';
import { installMemoryStorage } from './util/memory-storage';

const VALUES = SNAP_OPTIONS.map((o) => o.value);
/** The Agenda's own grid: 6am–10pm at 44px an hour. */
const GRID_START_HOUR = 6;
const GRID_MINUTES = 16 * 60;
const HOUR_PX = 44;

let storage: Storage;
beforeEach(() => {
  storage = installMemoryStorage();
});
afterEach(() => {
  cleanup(); // no globals:true, so testing-library's auto-cleanup is not installed
  storage.clear();
});

describe('the offered grids', () => {
  it('offers 5, 10, 15, 30 and 60 minutes, defaulting to 15', () => {
    expect(VALUES).toEqual([5, 10, 15, 30, 60]);
    expect(DEFAULT_SNAP).toBe(15);
  });

  it('recognizes only those as valid stored preferences', () => {
    for (const v of VALUES) expect(isSnapMinutes(v)).toBe(true);
    for (const bad of [0, 1, 7, 20, 45, 90, -15, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isSnapMinutes(bad)).toBe(false);
    }
  });

  it('divides both the hour and the whole grid, so every line is reachable', () => {
    // an option that did not divide 60 would drift out of step with the hour
    // rules; one that did not divide the grid could not reach its last slot.
    for (const v of VALUES) {
      expect(60 % v).toBe(0);
      expect(GRID_MINUTES % v).toBe(0);
    }
  });
});

describe('snapping a pointer to the grid', () => {
  const limit = GRID_MINUTES - 15;

  it('rounds to the nearest line rather than flooring to it', () => {
    // flooring would make the outline trail the cursor by up to a whole step
    expect(snapMinutes(97, 15, limit)).toBe(90);
    expect(snapMinutes(98, 15, limit)).toBe(105);
    expect(snapMinutes(97.5, 15, limit)).toBe(105);
  });

  it('lands on a multiple of the step, whatever the step', () => {
    for (const v of VALUES) {
      for (let raw = -30; raw <= GRID_MINUTES + 30; raw += 3.7) {
        const out = snapMinutes(raw, v, GRID_MINUTES - v);
        expect(out % v).toBe(0);
        expect(out).toBeGreaterThanOrEqual(0);
        expect(out).toBeLessThanOrEqual(GRID_MINUTES - v);
      }
    }
  });

  it('never starts an item above the grid or past its last line', () => {
    expect(snapMinutes(-500, 15, limit)).toBe(0);
    expect(snapMinutes(99_999, 15, limit)).toBe(limit);
    // the last line is reachable — the tail of the day is not a dead zone
    expect(snapMinutes(GRID_MINUTES, 15, limit)).toBe(945);
    expect(snapMinutes(GRID_MINUTES, 60, GRID_MINUTES - 60)).toBe(900);
  });

  it('treats an unmeasurable pointer as the top of the grid', () => {
    expect(snapMinutes(Number.NaN, 15, limit)).toBe(0);
  });

  it('reads the same clientY differently under each grid', () => {
    // one pointer position, five preferences — this is the whole feature
    const raw = pointerMinutes(150, 0, HOUR_PX, 0); // 204.54 min past 6am
    expect(snapMinutes(raw, 5, limit)).toBe(205); // 9:25
    expect(snapMinutes(raw, 10, limit)).toBe(200); // 9:20
    expect(snapMinutes(raw, 15, limit)).toBe(210); // 9:30
    expect(snapMinutes(raw, 30, limit)).toBe(210); // 9:30
    expect(snapMinutes(raw, 60, limit)).toBe(180); // 9:00
  });
});

describe('reading the pointer', () => {
  it('maps pixels down the column to minutes down the day', () => {
    expect(pointerMinutes(0, 0, HOUR_PX, 0)).toBe(0);
    expect(pointerMinutes(HOUR_PX, 0, HOUR_PX, 0)).toBe(60);
    expect(pointerMinutes(HOUR_PX * 3, 0, HOUR_PX, 0)).toBe(180);
  });

  it('measures from the column body, not the viewport', () => {
    expect(pointerMinutes(300, 120, HOUR_PX, 0)).toBeCloseTo(pointerMinutes(180, 0, HOUR_PX, 0));
  });

  it('keeps a block under the hand it was grabbed by', () => {
    // grabbed 30 minutes into itself and not moved: the drop is where it already
    // is, not 30 minutes earlier with its top yanked up to the cursor.
    const grabbedAt = pointerMinutes(HOUR_PX * 3.5, 0, HOUR_PX, 30);
    expect(grabbedAt).toBe(180);
  });
});

describe('the time an outline reports', () => {
  it('reads like the hour labels beside it', () => {
    expect(fmtGridClock(GRID_START_HOUR, 0)).toBe('6am');
    expect(fmtGridClock(GRID_START_HOUR, 180)).toBe('9am');
    expect(fmtGridClock(GRID_START_HOUR, 195)).toBe('9:15am');
    expect(fmtGridClock(GRID_START_HOUR, 360)).toBe('12pm');
    expect(fmtGridClock(GRID_START_HOUR, 365)).toBe('12:05pm');
    expect(fmtGridClock(GRID_START_HOUR, 960)).toBe('10pm');
  });

  it('says 12, not 0, on both sides of the clock', () => {
    expect(fmtGridClock(0, 0)).toBe('12am');
    expect(fmtGridClock(0, 30)).toBe('12:30am');
    expect(fmtGridClock(12, 0)).toBe('12pm');
  });
});

describe('the stored preference', () => {
  it('is 15 minutes until something says otherwise', () => {
    const { result } = renderHook(() => useSnapPref());
    expect(result.current).toBe(DEFAULT_SNAP);
  });

  it('honours a stored choice', () => {
    storage.setItem(SNAP_KEY, '30');
    const { result } = renderHook(() => useSnapPref());
    expect(result.current).toBe(30);
  });

  it('falls back rather than trusting junk in storage', () => {
    for (const junk of ['', 'quarter-hour', '7', '0', '-15', 'NaN']) {
      storage.setItem(SNAP_KEY, junk);
      const { result } = renderHook(() => useSnapPref());
      expect(result.current).toBe(DEFAULT_SNAP);
    }
  });

  it('reaches every mounted reader the moment it changes', () => {
    // Settings writes it while the Agenda is on screen beside it (wide window),
    // so a screen-local useState would have left the calendar on the old grid.
    const a = renderHook(() => useSnapPref());
    const b = renderHook(() => useSnapPref());
    act(() => setSnapPref(5));
    expect(a.result.current).toBe(5);
    expect(b.result.current).toBe(5);
    expect(storage.getItem(SNAP_KEY)).toBe('5');
  });

  it('ignores a value it does not offer', () => {
    const { result } = renderHook(() => useSnapPref());
    act(() => setSnapPref(45));
    expect(result.current).toBe(DEFAULT_SNAP);
    expect(storage.getItem(SNAP_KEY)).toBeNull();
  });

  it('follows the preference across tabs', () => {
    const { result } = renderHook(() => useSnapPref());
    act(() => {
      storage.setItem(SNAP_KEY, '60');
      window.dispatchEvent(new StorageEvent('storage', { key: SNAP_KEY }));
    });
    expect(result.current).toBe(60);
  });

  it('survives storage being unavailable', () => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('denied');
      },
      configurable: true,
    });
    const { result } = renderHook(() => useSnapPref());
    expect(result.current).toBe(DEFAULT_SNAP);
    expect(() => setSnapPref(30)).not.toThrow();
  });
});
