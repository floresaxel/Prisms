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

// two items, so focus can be moved BETWEEN links inside the sidebar. My Day is
// appended (not prepended) so the two links the focus tests reach for stay first.
const GROUPS = [
  {
    label: 'My work',
    items: [
      { key: 'agenda', label: 'Agenda', href: '/agenda', icon: 'cal' as const },
      { key: 'tasks', label: 'Tasks', href: '/tasks', icon: 'list' as const },
      { key: 'myday', label: 'My Day', href: '/', icon: 'sun' as const },
    ],
  },
];
/** Where the brand mark points once the sidebar is open. */
const HOME = '/';

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

function mount(extra: Partial<Parameters<typeof Layout>[0]> = {}) {
  return render(
    createElement(Layout, {
      groups: GROUPS,
      active: '/agenda',
      breadcrumb: { section: 'My work', page: 'Agenda' },
      children: null,
      ...extra,
    }),
  );
}

const aside = () => document.querySelector('.px-sidebar') as HTMLElement;
const state = () => aside().dataset.state;
const toggle = () => screen.getByTestId('sidebar-toggle');
const maybeToggle = () => screen.queryByTestId('sidebar-toggle');
const pin = () => screen.queryByTestId('sidebar-pin');
const navlink = () => document.querySelector('.px-navlink') as HTMLElement;
/** The brand mark in each of its two jobs. */
const markExpand = () => screen.queryByTestId('brand-expand');
const markHome = () => screen.queryByTestId('brand-home');

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
    // the chevron goes because the rail is opened by resting on it or by
    // pressing the mark, not by aiming at a 34px target; and the pin has
    // nothing to hold open while it is shut. The brand mark is not one of
    // these — it stays, wearing its other job.
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

  it('opens a rail that has no chevron of its own', () => {
    mount();
    collapse();
    expect(maybeToggle()).toBeNull(); // the brand mark is the only press left
    hoverFor(PEEK_DELAY_MS);
    expect(state()).toBe('peek');
    expect(pin()).not.toBeNull(); // …and now there is something else to press
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

describe('the brand mark', () => {
  // One mark, two jobs, decided by what the sidebar is already doing: shut, it
  // opens; open, there is nothing left to expand so it goes home.
  const collapse = () => fireEvent.click(toggle());

  it('opens the sidebar when it is shut', () => {
    mount({ brandHref: HOME });
    collapse();
    expect(state()).toBe('rail');
    expect(markHome()).toBeNull(); // not offering to navigate while it is shut
    fireEvent.click(markExpand()!);
    expect(state()).toBe('open');
  });

  it('opening it that way is a PREFERENCE, not a peek', () => {
    // pressing the mark is a deliberate act, so it must outlive the pointer
    // walking away — unlike a hover peek, which is not a choice at all.
    mount({ brandHref: HOME });
    collapse();
    fireEvent.click(markExpand()!);
    fireEvent.mouseLeave(aside());
    expect(state()).toBe('open');
    expect(storage.getItem(RAIL_KEY)).toBe('0');
    cleanup();
    mount({ brandHref: HOME });
    expect(state()).toBe('open');
  });

  it('goes to My Day when the sidebar is already open', () => {
    const onNavigate = vi.fn();
    mount({ brandHref: HOME, onNavigate });
    expect(markExpand()).toBeNull(); // nothing left to expand
    fireEvent.click(markHome()!);
    expect(onNavigate).toHaveBeenCalledWith(HOME);
  });

  it('takes its accessible name from the nav item it points at', () => {
    // derived rather than passed, so the mark cannot come to disagree with the
    // label the nav shows for the same route
    mount({ brandHref: HOME });
    expect(markHome()!.getAttribute('aria-label')).toBe('Prisms — go to My Day');
    expect(markHome()!.getAttribute('href')).toBe(HOME);
  });

  it('navigates rather than expands during a peek — it looks open, so it acts open', () => {
    const onNavigate = vi.fn();
    mount({ brandHref: HOME, onNavigate });
    collapse();
    hoverFor(PEEK_DELAY_MS);
    expect(state()).toBe('peek');
    expect(markExpand()).toBeNull();
    fireEvent.click(markHome()!);
    expect(onNavigate).toHaveBeenCalledWith(HOME);
  });

  it('stays inert on an open sidebar with nowhere to point', () => {
    mount(); // no brandHref
    expect(markHome()).toBeNull();
    expect(markExpand()).toBeNull();
    expect(document.querySelector('.px-brand-logo')!.tagName).toBe('SPAN');
  });

  it('still opens a shut sidebar with no brandHref — that job needs no route', () => {
    mount();
    fireEvent.click(toggle());
    fireEvent.click(markExpand()!);
    expect(state()).toBe('open');
  });

  it('says which job it is doing', () => {
    mount({ brandHref: HOME });
    fireEvent.click(toggle());
    expect(markExpand()!.getAttribute('aria-label')).toBe('expand sidebar');
    expect(markExpand()!.getAttribute('aria-expanded')).toBe('false');
  });

  it('survives being tabbed to — the focus peek must not pull it out from under the keyboard', () => {
    // The mark is the rail's EXPLICIT way open, so it does not also peek. If it
    // did, landing on it would open the sidebar, which swaps the button for a
    // link — unmounting the element that holds focus, dropping focus to the
    // body, and shutting the rail again under a keyboard that had just arrived.
    mount({ brandHref: HOME });
    collapse();
    act(() => {
      fireEvent.keyDown(window, { key: 'Tab' });
      markExpand()!.focus();
    });
    expect(state()).toBe('rail'); // did NOT peek
    expect(markExpand()).not.toBeNull(); // …so the button is still there
    expect(document.activeElement).toBe(markExpand()); // …still holding focus
  });

  it('and pressing it from there opens the sidebar outright', () => {
    mount({ brandHref: HOME });
    collapse();
    act(() => {
      fireEvent.keyDown(window, { key: 'Tab' });
      markExpand()!.focus();
    });
    fireEvent.click(markExpand()!);
    expect(state()).toBe('open');
  });

  it('costs exactly one tab stop — the next one peeks as it always did', () => {
    mount({ brandHref: HOME });
    collapse();
    act(() => {
      fireEvent.keyDown(window, { key: 'Tab' });
      markExpand()!.focus();
    });
    expect(state()).toBe('rail');
    act(() => {
      fireEvent.keyDown(window, { key: 'Tab' });
      navlink().focus();
    });
    expect(state()).toBe('peek');
  });

  it('holds a peek open when focus moves BACK onto the mark', () => {
    // the blur half of that move must not read as leaving the sidebar
    mount({ brandHref: HOME });
    collapse();
    act(() => {
      fireEvent.keyDown(window, { key: 'Tab' });
      navlink().focus();
    });
    expect(state()).toBe('peek');
    act(() => markHome()!.focus());
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

  it('gives the brand mark its OTHER job — an expand here could never work', () => {
    // the width overrules every preference, so a mark offering to expand would
    // be a button that visibly does nothing. Navigating at least works.
    const onNavigate = vi.fn();
    mount({ brandHref: HOME, onNavigate });
    expect(markExpand()).toBeNull();
    fireEvent.click(markHome()!);
    expect(onNavigate).toHaveBeenCalledWith(HOME);
    expect(state()).toBe('rail');
  });
});

describe('reaching a rail by keyboard', () => {
  // Focus alone opens it, without needing to find the brand mark first — the
  // mark is one press, but landing anywhere on the rail should already show you
  // what you are choosing between. A focus only counts while the KEYBOARD is
  // driving, so each of these tabs first — exactly as a keyboard user arrives.
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
