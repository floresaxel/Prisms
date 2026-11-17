// @vitest-environment jsdom
/**
 * The page reloads itself when a NEW build's service worker takes it over — and
 * only then. The shell is served from the worker's precache, so without this the
 * first load after every rebuild keeps running the previous bundle; with it done
 * carelessly, a first visit would reload for nothing, or an update would land in
 * the middle of someone's typing and take the text with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reloadWhenUpdated } from '../src/sw-update';

/** Just enough of `navigator.serviceWorker`: a controller and the one event. */
function fakeServiceWorker(controlled: boolean) {
  const target = new EventTarget();
  return {
    controller: controlled ? ({} as ServiceWorker) : null,
    addEventListener: target.addEventListener.bind(target) as ServiceWorkerContainer['addEventListener'],
    /** A worker claims the page (a first install, or an update taking over). */
    claim: () => target.dispatchEvent(new Event('controllerchange')),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('reloadWhenUpdated', () => {
  it('reloads when a new worker replaces the one that served this page', () => {
    const sw = fakeServiceWorker(true);
    const reload = vi.fn();
    reloadWhenUpdated({ serviceWorker: sw, reload });
    expect(reload).not.toHaveBeenCalled();

    sw.claim();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does NOT reload on a first visit — the worker claiming the page serves the build already on screen', () => {
    const sw = fakeServiceWorker(false);
    const reload = vi.fn();
    reloadWhenUpdated({ serviceWorker: sw, reload });

    sw.claim(); // first install taking control
    expect(reload).not.toHaveBeenCalled();

    sw.claim(); // …but a later one, with the page still open, IS an update
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('waits out a half-typed field instead of reloading it away', () => {
    const sw = fakeServiceWorker(true);
    const reload = vi.fn();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    reloadWhenUpdated({ serviceWorker: sw, reload, retryMs: 1000 });

    sw.claim();
    vi.advanceTimersByTime(5000);
    expect(reload).not.toHaveBeenCalled(); // still typing

    input.blur();
    vi.advanceTimersByTime(1000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('waits out an open dialog too, even with focus on one of its buttons', () => {
    const sw = fakeServiceWorker(true);
    const reload = vi.fn();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    reloadWhenUpdated({ serviceWorker: sw, reload, retryMs: 1000 });

    sw.claim();
    vi.advanceTimersByTime(3000);
    expect(reload).not.toHaveBeenCalled();

    dialog.remove();
    vi.advanceTimersByTime(1000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads once however many times the controller changes while it waits', () => {
    const sw = fakeServiceWorker(true);
    const reload = vi.fn();
    const input = document.createElement('textarea');
    document.body.append(input);
    input.focus();
    reloadWhenUpdated({ serviceWorker: sw, reload, retryMs: 1000 });

    sw.claim();
    sw.claim();
    input.blur();
    vi.advanceTimersByTime(1000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('is a no-op where there are no service workers at all', () => {
    // jsdom has no navigator.serviceWorker — the same as plain http off localhost
    expect(() => reloadWhenUpdated()).not.toThrow();
  });
});
