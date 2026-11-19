/**
 * A very quick blur out / blur in on the content a tab switch replaces.
 *
 * Built on the View Transitions API: the browser snapshots the old panel, React
 * commits the new tab synchronously inside the callback (`flushSync`), and CSS
 * (`.px-vt-tab` in theme.css) blurs the old snapshot out while the new one
 * blurs in. Only the panel animates — the root's default crossfade is switched
 * off, so the tab bar's underline and everything else change instantly.
 *
 * The panel gets its `view-transition-name` only for the length of the swap, so
 * two tabbed areas on one screen never claim the same name. Where the API is
 * missing (jsdom, older browsers) or the user prefers reduced motion, the
 * update just runs — the swap is purely cosmetic.
 */
import { useCallback, useRef, type RefObject } from 'react';
import { flushSync } from 'react-dom';

interface ViewTransitionLike {
  finished: Promise<void>;
}
type DocWithVT = Document & { startViewTransition?: (cb: () => void) => ViewTransitionLike };

const NAME = 'px-tabpanel';
const ROOT_CLASS = 'px-vt-tab';

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Run `update` (a tab change) with the blur swap on `panel`, when possible. */
export function swapTab(panel: HTMLElement | null, update: () => void): void {
  const doc = document as DocWithVT;
  if (!panel || typeof doc.startViewTransition !== 'function' || reducedMotion()) {
    update();
    return;
  }
  const root = document.documentElement;
  panel.style.setProperty('view-transition-name', NAME);
  root.classList.add(ROOT_CLASS);
  const done = () => {
    panel.style.removeProperty('view-transition-name');
    root.classList.remove(ROOT_CLASS);
  };
  try {
    doc.startViewTransition(() => flushSync(update)).finished.then(done, done);
  } catch {
    done();
    update();
  }
}

/**
 * `[panelRef, swap]` — put `panelRef` on the element that holds the tab's
 * content (one that stays mounted across tabs), and route tab changes through
 * `swap(() => setTab(key))`.
 */
export function useTabSwap<T extends HTMLElement = HTMLDivElement>(): [RefObject<T | null>, (update: () => void) => void] {
  const ref = useRef<T | null>(null);
  const swap = useCallback((update: () => void) => swapTab(ref.current, update), []);
  return [ref, swap];
}
