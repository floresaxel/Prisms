// @vitest-environment jsdom
/**
 * The shared Modal's exit: on close it stays up for MODAL_EXIT_MS, blurring out
 * with its LAST content (a parent usually clears that content as it closes),
 * unreachable meanwhile; it reopens cleanly mid-exit; and with reduced motion,
 * or no matchMedia to ask (plain jsdom), it closes at once.
 */
import { createElement } from 'react';

import { Modal } from '@prisms/ui';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Modal.tsx's MODAL_EXIT_MS (kept out of the package's public exports). */
const MODAL_EXIT_MS = 180;

const original = window.matchMedia;
function stubMotion(reduce: boolean) {
  window.matchMedia = ((q: string) => ({ matches: reduce && q.includes('reduce'), media: q })) as unknown as typeof window.matchMedia;
}

const view = (open: boolean, text: string | null) =>
  createElement(Modal, { open, title: 'Hello', onClose: () => {} }, createElement('p', { 'data-testid': 'body' }, text ?? '(cleared)'));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.matchMedia = original;
});

describe('Modal exit', () => {
  it('blurs out with its last content, inert, then unmounts', () => {
    stubMotion(false);
    const { rerender, container } = render(view(true, 'the task'));
    expect(container.querySelector('.px-scrim')?.getAttribute('data-state')).toBe('open');

    rerender(view(false, null));
    const scrim = container.querySelector('.px-scrim');
    expect(scrim?.classList.contains('px-scrim--out')).toBe(true);
    expect(scrim?.hasAttribute('inert')).toBe(true);
    expect(screen.getByTestId('body').textContent).toBe('the task'); // not the cleared content

    act(() => vi.advanceTimersByTime(MODAL_EXIT_MS));
    expect(container.querySelector('.px-scrim')).toBeNull();
  });

  it('reopens cleanly in the middle of the exit', () => {
    stubMotion(false);
    const { rerender, container } = render(view(true, 'one'));
    rerender(view(false, null));
    act(() => vi.advanceTimersByTime(MODAL_EXIT_MS / 2));
    rerender(view(true, 'two'));
    act(() => vi.advanceTimersByTime(MODAL_EXIT_MS * 2));
    const scrim = container.querySelector('.px-scrim');
    expect(scrim?.getAttribute('data-state')).toBe('open');
    expect(scrim?.hasAttribute('inert')).toBe(false);
    expect(screen.getByTestId('body').textContent).toBe('two');
  });

  it('closes at once under reduced motion', () => {
    stubMotion(true);
    const { rerender, container } = render(view(true, 'x'));
    rerender(view(false, null));
    expect(container.querySelector('.px-scrim')).toBeNull();
  });
});
