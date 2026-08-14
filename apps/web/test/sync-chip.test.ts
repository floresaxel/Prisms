// @vitest-environment jsdom
/**
 * The sync chip's choreography: the dot is the status and changes at once, the
 * words trail it, and neither may disturb the text an e2e reads.
 *
 * jsdom has no canvas, so the measured widths come back 0 and the component
 * falls back to natural widths — which is the point of that fallback, and lets
 * the timing be tested here without a layout engine.
 */
import { createElement } from 'react';

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = { busy: false, pending: 0 };

vi.mock('@prisms/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prisms/ui')>();
  return { ...actual, useSyncQueue: () => ({ busy: state.busy, pending: state.pending }) };
});

// Imported AFTER the mock (vitest hoists vi.mock).
import { SyncChip } from '../src/components/SyncChip';

afterEach(() => {
  cleanup();
  state.busy = false;
  state.pending = 0;
  vi.useRealTimers();
});

const chip = () => screen.getByTestId('sync-state');

describe('SyncChip', () => {
  it('reports the QUEUE, not just the connection', () => {
    state.busy = true;
    render(createElement(SyncChip, { connected: true }));
    // connected, but work is outstanding — the old chip called this "synced"
    expect(chip().getAttribute('data-sync')).toBe('syncing');
  });

  it('says connecting when there is no connection', () => {
    render(createElement(SyncChip, { connected: false }));
    expect(chip().getAttribute('data-sync')).toBe('connecting');
  });

  it('recolours the dot immediately but lets the words trail by 100ms', () => {
    vi.useFakeTimers();
    const { rerender } = render(createElement(SyncChip, { connected: true }));
    expect(chip().textContent).toBe('synced');

    state.busy = true;
    act(() => { rerender(createElement(SyncChip, { connected: true })); });
    // the dot follows the status at once — delaying it would make the chip lie
    expect(chip().getAttribute('data-sync')).toBe('syncing');
    expect(chip().textContent).toBe('synced'); // …the words have not caught up

    act(() => { vi.advanceTimersByTime(99); });
    expect(chip().textContent).toBe('synced');
    act(() => { vi.advanceTimersByTime(2); });
    expect(chip().textContent).toBe('syncing…');
  });

  it('does not leave stale words behind when the status changes twice quickly', () => {
    vi.useFakeTimers();
    const { rerender } = render(createElement(SyncChip, { connected: true }));
    state.busy = true;
    act(() => { rerender(createElement(SyncChip, { connected: true })); });
    act(() => { vi.advanceTimersByTime(40) }); // still mid-delay
    state.busy = false;
    act(() => { rerender(createElement(SyncChip, { connected: true })); });
    act(() => { vi.advanceTimersByTime(200); });
    expect(chip().textContent).toBe('synced');
    expect(chip().getAttribute('data-sync')).toBe('synced');
  });

  it('reads as exactly one status — the e2e waits on this text', () => {
    // s16.spec.ts asserts toHaveText('synced') after going back online. Anything
    // that reserves width with real hidden text would break that.
    render(createElement(SyncChip, { connected: true }));
    expect(chip().textContent).toBe('synced');
  });

  it('names the outstanding count for a hover, and says nothing when there is none', () => {
    state.busy = true;
    state.pending = 3;
    const { rerender } = render(createElement(SyncChip, { connected: true }));
    expect(chip().getAttribute('title')).toBe('3 change(s) not yet on the server');
    state.busy = false;
    state.pending = 0;
    rerender(createElement(SyncChip, { connected: true }));
    expect(chip().getAttribute('title')).toBeNull();
  });
});
