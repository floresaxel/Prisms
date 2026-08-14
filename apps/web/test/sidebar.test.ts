// @vitest-environment jsdom
/**
 * The app shell's sidebar: where its controls live, and the three inputs that
 * argue over whether it is open — the user's collapse preference, the pin that
 * overrules it, and the window width that overrules them both.
 *
 * The load-bearing property is the PEEK: resting the pointer on the rail opens
 * it after a delay and leaving shuts it again, WITHOUT that ever being mistaken
 * for the user's preference. Collapse it, peek at it, walk away, and it is
 * still collapsed.
 *
 * Driven through the real `Layout` from `@prisms/ui` (the web app is its only
 * consumer) with vitest's fake timers standing in for the 2.5s of patience.
 */
import { createElement } from 'react';

import { Layout, PEEK_DELAY_MS } from '@prisms/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installMemoryStorage } from './util/memory-storage';

const RAIL_KEY = 'prisms.sidebar.collapsed';
const PIN_KEY = 'prisms.sidebar.pinned';

const GROUPS = [{ label: 'My work', items: [{ key: 'agenda', label: 'Agenda', href: '/agenda', icon: 'cal' as const }] }];

let storage: Storage;

beforeEach(() => {
  storage = installMemoryStorage();
  vi.useFakeTimers();
  window.innerWidth = 1400; // wide enough that nothing is forced
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  storage.clear();
});

function mount() {
  return render(
    createElement(Layout, {
      groups: GROUPS,
      active: '/agenda',
      breadcrumb: { section: 'My work', page: 'Agenda' },
      children: null,
    }),
  );
}

const aside = () => document.querySelector('.px-sidebar') as HTMLElement;
const state = () => aside().dataset.state;
const toggle = () => screen.getByTestId('sidebar-toggle');
const pin = () => screen.queryByTestId('sidebar-pin');

/** Rest the pointer on the sidebar for `ms`, in one uninterrupted stay. */
function hoverFor(ms: number) {
  fireEvent.mouseEnter(aside());
  act(() => void vi.advanceTimersByTime(ms));
}

describe('where the controls live', () => {
  it('puts the collapse button inside the sidebar, not the topbar', () => {
    mount();
    expect(aside().contains(toggle())).toBe(true);
    expect(document.querySelector('.px-topbar')!.contains(toggle())).toBe(false);
  });

  it('keeps the pin beside it', () => {
    mount();
    expect(aside().contains(pin()!)).toBe(true);
  });

  it('collapses and expands on click, and says which it will do', () => {
    mount();
    expect(toggle().getAttribute('aria-label')).toBe('collapse sidebar');
    fireEvent.click(toggle());
    expect(state()).toBe('rail');
    expect(toggle().getAttribute('aria-label')).toBe('expand sidebar');
    fireEvent.click(toggle());
    expect(state()).toBe('open');
  });

  it('remembers the collapse across a remount', () => {
    mount();
    fireEvent.click(toggle());
    expect(storage.getItem(RAIL_KEY)).toBe('1');
    cleanup();
    mount();
    expect(state()).toBe('rail');
  });

  it('hides the pin on the rail — there is nothing open to hold', () => {
    mount();
    fireEvent.click(toggle());
    expect(pin()).toBeNull();
  });
});

