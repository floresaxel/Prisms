// @vitest-environment jsdom
/**
 * NoteSwap keeps the day you came FROM on screen long enough to fade it out.
 *
 * The behaviour worth pinning is not the fade itself (that is CSS) but what it
 * needs to be possible: two layers alive at once, the old one dropped on time,
 * and — the sharp edge — the outgoing panel MOVED rather than rebuilt, because a
 * rebuild would remount a whole editor and its save machinery just to fade it.
 */
import { createElement, useEffect } from 'react';

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NoteSwap } from '../src/components/NoteSwap';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const mounted: string[] = [];

function Day({ day }: { day: string }) {
  return createElement('div', { 'data-testid': `day-${day}` }, day);
}

/** Stand-in for the note panel that records every MOUNT, so a rebuild is visible. */
function Counted({ day }: { day: string }) {
  useEffect(() => {
    mounted.push(day);
  }, []);
  return createElement('div', { 'data-testid': `day-${day}` }, day);
}

const view = (day: string) =>
  createElement(NoteSwap, { swapKey: day }, createElement(Day, { key: day, day }));

describe('NoteSwap', () => {
  afterEach(() => {
    mounted.length = 0;
  });

  it('holds the outgoing day on screen beside the incoming one', () => {
    vi.useFakeTimers();
    const { rerender } = render(view('2026-08-05'));
    expect(screen.getByTestId('day-2026-08-05')).toBeTruthy();

    act(() => { rerender(view('2026-08-06')); });
    // both alive — this is what lets the two fades overlap
    expect(screen.getByTestId('day-2026-08-05')).toBeTruthy();
    expect(screen.getByTestId('day-2026-08-06')).toBeTruthy();

    act(() => { vi.advanceTimersByTime(120); });
    expect(screen.queryByTestId('day-2026-08-05')).toBeNull();
    expect(screen.getByTestId('day-2026-08-06')).toBeTruthy();
  });

  it('marks the leaving layer, and only it', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(view('2026-08-05'));
    act(() => { rerender(view('2026-08-06')); });
    const layers = [...container.querySelectorAll('.px-note-layer')];
    expect(layers).toHaveLength(2);
    expect(layers.filter((l) => l.classList.contains('px-note-layer--out'))).toHaveLength(1);
    // the ghost is a picture of a day you are no longer on
    expect(layers[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(layers[1]!.getAttribute('aria-hidden')).toBeNull();
  });

  it('does not keep a ghost of the day you just came back to', () => {
    // Switch away and straight back inside the fade. Without dropping the ghost
    // both layers would carry the same key, which React refuses.
    vi.useFakeTimers();
    const { container, rerender } = render(view('2026-08-05'));
    act(() => { rerender(view('2026-08-06')); });
    act(() => { vi.advanceTimersByTime(40); });
    act(() => { rerender(view('2026-08-05')); });
    const layers = [...container.querySelectorAll('.px-note-layer')];
    expect(layers).toHaveLength(2);
    expect(screen.getByTestId('day-2026-08-05')).toBeTruthy();
    // the live layer is the one we returned to, and it is NOT the ghost
    expect(layers.find((l) => l.querySelector('[data-testid="day-2026-08-05"]'))!.classList.contains('px-note-layer--out')).toBe(false);
  });

  it('renders one layer when nothing is leaving', () => {
    const { container } = render(view('2026-08-05'));
    expect(container.querySelectorAll('.px-note-layer')).toHaveLength(1);
    expect(container.querySelectorAll('.px-note-layer--out')).toHaveLength(0);
  });

  it('MOVES the leaving panel rather than rebuilding it', () => {
    // The sharp edge. The outgoing layer changes position in the child list, and
    // React only reuses an instance across a move if the keys match. Get that
    // wrong and every day change remounts an entire editor — TipTap, save timers
    // and all — purely to fade a copy of it out.
    vi.useFakeTimers();
    const counted = (day: string) =>
      createElement(NoteSwap, { swapKey: day }, createElement(Counted, { key: day, day }));

    const { rerender } = render(counted('2026-08-05'));
    expect(mounted).toEqual(['2026-08-05']);

    act(() => { rerender(counted('2026-08-06')); });
    // the incoming mounts; the outgoing must NOT mount a second time
    expect(mounted).toEqual(['2026-08-05', '2026-08-06']);

    act(() => { vi.advanceTimersByTime(120); });
    expect(mounted).toEqual(['2026-08-05', '2026-08-06']);
  });
});
