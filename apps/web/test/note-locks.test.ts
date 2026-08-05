// @vitest-environment jsdom
/**
 * Per-day note locks. The point of the store is that days are INDEPENDENT —
 * locking one must not lock, or unlock, any other — and that the key it lives in
 * cannot grow without bound.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { isNoteLocked, lockedDays, MAX_LOCKED_DAYS, setNoteLocked } from '../src/note-locks';
import { installMemoryStorage } from './util/memory-storage';

const KEY = 'prisms.journal.locked';
const store = installMemoryStorage();

afterEach(() => store.clear());

describe('per-day locks', () => {
  it('defaults every day to editable', () => {
    expect(isNoteLocked('2026-08-05')).toBe(false);
    expect(lockedDays()).toEqual([]);
  });

  it('locks one day without touching its neighbours', () => {
    setNoteLocked('2026-08-05', true);
    expect(isNoteLocked('2026-08-05')).toBe(true);
    expect(isNoteLocked('2026-08-04')).toBe(false);
    expect(isNoteLocked('2026-08-06')).toBe(false);
  });

  it('unlocks only the day asked for', () => {
    setNoteLocked('2026-08-04', true);
    setNoteLocked('2026-08-05', true);
    setNoteLocked('2026-08-04', false);
    expect(isNoteLocked('2026-08-04')).toBe(false);
    expect(isNoteLocked('2026-08-05')).toBe(true);
  });

  it('is idempotent — locking twice stores the day once', () => {
    setNoteLocked('2026-08-05', true);
    setNoteLocked('2026-08-05', true);
    expect(lockedDays()).toEqual(['2026-08-05']);
  });

  it('unlocking a day that was never locked is a no-op', () => {
    setNoteLocked('2026-08-05', false);
    expect(lockedDays()).toEqual([]);
  });

  it('survives a reload — the state is read back from storage', () => {
    setNoteLocked('2026-08-05', true);
    // a fresh read is exactly what a reload does; nothing is cached in module state
    expect(JSON.parse(store.getItem(KEY)!)).toEqual(['2026-08-05']);
    expect(isNoteLocked('2026-08-05')).toBe(true);
  });

  it('keeps only the newest MAX_LOCKED_DAYS, dropping the oldest', () => {
    for (let i = 0; i < MAX_LOCKED_DAYS + 10; i++) {
      const d = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
      setNoteLocked(d, true);
    }
    const kept = lockedDays();
    expect(kept).toHaveLength(MAX_LOCKED_DAYS);
    expect(kept).toEqual([...kept].sort()); // chronological
    expect(isNoteLocked('2020-01-01')).toBe(false); // oldest evicted
    expect(isNoteLocked(kept.at(-1)!)).toBe(true); // newest retained
  });

  it('treats a corrupt or foreign value as nothing locked, and recovers', () => {
    store.setItem(KEY, 'not json');
    expect(lockedDays()).toEqual([]);
    expect(isNoteLocked('2026-08-05')).toBe(false);

    store.setItem(KEY, '{"2026-08-05":true}'); // an object, not the array
    expect(lockedDays()).toEqual([]);

    setNoteLocked('2026-08-05', true); // writing repairs it
    expect(lockedDays()).toEqual(['2026-08-05']);
  });

  it('ignores non-string entries mixed into the array', () => {
    store.setItem(KEY, JSON.stringify(['2026-08-05', 42, null, { d: 'x' }]));
    expect(lockedDays()).toEqual(['2026-08-05']);
  });
});
