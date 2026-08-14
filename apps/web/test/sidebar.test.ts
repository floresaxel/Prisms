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

// two items, so focus can be moved BETWEEN links inside the sidebar
const GROUPS = [
  {
    label: 'My work',
    items: [
      { key: 'agenda', label: 'Agenda', href: '/agenda', icon: 'cal' as const },
      { key: 'tasks', label: 'Tasks', href: '/tasks', icon: 'list' as const },
    ],
  },
];

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
const maybeToggle = () => screen.queryByTestId('sidebar-toggle');
const pin = () => screen.queryByTestId('sidebar-pin');
const navlink = () => document.querySelector('.px-navlink') as HTMLElement;

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

  it('collapses on click', () => {
    mount();
    expect(toggle().getAttribute('aria-label')).toBe('collapse sidebar');
    fireEvent.click(toggle());
    expect(state()).toBe('rail');
  });

  it('remembers the collapse across a remount', () => {
    mount();
    fireEvent.click(toggle());
    expect(storage.getItem(RAIL_KEY)).toBe('1');
    cleanup();
    mount();
    expect(state()).toBe('rail');
  });

  it('takes BOTH controls away on the rail', () => {
    // the rail is opened by resting on it, not by aiming at a chevron; and the
    // pin has nothing to hold open while it is shut
    mount();
    fireEvent.click(toggle());
    expect(maybeToggle()).toBeNull();
    expect(pin()).toBeNull();
    expect(aside().querySelector('.px-sidebar-ctl')).toBeNull();
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

  it('waits 1.5 seconds', () => {
    expect(PEEK_DELAY_MS).toBe(1500);
  });

  it('is the only way back — a rail has no button to press', () => {
    mount();
    collapse();
    expect(maybeToggle()).toBeNull();
    hoverFor(PEEK_DELAY_MS);
    expect(state()).toBe('peek');
    expect(pin()).not.toBeNull(); // …and now there is something to press
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

  it('stays shut after a collapse, though the pointer never left the button', () => {
    // the collapse button is ON the sidebar, so the pointer is always resting
    // there when it is pressed. Re-arming from that would re-open what was just
    // shut a beat later, and read as a broken button.
    mount();
    fireEvent.mouseEnter(aside());
    fireEvent.click(toggle());
    act(() => void vi.advanceTimersByTime(PEEK_DELAY_MS * 3));
    expect(state()).toBe('rail');
  });

  it('…and opens again once the pointer has actually been away and back', () => {
    mount();
    fireEvent.mouseEnter(aside());
    fireEvent.click(toggle());
    fireEvent.mouseLeave(aside());
    hoverFor(PEEK_DELAY_MS);
    expect(state()).toBe('peek');
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

  it('forces the rail, controls and all', () => {
    mount();
    expect(state()).toBe('rail');
    expect(maybeToggle()).toBeNull();
    expect(pin()).toBeNull();
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

  it('refuses a focus peek too', () => {
    mount();
    fireEvent.focus(navlink());
    expect(state()).toBe('rail');
  });
});

describe('reaching a rail by keyboard', () => {
  // With no expand button left to tab to, focus is the ONLY key-driven way in.
  // A focus only counts while the KEYBOARD is driving, so each of these tabs
  // first — exactly as a keyboard user arrives.
  const collapse = () => fireEvent.click(toggle());
  const focusIn = (el: HTMLElement) =>
    act(() => {
      fireEvent.keyDown(window, { key: 'Tab' });
      el.focus();
    });
  const focusOut = () => act(() => (document.activeElement as HTMLElement | null)?.blur());

  it('opens it as soon as focus lands, without the pointer’s wait', () => {
    mount();
    collapse();
    focusIn(navlink());
    expect(state()).toBe('peek'); // no timer advanced
  });

  it('shuts it again when focus leaves the sidebar', () => {
    mount();
    collapse();
    focusIn(navlink());
    focusOut();
    expect(state()).toBe('rail');
  });

  it('stays open while focus moves BETWEEN its own links', () => {
    // React's onBlur is focusout: it fires on every internal move, and taking
    // it at face value would shut the rail between each pair of links.
    mount();
    collapse();
    const [first, second] = [...document.querySelectorAll('.px-navlink')] as HTMLElement[];
    focusIn(first!);
    focusIn(second!);
    expect(state()).toBe('peek');
  });

  it('ignores focus that arrived by press rather than by Tab', () => {
    // a press focuses whatever it lands on; treating that as a keyboard visit
    // would let a click on the pin — or on a nav link — hold the rail open
    // long after the pointer had gone
    mount();
    collapse();
    fireEvent.mouseDown(window);
    act(() => navlink().focus());
    expect(state()).toBe('rail');
  });

  it('lets the keyboard pin what it opened', () => {
    mount();
    collapse();
    focusIn(navlink());
    fireEvent.click(pin()!);
    focusOut();
    expect(state()).toBe('open');
  });
});