describe('resting the pointer on the rail', () => {
  const collapse = () => fireEvent.click(toggle());

  it('opens it, but only after the full delay', () => {
    mount();
    collapse();
    hoverFor(PEEK_DELAY_MS - 1);
    expect(state()).toBe('rail'); // a passing cursor must not open it
    act(() => void vi.advanceTimersByTime(1));
    expect(state()).toBe('peek');
  });

  it('waits 2.5 seconds', () => {
    expect(PEEK_DELAY_MS).toBe(2500);
  });

  it('shuts again when the pointer leaves', () => {
    mount();
    collapse();
    hoverFor(PEEK_DELAY_MS);
    expect(state()).toBe('peek');
    fireEvent.mouseLeave(aside());
    expect(state()).toBe('rail');
  });

  it('forgets the wait if the pointer leaves early', () => {
    mount();
    collapse();
    hoverFor(PEEK_DELAY_MS - 100);
    fireEvent.mouseLeave(aside());
    act(() => void vi.advanceTimersByTime(PEEK_DELAY_MS)); // the old timer must not fire
    expect(state()).toBe('rail');
  });

  it('is not a preference — a peek never becomes the resting state', () => {
    mount();
    collapse();
    hoverFor(PEEK_DELAY_MS);
    fireEvent.mouseLeave(aside());
    expect(storage.getItem(RAIL_KEY)).toBe('1');
    cleanup();
    mount();
    expect(state()).toBe('rail');
  });

  it('leaves an already-open sidebar alone', () => {
    mount();
    hoverFor(PEEK_DELAY_MS);
    expect(state()).toBe('open'); // not 'peek' — it was never shut
  });
});

describe('the pin', () => {
  it('holds the sidebar open across a remount', () => {
    mount();
    fireEvent.click(pin()!);
    expect(pin()!.getAttribute('aria-pressed')).toBe('true');
    expect(storage.getItem(PIN_KEY)).toBe('1');
    cleanup();
    mount();
    expect(state()).toBe('open');
  });

  it('refuses the collapse button while it holds', () => {
    mount();
    fireEvent.click(pin()!);
    expect((toggle() as HTMLButtonElement).disabled).toBe(true);
    expect(toggle().getAttribute('title')).toContain('unpin');
    fireEvent.click(toggle());
    expect(state()).toBe('open'); // the click did nothing
  });

  it('overrules a collapse preference that is already set', () => {
    storage.setItem(RAIL_KEY, '1');
    storage.setItem(PIN_KEY, '1');
    mount();
    expect(state()).toBe('open');
  });

  it('gives that preference back when unpinned, rather than guessing', () => {
    storage.setItem(RAIL_KEY, '1');
    storage.setItem(PIN_KEY, '1');
    mount();
    fireEvent.click(pin()!);
    expect(state()).toBe('rail'); // back to what the user had chosen
  });

  it('can be set from a peek, holding open what the pointer opened', () => {
    mount();
    fireEvent.click(toggle());
    hoverFor(PEEK_DELAY_MS);
    expect(state()).toBe('peek');
    fireEvent.click(pin()!);
    fireEvent.mouseLeave(aside()); // walking away no longer shuts it
    expect(state()).toBe('open');
    expect(aside().dataset.pinned).toBe('true');
  });

  it('re-arms the peek when unpinned under the cursor', () => {
    // unpinning drops it to the rail beneath a pointer that never left; without
    // re-arming, the sidebar would be stuck shut until you moved away and back.
    mount();
    fireEvent.click(toggle());
    fireEvent.mouseEnter(aside());
    act(() => void vi.advanceTimersByTime(PEEK_DELAY_MS));
    fireEvent.click(pin()!);
    fireEvent.click(pin()!); // unpin, pointer still resting on it
    expect(state()).toBe('rail');
    act(() => void vi.advanceTimersByTime(PEEK_DELAY_MS));
    expect(state()).toBe('peek');
  });
});

describe('a window too narrow for any of it', () => {
  beforeEach(() => {
    window.innerWidth = 800;
  });

  it('forces the rail and disables the button', () => {
    mount();
    expect(state()).toBe('rail');
    expect((toggle() as HTMLButtonElement).disabled).toBe(true);
    expect(toggle().getAttribute('title')).toContain('too narrow');
  });

  it('outranks even the pin', () => {
    storage.setItem(PIN_KEY, '1');
    mount();
    expect(state()).toBe('rail');
  });

  it('refuses to peek — there is no room to open into', () => {
    mount();
    hoverFor(PEEK_DELAY_MS);
    expect(state()).toBe('rail');
  });
});
