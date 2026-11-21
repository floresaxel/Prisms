// @vitest-environment jsdom
/**
 * Tasks › Recently deleted must never sit on "Loading…" for good: the history
 * stream's first sync never ends while sync is down (offline, or the server
 * refusing an expired token), so the hook gives up waiting after
 * HISTORY_WAIT_MS — and still releases the stream when the view closes mid-wait.
 * A fake stream stands in for PowerSync; timers are faked.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StreamSubscriber } from '@prisms/ui';

import { HISTORY_WAIT_MS, historyNotice, useHistoryStream } from '../src/components/useHistoryStream';

/** A stream whose first sync resolves only when `finish()` is called (never, if it isn't). */
function fakeDb() {
  let finish: () => void = () => {};
  const unsubscribe = vi.fn();
  const subscribe = vi.fn(() =>
    Promise.resolve({
      waitForFirstSync: () => new Promise<void>((resolve) => { finish = resolve; }),
      unsubscribe,
    }),
  );
  const db: StreamSubscriber = { syncStream: vi.fn(() => ({ subscribe })) };
  return { db, unsubscribe, subscribe, finish: () => finish() };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useHistoryStream', () => {
  it('reports synced once the first sync lands', async () => {
    const f = fakeDb();
    const { result } = renderHook(() => useHistoryStream(f.db));
    expect(result.current).toBe('waiting');
    await act(async () => { await Promise.resolve(); });
    expect(f.db.syncStream).toHaveBeenCalledWith('history');
    await act(async () => { f.finish(); await Promise.resolve(); });
    expect(result.current).toBe('synced');
    // a late timer doesn't undo it
    await act(async () => { vi.advanceTimersByTime(HISTORY_WAIT_MS); });
    expect(result.current).toBe('synced');
  });

  it('stops waiting after HISTORY_WAIT_MS when the first sync never comes', async () => {
    const f = fakeDb();
    const { result } = renderHook(() => useHistoryStream(f.db));
    await act(async () => { vi.advanceTimersByTime(HISTORY_WAIT_MS - 1); });
    expect(result.current).toBe('waiting');
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe('stalled');
  });

  it('releases the stream on unmount even while still waiting', async () => {
    const f = fakeDb();
    const { unmount } = renderHook(() => useHistoryStream(f.db));
    await act(async () => { await Promise.resolve(); });
    unmount();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('a failed subscribe counts as stalled', async () => {
    const db: StreamSubscriber = { syncStream: () => ({ subscribe: () => Promise.reject(new Error('nope')) }) };
    const { result } = renderHook(() => useHistoryStream(db));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current).toBe('stalled');
  });
});

describe('historyNotice', () => {
  it('says nothing once synced, even offline (the list on the device is complete)', () => {
    expect(historyNotice('synced', false)).toBeNull();
  });
  it('says so at once when not connected', () => {
    expect(historyNotice('waiting', false)).toMatch(/isn't connected/);
  });
  it('waits quietly while connected, then explains a stall', () => {
    expect(historyNotice('waiting', true)).toBeNull();
    expect(historyNotice('stalled', true)).toMatch(/haven't arrived/);
  });
});
