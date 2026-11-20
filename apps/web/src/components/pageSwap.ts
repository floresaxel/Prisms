/**
 * Moving between screens: the whole page area blurs out, the next screen's
 * chunk is made ready meanwhile, and the new screen blurs in already drawn.
 *
 * Plain CSS classes on the page wrapper (`.px-page--out` / `.px-page--in` in
 * theme.css), not a View Transition: the out phase has to WAIT for the next
 * screen (its chunk, on a first visit), and only the real page — never the
 * Suspense skeleton — may be what blurs in. `screens.ts` makes a screen whose
 * chunk is here render without suspending, so the commit below draws the page
 * itself.
 *
 * With reduced motion asked for, or no `matchMedia` to ask (jsdom), the screen
 * just switches.
 */
import { flushSync } from 'react-dom';

/** Matches `px-page-out` in theme.css. */
export const PAGE_OUT_MS = 112;
/** Matches `px-page-in` in theme.css (plus slack), for when animationend never comes. */
const PAGE_IN_MS = 200;

function skipMotion(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/**
 * Blur `page` out, wait for `ready` (the next screen's chunk) and the out
 * phase, then `commit` (set the route) and blur the new screen in.
 * `isCurrent` says whether this is still the latest navigation: a newer one
 * takes over from wherever this one is, and this one bows out.
 */
export async function swapPage(page: HTMLElement | null, ready: Promise<unknown>, isCurrent: () => boolean, commit: () => void): Promise<void> {
  if (!page || skipMotion()) {
    commit();
    return;
  }
  page.classList.remove('px-page--in');
  page.classList.add('px-page--out');
  await Promise.all([ready.catch(() => undefined), wait(PAGE_OUT_MS)]);
  if (!isCurrent()) return;

  flushSync(commit);
  page.classList.remove('px-page--out');
  page.classList.add('px-page--in');
  const done = () => {
    if (isCurrent()) page.classList.remove('px-page--in');
  };
  // the page's own animationend — descendants' animations bubble up here too
  const onEnd = (e: AnimationEvent) => {
    if (e.target !== page) return;
    page.removeEventListener('animationend', onEnd);
    done();
  };
  page.addEventListener('animationend', onEnd);
  window.setTimeout(() => {
    page.removeEventListener('animationend', onEnd);
    done();
  }, PAGE_IN_MS);
}
